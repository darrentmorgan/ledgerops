import {describe, expect, it} from 'vitest'
import {buildImplementedCommands, collectCommandSources} from '../../src/lib/inventory/scanner.js'
import {TARGET_CAPABILITIES} from '../../src/lib/inventory/targets.js'
import {buildInventory, renderInventory} from '../../src/lib/inventory/render.js'
import type {ImplementedCommand, TargetCapability} from '../../src/lib/inventory/types.js'
import {join, dirname} from 'node:path'
import {fileURLToPath} from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function cmd(command: string, overrides: Partial<ImplementedCommand> = {}): ImplementedCommand {
  const [domain] = command.split(' ')
  return {command, domain, surface: 'direct-xero', action: 'read', xeroMethods: [], ...overrides}
}

function target(domain: string, overrides: Partial<TargetCapability> = {}): TargetCapability {
  return {
    domain,
    resource: domain,
    actions: ['delete/archive'],
    phase: 'tier-2-write',
    source: 'test',
    ...overrides,
  }
}

describe('command classification', () => {
  it('classifies direct-Xero actions by their explicit full command paths', () => {
    const commands = buildImplementedCommands({
      sources: new Map([
        ['invoices list', 'xero.accountingApi.getInvoices(t)'],
        ['contacts create', 'xero.accountingApi.createContacts(t)'],
        ['invoices update', 'xero.accountingApi.updateInvoice(t)'],
      ]),
    })
    expect(commands.map(c => [c.command, c.action])).toEqual([
      ['contacts create', 'create'],
      ['invoices list', 'read'],
      ['invoices update', 'update'],
    ])
  })

  it('maps login and logout to the auth domain as local surface', () => {
    const commands = buildImplementedCommands({
      sources: new Map([
        ['login', 'open("https://login.xero.com")'],
        ['logout', 'clearTokens()'],
      ]),
    })
    expect(commands.map(c => [c.domain, c.surface])).toEqual([
      ['auth', 'local'],
      ['auth', 'local'],
    ])
    expect(commands.every(c => c.xeroMethods.length === 0)).toBe(true)
  })

  it('marks kernel and offline surfaces without forcing a CRUD action', () => {
    const commands = buildImplementedCommands({
      sources: new Map([['target plan', 'buildPlan()']]),
    })
    const byName = new Map(commands.map(c => [c.command, c]))
    expect(byName.get('target plan')).toMatchObject({surface: 'kernel', action: null})
  })

  it('merges tracking categories and options with their target domains', () => {
    const commands = buildImplementedCommands({
      sources: new Map([
        ['tracking categories create', 'xero.accountingApi.createTrackingCategory(tenantId)'],
        ['tracking categories list', 'xero.accountingApi.getTrackingCategories(tenantId)'],
        ['tracking options update', 'xero.accountingApi.updateTrackingOptions(tenantId)'],
      ]),
    })
    const inventory = buildInventory(commands, TARGET_CAPABILITIES)

    const categories = inventory.domains.find(d => d.domain === 'tracking-categories')
    expect(categories?.implemented.map(c => c.command)).toEqual([
      'tracking categories create',
      'tracking categories list',
    ])
    expect(categories?.targets.map(t => t.resource)).toEqual(['TrackingCategories'])

    const options = inventory.domains.find(d => d.domain === 'tracking-options')
    expect(options?.implemented.map(c => c.command)).toEqual(['tracking options update'])
    expect(options?.targets.map(t => t.resource)).toEqual(['TrackingOptions'])

    // No orphan "tracking" domain remains for the merged topics.
    expect(inventory.domains.find(d => d.domain === 'tracking' && d.targets.length > 0)).toBeUndefined()
    expect(
      inventory.domains.some(
        d => d.domain === 'tracking-categories' && d.implemented.length > 0 && d.targets.length > 0,
      ),
    ).toBe(true)
  })

  it('keeps known auth top-level files local but fails closed on unknown ones', () => {
    const local = buildImplementedCommands({sources: new Map([['login', 'open("https://login.xero.com")']])})
    expect(local).toEqual([{command: 'login', domain: 'auth', surface: 'local', action: null, xeroMethods: []}])

    // A familiar verb in an unregistered domain still needs an explicit decision.
    expect(() => buildImplementedCommands({sources: new Map([['widgets list', '']])})).toThrowError(
      /Unclassified direct-Xero command file/,
    )

    // Unknown non-CRUD top-level files cannot silently become auth/local.
    expect(() => buildImplementedCommands({sources: new Map([['frobnicate', 'doMagic()']])})).toThrowError(
      /Unclassified direct-Xero command file/,
    )
  })

  it('fails closed on an unknown direct-Xero command file name', () => {
    expect(() => buildImplementedCommands({sources: new Map([['invoices frobnicate', '']])})).toThrowError(
      /Unclassified direct-Xero command file/,
    )
  })

  it.each([
    'payments batch',
    'widgets batch',
    'tracking options batch',
    'invoices nested batch',
    'widgets create',
    'widgets update',
    'widgets list',
    'widgets delete',
  ])('fails closed for unregistered action path %s', command => {
    expect(() => buildImplementedCommands({sources: new Map([[command, '']])})).toThrowError(
      /Unclassified direct-Xero command file/,
    )
  })

  it('retains invoices batch as the explicitly registered kernel create command', () => {
    expect(buildImplementedCommands({sources: new Map([['invoices batch', '']])})).toEqual([
      {command: 'invoices batch', domain: 'invoices', surface: 'kernel', action: 'create', xeroMethods: []},
    ])
  })
})

describe('target capability registry', () => {
  it('only contains entries with valid phases and actions, sorted by domain', () => {
    const phases = new Set(['tier-0-read', 'tier-1-draft', 'tier-2-write', 'deferred'])
    for (let i = 1; i < TARGET_CAPABILITIES.length; i++) {
      expect(TARGET_CAPABILITIES[i - 1].domain <= TARGET_CAPABILITIES[i].domain).toBe(true)
    }
    for (const entry of TARGET_CAPABILITIES) {
      expect(phases.has(entry.phase)).toBe(true)
      expect(entry.actions.length).toBeGreaterThan(0)
      expect(entry.resource.length).toBeGreaterThan(0)
      expect(entry.source).toMatch(/ADR-0012|roadmap-v2/)
    }
  })
})

describe('grouping and rendering', () => {
  const commands = [
    cmd('invoices list'),
    cmd('contacts create'),
    cmd('target read', {domain: 'target', surface: 'kernel', action: 'read'}),
  ]
  const targets = [
    target('invoices', {resource: 'Invoices'}),
    target('payroll', {phase: 'deferred', actions: ['read', 'create']}),
  ]

  it('merges implemented and target domains and counts phases', () => {
    const inventory = buildInventory(commands, targets)
    const invoiceDomain = inventory.domains.find(d => d.domain === 'invoices')
    expect(invoiceDomain?.implemented.map(c => c.command)).toEqual(['invoices list'])
    expect(invoiceDomain?.targets.map(t => t.resource)).toEqual(['Invoices'])

    const deferred = inventory.phases.find(p => p.phase === 'deferred')
    expect(deferred?.targets).toBe(1)
    // Phase rows count pending targets only; no implemented field exists to drift.
    expect(inventory.phases.every(p => !('implemented' in p))).toBe(true)
  })

  it('renders deterministic output with no timestamps', () => {
    const first = renderInventory(buildInventory(commands, targets))
    const second = renderInventory(buildInventory([...commands].reverse(), [...targets].reverse()))
    expect(first).toEqual(second)
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(first).toContain('# Xero endpoint inventory')
    expect(first).toContain('**Target rows are planned capabilities and are NOT yet implemented**')
  })

  it('renders target rows with explicit not-implemented labels', () => {
    const output = renderInventory(buildInventory([], [target('payroll', {phase: 'deferred'})]))
    expect(output).toContain('Target — not yet implemented')
    expect(output).toContain('_No implemented commands._')
  })
})

describe('repository command tree', () => {
  it('collects every real command source under src/commands', async () => {
    const sources = await collectCommandSources(join(REPO_ROOT, 'src', 'commands'))
    expect(sources.has('invoices list')).toBe(true)
    expect(sources.has('tracking categories create')).toBe(true)
    expect(sources.has('org details')).toBe(true)
    // No index files or non-command modules leak into the map.
    for (const name of sources.keys()) {
      expect(name.endsWith(' index')).toBe(false)
    }
  })

  it('classifies the whole implemented surface without error and reports zero deletes', async () => {
    const sources = await collectCommandSources(join(REPO_ROOT, 'src', 'commands'))
    const commands = buildImplementedCommands({sources})
    const inventory = buildInventory(commands, TARGET_CAPABILITIES)
    const rendered = renderInventory(inventory)

    expect(commands.length).toBe(sources.size)
    expect(commands.filter(c => c.action === 'delete/archive')).toHaveLength(0)
    // Tracking topics merge with their target domains in the generated inventory.
    expect(rendered).toContain('| tracking-categories | 3 | 1 |')
    expect(rendered).toContain('| tracking-options | 2 | 1 |')
    expect(rendered).not.toMatch(/^\| tracking \| \d+ \| 0 \|$/m)
    // Every direct-Xero command cites at least one Xero API method call.
    for (const command of commands.filter(c => c.surface === 'direct-xero')) {
      expect(command.xeroMethods.length).toBeGreaterThan(0)
    }
    // Implemented totals in the summary match the scanned set.
    expect(rendered).toContain(`- Implemented commands: **${commands.length}**`)
    expect(rendered).toContain(`- Target capabilities not yet implemented: **${TARGET_CAPABILITIES.length}**`)
  })
})
