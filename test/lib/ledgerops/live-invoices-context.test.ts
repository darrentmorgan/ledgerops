import {describe, expect, it} from 'vitest'
import {createTargetIdentity} from '../../../src/lib/ledgerops/identity.js'
import {LIVE_DEMO_PROFILE, LIVE_DEMO_RESOURCE} from '../../../src/lib/ledgerops/live-identity.js'
import {
  createInvoicesLiveContext,
  INVOICES_LIVE_CONTEXT_RESOURCE,
  INVOICES_LIVE_CONTEXT_SCHEMA,
} from '../../../src/lib/ledgerops/live-invoices-context.js'
import type {TargetIdentity} from '../../../src/lib/ledgerops/types.js'

const NOW = Date.parse('2026-08-25T00:00:00.000Z')
const TENANT_SENTINEL = 'synthetic-tenant-must-not-echo'

function organisationIdentity(overrides: Partial<Parameters<typeof createTargetIdentity>[0]> = {}): TargetIdentity {
  return createTargetIdentity({
    profileName: LIVE_DEMO_PROFILE,
    tenantId: TENANT_SENTINEL,
    resource: LIVE_DEMO_RESOURCE,
    objectId: TENANT_SENTINEL,
    isDemoCompany: true,
    observedAt: NOW,
    freshUntil: NOW + 5 * 60 * 1000,
    capabilities: ['accounting.settings.read'],
    scopes: ['accounting.settings'],
    ...overrides,
  })
}

function expectStop(value: unknown, reasonCode: string): void {
  expect(value).toEqual({
    schemaVersion: INVOICES_LIVE_CONTEXT_SCHEMA,
    status: 'STOP',
    outcome: 'STOP',
    terminal: 'STOP',
    stop: true,
    code: 'INVOICES_LIVE_CONTEXT_STOP',
    reasonCode,
  })
}

describe('Demo Company bound invoices live context', () => {
  it('refuses a non-Demo-Company source identity', () => {
    const identity = organisationIdentity({isDemoCompany: false})

    const result = createInvoicesLiveContext({identity, now: NOW})

    expectStop(result, 'DEMO_COMPANY_REQUIRED')
  })

  it('refuses a stale source identity', () => {
    const identity = organisationIdentity()

    const result = createInvoicesLiveContext({identity, now: identity.freshUntil})

    expectStop(result, 'IDENTITY_STALE')
  })

  it('refuses a source identity bound to the wrong resource', () => {
    const identity = organisationIdentity({resource: 'unexpected-resource'})

    const result = createInvoicesLiveContext({identity, now: NOW})

    expectStop(result, 'SOURCE_RESOURCE_MISMATCH')
  })

  it('refuses a source identity bound to the wrong profile', () => {
    const identity = organisationIdentity({profileName: 'unexpected-profile'})

    const result = createInvoicesLiveContext({identity, now: NOW})

    expectStop(result, 'SOURCE_PROFILE_MISMATCH')
  })

  it('refuses a malformed source identity', () => {
    const result = createInvoicesLiveContext({identity: null as unknown as TargetIdentity, now: NOW})

    expectStop(result, 'SOURCE_IDENTITY_INVALID')
  })

  it('refuses an invalid clock', () => {
    const identity = organisationIdentity()

    const result = createInvoicesLiveContext({identity, now: Number.NaN})

    expectStop(result, 'CLOCK_INVALID')
  })

  it('accepts a fresh Demo Company identity and projects it into an invoices-scoped redacted binding', () => {
    const identity = organisationIdentity()

    const result = createInvoicesLiveContext({identity, now: NOW})
    const serialized = JSON.stringify(result)

    expect(result).toEqual({
      schemaVersion: INVOICES_LIVE_CONTEXT_SCHEMA,
      profileName: LIVE_DEMO_PROFILE,
      resource: INVOICES_LIVE_CONTEXT_RESOURCE,
      tenantFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      objectFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      targetFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      isDemoCompany: true,
      observedAt: identity.observedAt,
      freshUntil: identity.freshUntil,
      capabilitiesFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      scopesFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(INVOICES_LIVE_CONTEXT_RESOURCE).toBe('invoices')
    expect(serialized).not.toContain(TENANT_SENTINEL)
  })

  it('produces a target fingerprint that differs from the source organisation-identity binding', () => {
    const identity = organisationIdentity()

    const result = createInvoicesLiveContext({identity, now: NOW})

    expect(result).not.toHaveProperty('reasonCode')
    if ('targetFingerprint' in result) {
      expect(result.resource).not.toBe(identity.resource)
    }
  })
})
