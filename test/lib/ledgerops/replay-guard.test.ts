import {mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  claimOperation,
  createReplayClaim,
  FileReceiptSink,
  isReplayClaim,
  defaultReceiptLockFilePath,
} from '../../../src/lib/ledgerops/index.js'

const input = {recordedAt: 1000, operationId: 'a'.repeat(64), planDigest: 'b'.repeat(64)}
let directory: string
let sink: FileReceiptSink
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'replay-'))
  sink = new FileReceiptSink({path: join(directory, 'receipts.jsonl')})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, {recursive: true, force: true})
})

describe('durable operation claims', () => {
  it('persists a validated signed claim before returning and releases its lock', () => {
    const result = claimOperation(sink, input)
    expect(result.status).toBe('CLAIMED')
    const stored = JSON.parse(readFileSync(sink.filePath, 'utf8'))
    expect(isReplayClaim(stored)).toBe(true)
    expect(stored).toEqual(createReplayClaim(input))
    expect(existsSync(defaultReceiptLockFilePath(sink.filePath))).toBe(false)
    if (process.platform !== 'win32') expect(statSync(sink.filePath).mode & 0o777).toBe(0o600)
  })

  it('refuses duplicate and replanned operations without appending', () => {
    claimOperation(sink, input)
    const before = readFileSync(sink.filePath, 'utf8')
    for (const next of [input, {...input, recordedAt: 2000, planDigest: 'c'.repeat(64)}]) {
      expect(claimOperation(sink, next)).toMatchObject({
        status: 'STOP',
        code: 'DUPLICATE_OPERATION',
        dispatchState: 'not-dispatched',
      })
    }
    expect(readFileSync(sink.filePath, 'utf8')).toBe(before)
  })

  it('allows distinct operations and ignores other journal record kinds for deduplication', () => {
    writeFileSync(
      sink.filePath,
      `${JSON.stringify({schemaVersion: 'ledgerops.write-ahead.v1', operationId: input.operationId})}\n`,
    )
    expect(claimOperation(sink, input).status).toBe('CLAIMED')
    expect(claimOperation(sink, {...input, operationId: 'd'.repeat(64)}).status).toBe('CLAIMED')
  })

  it('retains existing locks and reports their diagnostic contents on repeated attempts', () => {
    const path = defaultReceiptLockFilePath(sink.filePath)
    const holder = JSON.stringify({pid: -1, acquiredAt: 0, operationId: input.operationId})
    writeFileSync(path, holder)
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = claimOperation(sink, input)
      expect(result).toMatchObject({status: 'STOP', code: 'RECEIPT_SINK_UNAVAILABLE', dispatchState: 'not-dispatched'})
      if (result.status === 'STOP') {
        expect(result.reason).toContain(path)
        expect(result.reason).toContain(holder)
      }
    }
    expect(readFileSync(path, 'utf8')).toBe(holder)
    expect(existsSync(sink.filePath)).toBe(false)
  })

  it('refuses damaged journals without changing bytes', () => {
    writeFileSync(sink.filePath, '{broken\n')
    expect(claimOperation(sink, input)).toMatchObject({status: 'STOP', code: 'RECEIPT_SINK_UNAVAILABLE'})
    expect(readFileSync(sink.filePath, 'utf8')).toBe('{broken\n')
  })

  it('fails closed when the durable append fails', () => {
    vi.spyOn(sink, 'writeReplayClaim').mockImplementation(() => {
      throw new Error('disk unavailable')
    })
    expect(claimOperation(sink, input)).toMatchObject({
      status: 'STOP',
      code: 'RECEIPT_SINK_UNAVAILABLE',
      dispatchState: 'not-dispatched',
    })
  })

  it('rejects tampered and expanded claims before writing', () => {
    const claim = createReplayClaim(input)
    for (const invalid of [
      {...claim, planDigest: 'e'.repeat(64)},
      {...claim, extra: true},
    ]) {
      expect(isReplayClaim(invalid)).toBe(false)
      expect(() => sink.writeReplayClaim(invalid)).toThrow(TypeError)
    }
    expect(existsSync(sink.filePath)).toBe(false)
  })
})
