import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {resolveDownloadTarget, writeDownload, STDOUT_TARGET} from '../../src/lib/file-download.js'

/**
 * Unit coverage for the shared binary-download helper (issue #109, packet ACC-03).
 * Every PDF-download command (invoices, and later quotes/credit-notes/purchase-orders)
 * consumes this module unchanged, so its file-write and stdout-purity behavior is
 * pinned here rather than re-tested per command.
 */

const FIXTURE_BYTES = Buffer.from('%PDF-1.4 fake pdf bytes\n', 'utf-8')

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ledgerops-file-download-'))
})

afterEach(() => {
  rmSync(tmpDir, {recursive: true, force: true})
})

describe('resolveDownloadTarget', () => {
  it('uses --out when provided', () => {
    expect(resolveDownloadTarget('explicit.pdf', './default.pdf')).toBe('explicit.pdf')
  })

  it('falls back to the default filename when --out is absent', () => {
    expect(resolveDownloadTarget(undefined, './default.pdf')).toBe('./default.pdf')
  })

  it('treats an empty --out as absent', () => {
    expect(resolveDownloadTarget('', './default.pdf')).toBe('./default.pdf')
  })
})

describe('writeDownload file mode', () => {
  it('writes bytes to the resolved path and reports the byte count', () => {
    const target = join(tmpDir, 'out.pdf')

    const result = writeDownload(FIXTURE_BYTES, target)

    expect(result.path).toBe(target)
    expect(result.bytesWritten).toBe(FIXTURE_BYTES.length)
    expect(readFileSync(target)).toEqual(FIXTURE_BYTES)
  })

  it('throws a clear error when the parent directory does not exist', () => {
    const target = join(tmpDir, 'missing-dir', 'out.pdf')

    expect(() => writeDownload(FIXTURE_BYTES, target)).toThrow(/directory does not exist/i)
  })
})

describe('writeDownload stdout mode', () => {
  it('writes raw bytes to stdout and nothing else', () => {
    const written: Buffer[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      return true
    })

    const result = writeDownload(FIXTURE_BYTES, STDOUT_TARGET)

    spy.mockRestore()
    expect(result.path).toBe(STDOUT_TARGET)
    expect(result.bytesWritten).toBe(FIXTURE_BYTES.length)
    expect(Buffer.concat(written)).toEqual(FIXTURE_BYTES)
  })
})
