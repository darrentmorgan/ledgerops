import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'
import {
  loadInvoiceBatchFile,
  parseInvoiceBatch,
  type InvoiceBatchParseResult,
} from '../../../../src/lib/ledgerops/workflows/invoice-batch-input.js'

/**
 * Offline contract tests for the synthetic invoice-batch CSV input parser.
 * All inputs are hand-built strings; nothing here touches the network, the
 * Xero SDK, or tenant data.
 */
const HEADER = 'contact,reference,date,description,quantity,unitAmount'

const row = (...fields: string[]): string => fields.join(',')

const csvFor = (...dataRows: string[]): string => [HEADER, ...dataRows].join('\n')

const expectError = (
  result: InvoiceBatchParseResult,
  index: number,
  expected: {row: number; column?: string; code: string},
): void => {
  expect(result.ok).toBe(false)
  if (result.ok) return
  const error = result.errors[index]
  expect(error).toBeDefined()
  expect(error.row).toBe(expected.row)
  expect(error.code).toBe(expected.code)
  if (expected.column === undefined) {
    expect(error.column).toBeUndefined()
  } else {
    expect(error.column).toBe(expected.column)
  }
  expect(typeof error.message).toBe('string')
  expect(error.message.length).toBeGreaterThan(0)
}

describe('invoice batch input parser', () => {
  it('parses a multi-row happy path with quoted commas and CRLF line endings', () => {
    const csv = [
      `${HEADER}\r\n`,
      'Synthetic Coffee Co,SC-001,2026-08-01,"Beans, whole, 1kg ""house blend""",2,10.50\r\n',
      'Synthetic Desk Works,SD-002,2026-08-02,Standing desk assembly,1.5,200\r\n',
      'Synthetic Paper Trail,SP-003,2026-08-03,Paper carton,6,18.25\r\n',
    ].join('')

    const result = parseInvoiceBatch(csv)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toHaveLength(3)
    expect(result.rows[0]).toEqual({
      contact: 'Synthetic Coffee Co',
      reference: 'SC-001',
      date: '2026-08-01',
      description: 'Beans, whole, 1kg "house blend"',
      quantity: '2',
      unitAmount: '10.50',
      lineTotal: '21.00',
    })
    expect(result.rows[1].lineTotal).toBe('300.00')
    expect(result.rows[2].lineTotal).toBe('109.50')
  })

  it('rejects a missing header column with BAD_HEADER', () => {
    const result = parseInvoiceBatch(
      [
        'contact,date,description,quantity,unitAmount',
        row('Synthetic Coffee Co', '2026-08-01', 'Beans', '2', '10.50'),
      ].join('\n'),
    )

    expectError(result, 0, {row: 0, code: 'BAD_HEADER'})
    if (!result.ok) expect(result.errors).toHaveLength(1)
  })

  it('rejects a ragged row with RAGGED_ROW', () => {
    const result = parseInvoiceBatch(csvFor(row('Synthetic Coffee Co', 'SC-001', '2026-08-01', 'Beans', '2')))

    expectError(result, 0, {row: 1, code: 'RAGGED_ROW'})
  })

  it('rejects a non-calendar date with BAD_DATE', () => {
    const result = parseInvoiceBatch(csvFor(row('Synthetic Coffee Co', 'SC-001', '2026-02-30', 'Beans', '2', '10.50')))

    expectError(result, 0, {row: 1, column: 'date', code: 'BAD_DATE'})
  })

  it('rejects a zero quantity with BAD_QUANTITY', () => {
    const result = parseInvoiceBatch(csvFor(row('Synthetic Coffee Co', 'SC-001', '2026-08-01', 'Beans', '0', '10.50')))

    expectError(result, 0, {row: 1, column: 'quantity', code: 'BAD_QUANTITY'})
  })

  it('rejects a negative unit amount with BAD_UNIT_AMOUNT', () => {
    const result = parseInvoiceBatch(csvFor(row('Synthetic Coffee Co', 'SC-001', '2026-08-01', 'Beans', '2', '-5.00')))

    expectError(result, 0, {row: 1, column: 'unitAmount', code: 'BAD_UNIT_AMOUNT'})
  })

  it('rejects a three-decimal unit amount with BAD_UNIT_AMOUNT', () => {
    const result = parseInvoiceBatch(csvFor(row('Synthetic Coffee Co', 'SC-001', '2026-08-01', 'Beans', '2', '5.123')))

    expectError(result, 0, {row: 1, column: 'unitAmount', code: 'BAD_UNIT_AMOUNT'})
  })

  it('rejects an empty contact with REQUIRED_FIELD', () => {
    const result = parseInvoiceBatch(csvFor(row('', 'SC-001', '2026-08-01', 'Beans', '2', '10.50')))

    expectError(result, 0, {row: 1, column: 'contact', code: 'REQUIRED_FIELD'})
  })

  it('rejects a zero line total with ZERO_LINE_TOTAL', () => {
    const result = parseInvoiceBatch(csvFor(row('Synthetic Coffee Co', 'SC-001', '2026-08-01', 'Beans', '2', '0')))

    expectError(result, 0, {row: 1, column: 'lineTotal', code: 'ZERO_LINE_TOTAL'})
  })

  it('flags the second occurrence of a duplicate row with DUP_ROW', () => {
    const duplicate = row('Synthetic Coffee Co', 'SC-001', '2026-08-01', 'Beans', '2', '10.50')
    const result = parseInvoiceBatch(csvFor(duplicate, duplicate))

    expectError(result, 0, {row: 2, code: 'DUP_ROW'})
    if (!result.ok) expect(result.errors).toHaveLength(1)
  })

  it('returns EMPTY_BATCH for an empty file', () => {
    const result = parseInvoiceBatch('')

    expectError(result, 0, {row: 0, code: 'EMPTY_BATCH'})
  })

  it('returns EMPTY_BATCH for a header-only file', () => {
    const result = parseInvoiceBatch(`${HEADER}\n`)

    expectError(result, 0, {row: 0, code: 'EMPTY_BATCH'})
  })

  it('sorts errors by row then column and returns no rows when any error exists', () => {
    const csv = csvFor(
      // Row 1: two cell errors, column order must sort contact before quantity.
      row('', 'R-1', '2026-08-01', 'Beans', '-1', '10.50'),
      // Row 2: one cell error.
      row('Synthetic Desk Works', 'SD-002', '2026-02-30', 'Desk assembly', '1', '200'),
      // Row 3 is clean on its own but must not appear in rows while errors exist.
      row('Synthetic Paper Trail', 'SP-003', '2026-08-03', 'Paper carton', '6', '18.25'),
    )

    const result = parseInvoiceBatch(csv)

    expect(result.ok).toBe(false)
    expect('rows' in result).toBe(false)
    if (result.ok) return
    expect(result.errors.map(error => [error.row, error.column, error.code])).toEqual([
      [1, 'contact', 'REQUIRED_FIELD'],
      [1, 'quantity', 'BAD_QUANTITY'],
      [2, 'date', 'BAD_DATE'],
    ])
  })

  it('loads a synthetic fixture file from disk via loadInvoiceBatchFile', async () => {
    const fixturePath = fileURLToPath(new URL('../../../fixtures/invoice-batch.csv', import.meta.url))
    const contents = await readFile(fixturePath, 'utf8')
    expect(contents.trim().length).toBeGreaterThan(0)

    const result = await loadInvoiceBatchFile(fixturePath)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toHaveLength(4)
    for (const entry of result.rows) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Number(entry.lineTotal)).toBeGreaterThan(0)
    }
    expect(result.rows[0].contact).toBe('Synthetic Coffee Co')
    expect(result.rows[0].lineTotal).toBe('99.00')
  })
})
