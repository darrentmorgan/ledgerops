import {describe, expect, it} from 'vitest'
import {checkDirectMutationResult, DirectMutationResultFailure} from '../../../src/lib/ledgerops/direct-result.js'

const TARGET = '4f7f1e2a-0000-4000-8000-00000000abcd'

describe('checkDirectMutationResult expected ID', () => {
  it('accepts a returned GUID that differs from the target only in letter case', () => {
    const record = {invoiceID: TARGET}
    expect(checkDirectMutationResult({body: {invoices: [record]}}, 'invoices', TARGET.toUpperCase())).toBe(record)
  })

  it('refuses a returned ID for a different resource', () => {
    expect(() =>
      checkDirectMutationResult(
        {body: {invoices: [{invoiceID: '4f7f1e2a-0000-4000-8000-00000000abce'}]}},
        'invoices',
        TARGET,
      ),
    ).toThrow(DirectMutationResultFailure)
  })
})
