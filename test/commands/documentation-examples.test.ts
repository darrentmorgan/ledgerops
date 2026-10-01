import {execFileSync} from 'node:child_process'
import {mkdtempSync, mkdirSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {isolatedEnvironment, inventoryCommands} from '../../scripts/release-check/checks.mjs'

const documents = ['README.md', 'docs/automation.md']
const examples = documents.flatMap(path =>
  [...readFileSync(path, 'utf8').matchAll(/```sh example:([a-z-]+)\n([\s\S]*?)```/g)].map(match => ({
    id: match[1],
    lines: match[2].trim().split('\n'),
  })),
)
const readme = readFileSync('README.md', 'utf8')
const inventory = inventoryCommands(readFileSync('docs/xero-endpoint-inventory.md', 'utf8'))
const reference = [...readme.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1])
let directory: string
let env: NodeJS.ProcessEnv
let invocation = 0

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'ledgerops-docs-'))
  env = isolatedEnvironment(process.env, directory, directory)
  for (const path of [env.HOME, env.XDG_CONFIG_HOME, env.LOCALAPPDATA]) {
    if (!path) throw new Error('Missing isolated directory')
    mkdirSync(path)
  }
})
afterAll(() => rmSync(directory, {recursive: true, force: true}))

function cli(args: string[]): string {
  const report = join(directory, `network-${invocation++}.json`)
  const stdout = execFileSync(
    process.execPath,
    ['--require', resolve('scripts/release-check/network-forbidden.cjs'), resolve('bin/run.js'), ...args],
    {encoding: 'utf8', env: {...env, RELEASE_NETWORK_REPORT: report}},
  )
  expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual({attempts: 0})
  return stdout
}

describe('public documentation against the built CLI', () => {
  it('lists exactly the 59 shipped paths once', () => {
    expect(reference).toHaveLength(59)
    expect(new Set(reference).size).toBe(59)
    expect([...reference].sort()).toEqual([...inventory].sort())
  })

  it.each(inventory)('resolves built help for %s without network access', command => {
    expect(cli([...command.split(' '), '--help'])).toContain('USAGE')
  })

  it.each(
    examples
      .filter(example => example.lines[0].startsWith('ledgerops '))
      .flatMap(example => example.lines.map(line => ({id: example.id, line}))),
  )('executes documented $id: $line', ({id, line}) => {
    expect(line.startsWith('ledgerops ')).toBe(true)
    const output = cli(line.slice('ledgerops '.length).split(' '))
    if (id.endsWith('preview')) {
      const preview = JSON.parse(output)
      expect(preview).toMatchObject({
        schemaVersion: 'ledgerops.mutation-preview.v1',
        operation: 'create',
        resource: 'invoices',
        profile: 'synthetic-docs',
        willDispatch: false,
      })
      expect(preview.payloadDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    } else if (line.endsWith('--help')) expect(output).toContain('USAGE')
  })

  it('accounts for every CLI example block', () => {
    expect(examples.filter(example => example.lines[0].startsWith('ledgerops ')).map(example => example.id)).toEqual([
      'setup-help',
      'synthetic-profile',
      'invoice-preview',
      'automation-preview',
      'target-help',
    ])
  })

  it('binds repository-only examples to their existing execution checks', () => {
    const repositoryExamples = examples.filter(example => !example.lines[0].startsWith('ledgerops '))
    expect(repositoryExamples).toEqual([
      {id: 'offline-demo', lines: ['npm run demo:offline']},
      {id: 'target-rehearsal', lines: ['npx --no-install vitest run test/commands/target.test.ts']},
    ])
    // target.test.ts runs in this same full suite; it is not recursively launched here.
    expect(readFileSync('test/commands/target.test.ts', 'utf8')).toContain('attempts: 0')
  })
})
