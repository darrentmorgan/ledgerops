/**
 * Conservative boundary check for offline workflow inputs.
 *
 * This is deliberately syntactic: it catches credential-shaped keys and a
 * small set of obvious wire formats, but it cannot determine whether an
 * arbitrary string is a secret. Callers still need allowlisted outputs and
 * must not treat this helper as semantic secret detection.
 */
const SECRET_KEY_PARTS = [
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'id_token',
  'idtoken',
  'bearertoken',
  'clientsecret',
  'apikey',
  'privatekey',
  'password',
  'passwd',
  'authorization',
  'cookie',
  'credential',
  'secret',
  'token',
  'oauth',
] as const

const MAX_SCAN_NODES = 10_000
const MAX_SCAN_DEPTH = 64

/** Return true when input contains credential-shaped keys or obvious secrets. */
export function containsSecretShapedData(value: unknown): boolean {
  const ancestors = new Set<object>()
  let visited = 0

  try {
    return scan(value, 0, ancestors)
  } catch {
    // Getters, proxies, and other non-JSON values are unsafe at this boundary.
    return true
  }

  function scan(current: unknown, depth: number, active: Set<object>): boolean {
    if (depth > MAX_SCAN_DEPTH || visited >= MAX_SCAN_NODES) return true
    visited += 1
    if (typeof current === 'string') return looksLikeSecretValue(current)
    if (current === null) return false
    if (typeof current === 'number') return !Number.isFinite(current)
    if (typeof current === 'boolean') return false
    if (typeof current !== 'object') return true

    const objectValue = current as object
    if (active.has(objectValue)) return true
    active.add(objectValue)
    try {
      if (Array.isArray(current)) {
        if (!isDenseArray(current)) return true
        return current.some(item => scan(item, depth + 1, active))
      }

      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) return true
      if (Object.getOwnPropertySymbols(current).length > 0) return true

      const record = current as Record<string, unknown>
      if (Object.getOwnPropertyNames(current).some(key => !Object.prototype.propertyIsEnumerable.call(current, key))) {
        return true
      }
      for (const key of Object.keys(record)) {
        if (isSecretShapedKey(key) || scan(record[key], depth + 1, active)) return true
      }
      return false
    } finally {
      active.delete(objectValue)
    }
  }
}

/**
 * True when any object key anywhere in the value names a tenant identifier.
 * The fixture and live read seams both reject such records: a raw tenant id
 * in a released record would undo the fingerprints-only binding redaction.
 */
export function containsTenantIdentifier(value: unknown): boolean {
  return scanForTenantIdentifier(value, 0)
}

// Depth-bounded like the secret scan: a value too deep to inspect is unsafe,
// not a stack overflow escaping the caller's typed failure boundary.
function scanForTenantIdentifier(value: unknown, depth: number): boolean {
  if (depth > MAX_SCAN_DEPTH) return true
  if (Array.isArray(value)) return value.some(item => scanForTenantIdentifier(item, depth + 1))
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(
    ([key, nested]) => /tenant/i.test(key) || scanForTenantIdentifier(nested, depth + 1),
  )
}

export function isSecretShapedKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, '').toLowerCase()
  return SECRET_KEY_PARTS.some(part => normalized.includes(part.replace(/[-_]/g, '')))
}

function isDenseArray(value: unknown[]): boolean {
  if (Object.getPrototypeOf(value) !== Array.prototype) return false
  if (Object.getOwnPropertySymbols(value).length > 0) return false
  const keys = Object.keys(value)
  const ownNames = Object.getOwnPropertyNames(value)
  return (
    ownNames.length === value.length + 1 &&
    ownNames.includes('length') &&
    keys.length === value.length &&
    keys.every((key, index) => key === String(index))
  )
}

function looksLikeSecretValue(value: string): boolean {
  return (
    /^(?:bearer|basic)\s+\S+/i.test(value) ||
    /^(?:sk|rk|pk)_(?:live|test)_/i.test(value) ||
    /^(?:gh[pousr]|xox[baprs])-/i.test(value) ||
    /^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
  )
}
