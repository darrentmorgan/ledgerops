import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {delimiter, dirname, join, resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {guardNodeOptions, isolatedEnvironment} from './release-check/checks.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(tmpdir(), 'ledgerops-package-smoke-'))
const prefix = join(scratch, 'install')
const home = join(scratch, 'home')
const attempts = join(scratch, 'attempts.log')
const networkReport = join(scratch, 'network.json')
const guard = join(repo, 'scripts', 'package-smoke-guard.mjs')
const networkGuard = join(repo, 'scripts', 'release-check', 'network-forbidden.cjs')
const PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH}`
assert.ok(process.env.npm_execpath, 'Run this script with npm run pack:smoke')
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(XERO_|LEDGEROPS_|NODE_OPTIONS$|NPM_CONFIG_|npm_config_)/i.test(key),
  ),
)
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, 'appdata'),
  LOCALAPPDATA: join(home, 'localappdata'),
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_CACHE_HOME: join(home, '.cache'),
  XDG_DATA_HOME: join(home, '.local', 'share'),
  npm_config_cache: join(scratch, 'npm-cache'),
  npm_config_userconfig: join(scratch, 'npmrc'),
  npm_config_globalconfig: join(scratch, 'global-npmrc'),
  NO_COLOR: '1',
  PATH,
})
function run(command, args, {status = 0, ...options} = {}) {
  const result = spawnSync(command, args, {
    cwd: scratch,
    env,
    encoding: 'utf8',
    timeout: 180_000,
    ...options,
  })
  if (result.error) throw result.error
  assert.equal(result.status, status, `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
function runNpm(args, options) {
  return run(process.execPath, [process.env.npm_execpath, ...args], options)
}

try {
  mkdirSync(home)
  mkdirSync(prefix)
  // Run lifecycle scripts explicitly so pack JSON is not mixed with their output.
  runNpm(['run', 'prepack'], {cwd: repo})
  const [pack] = JSON.parse(runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], {cwd: repo}))
  runNpm([
    'install',
    '--prefix',
    prefix,
    '--global=false',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    join(scratch, pack.filename),
  ])
  const bin = join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'ledgerops.cmd' : 'ledgerops')
  assert.ok(existsSync(bin), 'npm did not install the ledgerops executable')
  const cliWork = join(scratch, 'cli')
  const cliEnv = {
    ...isolatedEnvironment({...process.env, PATH}, cliWork),
    NODE_OPTIONS: `${guardNodeOptions(networkGuard)} --import=${pathToFileURL(guard).href}`,
    LEDGEROPS_SMOKE_ATTEMPTS: attempts,
    RELEASE_NETWORK_REPORT: networkReport,
  }
  for (const path of [cliEnv.HOME, cliEnv.XDG_CONFIG_HOME, cliEnv.LOCALAPPDATA, cliEnv.TMP]) {
    mkdirSync(path, {recursive: true})
  }
  // Prove the guard detects even swallowed attempts without contacting any service.
  run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import fs from 'node:fs'; import net from 'node:net'; import {join} from 'node:path';
       for (const probe of [
         () => fetch('https://example.invalid'),
         () => new net.Socket().connect(443, 'example.invalid'),
         () => fs.readFileSync(join(process.env.HOME, '.config', 'ledgerops', 'tokens.json')),
         () => import('@napi-rs/keyring'),
       ]) { try { await probe() } catch {} }`,
    ],
    {env: cliEnv, status: 1},
  )
  assert.deepEqual(JSON.parse(readFileSync(networkReport, 'utf8')), {attempts: 2})
  assert.deepEqual(readFileSync(attempts, 'utf8').trim().split('\n'), ['credential:file', 'credential:keyring'])
  rmSync(attempts)
  for (const [args, expected] of [
    [['--help'], /USAGE[\s\S]*ledgerops/],
    [['invoices', 'create', '--help'], /--execute/],
  ]) {
    const output = run(process.platform === 'win32' ? `"${bin}"` : bin, args, {
      env: cliEnv,
      shell: process.platform === 'win32',
    })
    assert.match(output, expected, `Missing expected help for ${args.join(' ')}`)
    assert.deepEqual(JSON.parse(readFileSync(networkReport, 'utf8')), {attempts: 0})
    assert.ok(!existsSync(attempts), existsSync(attempts) ? readFileSync(attempts, 'utf8') : '')
    console.log(`Installed ledgerops ${args.join(' ')}: passed (no credential or network calls)`)
  }
} finally {
  try {
    runNpm(['run', 'postpack'], {cwd: repo})
  } finally {
    rmSync(scratch, {recursive: true, force: true})
  }
}
