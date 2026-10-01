import {chmodSync, closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, writeSync} from 'node:fs'
import {homedir} from 'node:os'
import {basename, dirname, isAbsolute, join} from 'node:path'

import {isAuditReceipt, isWriteAheadIntent} from './audit.js'
import {verifyBatchLinkIntegrity} from './batch-link.js'
import {verifyBatchManifestIntegrity} from './batch-manifest.js'
import {verifyBatchReceiptIntegrity} from './batch-receipt.js'
import {canonicalJson} from './canonical.js'
import {isReplayClaim, type ReplayClaim} from './replay-claim.js'
import {isReadReceipt, type ReadReceipt, type ReadReceiptSink} from './read.js'
import type {
  AuditReceipt,
  BatchLink,
  BatchManifest,
  BatchReceipt,
  BatchRecordSink,
  ReceiptSink,
  WriteAheadIntent,
} from './types.js'

export const RECEIPT_FILE_NAME = 'receipts.jsonl'

/**
 * The durable receipt store lives outside the repository, on the private side
 * of the ADR-0007 boundary: `~/.config/ledgerops/` (or `$XDG_CONFIG_HOME/ledgerops/`).
 * A relative XDG_CONFIG_HOME is ignored — it would resolve against the working
 * directory and could land receipts inside a repository checkout.
 */
export function defaultReceiptFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome =
    typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim() !== '' && isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : join(homedir(), '.config')
  return join(configHome, 'ledgerops', RECEIPT_FILE_NAME)
}

export interface FileReceiptSinkOptions {
  /** Override the store location; used by tests. Defaults to `defaultReceiptFilePath()`. */
  readonly path?: string
}

/**
 * Append-only JSONL sink (ADR-0009). Each line is one canonical-JSON signed
 * record — a `ledgerops.write-ahead.v1` intent, a `ledgerops.audit.v1`
 * receipt (joined on `planDigest`), or a `ledgerops.read.v1` read receipt.
 * Every append writes the complete line and
 * fsyncs the file (and, once, its directory entry) before the sink reports
 * success, so a `writeAhead` that returns has proven the store is writable and
 * the intent is on disk. Directory and file modes are re-tightened to
 * 0700/0600 on every append, covering stores created by earlier tools.
 * Nothing here truncates, rewrites, or deletes.
 *
 * ADR-0011 batch records (`ledgerops.batch-manifest.v1`,
 * `ledgerops.batch-link.v1`, `ledgerops.batch-receipt.v1`) append through the
 * same store via one typed method per record label — no generic
 * `write(any)` escape hatch, so an unregistered shape is rejected at the
 * call site rather than silently persisted.
 */
export class FileReceiptSink implements ReceiptSink, ReadReceiptSink, BatchRecordSink {
  readonly filePath: string
  private directorySynced = false

  constructor(options: FileReceiptSinkOptions = {}) {
    this.filePath = options.path ?? defaultReceiptFilePath()
  }

  writeAhead(intent: WriteAheadIntent): void {
    if (!isWriteAheadIntent(intent)) {
      throw new TypeError('Only LedgerOps write-ahead intents may be written')
    }
    this.append(canonicalJson(intent))
  }

  write(receipt: AuditReceipt): void {
    if (!isAuditReceipt(receipt)) {
      throw new TypeError('Only LedgerOps audit receipts may be written')
    }
    this.append(canonicalJson(receipt))
  }

  writeRead(receipt: ReadReceipt): void {
    if (!isReadReceipt(receipt)) {
      throw new TypeError('Only LedgerOps read receipts may be written')
    }
    this.append(canonicalJson(receipt))
  }

  /**
   * Append a signed replay claim to the durable journal. The
   * append is the claim itself -- callers use `claimOperation`
   * (`replay-guard.ts`), which holds the exclusive lock across the
   * scan-then-append that makes this call safe; this method never scans.
   */
  writeReplayClaim(claim: ReplayClaim): void {
    if (!isReplayClaim(claim)) {
      throw new TypeError('Only LedgerOps replay claims may be written')
    }
    this.append(canonicalJson(claim))
  }

  writeBatchManifest(manifest: BatchManifest): void {
    if (!verifyBatchManifestIntegrity(manifest)) {
      throw new TypeError('Only LedgerOps batch manifests may be written')
    }
    this.append(canonicalJson(manifest))
  }

  writeBatchLink(link: BatchLink): void {
    if (!verifyBatchLinkIntegrity(link)) {
      throw new TypeError('Only LedgerOps batch links may be written')
    }
    this.append(canonicalJson(link))
  }

  writeBatchReceipt(receipt: BatchReceipt): void {
    if (!verifyBatchReceiptIntegrity(receipt)) {
      throw new TypeError('Only LedgerOps batch receipts may be written')
    }
    this.append(canonicalJson(receipt))
  }

  private append(line: string): void {
    const directory = dirname(this.filePath)
    const created = mkdirSync(directory, {recursive: true, mode: 0o700}) !== undefined
    // Tighten only a directory the sink manages: one it just created, or the
    // dedicated `ledgerops` store directory. A caller-supplied shared parent
    // (e.g. /tmp) must keep its own modes.
    if (created || basename(directory) === 'ledgerops') {
      chmodSync(directory, 0o700)
    }
    const fd = openSync(this.filePath, 'a', 0o600)
    try {
      fchmodSync(fd, 0o600)
      const data = Buffer.from(`${line}\n`, 'utf8')
      let written = 0
      while (written < data.length) {
        written += writeSync(fd, data, written, data.length - written)
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    this.ensureDirectoryDurable(directory)
  }

  /**
   * The first fsync of the file does not make its brand-new directory entry
   * durable; sync the directory once so a crash cannot lose the whole store.
   * Windows cannot fsync a directory handle — the entry-durability gap is
   * accepted there rather than making the sink unusable.
   */
  private ensureDirectoryDurable(directory: string): void {
    if (this.directorySynced) return
    try {
      const fd = openSync(directory, 'r')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch (error) {
      if (process.platform !== 'win32') throw error
    }

    this.directorySynced = true
  }
}

export function createFileReceiptSink(options: FileReceiptSinkOptions = {}): FileReceiptSink {
  return new FileReceiptSink(options)
}
