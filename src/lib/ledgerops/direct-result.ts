import type {MutationGateResource} from './mutation-gate.js'

const RESOURCES = {
  accounts: {collection: 'accounts', id: 'accountID'},
  'bank-transactions': {collection: 'bankTransactions', id: 'bankTransactionID'},
  contacts: {collection: 'contacts', id: 'contactID'},
  'credit-notes': {collection: 'creditNotes', id: 'creditNoteID'},
  invoices: {collection: 'invoices', id: 'invoiceID'},
  items: {collection: 'items', id: 'itemID'},
  'manual-journals': {collection: 'manualJournals', id: 'manualJournalID'},
  payments: {collection: 'payments', id: 'paymentID'},
  quotes: {collection: 'quotes', id: 'quoteID'},
  'tracking-categories': {collection: 'trackingCategories', id: 'trackingCategoryID'},
  'tracking-options': {collection: 'options', id: 'trackingOptionID'},
} satisfies Record<MutationGateResource, {collection: string; id: string}>

export class DirectMutationResultFailure extends Error {
  constructor(resource: MutationGateResource, reason: string) {
    super(
      `UNCERTAIN: ${resource} mutation outcome is unverified after dispatch (${reason}). ` +
        'Do not retry automatically; verify the outcome in Xero before attempting another write.',
    )
    this.name = 'DirectMutationResultFailure'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasProviderFailure(record: Record<string, unknown>): boolean {
  for (const key of ['hasValidationErrors', 'HasValidationErrors', 'hasErrors', 'HasErrors']) {
    const flag = record[key]
    if (flag !== undefined && flag !== null && flag !== false) return true
  }
  for (const key of ['validationErrors', 'ValidationErrors']) {
    const errors = record[key]
    if (errors !== undefined && errors !== null && (!Array.isArray(errors) || errors.length > 0)) return true
  }
  for (const key of ['statusAttributeString', 'StatusAttributeString']) {
    const status = record[key]
    if (status !== undefined && status !== null) {
      if (typeof status !== 'string' || status.trim().toUpperCase() === 'ERROR') return true
    }
  }
  return false
}

/** Check a resolved SDK write response before selecting or rendering its resource.
 * Failure means the remote outcome is unverified, not that the write did not happen.
 * Return the original resource so successful JSON retains the SDK's raw shape.
 */
export function checkDirectMutationResult(
  response: unknown,
  resource: MutationGateResource,
  expectedId?: string,
): Record<string, unknown> {
  const spec = RESOURCES[resource]
  if (!isRecord(response) || !isRecord(response.body)) {
    throw new DirectMutationResultFailure(resource, 'missing or malformed response body')
  }
  const body = response.body
  const records = body[spec.collection]
  if (!Array.isArray(records) || records.length !== 1 || !isRecord(records[0])) {
    throw new DirectMutationResultFailure(resource, `expected exactly one ${spec.collection} resource`)
  }
  const record = records[0]
  const id = record[spec.id]
  if (typeof id !== 'string' || id.trim() === '') {
    throw new DirectMutationResultFailure(resource, `missing or malformed ${spec.id}`)
  }
  if (expectedId !== undefined && id !== expectedId) {
    throw new DirectMutationResultFailure(resource, `returned ${spec.id} does not match the targeted resource`)
  }
  if (hasProviderFailure(body) || hasProviderFailure(record)) {
    throw new DirectMutationResultFailure(resource, 'provider validation failure')
  }
  return record
}
