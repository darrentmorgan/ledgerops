import {describe, expect, it} from 'vitest'
import {deriveOperationId, digestJson, type OperationIdentityInput} from '../../../src/lib/ledgerops/index.js'

/**
 * ADR-0014 general kernel rule:
 *   operationId = sha256Hex(canonicalJson({tenantFingerprint, resource, operation, origin}))
 *
 * These are pure-function tests for generic derivation. Caller-specific origin
 * schemas and workflow integration belong in the operator's own code.
 */

const TENANT_A = digestJson({
  kind: 'ledgerops.tenant.v1',
  tenantId: 'synthetic-tenant-a',
})
const TENANT_B = digestJson({
  kind: 'ledgerops.tenant.v1',
  tenantId: 'synthetic-tenant-b',
})

function inputFor(overrides: Partial<OperationIdentityInput> = {}): OperationIdentityInput {
  return {
    tenantFingerprint: TENANT_A,
    resource: 'invoices',
    operation: 'create',
    origin: {
      workflow: 'synthetic-import',
      sourceRecord: 'row-a',
      form: 'BILL',
    },
    ...overrides,
  }
}

describe('deriveOperationId', () => {
  it('is deterministic: the same input always derives the same id', () => {
    expect(deriveOperationId(inputFor())).toBe(deriveOperationId(inputFor()))
  })

  it('reads nothing time-varying: it is a pure function of tenant, resource, operation and origin', () => {
    // No timestamp field exists on the input at all -- the type itself
    // excludes createdAt/expiresAt/ttlMs/nonce, so there is nothing to vary.
    const a = deriveOperationId(inputFor())
    const b = deriveOperationId(inputFor())
    expect(a).toBe(b)
  })

  it('differs when the tenant fingerprint differs (org-scoped, not profile-scoped)', () => {
    const a = deriveOperationId(inputFor({tenantFingerprint: TENANT_A}))
    const b = deriveOperationId(inputFor({tenantFingerprint: TENANT_B}))
    expect(a).not.toBe(b)
  })

  it('differs when resource differs', () => {
    const a = deriveOperationId(inputFor({resource: 'invoices'}))
    const b = deriveOperationId(inputFor({resource: 'manual-journals'}))
    expect(a).not.toBe(b)
  })

  it('differs when operation differs', () => {
    const a = deriveOperationId(inputFor({operation: 'create'}))
    const b = deriveOperationId(inputFor({operation: 'update'}))
    expect(a).not.toBe(b)
  })

  it('differs when any origin field differs', () => {
    const base = inputFor()
    const differentWorkflow = deriveOperationId(
      inputFor({
        origin: {
          ...(base.origin as Record<string, unknown>),
          workflow: 'synthetic-export',
        },
      }),
    )
    const differentSource = deriveOperationId(
      inputFor({
        origin: {
          ...(base.origin as Record<string, unknown>),
          sourceRecord: 'row-b',
        },
      }),
    )
    const differentForm = deriveOperationId(
      inputFor({
        origin: {
          ...(base.origin as Record<string, unknown>),
          form: 'INVOICE',
        },
      }),
    )
    const original = deriveOperationId(base)
    expect(differentWorkflow).not.toBe(original)
    expect(differentSource).not.toBe(original)
    expect(differentForm).not.toBe(original)
  })

  it('derives the same identity for byte-identical origins (ADR-0014)', () => {
    const first = deriveOperationId(inputFor())
    const second = deriveOperationId(inputFor())
    expect(first).toBe(second)
  })

  it('rejects a non-digest tenant fingerprint', () => {
    expect(() => deriveOperationId(inputFor({tenantFingerprint: 'not-a-digest'}))).toThrow()
  })

  it('rejects a blank resource or operation', () => {
    expect(() => deriveOperationId(inputFor({resource: ''}))).toThrow()
    expect(() => deriveOperationId(inputFor({operation: ''}))).toThrow()
  })

  it('rejects a non-object origin', () => {
    expect(() =>
      deriveOperationId(
        inputFor({
          origin: 'not-an-object' as unknown as Record<string, unknown>,
        }),
      ),
    ).toThrow()
    expect(() => deriveOperationId(inputFor({origin: null as unknown as Record<string, unknown>}))).toThrow()
    expect(() => deriveOperationId(inputFor({origin: ['array'] as unknown as Record<string, unknown>}))).toThrow()
  })
})
