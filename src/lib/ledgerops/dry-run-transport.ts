import {cloneCanonical, type Digest, type JsonValue} from './canonical.js'
import {createTargetBinding, sameBinding} from './identity.js'
import type {MutationTransport, TargetBinding, TargetIdentity} from './types.js'

/**
 * The offline dry-run adapter behind `target apply`: it accepts a dispatch into
 * memory and reads the same payload back. It is bound to one target at
 * construction and throws if asked to act on any other, so a dry run can never
 * stand in for a target it was not built for.
 */
export function createDryRunTransport(target: TargetIdentity | TargetBinding): MutationTransport {
  const binding = createTargetBinding(target)
  const dispatched = new Map<Digest, JsonValue>()

  return {
    binding,
    dispatch(input) {
      requireOwnBinding(binding, input.targetBinding)
      dispatched.set(input.planDigest, cloneCanonical(input.payload))
      return {accepted: true}
    },
    readBack(input) {
      requireOwnBinding(binding, input.targetBinding)
      const record = dispatched.get(input.planDigest)
      if (record === undefined) return {status: 'missing'}
      return {status: 'found', records: [cloneCanonical(record)]}
    },
  }
}

function requireOwnBinding(own: TargetBinding, offered: TargetBinding): void {
  if (!offered || typeof offered !== 'object' || !sameBinding(own, offered)) {
    throw new Error('dry-run transport is bound to a different target')
  }
}
