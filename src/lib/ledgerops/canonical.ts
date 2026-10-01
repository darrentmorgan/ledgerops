import {createHash} from 'node:crypto'

export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | {[key: string]: JsonValue}
export type Digest = string

/**
 * Produce the small, deterministic JSON subset used by the LedgerOps kernel.
 * Objects are ordered by key; arrays retain their order. Unsupported values are
 * rejected instead of being silently dropped by JSON.stringify.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set<object>())
}

export function sha256(value: string): Digest {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function digestJson(value: unknown): Digest {
  return sha256(canonicalJson(value))
}

/** Clone through the canonical representation so callers cannot mutate inputs. */
export function cloneCanonical<T>(value: T): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue
}

/** Deep-freeze JSON-shaped values. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child)
    }
  }
  return value
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('Canonical JSON does not support non-finite numbers')
      }
      return Object.is(value, -0) ? '0' : JSON.stringify(value)
    case 'object':
      break
    default:
      throw new TypeError(`Canonical JSON does not support ${typeof value}`)
  }

  if (ancestors.has(value as object)) {
    throw new TypeError('Canonical JSON does not support circular values')
  }

  const objectValue = value as object
  ancestors.add(objectValue)
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value)
      if (Object.getOwnPropertySymbols(value).length > 0 || keys.some(key => !isArrayIndex(key))) {
        throw new TypeError('Canonical JSON arrays cannot have extra properties')
      }
      const items: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError('Canonical JSON does not support sparse arrays')
        }
        items.push(serialize(value[index], ancestors))
      }
      return `[${items.join(',')}]`
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON only supports plain objects and arrays')
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('Canonical JSON does not support symbol keys')
    }
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${serialize(record[key], ancestors)}`).join(',')}}`
  } finally {
    ancestors.delete(objectValue)
  }
}

function isArrayIndex(value: string): boolean {
  const index = Number(value)
  return Number.isInteger(index) && index >= 0 && index < 4294967295 && String(index) === value
}
