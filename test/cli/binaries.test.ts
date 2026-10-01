import {execFileSync} from 'node:child_process'
import {mkdtempSync, mkdirSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
import {isolatedEnvironment} from '../../scripts/release-check/checks.mjs'

describe('public executable', () => {
  it('declares only the ledgerops executable and no aliases', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(pkg.name).toBe('ledgerops')
    expect(pkg.bin).toEqual({ledgerops: 'bin/run.js'})
    expect(pkg.oclif.bin).toBe('ledgerops')
    expect(pkg.oclif.binAliases).toBeUndefined()
  })

  it('prints help without ambient credentials', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ledgerops-help-'))
    try {
      // Preserve reviewed Windows execution plumbing, including ComSpec-derived
      // SHELL, so Oclif does not probe the parent through PowerShell/CIM.
      const env = isolatedEnvironment(process.env, directory, directory)
      for (const path of [env.HOME, env.XDG_CONFIG_HOME, env.LOCALAPPDATA]) mkdirSync(path)
      const networkReport = join(directory, 'network.json')
      const output = execFileSync(
        process.execPath,
        ['--require', './scripts/release-check/network-forbidden.cjs', 'bin/run.js', '--help'],
        {
          encoding: 'utf8',
          timeout: 60_000,
          env: {...env, NODE_ENV: 'production', RELEASE_NETWORK_REPORT: networkReport},
        },
      )
      expect(output).toContain('ledgerops')
      expect(JSON.parse(readFileSync(networkReport, 'utf8'))).toEqual({attempts: 0})
    } finally {
      rmSync(directory, {recursive: true, force: true})
    }
  }, 65_000)
})
