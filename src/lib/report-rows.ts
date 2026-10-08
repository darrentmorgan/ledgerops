import {encode} from '@toon-format/toon'
import {formatCurrency, formatDate, formatOutput, type OutputFormat} from './formatters.js'

interface ReportRow {
  rowType?: string
  title?: string
  cells?: {value?: unknown}[]
  rows?: ReportRow[]
}

export interface FinancialReport {
  reportName?: string
  reportDate?: string
  rows?: ReportRow[]
}

/** Flatten report rows without assuming a fixed number of financial periods. */
export function formatReport(report: FinancialReport, fallbackHeaders: string[], format: OutputFormat): string {
  const values: unknown[][] = []
  const headerRows = new Set<unknown[]>()
  let header: unknown[] | undefined
  function visit(rows: ReportRow[]): void {
    for (const row of rows) {
      const cells = (row.cells ?? []).map(cell => cell.value ?? '')
      if (row.title) values.push([`--- ${row.title} ---`])
      if (row.rowType === 'Header' && !header && cells.length > 0) {
        header = cells
      } else if (cells.length > 0) {
        values.push(cells)
        if (row.rowType === 'Header') headerRows.add(cells)
      }
      visit(row.rows ?? [])
    }
  }
  visit(report.rows ?? [])

  const width = values.reduce((max, row) => Math.max(max, row.length), header?.length ?? fallbackHeaders.length)
  const columns = Array.from({length: width}, (_, index) =>
    String(header?.[index] ?? fallbackHeaders[index] ?? `Column ${index + 1}`),
  )
  const rows = values.map(row => Array.from({length: width}, (_, index) => row[index] ?? ''))

  // A matrix retains blank/repeated provider headers and original numeric values.
  // CSV and TOON each contain a complete document, with no prose prefix.
  if (format === 'toon') return encode({columns, rows})

  function formatCell(value: unknown, index: number): string {
    if (value === '' || value === null || value === undefined) return ''
    if (index === 0 && fallbackHeaders[0] === 'Date') return formatDate(value)
    if (index === 0 || (index === 1 && fallbackHeaders[1] === 'Reference')) return String(value)
    return formatCurrency(value)
  }

  return formatOutput(
    rows.map((row, rowIndex) =>
      Object.fromEntries(
        row.map((value, index) => [
          `column${index}`,
          format === 'table' && !headerRows.has(values[rowIndex]) ? formatCell(value, index) : value,
        ]),
      ),
    ),
    columns.map((header, index) => ({key: `column${index}`, header})),
    format,
  )
}
