import {digestJson, type Digest} from './canonical.js'
import type {MutationPlan} from './types.js'

export function confirmationTokenFor(planOrDigest: MutationPlan | Digest): string {
  const planDigest = typeof planOrDigest === 'string' ? planOrDigest : planOrDigest.planDigest
  if (!/^[0-9a-f]{64}$/.test(planDigest)) throw new TypeError('A SHA-256 plan digest is required')
  return `CONFIRM ${planDigest}`
}

export function confirmationDigestFor(confirmation: string): Digest {
  return digestJson({token: confirmation})
}

export function verifyConfirmation(confirmation: string, planOrDigest: MutationPlan | Digest): boolean {
  try {
    return confirmation === confirmationTokenFor(planOrDigest)
  } catch {
    return false
  }
}
