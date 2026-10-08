import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import {existsSync, mkdirSync, readFileSync, rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomBytes} from 'node:crypto'
import {spawnSync} from 'node:child_process'

const TEST_DIR = join(tmpdir(), `xero-auth-decrypt-test-${Date.now()}`)
const TEST_KEY = randomBytes(32)
const WRONG_KEY = randomBytes(32)

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => TEST_DIR,
  }
})

let useWrongKey = false
let useRealKeyStorage = false

vi.mock('@napi-rs/keyring', () => ({
  Entry: class UnavailableKeyring {
    getPassword() {
      throw new Error('Synthetic keyring read failure')
    }
    setPassword() {
      throw new Error('Synthetic keyring write failure')
    }
  },
}))

vi.mock('../../src/lib/crypto.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/crypto.js')>('../../src/lib/crypto.js')
  return {
    ...actual,
    getOrCreateKey: async () => (useRealKeyStorage ? actual.getOrCreateKey() : useWrongKey ? WRONG_KEY : TEST_KEY),
    encrypt: (plaintext: string, key: Buffer) => actual.encrypt(plaintext, key),
    decrypt: (encoded: string, key: Buffer) => actual.decrypt(encoded, key),
  }
})

// Discovery on a fresh home resolves to the preferred LedgerOps directory.
const CONFIG_DIR = join(TEST_DIR, '.config', 'ledgerops')
const TOKEN_PATH = join(CONFIG_DIR, 'tokens.json')

const {cacheTokenSet, getCachedTokenSet} = await import('../../src/lib/auth.js')
const {EncryptionKeyError, KEY_STORAGE_ENV, FILE_BACKUP_ENV, PASSPHRASE_ENV} = await import('../../src/lib/crypto.js')

describe('auth decrypt failures', () => {
  beforeEach(() => {
    useWrongKey = false
    useRealKeyStorage = false
    vi.stubEnv(KEY_STORAGE_ENV, undefined)
    vi.stubEnv(FILE_BACKUP_ENV, undefined)
    vi.stubEnv(PASSPHRASE_ENV, undefined)
    mkdirSync(CONFIG_DIR, {recursive: true})
  })

  afterEach(() => {
    rmSync(TEST_DIR, {recursive: true, force: true})
    vi.unstubAllEnvs()
  })

  it('does not delete tokens when decryption fails', async () => {
    await cacheTokenSet(
      'regan',
      {access_token: 'tok', refresh_token: 'ref', expires_in: 1800},
      'tenant-1',
      undefined,
      'synthetic-client',
    )
    useWrongKey = true

    await expect(getCachedTokenSet('regan', 'synthetic-client')).rejects.toBeInstanceOf(EncryptionKeyError)

    const cache = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8')) as Record<string, unknown>
    expect(cache.regan).toBeDefined()
  })

  it.each(['auto', 'keyring'])('does not cache tokens when %s key storage fails', async mode => {
    useRealKeyStorage = true
    if (mode === 'keyring') process.env[KEY_STORAGE_ENV] = mode

    await expect(
      cacheTokenSet(
        'synthetic-profile',
        {access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 1800},
        'synthetic-tenant',
        undefined,
        'synthetic-client',
      ),
    ).rejects.toBeInstanceOf(EncryptionKeyError)
    expect(existsSync(TOKEN_PATH)).toBe(false)
    expect(existsSync(join(CONFIG_DIR, '.encryption-key'))).toBe(false)
  })

  it.each(['file', 'passphrase'])('recovers cached tokens in a new process using %s storage', mode => {
    const script = `
      import os from 'node:os'
      import {syncBuiltinESMExports} from 'node:module'
      os.homedir = () => process.argv[2]
      syncBuiltinESMExports()
      const {cacheTokenSet, getCachedTokenSet} = await import(${JSON.stringify(new URL('../../src/lib/auth.ts', import.meta.url).href)})
      if (process.argv[1] === 'write') {
        await cacheTokenSet('synthetic-profile', {
          access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 1800,
        }, 'synthetic-tenant', undefined, 'synthetic-client')
      } else {
        console.log(JSON.stringify(await getCachedTokenSet('synthetic-profile', 'synthetic-client')))
      }
    `
    const env = {
      ...process.env,
      [KEY_STORAGE_ENV]: mode === 'file' ? 'file' : 'keyring',
      [FILE_BACKUP_ENV]: '0',
      [PASSPHRASE_ENV]: mode === 'passphrase' ? 'synthetic-process-passphrase' : '',
    }
    const run = (operation: string) =>
      spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script, operation, TEST_DIR], {
        env,
        encoding: 'utf-8',
        timeout: 10_000,
      })

    const write = run('write')
    expect(write.error).toBeUndefined()
    expect(write.stderr).toBe('')
    expect(write.status).toBe(0)
    const read = run('read')
    expect(read.error).toBeUndefined()
    expect(read.stderr).toBe('')
    expect(read.status).toBe(0)
    expect(JSON.parse(read.stdout)).toMatchObject({
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
      tenantId: 'synthetic-tenant',
    })
    expect(existsSync(join(CONFIG_DIR, '.encryption-key'))).toBe(mode === 'file')
    expect(existsSync(join(CONFIG_DIR, '.encryption-key.salt'))).toBe(mode === 'passphrase')
  })
})
