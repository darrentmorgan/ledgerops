import {describe, it, expect, afterEach} from 'vitest'
import {mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'

import {
  getConfigDir,
  legacyXeroConfigDir,
  preferredConfigDir,
  LEDGEROPS_CONFIG_DIR,
  LEGACY_XERO_CONFIG_DIR,
} from '../../src/lib/config-paths.js'

const HOME_ROOTS: string[] = []

function fakeHome(): string {
  const home = join(tmpdir(), `ledgerops-config-paths-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  HOME_ROOTS.push(home)
  return home
}

function configure(dir: string, profile: string): void {
  mkdirSync(dir, {recursive: true})
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      defaultProfile: profile,
      profiles: {[profile]: {clientId: 'synthetic-client-id'}},
    }),
  )
}

afterEach(() => {
  for (const home of HOME_ROOTS.splice(0)) {
    rmSync(home, {recursive: true, force: true})
  }
})

describe('config path adapter', () => {
  it('names the new LedgerOps directory as preferred', () => {
    expect(LEDGEROPS_CONFIG_DIR).toBe('ledgerops')
    expect(LEGACY_XERO_CONFIG_DIR).toBe('xero-command-line')
    expect(preferredConfigDir('/home/u')).toBe(join('/home/u', '.config', 'ledgerops'))
    expect(legacyXeroConfigDir('/home/u')).toBe(join('/home/u', '.config', 'xero-command-line'))
  })

  it('defaults to the LedgerOps directory on a fresh machine', () => {
    const home = fakeHome()
    expect(getConfigDir(home)).toBe(preferredConfigDir(home))
  })

  it('reads the legacy Xero directory when only it is configured', () => {
    const home = fakeHome()
    configure(legacyXeroConfigDir(home), 'legacy-profile')
    expect(getConfigDir(home)).toBe(legacyXeroConfigDir(home))
  })

  it('treats an existing but unconfigured directory as absent', () => {
    const home = fakeHome()
    mkdirSync(legacyXeroConfigDir(home), {recursive: true})
    expect(getConfigDir(home)).toBe(preferredConfigDir(home))
  })

  it('does not let an empty preferred directory orphan a populated legacy one', () => {
    const home = fakeHome()
    configure(legacyXeroConfigDir(home), 'legacy-profile')
    mkdirSync(preferredConfigDir(home), {recursive: true})
    expect(getConfigDir(home)).toBe(legacyXeroConfigDir(home))
  })

  it('prefers the LedgerOps directory when both are configured', () => {
    const home = fakeHome()
    configure(legacyXeroConfigDir(home), 'legacy-profile')
    configure(preferredConfigDir(home), 'new-profile')
    expect(getConfigDir(home)).toBe(preferredConfigDir(home))
  })

  it('switches to the LedgerOps directory once it is configured and keeps preferring it', () => {
    const home = fakeHome()
    configure(legacyXeroConfigDir(home), 'legacy-profile')
    expect(getConfigDir(home)).toBe(legacyXeroConfigDir(home))
    configure(preferredConfigDir(home), 'new-profile')
    expect(getConfigDir(home)).toBe(preferredConfigDir(home))
  })
})
