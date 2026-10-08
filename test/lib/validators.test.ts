import {describe, it, expect} from 'vitest'
import {
  dateSchema,
  lineItemSchema,
  invoiceCreateSchema,
  contactCreateSchema,
  paymentCreateSchema,
  journalCreateSchema,
  itemCreateSchema,
  quoteCreateSchema,
  formatZodError,
  contactFileCreateSchema,
  contactFileUpdateSchema,
  invoiceFileCreateSchema,
  invoiceFileUpdateSchema,
  quoteFileCreateSchema,
  quoteFileUpdateSchema,
  bankTransactionFileCreateSchema,
  bankTransactionFileUpdateSchema,
  creditNoteFileCreateSchema,
  creditNoteFileUpdateSchema,
  paymentFileCreateSchema,
  itemFileCreateSchema,
  itemFileUpdateSchema,
  accountFileUpdateSchema,
  journalFileCreateSchema,
  journalFileUpdateSchema,
  trackingOptionsFileUpdateSchema,
} from '../../src/lib/validators.js'

describe('dateSchema', () => {
  it('accepts valid YYYY-MM-DD dates', () => {
    expect(dateSchema.safeParse('2025-01-15').success).toBe(true)
    expect(dateSchema.safeParse('2025-12-31').success).toBe(true)
  })

  it('rejects invalid date formats', () => {
    expect(dateSchema.safeParse('01-15-2025').success).toBe(false)
    expect(dateSchema.safeParse('2025/01/15').success).toBe(false)
    expect(dateSchema.safeParse('not-a-date').success).toBe(false)
    expect(dateSchema.safeParse('').success).toBe(false)
  })
})

describe('lineItemSchema', () => {
  const validLineItem = {
    description: 'Consulting',
    quantity: 10,
    unitAmount: 150,
    accountCode: '200',
    taxType: 'OUTPUT2',
  }

  it('accepts valid line items', () => {
    expect(lineItemSchema.safeParse(validLineItem).success).toBe(true)
  })

  it('accepts line items with optional fields', () => {
    expect(lineItemSchema.safeParse({...validLineItem, itemCode: 'CONS'}).success).toBe(true)
  })

  it('rejects missing description', () => {
    const {description: _, ...noDesc} = validLineItem
    expect(lineItemSchema.safeParse(noDesc).success).toBe(false)
  })

  it('rejects negative quantity', () => {
    expect(lineItemSchema.safeParse({...validLineItem, quantity: -1}).success).toBe(false)
  })

  it('rejects negative unit amount', () => {
    expect(lineItemSchema.safeParse({...validLineItem, unitAmount: -10}).success).toBe(false)
  })
})

describe('invoiceCreateSchema', () => {
  const validInvoice = {
    contactId: 'abc-123',
    type: 'ACCREC' as const,
    lineItems: [
      {
        description: 'Consulting',
        quantity: 10,
        unitAmount: 150,
        accountCode: '200',
        taxType: 'OUTPUT2',
      },
    ],
  }

  it('accepts valid invoice', () => {
    expect(invoiceCreateSchema.safeParse(validInvoice).success).toBe(true)
  })

  it('accepts ACCPAY type', () => {
    expect(invoiceCreateSchema.safeParse({...validInvoice, type: 'ACCPAY'}).success).toBe(true)
  })

  it('rejects invalid type', () => {
    expect(invoiceCreateSchema.safeParse({...validInvoice, type: 'INVALID'}).success).toBe(false)
  })

  it('rejects empty line items', () => {
    expect(invoiceCreateSchema.safeParse({...validInvoice, lineItems: []}).success).toBe(false)
  })

  it('rejects missing contact ID', () => {
    const {contactId: _, ...noContact} = validInvoice
    expect(invoiceCreateSchema.safeParse(noContact).success).toBe(false)
  })

  it('accepts optional date and reference', () => {
    const result = invoiceCreateSchema.safeParse({
      ...validInvoice,
      date: '2025-06-15',
      reference: 'REF-001',
    })
    expect(result.success).toBe(true)
  })
})

describe('contactCreateSchema', () => {
  it('accepts name only', () => {
    expect(contactCreateSchema.safeParse({name: 'Acme Corp'}).success).toBe(true)
  })

  it('accepts name with email and phone', () => {
    expect(
      contactCreateSchema.safeParse({
        name: 'Acme Corp',
        email: 'info@acme.com',
        phone: '+1234567890',
      }).success,
    ).toBe(true)
  })

  it('rejects empty name', () => {
    expect(contactCreateSchema.safeParse({name: ''}).success).toBe(false)
  })

  it('rejects invalid email', () => {
    expect(contactCreateSchema.safeParse({name: 'Acme', email: 'not-an-email'}).success).toBe(false)
  })
})

describe('paymentCreateSchema', () => {
  it('accepts valid payment', () => {
    expect(
      paymentCreateSchema.safeParse({
        invoiceId: 'inv-123',
        accountId: 'acc-456',
        amount: 500,
      }).success,
    ).toBe(true)
  })

  it('rejects zero amount', () => {
    expect(
      paymentCreateSchema.safeParse({
        invoiceId: 'inv-123',
        accountId: 'acc-456',
        amount: 0,
      }).success,
    ).toBe(false)
  })

  it('rejects negative amount', () => {
    expect(
      paymentCreateSchema.safeParse({
        invoiceId: 'inv-123',
        accountId: 'acc-456',
        amount: -100,
      }).success,
    ).toBe(false)
  })
})

describe('journalCreateSchema', () => {
  it('accepts valid journal with balanced lines', () => {
    expect(
      journalCreateSchema.safeParse({
        narration: 'Test journal',
        manualJournalLines: [
          {accountCode: '200', lineAmount: 100},
          {accountCode: '400', lineAmount: -100},
        ],
      }).success,
    ).toBe(true)
  })

  it('rejects fewer than 2 lines', () => {
    expect(
      journalCreateSchema.safeParse({
        narration: 'Test journal',
        manualJournalLines: [{accountCode: '200', lineAmount: 100}],
      }).success,
    ).toBe(false)
  })

  it('rejects empty narration', () => {
    expect(
      journalCreateSchema.safeParse({
        narration: '',
        manualJournalLines: [
          {accountCode: '200', lineAmount: 100},
          {accountCode: '400', lineAmount: -100},
        ],
      }).success,
    ).toBe(false)
  })
})

describe('formatZodError', () => {
  it('formats validation errors', () => {
    const result = contactCreateSchema.safeParse({name: '', email: 'bad'})
    expect(result.success).toBe(false)
    if (!result.success) {
      const formatted = formatZodError(result.error)
      expect(formatted).toContain('name')
      expect(formatted).toContain('email')
    }
  })
})

// File-mode passthrough schema tests
describe('contactFileCreateSchema', () => {
  it('validates required name field', () => {
    expect(contactFileCreateSchema.safeParse({name: 'Acme Corp'}).success).toBe(true)
  })

  it('rejects missing name', () => {
    expect(contactFileCreateSchema.safeParse({}).success).toBe(false)
  })

  it('passes through extra/nested fields untouched', () => {
    const data = {
      name: 'Acme Corp',
      phones: [{phoneType: 'MOBILE', phoneNumber: '+1234567890'}],
      addresses: [{addressType: 'STREET', city: 'Auckland'}],
      contactPersons: [{firstName: 'John', lastName: 'Doe'}],
      taxNumber: '123-456-789',
    }
    const result = contactFileCreateSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.phones).toEqual(data.phones)
      expect(result.data.addresses).toEqual(data.addresses)
      expect(result.data.contactPersons).toEqual(data.contactPersons)
      expect(result.data.taxNumber).toBe('123-456-789')
    }
  })
})

describe('contactFileUpdateSchema', () => {
  it('validates required contactID field', () => {
    expect(contactFileUpdateSchema.safeParse({contactID: 'abc-123'}).success).toBe(true)
  })

  it('rejects missing contactID', () => {
    expect(contactFileUpdateSchema.safeParse({name: 'Acme'}).success).toBe(false)
  })

  it('passes through all nested fields', () => {
    const data = {
      contactID: 'abc-123',
      name: 'Updated Name',
      phones: [{phoneType: 'DEFAULT', phoneNumber: '555-0100'}],
      addresses: [{addressType: 'POBOX', postalCode: '90210'}],
    }
    const result = contactFileUpdateSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.phones).toEqual(data.phones)
      expect(result.data.addresses).toEqual(data.addresses)
    }
  })
})

describe('invoiceFileCreateSchema', () => {
  it('validates required type and lineItems', () => {
    const data = {
      type: 'ACCREC',
      contact: {contactID: 'abc-123'},
      lineItems: [{description: 'Consulting', quantity: 10, unitAmount: 150}],
    }
    expect(invoiceFileCreateSchema.safeParse(data).success).toBe(true)
  })

  it('rejects missing type', () => {
    expect(
      invoiceFileCreateSchema.safeParse({
        lineItems: [{description: 'x'}],
      }).success,
    ).toBe(false)
  })

  it('rejects empty lineItems', () => {
    expect(invoiceFileCreateSchema.safeParse({type: 'ACCREC', lineItems: []}).success).toBe(false)
  })

  it('passes through nested line item fields', () => {
    const data = {
      type: 'ACCPAY',
      contact: {contactID: 'abc-123'},
      lineItems: [
        {
          description: 'Widget',
          quantity: 5,
          unitAmount: 20,
          accountCode: '200',
          tracking: [{name: 'Region', option: 'East'}],
        },
      ],
      dueDate: '2025-07-01',
      brandingThemeID: 'theme-123',
    }
    const result = invoiceFileCreateSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.brandingThemeID).toBe('theme-123')
      expect(result.data.dueDate).toBe('2025-07-01')
    }
  })
})

describe('invoiceFileUpdateSchema', () => {
  it('validates required invoiceID', () => {
    expect(invoiceFileUpdateSchema.safeParse({invoiceID: 'inv-123'}).success).toBe(true)
  })

  it('rejects missing invoiceID', () => {
    expect(invoiceFileUpdateSchema.safeParse({reference: 'REF'}).success).toBe(false)
  })
})

describe('quoteFileCreateSchema', () => {
  it('validates required lineItems', () => {
    const data = {
      contact: {contactID: 'abc-123'},
      lineItems: [{description: 'Service', quantity: 1, unitAmount: 100}],
    }
    expect(quoteFileCreateSchema.safeParse(data).success).toBe(true)
  })

  it('rejects empty lineItems', () => {
    expect(quoteFileCreateSchema.safeParse({lineItems: []}).success).toBe(false)
  })

  it('passes through extra fields', () => {
    const data = {
      contact: {contactID: 'abc-123'},
      lineItems: [{description: 'x', quantity: 1, unitAmount: 50}],
      title: 'My Quote',
      terms: 'Net 30',
      currencyCode: 'NZD',
    }
    const result = quoteFileCreateSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.currencyCode).toBe('NZD')
    }
  })
})

describe('quoteFileUpdateSchema', () => {
  it('validates required quoteID', () => {
    expect(quoteFileUpdateSchema.safeParse({quoteID: 'q-123'}).success).toBe(true)
  })

  it('rejects missing quoteID', () => {
    expect(quoteFileUpdateSchema.safeParse({title: 'x'}).success).toBe(false)
  })
})

describe('bankTransactionFileCreateSchema', () => {
  it('validates required type and lineItems', () => {
    const data = {
      type: 'RECEIVE',
      bankAccount: {accountID: 'bank-1'},
      contact: {contactID: 'c-1'},
      lineItems: [{description: 'Payment', quantity: 1, unitAmount: 500}],
    }
    expect(bankTransactionFileCreateSchema.safeParse(data).success).toBe(true)
  })

  it('rejects invalid type', () => {
    expect(
      bankTransactionFileCreateSchema.safeParse({
        type: 'INVALID',
        lineItems: [{description: 'x'}],
      }).success,
    ).toBe(false)
  })
})

describe('bankTransactionFileUpdateSchema', () => {
  it('validates required bankTransactionID', () => {
    expect(bankTransactionFileUpdateSchema.safeParse({bankTransactionID: 'bt-123'}).success).toBe(true)
  })

  it('rejects missing bankTransactionID', () => {
    expect(bankTransactionFileUpdateSchema.safeParse({}).success).toBe(false)
  })
})

describe('creditNoteFileCreateSchema', () => {
  it('validates required lineItems', () => {
    const data = {
      type: 'ACCRECCREDIT',
      contact: {contactID: 'c-1'},
      lineItems: [{description: 'Refund', quantity: 1, unitAmount: 100}],
    }
    expect(creditNoteFileCreateSchema.safeParse(data).success).toBe(true)
  })

  it('rejects empty lineItems', () => {
    expect(creditNoteFileCreateSchema.safeParse({lineItems: []}).success).toBe(false)
  })
})

describe('creditNoteFileUpdateSchema', () => {
  it('validates required creditNoteID', () => {
    expect(creditNoteFileUpdateSchema.safeParse({creditNoteID: 'cn-123'}).success).toBe(true)
  })

  it('rejects missing creditNoteID', () => {
    expect(creditNoteFileUpdateSchema.safeParse({}).success).toBe(false)
  })
})

describe('paymentFileCreateSchema', () => {
  it('validates required amount', () => {
    const data = {
      invoice: {invoiceID: 'inv-1'},
      account: {accountID: 'acc-1'},
      amount: 250.5,
    }
    expect(paymentFileCreateSchema.safeParse(data).success).toBe(true)
  })

  it('rejects zero amount', () => {
    expect(paymentFileCreateSchema.safeParse({amount: 0}).success).toBe(false)
  })

  it('passes through nested objects', () => {
    const data = {
      invoice: {invoiceID: 'inv-1'},
      account: {accountID: 'acc-1', code: 'BANK'},
      amount: 100,
      reference: 'PAY-001',
    }
    const result = paymentFileCreateSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.invoice).toEqual({invoiceID: 'inv-1'})
      expect(result.data.reference).toBe('PAY-001')
    }
  })
})

describe('itemFileCreateSchema', () => {
  it('validates required code and name', () => {
    expect(itemFileCreateSchema.safeParse({code: 'WIDGET', name: 'Widget'}).success).toBe(true)
  })

  it('rejects missing code', () => {
    expect(itemFileCreateSchema.safeParse({name: 'Widget'}).success).toBe(false)
  })

  it('rejects missing name', () => {
    expect(itemFileCreateSchema.safeParse({code: 'WIDGET'}).success).toBe(false)
  })

  it('passes through salesDetails and purchaseDetails', () => {
    const data = {
      code: 'WIDGET',
      name: 'Widget',
      salesDetails: {unitPrice: 29.99, accountCode: '200', taxType: 'OUTPUT2'},
      purchaseDetails: {unitPrice: 15.0, cOGSAccountCode: '500'},
    }
    const result = itemFileCreateSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.salesDetails).toEqual(data.salesDetails)
      expect(result.data.purchaseDetails).toEqual(data.purchaseDetails)
    }
  })
})

describe('itemFileUpdateSchema', () => {
  it('validates required itemID', () => {
    expect(itemFileUpdateSchema.safeParse({itemID: 'item-123'}).success).toBe(true)
  })

  it('rejects missing itemID', () => {
    expect(itemFileUpdateSchema.safeParse({code: 'WIDGET'}).success).toBe(false)
  })
})

describe('accountFileUpdateSchema', () => {
  it('validates required accountID', () => {
    expect(accountFileUpdateSchema.safeParse({accountID: 'acc-123'}).success).toBe(true)
  })

  it('rejects missing accountID', () => {
    expect(accountFileUpdateSchema.safeParse({name: 'Sales'}).success).toBe(false)
  })

  it('passes through extra fields', () => {
    const data = {
      accountID: 'acc-123',
      name: 'Sales',
      type: 'REVENUE',
      bankAccountNumber: '123456',
    }
    const result = accountFileUpdateSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.bankAccountNumber).toBe('123456')
    }
  })
})

describe('journalFileCreateSchema', () => {
  it('validates required narration and journalLines', () => {
    const data = {
      narration: 'Month end adjustment',
      journalLines: [
        {lineAmount: 100, accountCode: '200'},
        {lineAmount: -100, accountCode: '400'},
      ],
    }
    expect(journalFileCreateSchema.safeParse(data).success).toBe(true)
  })

  it('rejects missing narration', () => {
    expect(
      journalFileCreateSchema.safeParse({
        journalLines: [
          {lineAmount: 100, accountCode: '200'},
          {lineAmount: -100, accountCode: '400'},
        ],
      }).success,
    ).toBe(false)
  })

  it('rejects fewer than 2 journalLines', () => {
    expect(
      journalFileCreateSchema.safeParse({
        narration: 'Test',
        journalLines: [{lineAmount: 100, accountCode: '200'}],
      }).success,
    ).toBe(false)
  })

  it('passes through extra fields on journal lines', () => {
    const data = {
      narration: 'Test',
      journalLines: [
        {lineAmount: 100, accountCode: '200', taxType: 'OUTPUT2', description: 'Debit'},
        {lineAmount: -100, accountCode: '400', taxType: 'INPUT2', trackingCategories: [{name: 'Dept'}]},
      ],
    }
    const result = journalFileCreateSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data.journalLines[1] as Record<string, unknown>).trackingCategories).toEqual([{name: 'Dept'}])
    }
  })
})

describe('journalFileUpdateSchema', () => {
  it('validates required manualJournalID, narration, and journalLines', () => {
    const data = {
      manualJournalID: 'mj-123',
      narration: 'Updated',
      journalLines: [
        {lineAmount: 50, accountCode: '200'},
        {lineAmount: -50, accountCode: '400'},
      ],
    }
    expect(journalFileUpdateSchema.safeParse(data).success).toBe(true)
  })

  it('rejects missing manualJournalID', () => {
    expect(
      journalFileUpdateSchema.safeParse({
        narration: 'Test',
        journalLines: [
          {lineAmount: 100, accountCode: '200'},
          {lineAmount: -100, accountCode: '400'},
        ],
      }).success,
    ).toBe(false)
  })
})

describe('trackingOptionsFileUpdateSchema', () => {
  it('validates required trackingCategoryId and options', () => {
    const data = {
      trackingCategoryId: 'tc-123',
      options: [{trackingOptionId: 'to-1', name: 'Updated'}],
    }
    expect(trackingOptionsFileUpdateSchema.safeParse(data).success).toBe(true)
  })

  it('rejects missing trackingCategoryId', () => {
    expect(
      trackingOptionsFileUpdateSchema.safeParse({
        options: [{trackingOptionId: 'to-1'}],
      }).success,
    ).toBe(false)
  })

  it('rejects options without trackingOptionId', () => {
    expect(
      trackingOptionsFileUpdateSchema.safeParse({
        trackingCategoryId: 'tc-123',
        options: [{name: 'Test'}],
      }).success,
    ).toBe(false)
  })

  it('passes through extra fields on options', () => {
    const data = {
      trackingCategoryId: 'tc-123',
      options: [{trackingOptionId: 'to-1', name: 'North', sortOrder: 1}],
    }
    const result = trackingOptionsFileUpdateSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data.options[0] as Record<string, unknown>).sortOrder).toBe(1)
    }
  })
})

describe('finite amounts and actual calendar dates', () => {
  it.each(['2024-02-29', '2000-02-29', '2026-04-30'])('accepts calendar date %s', date => {
    expect(dateSchema.safeParse(date).success).toBe(true)
  })
  it.each([
    '2026-02-31',
    '2026-02-29',
    '1900-02-29',
    '2026-04-31',
    '2026-00-01',
    '2026-13-01',
    '2026-01-00',
    '0000-01-01',
  ])('refuses impossible calendar date %s', date => {
    expect(dateSchema.safeParse(date).success).toBe(false)
  })
  it.each([Infinity, -Infinity, NaN])('refuses nonfinite flag value %s', value => {
    expect(paymentCreateSchema.safeParse({invoiceId: 'inv', accountId: 'bank', amount: value}).success).toBe(false)
    const line = {description: 'Synthetic', quantity: 1, unitAmount: 1, accountCode: '200', taxType: 'NONE'}
    for (const field of ['quantity', 'unitAmount']) {
      expect(lineItemSchema.safeParse({...line, [field]: value}).success).toBe(false)
    }
    expect(
      journalCreateSchema.safeParse({
        narration: 'Synthetic',
        manualJournalLines: [
          {accountCode: '200', lineAmount: value},
          {accountCode: '300', lineAmount: 1},
        ],
      }).success,
    ).toBe(false)
    for (const field of ['salesDetails', 'purchaseDetails']) {
      expect(itemCreateSchema.safeParse({code: 'ITEM', name: 'Synthetic', [field]: {unitPrice: value}}).success).toBe(
        false,
      )
    }
  })
  it('checks quote flag dates too', () => {
    expect(
      quoteCreateSchema.safeParse({
        contactId: 'contact',
        date: '2026-02-31',
        lineItems: [{description: 'Synthetic', quantity: 1, unitAmount: 1, accountCode: '200', taxType: 'NONE'}],
      }).success,
    ).toBe(false)
  })
})

describe('minimum file relationships and line values', () => {
  const documents = [
    {schema: invoiceFileCreateSchema, payload: {type: 'ACCREC'}},
    {schema: quoteFileCreateSchema, payload: {}},
    {schema: creditNoteFileCreateSchema, payload: {type: 'ACCRECCREDIT'}},
    {schema: bankTransactionFileCreateSchema, payload: {type: 'SPEND', bankAccount: {code: '090'}}},
  ]
  for (const {schema, payload} of documents) {
    it(`requires contact and meaningful lines for ${JSON.stringify(payload)}`, () => {
      const good = {...payload, contact: {name: 'Synthetic'}, lineItems: [{description: 'Note only'}]}
      expect(schema.safeParse(good).success).toBe(true)
      for (const contact of [undefined, null, {}, [], 'contact', {contactID: null}, {contactID: ' '}, {name: ''}]) {
        expect(schema.safeParse({...good, contact}).success).toBe(false)
      }
      for (const line of [{}, null, [], {description: ''}, {quantity: 1, unitAmount: 10}]) {
        expect(schema.safeParse({...good, lineItems: [line]}).success).toBe(false)
      }
      expect(schema.safeParse({...good, lineItems: [{itemCode: 'ITEM'}]}).success).toBe(true)
      expect(schema.safeParse({...good, contact: undefined, contactId: 'contact'}).success).toBe(true)
      // A valid alias cannot hide a malformed nested relationship.
      expect(schema.safeParse({...good, contact: null, contactId: 'contact'}).success).toBe(false)
    })
  }
  it.each(['invoice', 'creditNote', 'prepayment', 'overpayment', 'account'])(
    'refuses malformed payment relationship %s even beside valid relationships',
    field => {
      const good = {amount: 1, invoice: {invoiceID: 'inv'}, account: {code: '090'}}
      for (const malformed of [null, {}, [], 1, 'id']) {
        expect(paymentFileCreateSchema.safeParse({...good, [field]: malformed}).success).toBe(false)
      }
    },
  )
  it('requires both payment account and a supported payable relationship', () => {
    expect(paymentFileCreateSchema.safeParse({amount: 1}).success).toBe(false)
    expect(paymentFileCreateSchema.safeParse({amount: 1, account: {code: '090'}}).success).toBe(false)
    expect(paymentFileCreateSchema.safeParse({amount: 1, invoice: {invoiceID: 'inv'}}).success).toBe(false)
    for (const relationship of [
      {invoice: {invoiceID: 'inv'}},
      {invoice: {invoiceNumber: 'INV-1'}},
      {creditNote: {creditNoteID: 'credit'}},
      {creditNote: {creditNoteNumber: 'CN-1'}},
      {prepayment: {prepaymentID: 'pre'}},
      {overpayment: {overpaymentID: 'over'}},
      {invoiceId: 'inv'},
      {invoiceNumber: 'INV-1'},
      {creditNoteNumber: 'CN-1'},
    ]) {
      const payload = {amount: 1, account: {code: '090', name: 'Synthetic bank'}, ...relationship}
      expect(paymentFileCreateSchema.parse(payload)).toEqual(payload)
    }
  })
  it('validates fields supplied by partial updates without requiring omitted relationships', () => {
    for (const [schema, id] of [
      [invoiceFileUpdateSchema, 'invoiceID'],
      [quoteFileUpdateSchema, 'quoteID'],
      [creditNoteFileUpdateSchema, 'creditNoteID'],
      [bankTransactionFileUpdateSchema, 'bankTransactionID'],
    ] as const) {
      expect(schema.safeParse({[id]: 'existing', status: 'VOIDED'}).success).toBe(true)
      for (const changes of [
        {contact: null},
        {contact: {}},
        {lineItems: [{}]},
        {lineItems: null},
        {lineItems: []},
        {date: '2026-02-31'},
        {lineItems: [{description: 'Synthetic', taxAmount: Infinity}]},
      ]) {
        expect(schema.safeParse({[id]: 'existing', ...changes}).success).toBe(false)
      }
      const extended = {
        [id]: 'existing',
        contact: {name: 'Synthetic'},
        date: '2024-02-29',
        lineItems: [{lineItemID: 'line', tracking: [{name: 'Region', option: 'East'}]}],
        url: 'https://example.com',
      }
      expect(schema.parse(extended)).toEqual(extended)
    }
  })
  it('checks nested SDK numeric extensions without removing them', () => {
    const good = {
      type: 'ACCREC',
      contact: {name: 'Synthetic'},
      date: '2024-02-29',
      expectedPaymentDate: '2024-03-01T00:00:00',
      currencyRate: 1.2,
      brandingThemeID: 'theme',
      lineItems: [
        {
          itemCode: 'ITEM',
          quantity: 0,
          unitAmount: -10,
          taxAmount: -1,
          discountRate: 5,
          tracking: [{name: 'Region', option: 'East'}],
          taxBreakdown: [{taxAmount: 2}],
        },
      ],
    }
    expect(invoiceFileCreateSchema.parse(good)).toEqual(good)
    expect(invoiceFileCreateSchema.safeParse({...good, currencyRate: Infinity}).success).toBe(false)
    expect(invoiceFileCreateSchema.safeParse({...good, expectedPaymentDate: '2026-02-31T00:00:00'}).success).toBe(false)
    expect(
      invoiceFileCreateSchema.safeParse({
        ...good,
        lineItems: [{description: 'Synthetic', taxBreakdown: [{taxAmount: Infinity}]}],
      }).success,
    ).toBe(false)
    const overflow = JSON.parse('{"amount":1e400,"invoice":{"invoiceID":"inv"},"account":{"code":"090"}}')
    expect(paymentFileCreateSchema.safeParse(overflow).success).toBe(false)
  })
  it('requires journal amounts and account relationships while preserving extensions', () => {
    const good = {
      narration: 'Synthetic',
      journalLines: [
        {lineAmount: 1, accountID: 'account', tracking: [{name: 'Region', option: 'East'}]},
        {lineAmount: -1, accountCode: '200'},
        {isBlank: true},
      ],
    }
    expect(journalFileCreateSchema.parse(good)).toEqual(good)
    for (const line of [{}, null, {accountCode: '200'}, {lineAmount: 1}, {lineAmount: Infinity, accountCode: '200'}]) {
      expect(journalFileCreateSchema.safeParse({...good, journalLines: [line, good.journalLines[1]]}).success).toBe(
        false,
      )
      expect(
        journalFileUpdateSchema.safeParse({
          ...good,
          manualJournalID: 'journal',
          journalLines: [line, good.journalLines[1]],
        }).success,
      ).toBe(false)
    }
  })
  it('checks item prices without requiring them for account-only changes', () => {
    for (const schema of [itemFileCreateSchema, itemFileUpdateSchema]) {
      const good = {code: 'ITEM', name: 'Synthetic', itemID: 'item', purchaseDetails: {cOGSAccountCode: '500'}}
      expect(schema.parse(good)).toEqual(good)
      expect(schema.safeParse({...good, salesDetails: {unitPrice: Infinity}}).success).toBe(false)
      expect(schema.safeParse({...good, purchaseDetails: null}).success).toBe(false)
    }
  })
})
