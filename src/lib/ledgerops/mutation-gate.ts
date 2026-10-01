import {createHash} from 'node:crypto'
import {createInterface} from 'node:readline/promises'
import {formatOutput, type OutputFormat} from '../formatters.js'

export const MUTATION_PREVIEW_SCHEMA_VERSION = 'ledgerops.mutation-preview.v1'

/**
 * `batch-create` is one ADR-0011 batch manifest presented as a single
 * mutation: the gate's policy is unchanged, only the thing being confirmed is
 * an enumeration rather than one object.
 */
export type MutationGateOperation = 'create' | 'update' | 'batch-create'

export type MutationGateResource =
  | 'invoices'
  | 'payments'
  | 'accounts'
  | 'bank-transactions'
  | 'contacts'
  | 'credit-notes'
  | 'items'
  | 'manual-journals'
  | 'quotes'
  | 'tracking-categories'
  | 'tracking-options'

export interface MutationGateTarget {
  readonly profileName: string
  readonly clientId: string
}

export interface MutationDescriptor {
  readonly operation: MutationGateOperation
  readonly resource: MutationGateResource
  readonly target: MutationGateTarget
  readonly summary: readonly string[]
  readonly payload: Record<string, unknown>
  /**
   * A digest the caller has already sealed over this mutation — an ADR-0011
   * `manifestDigest`, for instance. When present the preview, the confirmation
   * text, and the dispatched snapshot all report it instead of deriving one
   * from `payload`, so what a user confirms is exactly what the downstream
   * kernel re-checks. Absent, the payload's own digest is used as before.
   *
   * A sealed digest must also appear in the payload as `manifestDigest`: the
   * reported `payloadDigest` then stays checkable against the payload the same
   * preview shows, instead of being an unrelated value the reader has to take
   * on trust. A disagreement fails closed.
   */
  readonly sealedDigest?: string
}

export interface MutationDescriptorSnapshot {
  readonly operation: MutationGateOperation
  readonly resource: MutationGateResource
  readonly target: MutationGateTarget
  readonly summary: readonly string[]
  readonly payload: Record<string, unknown>
  readonly sealedDigest?: string
}

export interface MutationPreview {
  readonly schemaVersion: typeof MUTATION_PREVIEW_SCHEMA_VERSION
  readonly operation: MutationGateOperation
  readonly resource: MutationGateResource
  readonly profile: string
  readonly payloadDigest: string
  readonly payload: Record<string, unknown>
  readonly willDispatch: false
}

export const MUTATION_PREVIEW_COLUMNS: {key: string; header: string; format?: (value: unknown) => string}[] = [
  {key: 'schemaVersion', header: 'schemaVersion'},
  {key: 'operation', header: 'operation'},
  {key: 'resource', header: 'resource'},
  {key: 'profile', header: 'profile'},
  {key: 'payloadDigest', header: 'payloadDigest'},
  {key: 'payload', header: 'payload', format: value => JSON.stringify(value)},
  {key: 'willDispatch', header: 'willDispatch'},
]

export interface MutationGateRequest {
  readonly execute: boolean
  readonly yes: boolean
}

export interface MutationGateOutcome<T> {
  readonly dispatched: boolean
  readonly response?: T
  readonly descriptor?: MutationDescriptorSnapshot
}

export interface MutationGateDependencies<T> {
  readonly log: (line: string) => void
  readonly dispatchOnce: (snapshot: MutationDescriptorSnapshot) => Promise<T>
  readonly outputFormat?: OutputFormat
  readonly isInteractive?: () => boolean
  readonly confirm?: (question: string) => Promise<boolean>
  readonly promptLog?: (line: string) => void
}

export type MutationGateRefusalCode = 'CONFIRMATION_DECLINED' | 'DOUBLE_DISPATCH' | 'SEALED_DIGEST_UNBOUND'

export class MutationGateRefusal extends Error {
  readonly reasonCode: MutationGateRefusalCode

  constructor(reasonCode: MutationGateRefusalCode, message: string) {
    super(message)
    this.name = 'MutationGateRefusal'
    this.reasonCode = reasonCode
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue)
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = stableValue(record[key])
        return sorted
      }, {})
  }
  return value
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child)
    }
    Object.freeze(value)
  }
  return value
}

export function payloadDigestFor(payload: Record<string, unknown>): string {
  return digestOfCanonical(stableValue(payload) as Record<string, unknown>)
}

function digestOfCanonical(payload: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`
}

/**
 * The one field a sealed digest must be carried in by the payload it seals.
 * Naming it here keeps `payloadDigest` a single meaning: a value the reader
 * can check against the payload the same record shows.
 */
const SEALED_DIGEST_FIELD = 'manifestDigest'

/**
 * A sealed digest is only honest if the previewed payload binds it. Without
 * this the record would report a digest of something the reader never sees,
 * so an unbound or disagreeing seal refuses — no preview, no confirmation, no
 * dispatch.
 */
function assertSealedDigestBound(sealedDigest: string, payload: Record<string, unknown>): void {
  if (payload[SEALED_DIGEST_FIELD] !== sealedDigest) {
    throw new MutationGateRefusal(
      'SEALED_DIGEST_UNBOUND',
      `The sealed digest is not bound to this payload's ${SEALED_DIGEST_FIELD} — nothing was previewed or dispatched.`,
    )
  }
}

export function mutationPreview(descriptor: MutationDescriptor): MutationPreview {
  const payload = deepFreeze(stableValue(descriptor.payload)) as Record<string, unknown>
  if (descriptor.sealedDigest !== undefined) {
    assertSealedDigestBound(descriptor.sealedDigest, payload)
  }
  return Object.freeze({
    schemaVersion: MUTATION_PREVIEW_SCHEMA_VERSION,
    operation: descriptor.operation,
    resource: descriptor.resource,
    profile: descriptor.target.profileName,
    payloadDigest: descriptor.sealedDigest ?? digestOfCanonical(payload),
    payload,
    willDispatch: false,
  })
}

export function snapshotDescriptor(descriptor: MutationDescriptor): MutationDescriptorSnapshot {
  return deepFreeze(stableValue({...descriptor})) as MutationDescriptorSnapshot
}

function previewBodyLines(preview: MutationPreview, summary: readonly string[]): readonly string[] {
  return [`  profile: ${preview.profile}`, `  digest:  ${preview.payloadDigest}`, ...summary.map(line => `  - ${line}`)]
}

export function renderPreviewText(descriptor: MutationDescriptor): readonly string[] {
  const preview = mutationPreview(descriptor)
  return [
    `PREVIEW — nothing was sent to Xero. Pending mutation: ${preview.operation} ${preview.resource}.`,
    ...previewBodyLines(preview, descriptor.summary),
    'Re-run with --execute to dispatch this mutation.',
  ]
}

export function renderMutationPreview(descriptor: MutationDescriptor, format: OutputFormat = 'table'): string {
  if (format === 'table') {
    return renderPreviewText(descriptor).join('\n')
  }
  if (format === 'csv' || format === 'toon') {
    return formatOutput(
      [mutationPreview(descriptor) as unknown as Record<string, unknown>],
      MUTATION_PREVIEW_COLUMNS,
      format,
    )
  }
  return JSON.stringify(mutationPreview(descriptor), null, 2)
}

export function singleDispatch<T>(
  dispatch: (snapshot: MutationDescriptorSnapshot) => Promise<T>,
): (snapshot: MutationDescriptorSnapshot) => Promise<T> {
  let called = false
  return async snapshot => {
    if (called) {
      throw new MutationGateRefusal('DOUBLE_DISPATCH', 'A mutation gate instance dispatches at most once.')
    }
    called = true
    return dispatch(snapshot)
  }
}

function defaultIsInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true
}

async function defaultConfirm(question: string): Promise<boolean> {
  const rl = createInterface({input: process.stdin, output: process.stderr})
  try {
    const answer = await rl.question(`${question}: `)
    return /^yes$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

function defaultPromptLog(line: string): void {
  console.error(line)
}

export async function runMutationGate<T>(
  descriptor: MutationDescriptor,
  request: MutationGateRequest,
  deps: MutationGateDependencies<T>,
): Promise<MutationGateOutcome<T>> {
  const snapshot = snapshotDescriptor(descriptor)
  if (snapshot.sealedDigest !== undefined) {
    // Checked on the snapshot, before anything is printed: a structured
    // `--execute` run never renders a preview, so the binding cannot be left
    // to the preview path alone.
    assertSealedDigestBound(snapshot.sealedDigest, snapshot.payload)
  }

  if (!request.execute) {
    deps.log(renderMutationPreview(snapshot, deps.outputFormat ?? 'table'))
    return {dispatched: false}
  }

  const interactive =
    deps.outputFormat !== 'json' &&
    deps.outputFormat !== 'csv' &&
    deps.outputFormat !== 'toon' &&
    (deps.isInteractive ?? defaultIsInteractive)()
  if (!request.yes && interactive) {
    const promptLog = deps.promptLog ?? defaultPromptLog
    const pending = mutationPreview(snapshot)
    for (const line of [
      `PENDING MUTATION — nothing was sent to Xero yet: ${pending.operation} ${pending.resource}.`,
      ...previewBodyLines(pending, snapshot.summary),
    ]) {
      promptLog(line)
    }
    const confirm = deps.confirm ?? defaultConfirm
    const approved = await confirm(
      `Dispatch this ${snapshot.operation} ${snapshot.resource} mutation? Type 'yes' to confirm`,
    )
    if (!approved) {
      throw new MutationGateRefusal('CONFIRMATION_DECLINED', 'Confirmation declined — nothing was dispatched.')
    }
  }

  const response = await singleDispatch(deps.dispatchOnce)(snapshot)
  return {dispatched: true, response, descriptor: snapshot}
}
