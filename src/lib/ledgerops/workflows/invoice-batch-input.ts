import {readFile} from 'node:fs/promises'

/**
 * Synthetic invoice-batch input parser (offline, pure).
 *
 * This module turns a CSV batch of draft-invoice line items into typed rows
 * before any workflow or transport sees them. It performs zero network I/O
 * and imports nothing from the Xero SDK; the only filesystem touch is the
 * optional `loadInvoiceBatchFile` convenience wrapper.
 *
 * CSV schema (this issue covers CSV only; a JSON variant is deferred):
 *
 *   Required exact header: contact,reference,date,description,quantity,unitAmount
 *
 *   - contact:     non-empty string
 *   - reference:   non-empty string
 *   - date:        YYYY-MM-DD, must be a real calendar date
 *   - description: non-empty string
 *   - quantity:    decimal > 0
 *   - unitAmount:  decimal >= 0 with at most 2 decimal places
 *   - computed line total quantity * unitAmount must be > 0
 *
 * Parsing is RFC4180-lite:
 *   - CRLF and bare CR are normalized to LF;
 *   - fields may be double-quoted; quoted fields may contain commas and
 *     newlines;
 *   - `""` inside a quoted field escapes a single double quote; and
 *   - ragged rows (wrong column count) are rejected.
 *
 * Error model (all-or-nothing): every problem is collected into
 * `InvoiceBatchInputError` values carrying the 1-based data row number (the
 * header row is row 0), an optional column name, a stable SCREAMING_SNAKE
 * code, and a human message. Errors are sorted by row then column. When any
 * error exists the result is `{ok: false, errors}` and NO rows are returned;
 * only a fully valid batch yields `{ok: true, rows}`. An empty file or a
 * header-only file fails with `EMPTY_BATCH`.
 *
 * Stable error codes:
 *   - EMPTY_BATCH         no data rows at all
 *   - BAD_HEADER          header row is not exactly the required header
 *   - RAGGED_ROW          record does not have exactly 6 columns
 *   - UNTERMINATED_QUOTE  quoted field runs to end of input
 *   - REQUIRED_FIELD      required string cell is empty
 *   - BAD_DATE            not a real YYYY-MM-DD calendar date
 *   - BAD_QUANTITY        not a decimal, or not strictly positive
 *   - BAD_UNIT_AMOUNT     not a decimal, negative, or more than 2 decimals
 *   - ZERO_LINE_TOTAL     quantity * unitAmount is not strictly positive
 *   - DUP_ROW             contact+reference+date+description repeats an
 *                         earlier well-formed row (flagged on each later
 *                         occurrence)
 */

export type InvoiceBatchErrorCode =
  | 'EMPTY_BATCH'
  | 'BAD_HEADER'
  | 'RAGGED_ROW'
  | 'UNTERMINATED_QUOTE'
  | 'REQUIRED_FIELD'
  | 'BAD_DATE'
  | 'BAD_QUANTITY'
  | 'BAD_UNIT_AMOUNT'
  | 'ZERO_LINE_TOTAL'
  | 'DUP_ROW'

export interface InvoiceBatchRow {
  readonly contact: string
  readonly reference: string
  readonly date: string
  readonly description: string
  /** Decimal string, strictly greater than zero, as written in the input. */
  readonly quantity: string
  /** Decimal string, zero or greater, at most two decimal places, as written. */
  readonly unitAmount: string
  /** Exact product quantity * unitAmount rendered with at least 2 decimals. */
  readonly lineTotal: string
}

export interface InvoiceBatchInputError {
  /** 1-based data row number; the header row is row 0. */
  readonly row: number
  readonly column?: string
  readonly code: InvoiceBatchErrorCode
  readonly message: string
}

export type InvoiceBatchParseResult =
  | {readonly ok: true; readonly rows: readonly InvoiceBatchRow[]}
  | {readonly ok: false; readonly errors: readonly InvoiceBatchInputError[]}

const HEADER_COLUMNS = ['contact', 'reference', 'date', 'description', 'quantity', 'unitAmount'] as const
const COLUMN_COUNT = HEADER_COLUMNS.length
const DECIMAL_PATTERN = /^\d+(\.\d+)?$/

interface Decimal {
  readonly digits: bigint
  readonly scale: number
}

function parseDecimal(value: string): Decimal | undefined {
  if (!DECIMAL_PATTERN.test(value)) return undefined
  const point = value.indexOf('.')
  return {
    digits: BigInt(value.replace('.', '')),
    scale: point === -1 ? 0 : value.length - point - 1,
  }
}

function calendarDateValid(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
}

/**
 * Exact decimal product rendered with at least two fraction digits; trailing
 * zeros beyond two are stripped so money totals stay canonical (`21.00`,
 * never `21.000`). Callers only reach this with non-negative operands.
 */
function renderLineTotal(product: bigint, scale: number): string {
  const raw = product.toString().padStart(scale + 1, '0')
  let intPart = raw.slice(0, raw.length - scale)
  let fracPart = raw.slice(raw.length - scale)
  while (fracPart.length < 2) fracPart += '0'
  while (fracPart.length > 2 && fracPart.endsWith('0')) fracPart = fracPart.slice(0, -1)
  if (intPart === '') intPart = '0'
  return `${intPart}.${fracPart}`
}

interface RecordScan {
  readonly records: string[][]
  readonly unterminatedQuoteRow?: number
}

/**
 * RFC4180-lite record splitter over LF-normalized text: commas separate
 * unquoted fields, double quotes toggle quoting, `""` escapes a quote inside
 * quotes, and newlines terminate records outside quotes.
 */
function splitRecords(text: string): RecordScan {
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      record.push(field)
      field = ''
    } else if (char === '\n') {
      record.push(field)
      records.push(record)
      record = []
      field = ''
    } else {
      field += char
    }
  }

  if (inQuotes) {
    return {records, unterminatedQuoteRow: records.length}
  }

  // A final newline already closed the last record; anything after it starts
  // one more record, which is dropped when it holds no characters at all.
  if (field !== '' || record.length > 0) {
    record.push(field)
    records.push(record)
  }
  return {records}
}

/**
 * Parse an invoice-batch CSV document into typed rows or a complete error
 * list. Pure function: same input always yields the same result, and no
 * state outside this file is read or written.
 */
export function parseInvoiceBatch(csv: string): InvoiceBatchParseResult {
  const errors: InvoiceBatchInputError[] = []
  const fail = (row: number, code: InvoiceBatchErrorCode, message: string, column?: string): void => {
    errors.push(column === undefined ? {row, code, message} : {row, code, column, message})
  }

  const normalized = csv.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const scan = splitRecords(normalized)
  if (scan.unterminatedQuoteRow !== undefined) {
    fail(scan.unterminatedQuoteRow, 'UNTERMINATED_QUOTE', 'quoted field reaches end of input without a closing quote')
  }

  const records = scan.records
  if (records.length === 0) {
    fail(0, 'EMPTY_BATCH', 'file contains no header and no data rows')
    return {ok: false, errors: sortErrors(errors)}
  }

  if (records[0].join(',') !== HEADER_COLUMNS.join(',')) {
    fail(0, 'BAD_HEADER', `expected exact header "${HEADER_COLUMNS.join(',')}" but got "${records[0].join(',')}"`)
    return {ok: false, errors: sortErrors(errors)}
  }

  const dataRecords = records.slice(1)
  if (dataRecords.length === 0) {
    fail(0, 'EMPTY_BATCH', 'file contains a header but no data rows')
    return {ok: false, errors: sortErrors(errors)}
  }

  const seenDuplicateKeys = new Set<string>()
  const rows: InvoiceBatchRow[] = []

  dataRecords.forEach((fields, recordOffset) => {
    const dataRow = recordOffset + 1
    if (fields.length !== COLUMN_COUNT) {
      fail(dataRow, 'RAGGED_ROW', `expected ${COLUMN_COUNT} columns but got ${fields.length}`)
      return
    }

    const [contact, reference, date, description, quantityText, unitAmountText] = fields
    let rowValid = true

    for (const [column, value] of [
      ['contact', contact],
      ['reference', reference],
      ['description', description],
    ] as const) {
      if (value === '') {
        fail(dataRow, 'REQUIRED_FIELD', `${column} must be a non-empty string`, column)
        rowValid = false
      }
    }

    if (!calendarDateValid(date)) {
      fail(dataRow, 'BAD_DATE', `date must be a real calendar date as YYYY-MM-DD but got "${date}"`, 'date')
      rowValid = false
    }

    const quantity = parseDecimal(quantityText)
    if (quantity === undefined || quantity.digits <= 0n) {
      fail(dataRow, 'BAD_QUANTITY', `quantity must be a decimal greater than 0 but got "${quantityText}"`, 'quantity')
      rowValid = false
    }

    const unitAmount = parseDecimal(unitAmountText)
    if (unitAmount === undefined || unitAmount.scale > 2) {
      fail(
        dataRow,
        'BAD_UNIT_AMOUNT',
        `unitAmount must be a decimal with at most 2 decimal places but got "${unitAmountText}"`,
        'unitAmount',
      )
      rowValid = false
    }

    if (rowValid && quantity !== undefined && unitAmount !== undefined) {
      const duplicateKey = [contact, reference, date, description].join('\u0000')
      if (seenDuplicateKeys.has(duplicateKey)) {
        fail(dataRow, 'DUP_ROW', 'a previous row has the same contact, reference, date, and description')
      } else {
        seenDuplicateKeys.add(duplicateKey)
      }

      const product = quantity.digits * unitAmount.digits
      if (product <= 0n) {
        fail(dataRow, 'ZERO_LINE_TOTAL', 'line total quantity * unitAmount must be greater than 0', 'lineTotal')
        rowValid = false
      } else {
        rows.push({
          contact,
          reference,
          date,
          description,
          quantity: quantityText,
          unitAmount: unitAmountText,
          lineTotal: renderLineTotal(product, quantity.scale + unitAmount.scale),
        })
      }
    }
  })

  if (errors.length > 0) {
    return {ok: false, errors: sortErrors(errors)}
  }
  return {ok: true, rows}
}

function sortErrors(errors: InvoiceBatchInputError[]): InvoiceBatchInputError[] {
  return [...errors].sort((left, right) => left.row - right.row || compareOptionalColumns(left.column, right.column))
}

function compareOptionalColumns(left: string | undefined, right: string | undefined): number {
  if (left === right) return 0
  if (left === undefined) return -1
  if (right === undefined) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Read an invoice-batch CSV file from disk (UTF-8) and parse it offline.
 * Filesystem failures surface as rejected promises; content problems follow
 * the all-or-nothing {@link InvoiceBatchParseResult} contract.
 */
export async function loadInvoiceBatchFile(path: string): Promise<InvoiceBatchParseResult> {
  return parseInvoiceBatch(await readFile(path, 'utf8'))
}
