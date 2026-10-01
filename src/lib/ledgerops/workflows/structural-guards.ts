/**
 * Structural boundary guards shared by the ledgerops workflows.
 *
 * These are deliberately not exported through the kernel barrel: they are an
 * internal implementation detail of the workflow boundary, not public surface.
 */

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    return (
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
      Object.getOwnPropertySymbols(value).length === 0
    )
  } catch {
    return false
  }
}

export function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) return false
    const keys = Object.keys(value)
    return keys.length === value.length && keys.every((key, index) => key === String(index))
  } catch {
    return false
  }
}
