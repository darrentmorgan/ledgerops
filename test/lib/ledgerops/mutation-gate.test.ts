import {describe, expect, it, vi} from 'vitest'
import {
  MUTATION_PREVIEW_SCHEMA_VERSION,
  mutationPreview,
  payloadDigestFor,
  renderMutationPreview,
  renderPreviewText,
  runMutationGate,
  snapshotDescriptor,
  type MutationDescriptor,
  type MutationDescriptorSnapshot,
  type MutationGateOperation,
  type MutationGateResource,
} from '../../../src/lib/ledgerops/mutation-gate.js'

const descriptor: MutationDescriptor = {
  operation: 'create',
  resource: 'invoices',
  target: {profileName: 'synthetic-gate-profile', clientId: 'synthetic-gate-client-id'},
  summary: ['type ACCREC', '1 line item'],
  payload: {type: 'ACCREC', contact: {contactID: 'c-1'}},
}

describe('mutation preview record', () => {
  it('carries the versioned schema and a sha256 digest of the payload', () => {
    const preview = mutationPreview(descriptor)
    expect(preview.schemaVersion).toBe(MUTATION_PREVIEW_SCHEMA_VERSION)
    expect(Object.keys(preview)).toEqual([
      'schemaVersion',
      'operation',
      'resource',
      'profile',
      'payloadDigest',
      'payload',
      'willDispatch',
    ])
    expect(preview.profile).toBe(descriptor.target.profileName)
    expect(preview.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(preview.willDispatch).toBe(false)
    expect(preview.payload).not.toContain('synthetic-gate-client-id')
  })

  it('changes the digest when the payload changes and is stable across key order', () => {
    const changed: MutationDescriptor = {...descriptor, payload: {...descriptor.payload, reference: 'r-1'}}
    expect(mutationPreview(changed).payloadDigest).not.toBe(mutationPreview(descriptor).payloadDigest)
    const reordered: MutationDescriptor = {
      ...descriptor,
      payload: {contact: {contactID: 'c-1'}, type: 'ACCREC'},
    }
    expect(mutationPreview(reordered).payloadDigest).toBe(mutationPreview(descriptor).payloadDigest)
  })

  it('digests frozen and non-frozen payloads through one canonical path as payloadDigestFor', () => {
    const unsorted = {reference: 'r-9', contact: {note: {deep: 'z', early: 'a'}, contactID: 'c-1'}, type: 'ACCREC'}
    const canonicalEquivalent = {
      type: 'ACCREC',
      reference: 'r-9',
      contact: {contactID: 'c-1', note: {early: 'a', deep: 'z'}},
    }
    const frozenPayload = Object.freeze({
      reference: 'r-9',
      contact: Object.freeze({contactID: 'c-1', note: Object.freeze({deep: 'z', early: 'a'})}),
      type: 'ACCREC',
    })

    const frozenPreview = mutationPreview({...descriptor, payload: frozenPayload})
    const plainPreview = mutationPreview({...descriptor, payload: unsorted})
    const canonicalPreview = mutationPreview({...descriptor, payload: canonicalEquivalent})

    expect(frozenPreview.payloadDigest).toBe(payloadDigestFor(unsorted))
    expect(frozenPreview.payloadDigest).toBe(payloadDigestFor(canonicalEquivalent))
    expect(plainPreview.payloadDigest).toBe(frozenPreview.payloadDigest)
    expect(canonicalPreview.payloadDigest).toBe(frozenPreview.payloadDigest)
    expect(Object.isFrozen(frozenPreview.payload)).toBe(true)
    expect(frozenPreview.payload).toEqual(unsorted)

    const deepFrozenSnapshot = snapshotDescriptor({...descriptor, payload: unsorted})
    expect(mutationPreview(deepFrozenSnapshot).payloadDigest).toBe(frozenPreview.payloadDigest)
  })

  it('emits exactly the canonical payload bytes it digests, even for frozen unsorted input', () => {
    const frozenUnsorted = Object.freeze({
      reference: 'r-9',
      contact: Object.freeze({contactID: 'c-1', note: Object.freeze({deep: 'z', early: 'a'})}),
      type: 'ACCREC',
    })
    const frozenDescriptor: MutationDescriptor = {...descriptor, payload: frozenUnsorted}

    const preview = mutationPreview(frozenDescriptor)
    const canonicalBytes = JSON.stringify({
      contact: {contactID: 'c-1', note: {deep: 'z', early: 'a'}},
      reference: 'r-9',
      type: 'ACCREC',
    })
    expect(JSON.stringify(preview.payload)).toBe(canonicalBytes)
    expect(preview.payloadDigest).toBe(payloadDigestFor(preview.payload))
    expect(Object.isFrozen(preview.payload)).toBe(true)

    const rendered = renderMutationPreview(frozenDescriptor, 'json')
    const parsed = JSON.parse(rendered) as MutationPreview
    expect(parsed.payloadDigest).toBe(preview.payloadDigest)
    expect(JSON.stringify(parsed.payload)).toBe(JSON.stringify(preview.payload))
  })

  it('materializes a hostile payload exactly once so the digest covers its own emitted payload', () => {
    const backing = {type: 'ACCREC'}
    let reads = 0
    const hostile = {} as unknown as MutationDescriptor
    hostile.operation = 'create'
    Object.defineProperty(hostile, 'resource', {enumerable: true, value: 'invoices'})
    Object.defineProperty(hostile, 'target', {enumerable: true, value: descriptor.target})
    Object.defineProperty(hostile, 'summary', {enumerable: true, value: ['type ACCREC']})
    Object.defineProperty(hostile, 'payload', {
      enumerable: true,
      get: () => {
        reads += 1
        return {...backing}
      },
    })

    const preview = mutationPreview(hostile)
    expect(reads).toBe(1)
    expect(preview.payloadDigest).toBe(payloadDigestFor(preview.payload))
    expect(preview.payload).toEqual({type: 'ACCREC'})
  })
})

describe('preview text rendering', () => {
  it('names operation and resource and points at --execute without echoing secrets', () => {
    const text = renderPreviewText(descriptor)
    expect(text.join('\n')).toContain('PREVIEW')
    expect(text.join('\n')).toContain('create invoices')
    expect(text.join('\n')).toContain('--execute')
    expect(text.join('\n')).toContain(descriptor.summary[0])
    expect(text.join('\n')).toMatch(/sha256:[0-9a-f]{64}/)
    expect(text.join('\n')).not.toContain(descriptor.target.clientId)
  })
})

describe('runMutationGate dispatch policy', () => {
  function deps(overrides: Partial<Parameters<typeof runMutationGate>[2]> = {}) {
    return {
      log: vi.fn(),
      isInteractive: () => false,
      confirm: vi.fn().mockResolvedValue(true),
      dispatchOnce: vi.fn().mockResolvedValue({id: 'created-1'}),
      ...overrides,
    }
  }

  it('previews without dispatching when execute is absent', async () => {
    const d = deps()
    const outcome = await runMutationGate(descriptor, {execute: false, yes: true}, d)
    expect(outcome.dispatched).toBe(false)
    expect(d.dispatchOnce).not.toHaveBeenCalled()
    expect(d.log).toHaveBeenCalled()
  })

  it('dispatches exactly once non-interactively with --execute', async () => {
    const d = deps()
    const outcome = await runMutationGate(descriptor, {execute: true, yes: false}, d)
    expect(outcome.dispatched).toBe(true)
    expect(d.dispatchOnce).toHaveBeenCalledTimes(1)
    expect(d.confirm).not.toHaveBeenCalled()
  })

  it('asks an interactive confirmation without --yes and refuses on decline', async () => {
    const declined = deps({isInteractive: () => true, confirm: vi.fn().mockResolvedValue(false)})
    await expect(runMutationGate(descriptor, {execute: true, yes: false}, declined)).rejects.toMatchObject({
      reasonCode: 'CONFIRMATION_DECLINED',
    })
    expect(declined.dispatchOnce).not.toHaveBeenCalled()

    const accepted = deps({isInteractive: () => true})
    const outcome = await runMutationGate(descriptor, {execute: true, yes: false}, accepted)
    expect(accepted.confirm).toHaveBeenCalledTimes(1)
    expect(outcome.dispatched).toBe(true)
    expect(accepted.dispatchOnce).toHaveBeenCalledTimes(1)
  })

  it('renders the snapshot-bound preview before the confirmation and routes it through promptLog', async () => {
    const promptLines: string[] = []
    let promptLinesAtConfirm = -1
    const d = deps({
      isInteractive: () => true,
      confirm: vi.fn().mockImplementation(async () => {
        promptLinesAtConfirm = promptLines.length
        return false
      }),
      promptLog: (line: string) => promptLines.push(line),
    })

    await expect(runMutationGate(descriptor, {execute: true, yes: false}, d)).rejects.toMatchObject({
      reasonCode: 'CONFIRMATION_DECLINED',
    })
    expect(d.dispatchOnce).not.toHaveBeenCalled()

    const rendered = promptLines.join('\n')
    expect(promptLinesAtConfirm).toBe(promptLines.length)
    expect(promptLines.length).toBeGreaterThan(0)
    expect(rendered).toContain('nothing was sent to Xero yet')
    expect(rendered).toContain('create invoices')
    expect(rendered).toContain(`profile: ${descriptor.target.profileName}`)
    expect(rendered).toContain(`digest:  ${payloadDigestFor(descriptor.payload)}`)
    expect(rendered).toContain('- type ACCREC')
    expect(rendered).not.toContain(descriptor.target.clientId)

    const silent = deps({isInteractive: () => true, promptLog: (line: string) => promptLines.push(line)})
    await runMutationGate(descriptor, {execute: true, yes: true}, silent)
    expect(silent.confirm).not.toHaveBeenCalled()
    expect(silent.dispatchOnce).toHaveBeenCalledTimes(1)
  })

  it('lets --yes answer the interactive confirmation without prompting', async () => {
    const d = deps({isInteractive: () => true})
    const outcome = await runMutationGate(descriptor, {execute: true, yes: true}, d)
    expect(d.confirm).not.toHaveBeenCalled()
    expect(outcome.dispatched).toBe(true)
    expect(d.dispatchOnce).toHaveBeenCalledTimes(1)
  })

  it('never prompts for structured --json execution even when both TTYs are present', async () => {
    const d = deps({outputFormat: 'json', isInteractive: () => true})
    const outcome = await runMutationGate(descriptor, {execute: true, yes: false}, d)
    expect(outcome.dispatched).toBe(true)
    expect(d.dispatchOnce).toHaveBeenCalledTimes(1)
    expect(d.confirm).not.toHaveBeenCalled()
    expect(d.log).not.toHaveBeenCalled()
  })

  it('refuses a second dispatch attempt through one dispatch wrapper', async () => {
    const {singleDispatch} = await import('../../../src/lib/ledgerops/mutation-gate.js')
    const d = deps()
    const single = singleDispatch(d.dispatchOnce)
    const first = await single(snapshotOf(descriptor))
    expect(first).toEqual({id: 'created-1'})
    await expect(single(snapshotOf(descriptor))).rejects.toMatchObject({reasonCode: 'DOUBLE_DISPATCH'})
    expect(d.dispatchOnce).toHaveBeenCalledTimes(1)
  })
})

describe('preview-to-dispatch binding', () => {
  it('hands dispatch a frozen snapshot of the exact previewed descriptor', async () => {
    const seen: MutationDescriptorSnapshot[] = []
    const outcome = await runMutationGate(
      descriptor,
      {execute: true, yes: false},
      {
        log: vi.fn(),
        isInteractive: () => false,
        dispatchOnce: async snapshot => {
          seen.push(snapshot)
          return {id: 'created-1'}
        },
      },
    )

    expect(seen).toHaveLength(1)
    expect(outcome.descriptor).toBe(seen[0])
    expect(Object.isFrozen(seen[0])).toBe(true)
    expect(Object.isFrozen(seen[0].target)).toBe(true)
    expect(Object.isFrozen(seen[0].payload)).toBe(true)
    expect(Object.isFrozen(seen[0].summary)).toBe(true)
    expect(seen[0]).toEqual({
      operation: 'create',
      resource: 'invoices',
      target: {...descriptor.target},
      summary: [...descriptor.summary],
      payload: {...descriptor.payload},
    })
  })

  it('ignores caller-side descriptor drift after the gate previewed it', async () => {
    const source = JSON.parse(JSON.stringify(descriptor)) as {
      payload: Record<string, unknown>
      summary: string[]
    }
    const seen: MutationDescriptorSnapshot[] = []
    const pending = runMutationGate(
      source as unknown as MutationDescriptor,
      {execute: true, yes: false},
      {
        log: vi.fn(),
        isInteractive: () => false,
        dispatchOnce: async snapshot => {
          seen.push(snapshot)
          return {id: 'created-1'}
        },
      },
    )
    source.payload = {type: 'TAMPERED'}
    source.summary = ['tampered']
    await pending

    expect(seen[0].payload).toEqual({...descriptor.payload})
    expect(seen[0].summary).toEqual([...descriptor.summary])
    expect(payloadDigestFor(seen[0].payload)).toBe(mutationPreview(descriptor).payloadDigest)
  })

  it('materializes nested getters once and builds preview and dispatch from that one snapshot', async () => {
    let lineItemReads = 0
    const lineItemSource = {description: 'Consulting', quantity: 2}
    const nestedProxy = new Proxy(lineItemSource, {
      get(target, prop) {
        if (typeof prop === 'string') {
          lineItemReads += 1
        }
        return (target as Record<string, unknown>)[prop]
      },
    })
    const slippery = {} as unknown as MutationDescriptor
    slippery.operation = 'create'
    Object.defineProperty(slippery, 'resource', {enumerable: true, get: () => 'invoices'})
    Object.defineProperty(slippery, 'target', {enumerable: true, get: () => descriptor.target})
    Object.defineProperty(slippery, 'summary', {enumerable: true, get: () => ['type ACCREC']})
    Object.defineProperty(slippery, 'payload', {
      enumerable: true,
      get: () => ({type: 'ACCREC', lineItems: [nestedProxy]}),
    })

    const seen: MutationDescriptorSnapshot[] = []
    const outcome = await runMutationGate(
      slippery,
      {execute: true, yes: false},
      {
        log: vi.fn(),
        isInteractive: () => false,
        dispatchOnce: async snapshot => {
          seen.push(snapshot)
          return {id: 'created-1'}
        },
      },
    )

    const dispatchedPayload = seen[0].payload as {
      lineItems: {description: string; quantity: number}[]
    }

    expect(outcome.descriptor).toBe(seen[0])
    expect(Object.isFrozen(dispatchedPayload.lineItems)).toBe(true)
    expect(dispatchedPayload.lineItems[0]).toEqual({description: 'Consulting', quantity: 2})

    const readsAfterSnapshot = lineItemReads
    expect(readsAfterSnapshot).toBeGreaterThan(0)

    const preview = mutationPreview(seen[0])
    expect(preview.payload).toEqual(seen[0].payload)
    expect(Object.isFrozen(preview.payload)).toBe(true)
    expect(preview.payloadDigest).toBe(payloadDigestFor(seen[0].payload))
    JSON.stringify(preview)
    renderPreviewText(seen[0]).join('\n')

    expect(lineItemReads).toBe(readsAfterSnapshot)
    expect(renderPreviewText(seen[0])).toEqual([
      'PREVIEW — nothing was sent to Xero. Pending mutation: create invoices.',
      `  profile: ${descriptor.target.profileName}`,
      `  digest:  ${payloadDigestFor(seen[0].payload)}`,
      '  - type ACCREC',
      'Re-run with --execute to dispatch this mutation.',
    ])
  })
})

describe('sealed digest binding', () => {
  const manifestDigest = 'c'.repeat(64)

  function batchDescriptor(overrides: Partial<MutationDescriptor> = {}): MutationDescriptor {
    return {
      operation: 'batch-create',
      resource: 'invoices',
      target: {profileName: 'synthetic-gate-profile', clientId: 'synthetic-gate-client-id'},
      summary: ['batch b-1', '2 draft invoice(s)'],
      payload: {batchId: 'b-1', manifestDigest, itemCount: 2},
      sealedDigest: manifestDigest,
      ...overrides,
    }
  }

  it('reports a sealed digest the payload itself carries, so a reader can check it', () => {
    const preview = mutationPreview(batchDescriptor())
    expect(preview.payloadDigest).toBe(manifestDigest)
    expect((preview.payload as Record<string, unknown>).manifestDigest).toBe(preview.payloadDigest)
  })

  it('mints no preview when the sealed digest disagrees with the payload it claims to seal', () => {
    const drifted = batchDescriptor({sealedDigest: 'd'.repeat(64)})
    expect(() => mutationPreview(drifted)).toThrowError(expect.objectContaining({reasonCode: 'SEALED_DIGEST_UNBOUND'}))
    expect(() => renderMutationPreview(drifted, 'json')).toThrowError(
      expect.objectContaining({reasonCode: 'SEALED_DIGEST_UNBOUND'}),
    )
    expect(() => renderPreviewText(drifted)).toThrowError(
      expect.objectContaining({reasonCode: 'SEALED_DIGEST_UNBOUND'}),
    )
  })

  it('mints no preview when the payload binds no sealed digest at all', () => {
    const unbound = batchDescriptor({payload: {batchId: 'b-1', itemCount: 2}})
    expect(() => mutationPreview(unbound)).toThrowError(expect.objectContaining({reasonCode: 'SEALED_DIGEST_UNBOUND'}))
  })

  it('fails closed before preview and before dispatch when the binding disagrees', async () => {
    const drifted = batchDescriptor({sealedDigest: 'd'.repeat(64)})

    const previewDeps = {log: vi.fn(), isInteractive: () => false, dispatchOnce: vi.fn()}
    await expect(runMutationGate(drifted, {execute: false, yes: false}, previewDeps)).rejects.toMatchObject({
      reasonCode: 'SEALED_DIGEST_UNBOUND',
    })
    expect(previewDeps.log).not.toHaveBeenCalled()
    expect(previewDeps.dispatchOnce).not.toHaveBeenCalled()

    const executeDeps = {log: vi.fn(), isInteractive: () => false, dispatchOnce: vi.fn()}
    await expect(runMutationGate(drifted, {execute: true, yes: true}, executeDeps)).rejects.toMatchObject({
      reasonCode: 'SEALED_DIGEST_UNBOUND',
    })
    expect(executeDeps.dispatchOnce).not.toHaveBeenCalled()
  })

  it('leaves the unsealed create path digesting its own payload', () => {
    const preview = mutationPreview(descriptor)
    expect(preview.payloadDigest).toBe(payloadDigestFor(descriptor.payload))
  })
})

function snapshotOf(input: MutationDescriptor): MutationDescriptorSnapshot {
  return JSON.parse(JSON.stringify(input)) as MutationDescriptorSnapshot
}

// Exhaustive maps make a newly widened union require a corresponding table row.
const operations = {create: true, update: true, 'batch-create': true} satisfies Record<MutationGateOperation, true>
const resources = {
  invoices: true,
  payments: true,
  accounts: true,
  'bank-transactions': true,
  contacts: true,
  'credit-notes': true,
  items: true,
  'manual-journals': true,
  quotes: true,
  'tracking-categories': true,
  'tracking-options': true,
} satisfies Record<MutationGateResource, true>

describe('closed operation and resource matrix', () => {
  it.each(
    (Object.keys(operations) as MutationGateOperation[]).flatMap(operation =>
      (Object.keys(resources) as MutationGateResource[]).map(resource => ({operation, resource})),
    ),
  )('$operation $resource preserves schema and dispatch policy', async ({operation, resource}) => {
    const input = {...descriptor, operation, resource}
    const log = vi.fn()
    const dispatchOnce = vi.fn().mockResolvedValue({id: 'synthetic-result'})
    const dependencies = {log, dispatchOnce, outputFormat: 'json' as const, isInteractive: () => false}
    await runMutationGate(input, {execute: false, yes: true}, dependencies)
    expect(dispatchOnce).not.toHaveBeenCalled()
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      schemaVersion: 'ledgerops.mutation-preview.v1',
      operation,
      resource,
      profile: input.target.profileName,
      payloadDigest: payloadDigestFor(input.payload),
      payload: input.payload,
      willDispatch: false,
    })
    await runMutationGate(input, {execute: true, yes: false}, dependencies)
    expect(dispatchOnce).toHaveBeenCalledExactlyOnceWith(snapshotDescriptor(input))
  })
})
