import {describe, expect, it} from 'vitest'
import {
  ensureAccountNested,
  ensureBankAccountNested,
  ensureContactNested,
  ensureInvoiceNested,
  extractAccountId,
  extractContactId,
  extractInvoiceId,
} from '../../src/lib/file-data.js'

describe('file payload reference normalization', () => {
  it.each([
    ['contact', extractContactId, ensureContactNested],
    ['invoice', extractInvoiceId, ensureInvoiceNested],
    ['account', extractAccountId, ensureAccountNested],
  ] as const)(
    'accepts ID aliases and nested references for %s without changing monetary fields',
    (name, extract, ensure) => {
      for (const alias of [`${name}ID`, `${name}Id`]) {
        const input = Object.freeze({[alias]: 'synthetic-id', amount: 125.25, reference: 'Synthetic payment'})
        expect(extract(input)).toBe('synthetic-id')
        expect(ensure(input)).toEqual({
          [name]: {[`${name}ID`]: 'synthetic-id'},
          amount: 125.25,
          reference: 'Synthetic payment',
        })
        expect(input[alias]).toBe('synthetic-id')
      }
      const nested = Object.freeze({[name]: {[`${name}ID`]: 'synthetic-nested'}, amount: 125.25})
      expect(extract(nested)).toBe('synthetic-nested')
      expect(ensure(nested)).toBe(nested)
    },
  )

  it('preserves explicit nested payment references when conflicting top-level aliases are present', () => {
    const input = Object.freeze({
      invoice: {invoiceID: 'synthetic-explicit-invoice'},
      invoiceId: 'synthetic-alias-invoice',
      account: {accountID: 'synthetic-explicit-account'},
      accountId: 'synthetic-alias-account',
      amount: 125.25,
    })
    expect(ensureAccountNested(ensureInvoiceNested(input))).toBe(input)
  })

  it('normalizes payment invoice and account numbers while preserving amount, date and reference', () => {
    const input = Object.freeze({
      invoiceNumber: 'INV-SYNTHETIC',
      code: 'SYNTHETIC-BANK',
      amount: 125.25,
      date: '2026-01-01',
      reference: 'Synthetic payment',
    })
    expect(ensureAccountNested(ensureInvoiceNested(input))).toEqual({
      invoice: {invoiceNumber: 'INV-SYNTHETIC'},
      account: {code: 'SYNTHETIC-BANK'},
      amount: 125.25,
      date: '2026-01-01',
      reference: 'Synthetic payment',
    })
    expect(input.invoiceNumber).toBe('INV-SYNTHETIC')
    expect(input.code).toBe('SYNTHETIC-BANK')
  })

  it('nests a credit-note payment reference and preserves an explicit credit-note object', () => {
    expect(ensureInvoiceNested({creditNoteNumber: 'CN-SYNTHETIC', amount: 20.5})).toEqual({
      creditNote: {creditNoteNumber: 'CN-SYNTHETIC'},
      amount: 20.5,
    })
    const nested = {creditNote: {creditNoteID: 'synthetic-credit-note'}, creditNoteNumber: 'CN-ALIAS', amount: 20.5}
    expect(ensureInvoiceNested(nested)).toBe(nested)
  })

  it.each(['bankAccountId', 'bankAccountID'])('maps %s to the Xero bankAccount.accountID field', alias => {
    const input = Object.freeze({[alias]: 'synthetic-bank', amount: 125.25})
    expect(ensureBankAccountNested(input)).toEqual({bankAccount: {accountID: 'synthetic-bank'}, amount: 125.25})
    const nested = {...input, bankAccount: {accountID: 'synthetic-explicit-bank'}}
    expect(ensureBankAccountNested(nested)).toBe(nested)
  })

  it('leaves absent references for validation instead of inventing an API target', () => {
    const input = Object.freeze({amount: 125.25})
    for (const extract of [extractContactId, extractInvoiceId, extractAccountId]) {
      expect(extract(input)).toBeUndefined()
    }
    for (const ensure of [ensureContactNested, ensureInvoiceNested, ensureAccountNested, ensureBankAccountNested]) {
      expect(ensure(input)).toBe(input)
    }
  })
})
