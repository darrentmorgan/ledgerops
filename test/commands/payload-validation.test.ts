import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest'
import InvoicesCreate from '../../src/commands/invoices/create.js'
import InvoicesUpdate from '../../src/commands/invoices/update.js'
import PaymentsCreate from '../../src/commands/payments/create.js'
import QuotesCreate from '../../src/commands/quotes/create.js'
import QuotesUpdate from '../../src/commands/quotes/update.js'
import CreditNotesCreate from '../../src/commands/credit-notes/create.js'
import CreditNotesUpdate from '../../src/commands/credit-notes/update.js'
import BankTransactionsCreate from '../../src/commands/bank-transactions/create.js'
import BankTransactionsUpdate from '../../src/commands/bank-transactions/update.js'
import ManualJournalsCreate from '../../src/commands/manual-journals/create.js'
import ManualJournalsUpdate from '../../src/commands/manual-journals/update.js'
import ItemsCreate from '../../src/commands/items/create.js'
import ItemsUpdate from '../../src/commands/items/update.js'
import type {CommandClass} from '../support/mutation-command-boundary.js'

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  resolve: vi.fn(),
  prompt: vi.fn(),
  createPayment: vi.fn(),
  createInvoices: vi.fn(),
}))
vi.mock('../../src/lib/profiles.js', () => ({
  getDefaultProfile: mocks.resolve,
  getProfileClientId: () => 'synthetic-client',
}))
vi.mock('../../src/lib/xero-client.js', () => ({withSingleAttempt: mocks.dispatch}))
vi.mock('node:readline/promises', () => ({createInterface: mocks.prompt}))

const root = mkdtempSync(join(tmpdir(), 'ledgerops-payload-validation-'))
writeFileSync(
  join(root, 'package.json'),
  JSON.stringify({
    name: 'synthetic-validation',
    version: '1.0.0',
    type: 'module',
    oclif: {bin: 'ledgerops', commands: join(process.cwd(), 'dist', 'commands')},
  }),
)
let nextFile = 0
function file(payload: unknown, raw = false): string {
  const path = join(root, `payload-${nextFile++}.json`)
  writeFileSync(path, raw ? String(payload) : JSON.stringify(payload))
  return path
}
async function run(command: CommandClass, args: string[]) {
  const stdout: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...values) => stdout.push(values.map(String).join(' ')))
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
  const exitCode = process.exitCode
  let error: Error | undefined
  try {
    await command.run(args, {root})
  } catch (caught) {
    error = caught as Error
  } finally {
    log.mockRestore()
    stderr.mockRestore()
    process.exitCode = exitCode
  }
  return {error, stdout: stdout.join('\n')}
}
afterAll(() => rmSync(root, {recursive: true, force: true}))
beforeEach(() => {
  vi.resetAllMocks()
  mocks.resolve.mockReturnValue('synthetic-profile')
  mocks.dispatch.mockImplementation(async (_profile, _client, operation) =>
    operation(
      {
        accountingApi: {
          createPayment: mocks.createPayment,
          createInvoices: mocks.createInvoices,
        },
      },
      'synthetic-tenant',
    ),
  )
})

const line = {description: 'Synthetic', quantity: 1, unitAmount: 1}
const contact = {contactID: 'synthetic-contact'}
const cases = [
  {
    name: 'invoices create',
    command: InvoicesCreate,
    good: {type: 'ACCREC', contact, lineItems: [line]},
    bad: [{contact: null}, {contact: {}}, {lineItems: [{}]}, {date: '2026-02-31'}, {dueDate: '2026-02-29'}],
  },
  {
    name: 'invoices update',
    command: InvoicesUpdate,
    good: {invoiceID: 'invoice'},
    bad: [{contact: null}, {lineItems: [{}]}, {dueDate: '1900-02-29'}],
  },
  {
    name: 'payments create',
    command: PaymentsCreate,
    good: {amount: 1, invoice: {invoiceID: 'invoice'}, account: {code: '090'}},
    bad: [
      {invoice: undefined},
      {invoice: null},
      {invoice: {}},
      {account: undefined},
      {account: null},
      {account: []},
      {prepayment: {}},
      {creditNote: null},
      {overpayment: 'invalid'},
      {date: '2026-02-31'},
    ],
  },
  {
    name: 'quotes create',
    command: QuotesCreate,
    good: {contact, lineItems: [line]},
    bad: [{contact: null}, {contact: undefined}, {lineItems: [{}]}, {expiryDate: '2026-04-31'}],
  },
  {
    name: 'quotes update',
    command: QuotesUpdate,
    good: {quoteID: 'quote'},
    bad: [{contact: {}}, {lineItems: [null]}, {date: '2026-02-29'}],
  },
  {
    name: 'credit notes create',
    command: CreditNotesCreate,
    good: {type: 'ACCRECCREDIT', contact, lineItems: [line]},
    bad: [{type: undefined}, {contact: null}, {lineItems: [{}]}, {date: '2026-04-31'}],
  },
  {
    name: 'credit notes update',
    command: CreditNotesUpdate,
    good: {creditNoteID: 'credit'},
    bad: [{contact: []}, {lineItems: [{}]}, {date: '2026-02-29'}],
  },
  {
    name: 'bank transactions create',
    command: BankTransactionsCreate,
    good: {type: 'SPEND', contact, bankAccount: {accountID: 'bank'}, lineItems: [line]},
    bad: [{bankAccount: undefined}, {bankAccount: null}, {bankAccount: {}}, {contact: {}}, {lineItems: [{}]}],
  },
  {
    name: 'bank transactions update',
    command: BankTransactionsUpdate,
    good: {bankTransactionID: 'bank'},
    bad: [{bankAccount: null}, {contact: {}}, {lineItems: [{}]}, {date: '2026-02-31'}],
  },
  {
    name: 'journals create',
    command: ManualJournalsCreate,
    good: {
      narration: 'Synthetic',
      journalLines: [
        {accountCode: '200', lineAmount: 1},
        {accountCode: '300', lineAmount: -1},
      ],
    },
    bad: [
      {journalLines: [{}, {}]},
      {journalLines: [{lineAmount: 1}, {accountCode: '300', lineAmount: -1}]},
      {date: '2026-02-31'},
    ],
  },
  {
    name: 'journals update',
    command: ManualJournalsUpdate,
    good: {
      manualJournalID: 'journal',
      narration: 'Synthetic',
      journalLines: [
        {accountCode: '200', lineAmount: 1},
        {accountCode: '300', lineAmount: -1},
      ],
    },
    bad: [{journalLines: [null, null]}, {date: '2026-02-31'}],
  },
  {
    name: 'items create',
    command: ItemsCreate,
    good: {code: 'ITEM', name: 'Synthetic'},
    bad: [{salesDetails: null}, {purchaseDetails: {unitPrice: 'invalid'}}],
  },
  {
    name: 'items update',
    command: ItemsUpdate,
    good: {itemID: 'item'},
    bad: [{salesDetails: null}, {purchaseDetails: {unitPrice: 'invalid'}}],
  },
]
for (const {name, command, good, bad} of cases) {
  describe(`${name} payload refusal`, () => {
    it.each(bad.map((changes, index) => ({changes, index})))(
      'refuses malformed file $index before preview or execute',
      async ({changes}) => {
        for (const execute of [[], ['--execute', '--yes']]) {
          mocks.resolve.mockClear()
          const output = await run(command, ['--json', '--file', file({...good, ...changes}), ...execute])
          expect(output.error?.message).toContain('Validation errors')
          expect(mocks.resolve).toHaveBeenCalledTimes(1)
          expect(mocks.dispatch).not.toHaveBeenCalled()
          expect(mocks.prompt).not.toHaveBeenCalled()
          expect(output.stdout).toBe('')
        }
      },
    )
    it.each(['1e400', '-1e400'])('refuses overflow %s in financial fields with zero dispatch', async overflow => {
      const changes = name.startsWith('payments')
        ? {amount: 'OVERFLOW'}
        : name.startsWith('journals')
          ? {
              journalLines: [
                {accountCode: '200', lineAmount: 'OVERFLOW'},
                {accountCode: '300', lineAmount: -1},
              ],
            }
          : name.startsWith('items')
            ? {salesDetails: {unitPrice: 'OVERFLOW'}}
            : {lineItems: [{description: 'Synthetic', quantity: 1, unitAmount: 'OVERFLOW'}]}
      const raw = JSON.stringify({...good, ...changes}).replace('"OVERFLOW"', overflow)
      for (const execute of [[], ['--execute']]) {
        const output = await run(command, ['--json', '--file', file(raw, true), ...execute])
        expect(output.error?.message).toContain('Validation errors')
        expect(mocks.dispatch).not.toHaveBeenCalled()
        expect(output.stdout).toBe('')
      }
    })
    it('refuses exponent overflow in SDK extras with zero dispatch', async () => {
      const raw = JSON.stringify({...good, currencyRate: 'OVERFLOW'}).replace('"OVERFLOW"', '1e400')
      for (const execute of [[], ['--execute']]) {
        const output = await run(command, ['--json', '--file', file(raw, true), ...execute])
        expect(output.error?.message).toContain('Validation errors')
        expect(mocks.dispatch).not.toHaveBeenCalled()
        expect(output.stdout).toBe('')
      }
    })
  })
}

describe('numeric flag refusal', () => {
  const lineFlags = [
    '--description',
    'Synthetic',
    '--quantity',
    '1',
    '--unit-amount',
    '1',
    '--account-code',
    '200',
    '--tax-type',
    'NONE',
  ]
  const commands = [
    {command: PaymentsCreate, args: ['--invoice-id', 'invoice', '--account-id', 'bank', '--amount', 'Infinity']},
    ...[InvoicesCreate, QuotesCreate, CreditNotesCreate, BankTransactionsCreate].flatMap(command =>
      ['--quantity', '--unit-amount'].map(flag => ({
        command,
        args: [
          '--contact-id',
          'contact',
          ...(command === InvoicesCreate ? ['--type', 'ACCREC'] : []),
          ...(command === BankTransactionsCreate ? ['--type', 'SPEND', '--bank-account-id', 'bank'] : []),
          ...lineFlags.map((value, index) => (lineFlags[index - 1] === flag ? 'Infinity' : value)),
        ],
      })),
    ),
    ...[ItemsCreate, ItemsUpdate].flatMap(command =>
      ['--sale-price', '--purchase-price'].map(flag => ({
        command,
        args: [
          '--code',
          'ITEM',
          '--name',
          'Synthetic',
          ...(command === ItemsUpdate ? ['--item-id', 'item'] : []),
          flag,
          'Infinity',
        ],
      })),
    ),
  ]
  it.each(commands)('refuses nonfinite flag case %# before preview or execute', async ({command, args}) => {
    for (const execute of [[], ['--execute']]) {
      const output = await run(command, ['--json', ...args, ...execute])
      expect(output.error?.message).toContain('Validation errors')
      expect(mocks.dispatch).not.toHaveBeenCalled()
      expect(output.stdout).toBe('')
    }
  })
})

describe('validated extended payloads', () => {
  it.each([
    {invoice: {invoiceNumber: 'INV-1'}},
    {creditNote: {creditNoteID: 'credit'}},
    {prepayment: {prepaymentID: 'pre'}},
    {overpayment: {overpaymentID: 'over'}},
    {invoiceNumber: 'INV-1'},
    {creditNoteNumber: 'CN-1'},
  ])('preserves and dispatches supported payment relationships %#', async relationship => {
    const path = file({
      amount: 10,
      code: '090',
      date: '2024-02-29',
      currencyRate: 1.5,
      isReconciled: true,
      reference: 'Synthetic',
      ...relationship,
    })
    const preview = await run(PaymentsCreate, ['--json', '--file', path])
    expect(preview.error).toBeUndefined()
    expect(mocks.dispatch).not.toHaveBeenCalled()
    const payload = JSON.parse(preview.stdout).payload
    expect(payload.account).toEqual({code: '090'})
    expect(payload.currencyRate).toBe(1.5)
    expect(payload.isReconciled).toBe(true)
    if ('invoiceNumber' in relationship) expect(payload.invoice).toEqual({invoiceNumber: 'INV-1'})
    else if ('creditNoteNumber' in relationship) expect(payload.creditNote).toEqual({creditNoteNumber: 'CN-1'})
    else for (const [key, value] of Object.entries(relationship)) expect(payload[key]).toEqual(value)
    mocks.createPayment.mockResolvedValue({body: {payments: [{paymentID: 'payment'}]}})
    const executed = await run(PaymentsCreate, ['--json', '--file', path, '--execute'])
    expect(executed.error).toBeUndefined()
    expect(mocks.createPayment).toHaveBeenCalledExactlyOnceWith('synthetic-tenant', payload)
  })
  it('preserves SDK invoice extras, description-only and item-code lines, and leap date', async () => {
    const payload = {
      type: 'ACCREC',
      contact: {name: 'Synthetic'},
      date: '2000-02-29',
      dueDate: '2000-03-31',
      brandingThemeID: 'theme',
      currencyRate: 1.2,
      url: 'https://example.com',
      lineItems: [
        {description: 'Note only'},
        {itemCode: 'ITEM', unitAmount: -10, quantity: 2, discountRate: 5, tracking: [{name: 'Region', option: 'East'}]},
      ],
    }
    const path = file(payload)
    const preview = await run(InvoicesCreate, ['--json', '--file', path])
    expect(preview.error).toBeUndefined()
    expect(JSON.parse(preview.stdout).payload).toEqual(payload)
    mocks.createInvoices.mockResolvedValue({body: {invoices: [{invoiceID: 'invoice'}]}})
    const executed = await run(InvoicesCreate, ['--json', '--file', path, '--execute'])
    expect(executed.error).toBeUndefined()
    expect(mocks.createInvoices).toHaveBeenCalledExactlyOnceWith('synthetic-tenant', {invoices: [payload]})
  })
  it('resolves the target before touching malformed payloads', async () => {
    mocks.resolve.mockImplementation(() => {
      throw new Error('synthetic target refusal')
    })
    const output = await run(PaymentsCreate, ['--json', '--file', join(root, 'missing.json'), '--execute'])
    expect(output.error?.message).toBe('synthetic target refusal')
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(output.stdout).toBe('')
  })
})
