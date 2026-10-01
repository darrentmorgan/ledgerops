import {existsSync, writeFileSync} from 'node:fs'
import {dirname, resolve} from 'node:path'

/**
 * Shared binary-download helper for commands that fetch a non-JSON payload
 * from Xero (invoice/quote/credit-note/purchase-order PDFs, and similar).
 *
 * Callers resolve a default filename and fetch the bytes; this module only
 * decides where those bytes go: `--out -` writes raw bytes to stdout with
 * nothing else on stdout, otherwise it writes a file (creating no missing
 * directories — the parent must already exist).
 */

export const STDOUT_TARGET = '-'

export interface DownloadResult {
  /** Absolute file path written, or `'-'` when the bytes went to stdout. */
  readonly path: string
  readonly bytesWritten: number
}

/** Resolve the effective output target: the `--out` flag value, or the caller's default filename. */
export function resolveDownloadTarget(out: string | undefined, defaultFilename: string): string {
  return out && out.length > 0 ? out : defaultFilename
}

/**
 * Write `bytes` to `target`. When `target` is `'-'`, writes the raw bytes to
 * stdout and returns immediately (callers must not print anything else to
 * stdout in that mode). Otherwise resolves `target` to an absolute path and
 * writes the file, throwing a clear error if the parent directory does not
 * exist.
 */
export function writeDownload(bytes: Buffer, target: string): DownloadResult {
  if (target === STDOUT_TARGET) {
    process.stdout.write(bytes)
    return {path: STDOUT_TARGET, bytesWritten: bytes.length}
  }

  const resolvedPath = resolve(target)
  const parentDir = dirname(resolvedPath)
  if (!existsSync(parentDir)) {
    throw new Error(`Output directory does not exist: ${parentDir}`)
  }

  writeFileSync(resolvedPath, bytes)
  return {path: resolvedPath, bytesWritten: bytes.length}
}
