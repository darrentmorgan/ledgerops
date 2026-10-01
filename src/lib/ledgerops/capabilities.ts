import {deepFreeze, digestJson, type Digest} from './canonical.js'

export function normalizeCapabilities(values: readonly string[] | undefined): readonly string[] {
  return normalizeNames(values, 'capability')
}

export function normalizeScopes(values: readonly string[] | undefined): readonly string[] {
  return normalizeNames(values, 'scope')
}

export function fingerprintCapabilities(values: readonly string[] | undefined): Digest {
  return digestJson({kind: 'ledgerops.capabilities.v1', values: normalizeCapabilities(values)})
}

export function fingerprintScopes(values: readonly string[] | undefined): Digest {
  return digestJson({kind: 'ledgerops.scopes.v1', values: normalizeScopes(values)})
}

export function hasRequiredCapabilities(
  available: readonly string[] | undefined,
  required: readonly string[],
): boolean {
  const set = new Set(normalizeCapabilities(available))
  return normalizeCapabilities(required).every(value => set.has(value))
}

export function hasRequiredScopes(available: readonly string[] | undefined, required: readonly string[]): boolean {
  const set = new Set(normalizeScopes(available))
  return normalizeScopes(required).every(value => set.has(value))
}

function normalizeNames(values: readonly string[] | undefined, label: string): readonly string[] {
  const normalized = [...(values ?? [])].map(value => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TypeError(`${label} names must be non-empty strings`)
    }
    return value.trim()
  })

  normalized.sort()
  const unique = [...new Set(normalized)]
  return deepFreeze(unique)
}
