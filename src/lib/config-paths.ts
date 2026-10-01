import {existsSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'

export const LEDGEROPS_CONFIG_DIR = 'ledgerops'
export const LEGACY_XERO_CONFIG_DIR = 'xero-command-line'

/** New LedgerOps config directory, the preferred location. */
export function preferredConfigDir(home: string = homedir()): string {
  return join(home, '.config', LEDGEROPS_CONFIG_DIR)
}

/** Historical Xero CLI config directory kept readable for existing installs. */
export function legacyXeroConfigDir(home: string = homedir()): string {
  return join(home, '.config', LEGACY_XERO_CONFIG_DIR)
}

function isConfigured(dir: string): boolean {
  return existsSync(join(dir, 'config.json'))
}

/**
 * Config discovery adapter: prefer the new LedgerOps directory once it holds a
 * config.json, fall back to the historical Xero directory while it is the one
 * actually configured — so an existing-but-unconfigured preferred directory
 * cannot silently orphan legacy profiles — and default to the new directory on
 * fresh installs. Discovery never migrates or writes anything itself.
 */
export function getConfigDir(home: string = homedir()): string {
  const preferred = preferredConfigDir(home)
  const legacy = legacyXeroConfigDir(home)
  if (!isConfigured(preferred) && isConfigured(legacy)) {
    return legacy
  }
  return preferred
}
