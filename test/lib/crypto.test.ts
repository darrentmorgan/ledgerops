import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import {chmodSync, mkdirSync, rmSync, readFileSync, existsSync, statSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'

const TEST_DIR = join(tmpdir(), `xero-crypto-test-${Date.now()}`)

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => TEST_DIR,
  }
})

vi.mock('@napi-rs/keyring', () => ({
  Entry: class MockEntry {
    static store: string | null = null
    static constructedWith: Array<{service: string; account: string}> = []
    constructor(service: string, account: string) {
      MockEntry.constructedWith.push({service, account})
    }
    getPassword() {
      return MockEntry.store
    }
    setPassword(value: string) {
      MockEntry.store = value
    }
    deletePassword() {
      MockEntry.store = null
    }
  },
}))

const {
  getOrCreateKey,
  encrypt,
  decrypt,
  hasEncryptedTokens,
  EncryptionKeyError,
  PASSPHRASE_ENV,
  KEY_STORAGE_ENV,
  FILE_BACKUP_ENV,
} = await import('../../src/lib/crypto.js')

const {getConfigDir} = await import('../../src/lib/config-paths.js')

const CONFIG_DIR = getConfigDir()
const FILE_KEY_PATH = join(CONFIG_DIR, '.encryption-key')
const SALT_PATH = join(CONFIG_DIR, '.encryption-key.salt')
const TOKEN_PATH = join(CONFIG_DIR, 'tokens.json')

describe('crypto key storage', () => {
  beforeEach(async () => {
    delete process.env[PASSPHRASE_ENV]
    delete process.env[KEY_STORAGE_ENV]
    delete process.env[FILE_BACKUP_ENV]
    mkdirSync(CONFIG_DIR, {recursive: true})
    const {Entry} = await import('@napi-rs/keyring')
    Entry.store = null
    Entry.constructedWith = []
  })

  afterEach(() => {
    rmSync(TEST_DIR, {recursive: true, force: true})
  })

  it('stores key in keyring only by default (no file backup)', async () => {
    const key = await getOrCreateKey()
    expect(existsSync(FILE_KEY_PATH)).toBe(false)
    const {Entry} = await import('@napi-rs/keyring')
    expect(Entry.store).toBe(key.toString('base64'))
    const roundTrip = encrypt('secret', key)
    expect(decrypt(roundTrip, key)).toBe('secret')
  })

  it('writes file backup when XERO_KEYRING_FILE_BACKUP is enabled', async () => {
    process.env[FILE_BACKUP_ENV] = '1'
    await getOrCreateKey()
    expect(existsSync(FILE_KEY_PATH)).toBe(true)
    const {Entry} = await import('@napi-rs/keyring')
    expect(Entry.store).not.toBeNull()
  })

  it('reads file backup when keyring is empty and backup is enabled', async () => {
    process.env[FILE_BACKUP_ENV] = '1'
    const first = await getOrCreateKey()
    const {Entry} = await import('@napi-rs/keyring')
    Entry.store = null
    const second = await getOrCreateKey()
    expect(second.equals(first)).toBe(true)
  })

  it('does not read file backup when backup is disabled', async () => {
    process.env[FILE_BACKUP_ENV] = '1'
    await getOrCreateKey()
    const {Entry} = await import('@napi-rs/keyring')
    Entry.store = null
    delete process.env[FILE_BACKUP_ENV]
    writeFileSync(
      TOKEN_PATH,
      JSON.stringify({regan: {accessToken: 'x', refreshToken: 'y', expiresAt: 0, tenantId: 't'}}),
      {
        mode: 0o600,
      },
    )
    await expect(getOrCreateKey()).rejects.toBeInstanceOf(EncryptionKeyError)
  })

  it('throws instead of creating a new key when tokens exist but no key is found', async () => {
    writeFileSync(
      TOKEN_PATH,
      JSON.stringify({regan: {accessToken: 'x', refreshToken: 'y', expiresAt: 0, tenantId: 't'}}),
      {
        mode: 0o600,
      },
    )
    const {Entry} = await import('@napi-rs/keyring')
    Entry.store = null
    rmSync(FILE_KEY_PATH, {force: true})
    await expect(getOrCreateKey()).rejects.toBeInstanceOf(EncryptionKeyError)
    expect(hasEncryptedTokens()).toBe(true)
  })

  it('derives a stable key from XERO_TOKEN_PASSPHRASE', async () => {
    process.env[PASSPHRASE_ENV] = 'test-passphrase'
    const a = await getOrCreateKey()
    const b = await getOrCreateKey()
    expect(a.equals(b)).toBe(true)
    expect(existsSync(join(CONFIG_DIR, '.encryption-key.salt'))).toBe(true)
  })

  it('uses file-only storage when XERO_KEY_STORAGE=file', async () => {
    process.env[KEY_STORAGE_ENV] = 'file'
    await getOrCreateKey()
    const {Entry} = await import('@napi-rs/keyring')
    expect(Entry.store).toBeNull()
    expect(readFileSync(FILE_KEY_PATH, 'utf-8').length).toBeGreaterThan(0)
  })

  // Windows chmod does not expose POSIX owner/group mode bits.
  it.skipIf(process.platform === 'win32')(
    'repairs permissive modes on an existing config directory and file key',
    async () => {
      process.env[KEY_STORAGE_ENV] = 'file'
      const key = await getOrCreateKey()
      chmodSync(CONFIG_DIR, 0o777)
      chmodSync(FILE_KEY_PATH, 0o666)
      expect((await getOrCreateKey()).equals(key)).toBe(true)
      expect(statSync(CONFIG_DIR).mode & 0o777).toBe(0o700)
      expect(statSync(FILE_KEY_PATH).mode & 0o777).toBe(0o600)
    },
  )

  // Windows chmod does not expose POSIX owner/group mode bits.
  it.skipIf(process.platform === 'win32')(
    'repairs permissive modes on existing token and passphrase-salt files',
    async () => {
      process.env[PASSPHRASE_ENV] = 'synthetic-passphrase'
      await getOrCreateKey()
      writeFileSync(TOKEN_PATH, '{}', {mode: 0o666})
      chmodSync(CONFIG_DIR, 0o777)
      chmodSync(SALT_PATH, 0o666)
      chmodSync(TOKEN_PATH, 0o666)
      await getOrCreateKey()
      hasEncryptedTokens()
      expect(statSync(CONFIG_DIR).mode & 0o777).toBe(0o700)
      expect(statSync(SALT_PATH).mode & 0o777).toBe(0o600)
      expect(statSync(TOKEN_PATH).mode & 0o777).toBe(0o600)
    },
  )

  it('creates the config directory on a fresh install before writing the file key', async () => {
    process.env[KEY_STORAGE_ENV] = 'file'
    rmSync(TEST_DIR, {recursive: true, force: true})
    const key = await getOrCreateKey()
    expect(existsSync(CONFIG_DIR)).toBe(true)
    expect(existsSync(FILE_KEY_PATH)).toBe(true)
    expect(key.length).toBe(32)
  })

  it('creates the config directory on a fresh install before writing the passphrase salt', async () => {
    process.env[PASSPHRASE_ENV] = 'fresh-install-passphrase'
    rmSync(TEST_DIR, {recursive: true, force: true})
    const key = await getOrCreateKey()
    expect(existsSync(CONFIG_DIR)).toBe(true)
    expect(existsSync(SALT_PATH)).toBe(true)
    expect(key.length).toBe(32)
  })

  it('keeps constructing keyring entries with the historical service name', async () => {
    await getOrCreateKey()
    const {Entry} = await import('@napi-rs/keyring')
    const services = new Set(Entry.constructedWith.map(call => call.service))
    expect(services).toEqual(new Set(['xero-command-line']))
  })
})
