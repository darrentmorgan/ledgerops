import {closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync} from 'node:fs'
import {hostname} from 'node:os'
import {dirname} from 'node:path'
import {canonicalJson} from './canonical.js'
import type {FileReceiptSink} from './file-receipt-sink.js'
import {createReplayClaim, REPLAY_CLAIM_SCHEMA, type ReplayClaim, type ReplayClaimInput} from './replay-claim.js'

export const RECEIPT_LOCK_FILE_SUFFIX = '.lock'
export const defaultReceiptLockFilePath = (receiptFilePath: string): string =>
  `${receiptFilePath}${RECEIPT_LOCK_FILE_SUFFIX}`
export class ReceiptSinkUnavailableError extends Error {}
export type ClaimOperationInput = ReplayClaimInput
export type ReplayClaimResult =
  | {readonly status: 'CLAIMED'; readonly claim: ReplayClaim}
  | {
      readonly status: 'STOP'
      readonly code: 'DUPLICATE_OPERATION' | 'RECEIPT_SINK_UNAVAILABLE'
      readonly reason: string
      readonly dispatchState: 'not-dispatched'
    }

/**
 * Hold an exclusive journal lock across lookup and durable append. The append
 * itself claims the operation; callers may dispatch only after CLAIMED.
 * Locks left by interrupted calls require manual recovery, with no expiry or
 * process-liveness shortcut that could allow a second writer.
 */
export function claimOperation(sink: FileReceiptSink, input: ClaimOperationInput, now = Date.now()): ReplayClaimResult {
  const lockPath = defaultReceiptLockFilePath(sink.filePath)
  let acquired = false
  try {
    mkdirSync(dirname(lockPath), {recursive: true, mode: 0o700})
    let fd: number
    try {
      fd = openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      let holder = '(holder unavailable)'
      try {
        holder = readFileSync(lockPath, 'utf8').trim()
      } catch {
        /* Preserve acquisition failure. */
      }
      throw new ReceiptSinkUnavailableError(`Unable to acquire ${lockPath}: ${holder}: ${String(error)}`)
    }
    // Retain the lock if writing its diagnostic record fails: no successful
    // acquisition has been established, and interrupted ownership is ambiguous.
    try {
      fchmodSync(fd, 0o600)
      const bytes = Buffer.from(
        `${canonicalJson({pid: process.pid, hostname: hostname(), operationId: input.operationId, acquiredAt: now})}\n`,
      )
      let offset = 0
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    acquired = true
    if (hasClaim(sink.filePath, input.operationId)) {
      return {
        status: 'STOP',
        code: 'DUPLICATE_OPERATION',
        reason: `Operation already claimed: ${input.operationId}`,
        dispatchState: 'not-dispatched',
      }
    }
    const claim = createReplayClaim(input)
    sink.writeReplayClaim(claim)
    return {status: 'CLAIMED', claim}
  } catch (error) {
    return {
      status: 'STOP',
      code: 'RECEIPT_SINK_UNAVAILABLE',
      reason: `Unable to claim operation at ${lockPath}: ${String(error)}`,
      dispatchState: 'not-dispatched',
    }
  } finally {
    if (acquired) {
      try {
        unlinkSync(lockPath)
      } catch {
        /* A retained lock safely blocks subsequent claims. */
      }
    }
  }
}

function hasClaim(path: string, operationId: string): boolean {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
  let found = false
  for (const line of contents.split('\n')) {
    if (line === '') continue
    // Never skip damaged JSON: it could contain the only previous claim.
    const value: unknown = JSON.parse(line)
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'schemaVersion' in value &&
      value.schemaVersion === REPLAY_CLAIM_SCHEMA &&
      'operationId' in value &&
      value.operationId === operationId
    )
      found = true
  }
  return found
}
