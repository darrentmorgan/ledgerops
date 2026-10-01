import {spawnSync} from 'node:child_process'
import {mkdtempSync, mkdirSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {inventoryCommands, isolatedEnvironment} from '../../scripts/release-check/checks.mjs'

const skill = readFileSync('SKILL.md', 'utf8')
const rows = [...skill.matchAll(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \|$/gm)].map(match => ({
  command: match[1],
  group: match[2].trim(),
  inputs: match[3].trim(),
}))
const examples = [...skill.matchAll(/```sh example:([a-z-]+)\n([\s\S]*?)```/g)].map(match => ({
  id: match[1],
  line: match[2].trim(),
}))
let directory: string
let env: NodeJS.ProcessEnv
let invocation = 0
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'ledgerops-skill-'))
  env = isolatedEnvironment(process.env, directory, directory)
  for (const path of [env.HOME, env.XDG_CONFIG_HOME, env.LOCALAPPDATA]) {
    if (!path) throw new Error('Missing isolated directory')
    mkdirSync(path)
  }
})
afterAll(() => rmSync(directory, {recursive: true, force: true}))

function cli(args: string[]) {
  const report = join(directory, `network-${invocation++}.json`)
  const result = spawnSync(
    process.execPath,
    ['--require', resolve('scripts/release-check/network-forbidden.cjs'), resolve('bin/run.js'), ...args],
    {encoding: 'utf8', env: {...env, RELEASE_NETWORK_REPORT: report}},
  )
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual({attempts: 0})
  return result
}

describe('agent adapter contract', () => {
  it('covers all shipped commands once and only the supported groups', () => {
    expect(rows).toHaveLength(59)
    expect(new Set(rows.map(row => row.command)).size).toBe(59)
    expect(rows.map(row => row.command).sort()).toEqual(
      inventoryCommands(readFileSync('docs/xero-endpoint-inventory.md', 'utf8')).sort(),
    )
    const counts: Record<string, number> = {}
    for (const row of rows) counts[row.group] = (counts[row.group] ?? 0) + 1
    expect(counts).toEqual({
      Mutation: 20,
      Batch: 1,
      Array: 15,
      Object: 4,
      Report: 5,
      PDF: 4,
      'Local/auth': 6,
      Target: 4,
    })
    expect(skill).not.toMatch(/\bxero\b|client workflows/i)
    expect(examples.map(example => example.id)).toEqual(['skill-profile', 'skill-preview', 'skill-read-help'])
  })

  it.each(rows)('lists only built inputs and correct execution flags for $command', async row => {
    const command = (
      await import(pathToFileURL(resolve('dist/commands', row.command.replaceAll(' ', '/') + '.js')).href)
    ).default
    const declared = command.flags ?? {}
    for (const flag of row.inputs.match(/--[a-z][a-z0-9-]*/g) ?? []) expect(declared).toHaveProperty(flag.slice(2))
    for (const argument of row.inputs.matchAll(/&lt;([^&]+)&gt;/g)) expect(command.args).toHaveProperty(argument[1])
    if (['Mutation', 'Batch'].includes(row.group)) {
      expect(declared).toHaveProperty('execute')
      expect(declared).toHaveProperty('yes')
      expect(declared).toHaveProperty('json')
    } else expect(declared).not.toHaveProperty('execute')
    if (row.group === 'Target') expect(declared).not.toHaveProperty('json')
  })

  it.each(examples)('runs the documented $id without credentials or network', example => {
    expect(example.line.startsWith('ledgerops ')).toBe(true)
    const result = cli(example.line.slice('ledgerops '.length).split(' '))
    expect(result.status).toBe(0)
    if (example.id === 'skill-preview') {
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 'ledgerops.mutation-preview.v1',
        profile: 'synthetic-skill',
        willDispatch: false,
      })
    } else if (example.id === 'skill-read-help') expect(result.stdout).toContain('USAGE')
    else expect(result.stdout).toContain('added successfully')
  })

  it.each(rows.filter(row => row.group === 'PDF'))('$command refuses JSON before any API call', row => {
    const result = cli([...row.command.split(' '), '--json'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('not supported')
    expect(result.stdout).toBe('')
  })

  it.each(rows.filter(row => row.group === 'Target'))('$command does not accept a generic JSON flag', row => {
    const result = cli([...row.command.split(' '), '--json'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Nonexistent flag: --json')
  })

  it('keeps local profile listing human-readable', () => {
    const result = cli(['profile', 'list'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('synthetic-skill')
    expect(() => JSON.parse(result.stdout)).toThrow()
  })
})
