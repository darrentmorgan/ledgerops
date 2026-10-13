/**
 * Structural boundary guards shared by the ledgerops kernel and workflows.
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

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function requireLabel(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`)
  return value.trim()
}

export function requireTimestamp(value: number, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${field} must be finite`)
}
