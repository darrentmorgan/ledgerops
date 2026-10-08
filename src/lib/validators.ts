import {z} from 'zod'

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
  .refine(value => {
    const [year, month, day] = value.split('-').map(Number)
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
  }, 'Date must be a valid calendar date')

export const lineItemSchema = z.object({
  description: z.string().min(1, 'Description is required'),
  quantity: z.number().finite().positive('Quantity must be positive'),
  unitAmount: z.number().finite().nonnegative('Unit amount must be non-negative'),
  accountCode: z.string().min(1, 'Account code is required'),
  taxType: z.string().min(1, 'Tax type is required'),
  itemCode: z.string().optional(),
  tracking: z
    .array(
      z.object({
        name: z.string(),
        option: z.string(),
        trackingCategoryID: z.string(),
      }),
    )
    .max(2)
    .optional(),
})

export const invoiceCreateSchema = z.object({
  contactId: z.string().min(1, 'Contact ID is required'),
  type: z.enum(['ACCREC', 'ACCPAY']),
  lineItems: z.array(lineItemSchema).min(1, 'At least one line item is required'),
  date: dateSchema.optional(),
  reference: z.string().optional(),
})

export const invoiceUpdateSchema = z.object({
  invoiceId: z.string().min(1, 'Invoice ID is required'),
  contactId: z.string().optional(),
  lineItems: z.array(lineItemSchema).min(1).optional(),
  date: dateSchema.optional(),
  dueDate: dateSchema.optional(),
  reference: z.string().optional(),
})

export const contactCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email format').optional(),
  phone: z.string().optional(),
})

export const contactUpdateSchema = z.object({
  contactId: z.string().min(1, 'Contact ID is required'),
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email format').optional(),
  phone: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  address: z
    .object({
      addressLine1: z.string(),
      addressLine2: z.string().optional(),
      city: z.string().optional(),
      region: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
    })
    .optional(),
})

export const quoteCreateSchema = z.object({
  contactId: z.string().min(1, 'Contact ID is required'),
  lineItems: z.array(lineItemSchema).min(1, 'At least one line item is required'),
  title: z.string().optional(),
  summary: z.string().optional(),
  terms: z.string().optional(),
  reference: z.string().optional(),
  quoteNumber: z.string().optional(),
  date: dateSchema.optional(),
})

export const quoteUpdateSchema = z.object({
  quoteId: z.string().min(1, 'Quote ID is required'),
  contactId: z.string().optional(),
  lineItems: z.array(lineItemSchema).min(1).optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  terms: z.string().optional(),
  reference: z.string().optional(),
  quoteNumber: z.string().optional(),
  date: dateSchema.optional(),
  expiryDate: dateSchema.optional(),
})

export const creditNoteCreateSchema = z.object({
  contactId: z.string().min(1, 'Contact ID is required'),
  lineItems: z.array(lineItemSchema).min(1, 'At least one line item is required'),
  reference: z.string().optional(),
})

export const creditNoteUpdateSchema = z.object({
  creditNoteId: z.string().min(1, 'Credit note ID is required'),
  contactId: z.string().optional(),
  lineItems: z.array(lineItemSchema).min(1).optional(),
  date: dateSchema.optional(),
  reference: z.string().optional(),
})

export const journalLineSchema = z.object({
  accountCode: z.string().min(1, 'Account code is required'),
  lineAmount: z.number().finite(),
  description: z.string().optional(),
  taxType: z.string().optional(),
})

export const journalCreateSchema = z.object({
  narration: z.string().min(1, 'Narration is required'),
  manualJournalLines: z.array(journalLineSchema).min(2, 'At least two journal lines are required'),
  date: dateSchema.optional(),
  lineAmountTypes: z.enum(['EXCLUSIVE', 'INCLUSIVE', 'NO_TAX']).optional(),
  status: z.enum(['DRAFT', 'POSTED', 'DELETED', 'VOIDED', 'ARCHIVED']).optional(),
  url: z.string().url().optional(),
  showOnCashBasisReports: z.boolean().optional(),
})

export const journalUpdateSchema = z.object({
  manualJournalID: z.string().min(1, 'Manual journal ID is required'),
  narration: z.string().min(1, 'Narration is required'),
  manualJournalLines: z.array(journalLineSchema).min(2, 'At least two journal lines are required'),
  date: dateSchema.optional(),
  lineAmountTypes: z.enum(['EXCLUSIVE', 'INCLUSIVE', 'NO_TAX']).optional(),
  status: z.enum(['DRAFT', 'POSTED', 'DELETED', 'VOIDED', 'ARCHIVED']).optional(),
  url: z.string().url().optional(),
  showOnCashBasisReports: z.boolean().optional(),
})

export const bankTransactionCreateSchema = z.object({
  type: z.enum(['RECEIVE', 'SPEND']),
  bankAccountId: z.string().min(1, 'Bank account ID is required'),
  contactId: z.string().min(1, 'Contact ID is required'),
  lineItems: z.array(lineItemSchema).min(1, 'At least one line item is required'),
  date: dateSchema.optional(),
  reference: z.string().optional(),
})

export const bankTransactionUpdateSchema = z.object({
  bankTransactionId: z.string().min(1, 'Bank transaction ID is required'),
  contactId: z.string().optional(),
  lineItems: z.array(lineItemSchema).min(1).optional(),
  type: z.enum(['RECEIVE', 'SPEND']).optional(),
  date: dateSchema.optional(),
  reference: z.string().optional(),
})

export const paymentCreateSchema = z.object({
  invoiceId: z.string().min(1, 'Invoice ID is required'),
  accountId: z.string().min(1, 'Account ID is required'),
  amount: z.number().finite().positive('Amount must be positive'),
  date: dateSchema.optional(),
  reference: z.string().optional(),
})

export const itemCreateSchema = z.object({
  code: z.string().min(1, 'Code is required'),
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  purchaseDescription: z.string().optional(),
  isTrackedAsInventory: z.boolean().optional(),
  inventoryAssetAccountCode: z.string().optional(),
  salesDetails: z
    .object({
      unitPrice: z.number().finite(),
      accountCode: z.string().optional(),
      taxType: z.string().optional(),
    })
    .optional(),
  purchaseDetails: z
    .object({
      unitPrice: z.number().finite(),
      accountCode: z.string().optional(),
      taxType: z.string().optional(),
    })
    .optional(),
})

export const itemUpdateSchema = itemCreateSchema.extend({
  itemId: z.string().min(1, 'Item ID is required'),
})

export const accountUpdateSchema = z.object({
  accountId: z.string().min(1, 'Account ID is required'),
  name: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  taxType: z.string().optional(),
  enablePaymentsToAccount: z.boolean().optional(),
})

export const trackingCategoryCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
})

export const trackingCategoryUpdateSchema = z.object({
  trackingCategoryId: z.string().min(1, 'Tracking category ID is required'),
  name: z.string().optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
})

export const trackingOptionsCreateSchema = z.object({
  trackingCategoryId: z.string().min(1, 'Tracking category ID is required'),
  optionNames: z.array(z.string().min(1)).min(1).max(10),
})

export const trackingOptionsUpdateSchema = z.object({
  trackingCategoryId: z.string().min(1, 'Tracking category ID is required'),
  options: z
    .array(
      z.object({
        trackingOptionId: z.string().min(1),
        name: z.string().optional(),
        status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
      }),
    )
    .min(1)
    .max(10),
})

// File mode validates minimum relationships and values, preserving SDK extensions.
const nonempty = z.string().refine(value => value.trim().length > 0, 'Must not be blank')
const finite = z.number().finite()

// SDK date fields can also carry ISO timestamps. Check their calendar component
// explicitly: Date.parse alone normalizes impossible dates such as February 31.
const fileDateSchema = z.string().refine(value => {
  if (dateSchema.safeParse(value).success) return true
  return (
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(value) &&
    dateSchema.safeParse(value.slice(0, 10)).success &&
    Number.isFinite(Date.parse(value))
  )
}, 'Date must be a valid calendar date or ISO timestamp')

function relationship(fields: string[]) {
  return z
    .object(Object.fromEntries(fields.map(field => [field, nonempty.optional()])))
    .passthrough()
    .refine(data => fields.some(field => data[field] !== undefined), `Requires ${fields.join(' or ')}`)
}

const contactRelationship = relationship(['contactID', 'name', 'contactNumber'])
const accountRelationship = relationship(['accountID', 'code'])
const contactFields = {
  contact: contactRelationship.optional(),
  contactID: nonempty.optional(),
  contactId: nonempty.optional(),
}
const documentDates = {
  date: fileDateSchema.optional(),
  dueDate: fileDateSchema.optional(),
  expectedPaymentDate: fileDateSchema.optional(),
  plannedPaymentDate: fileDateSchema.optional(),
  expiryDate: fileDateSchema.optional(),
}

const fileLineItemFields = {
  description: nonempty.optional(),
  itemCode: nonempty.optional(),
  quantity: finite.optional(),
  unitAmount: finite.optional(),
  lineAmount: finite.optional(),
  taxAmount: finite.optional(),
  discountRate: finite.optional(),
  discountAmount: finite.optional(),
}
// Xero supports description-only lines and lines populated from an ItemCode.
const fileLineItemSchema = z
  .object(fileLineItemFields)
  .passthrough()
  .refine(
    line => line.description !== undefined || line.itemCode !== undefined,
    'Line requires a description or itemCode',
  )
const fileUpdateLineItemSchema = z
  .object({
    ...fileLineItemFields,
    lineItemID: nonempty.optional(),
  })
  .passthrough()
  .refine(
    line => line.description !== undefined || line.itemCode !== undefined || line.lineItemID !== undefined,
    'Line requires a description, itemCode or existing lineItemID',
  )
const fileLineItems = z.array(fileLineItemSchema).min(1, 'At least one line item is required')
const fileUpdateLineItems = z.array(fileUpdateLineItemSchema).min(1, 'At least one line item is required').optional()

// JSON exponent overflow is legal to parse but would serialize as null. Check
// every nested numeric value, including SDK fields outside the minimum schema.
function filePayload<T extends z.AnyZodObject>(schema: T) {
  return schema.passthrough().superRefine((data, ctx) => {
    function visit(value: unknown, path: (string | number)[]): void {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        ctx.addIssue({code: z.ZodIssueCode.custom, path, message: 'Number must be finite'})
      } else if (Array.isArray(value)) {
        value.forEach((child, index) => {
          visit(child, [...path, index])
        })
      } else if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) visit(child, [...path, key])
      }
    }
    visit(data, [])
  })
}

function withContact<T extends z.AnyZodObject>(schema: T) {
  return filePayload(schema).refine(
    data => data.contact !== undefined || data.contactID !== undefined || data.contactId !== undefined,
    {path: ['contact'], message: 'Contact relationship is required'},
  )
}

export const contactFileCreateSchema = filePayload(z.object({name: nonempty}))
export const contactFileUpdateSchema = filePayload(z.object({contactID: nonempty}))

export const invoiceFileCreateSchema = withContact(
  z.object({
    type: z.enum(['ACCREC', 'ACCPAY']),
    ...contactFields,
    ...documentDates,
    lineItems: fileLineItems,
  }),
)
export const invoiceFileUpdateSchema = filePayload(
  z.object({
    invoiceID: nonempty,
    contact: contactRelationship.optional(),
    ...documentDates,
    lineItems: fileUpdateLineItems,
  }),
)

export const quoteFileCreateSchema = withContact(
  z.object({
    ...contactFields,
    ...documentDates,
    lineItems: fileLineItems,
  }),
)
export const quoteFileUpdateSchema = filePayload(
  z.object({
    quoteID: nonempty,
    contact: contactRelationship.optional(),
    ...documentDates,
    lineItems: fileUpdateLineItems,
  }),
)

export const bankTransactionFileCreateSchema = withContact(
  z.object({
    type: z.enum(['RECEIVE', 'SPEND']),
    ...contactFields,
    ...documentDates,
    bankAccount: accountRelationship.optional(),
    bankAccountID: nonempty.optional(),
    bankAccountId: nonempty.optional(),
    lineItems: fileLineItems,
  }),
).refine(
  data => data.bankAccount !== undefined || data.bankAccountID !== undefined || data.bankAccountId !== undefined,
  {path: ['bankAccount'], message: 'Bank account relationship is required'},
)
export const bankTransactionFileUpdateSchema = filePayload(
  z.object({
    bankTransactionID: nonempty,
    contact: contactRelationship.optional(),
    bankAccount: accountRelationship.optional(),
    ...documentDates,
    lineItems: fileUpdateLineItems,
  }),
)

export const creditNoteFileCreateSchema = withContact(
  z.object({
    type: z.enum(['ACCRECCREDIT', 'ACCPAYCREDIT']),
    ...contactFields,
    ...documentDates,
    lineItems: fileLineItems,
  }),
)
export const creditNoteFileUpdateSchema = filePayload(
  z.object({
    creditNoteID: nonempty,
    contact: contactRelationship.optional(),
    ...documentDates,
    lineItems: fileUpdateLineItems,
  }),
)

export const paymentFileCreateSchema = filePayload(
  z.object({
    amount: finite.positive('Amount must be positive'),
    date: fileDateSchema.optional(),
    account: accountRelationship.optional(),
    accountID: nonempty.optional(),
    accountId: nonempty.optional(),
    code: nonempty.optional(),
    invoice: relationship(['invoiceID', 'invoiceNumber']).optional(),
    invoiceID: nonempty.optional(),
    invoiceId: nonempty.optional(),
    invoiceNumber: nonempty.optional(),
    creditNote: relationship(['creditNoteID', 'creditNoteNumber']).optional(),
    creditNoteNumber: nonempty.optional(),
    prepayment: relationship(['prepaymentID']).optional(),
    overpayment: relationship(['overpaymentID']).optional(),
    currencyRate: finite.optional(),
    bankAmount: finite.optional(),
  }),
)
  .refine(
    data =>
      data.account !== undefined ||
      data.accountID !== undefined ||
      data.accountId !== undefined ||
      data.code !== undefined,
    {path: ['account'], message: 'Payment account relationship is required'},
  )
  .refine(
    data =>
      [
        data.invoice,
        data.invoiceID,
        data.invoiceId,
        data.invoiceNumber,
        data.creditNote,
        data.creditNoteNumber,
        data.prepayment,
        data.overpayment,
      ].some(value => value !== undefined),
    {path: ['invoice'], message: 'Invoice, credit note, prepayment or overpayment relationship is required'},
  )

const itemDetailsSchema = z.object({unitPrice: finite.optional()}).passthrough()
export const itemFileCreateSchema = filePayload(
  z.object({
    code: nonempty,
    name: nonempty,
    salesDetails: itemDetailsSchema.optional(),
    purchaseDetails: itemDetailsSchema.optional(),
  }),
)
export const itemFileUpdateSchema = filePayload(
  z.object({
    itemID: nonempty,
    salesDetails: itemDetailsSchema.optional(),
    purchaseDetails: itemDetailsSchema.optional(),
  }),
)
export const accountFileUpdateSchema = filePayload(z.object({accountID: nonempty}))

const fileJournalLineSchema = z
  .object({
    lineAmount: finite.optional(),
    accountCode: nonempty.optional(),
    accountID: nonempty.optional(),
    taxAmount: finite.optional(),
    isBlank: z.boolean().optional(),
  })
  .passthrough()
  .refine(
    line =>
      line.isBlank === true ||
      (line.lineAmount !== undefined && (line.accountCode !== undefined || line.accountID !== undefined)),
    'Journal line requires a finite lineAmount and accountCode or accountID',
  )
const journalFields = {
  narration: nonempty,
  date: fileDateSchema.optional(),
  journalLines: z.array(fileJournalLineSchema).min(2, 'At least two journal lines are required'),
}
export const journalFileCreateSchema = filePayload(z.object(journalFields))
export const journalFileUpdateSchema = filePayload(z.object({manualJournalID: nonempty, ...journalFields}))

export const trackingOptionsFileUpdateSchema = z
  .object({
    trackingCategoryId: z.string().min(1, 'Tracking category ID is required'),
    options: z
      .array(
        z
          .object({
            trackingOptionId: z.string().min(1),
          })
          .passthrough(),
      )
      .min(1)
      .max(10),
  })
  .passthrough()

export function formatZodError(error: z.ZodError): string {
  return error.issues.map(issue => `  ${issue.path.join('.')}: ${issue.message}`).join('\n')
}
