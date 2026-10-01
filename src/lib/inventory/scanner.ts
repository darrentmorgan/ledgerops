import type {CommandSurface, ImplementedCommand, InventoryAction} from './types.js'

const LOCAL_DOMAINS = new Set(['profile', 'auth'])
const KERNEL_DOMAINS = new Set(['target'])
const OFFLINE_DOMAINS = new Set<string>()

/**
 * Full command paths (space-joined, e.g. "invoices batch") that reach Xero
 * through the guarded kernel rather than the SDK directly: they cite no
 * `accountingApi` method because the kernel's transport owns the call.
 *
 * Keyed on the full command path rather than the bare file name so a future
 * `<other-domain>/batch.ts` is not silently swept into the kernel surface;
 * an unclassified file must still fail closed.
 */
const KERNEL_COMMANDS = new Set(['invoices batch'])

/** Top-level command files that are local auth commands, not Xero API calls. */
const AUTH_FILES = new Set(['login', 'logout'])

/** Topic prefixes that merge into the target-capability domain of the same resource. */
const TOPIC_DOMAIN_MAP: Record<string, string> = {
  'tracking categories': 'tracking-categories',
  'tracking options': 'tracking-options',
}

// Explicit full paths force every new command to receive an inventory decision.
const CREATE_COMMANDS = new Set([
  'bank-transactions create',
  'contacts create',
  'credit-notes create',
  'invoices batch',
  'invoices create',
  'items create',
  'manual-journals create',
  'payments create',
  'quotes create',
  'tracking categories create',
  'tracking options create',
])
const UPDATE_COMMANDS = new Set([
  'accounts update',
  'bank-transactions update',
  'contacts update',
  'credit-notes update',
  'invoices update',
  'items update',
  'manual-journals update',
  'quotes update',
  'tracking categories update',
  'tracking options update',
])
const READ_COMMANDS = new Set([
  'accounts list',
  'bank-transactions get',
  'bank-transactions list',
  'contact-groups list',
  'contacts get',
  'contacts list',
  'credit-notes list',
  'credit-notes pdf',
  'currencies list',
  'invoices get',
  'invoices list',
  'invoices pdf',
  'items list',
  'manual-journals list',
  'org details',
  'payments list',
  'profile list',
  'purchase-orders pdf',
  'quotes get',
  'quotes list',
  'quotes pdf',
  'reports aged-payables',
  'reports aged-receivables',
  'reports balance-sheet',
  'reports profit-and-loss',
  'reports trial-balance',
  'target read',
  'tax-rates list',
  'tracking categories list',
  'users list',
])

/**
 * Domain for a command: nested topics map through TOPIC_DOMAIN_MAP so implemented
 * rows merge with their target domains; top-level files must be explicitly known
 * auth commands or they become their own direct-Xero domain (fail-closed).
 */
function classifyDomain(prefix: string[], file: string): string {
  if (prefix.length >= 2) {
    const merged = TOPIC_DOMAIN_MAP[prefix.slice(0, 2).join(' ')]
    if (merged) return merged
  }
  if (prefix[0] !== undefined) return prefix[0]
  if (AUTH_FILES.has(file)) return 'auth'
  return file
}

function classifyAction(command: string): InventoryAction | null {
  if (CREATE_COMMANDS.has(command)) return 'create'
  if (UPDATE_COMMANDS.has(command)) return 'update'
  if (READ_COMMANDS.has(command)) return 'read'
  return null
}

function extractXeroMethods(source: string): string[] {
  const methods = new Set<string>()
  const pattern = /\.(accountingApi|payrollApi)\.([A-Za-z0-9_]+)/g
  let match = pattern.exec(source)
  while (match !== null) {
    methods.add(`${match[1]}.${match[2]}`)
    match = pattern.exec(source)
  }
  return [...methods].sort()
}

function surfaceFor(domain: string): CommandSurface {
  if (LOCAL_DOMAINS.has(domain)) return 'local'
  if (KERNEL_DOMAINS.has(domain)) return 'kernel'
  if (OFFLINE_DOMAINS.has(domain)) return 'offline'
  return 'direct-xero'
}

export interface ScanInput {
  /** Map from command name (e.g. "invoices list") to TypeScript source text. */
  sources: Map<string, string>
}

/**
 * Classify a command-source map into implemented inventory entries.
 *
 * Fails closed: any direct-Xero command whose full path does not map to a known
 * action class throws, so new commands force an explicit inventory decision.
 */
export function buildImplementedCommands(input: ScanInput): ImplementedCommand[] {
  const commands: ImplementedCommand[] = []
  for (const [name, source] of input.sources) {
    const segments = name.split(' ')
    const file = segments[segments.length - 1]
    if (!file || file === 'index') continue
    const domain = classifyDomain(segments.slice(0, -1), file)
    const surface = KERNEL_COMMANDS.has(name) ? 'kernel' : surfaceFor(domain)
    const action = classifyAction(name)
    if (surface === 'direct-xero' && action === null) {
      throw new Error(`Unclassified direct-Xero command file "${file}" (${name})`)
    }
    const xeroMethods = surface === 'offline' ? [] : extractXeroMethods(source)
    commands.push({command: name, domain, surface, action, xeroMethods})
  }
  return commands.sort((a, b) => a.command.localeCompare(b.command))
}

/** Walk a directory tree of command sources into a command-name -> source map. */
export async function collectCommandSources(commandsDir: string): Promise<Map<string, string>> {
  const {readdir} = await import('node:fs/promises')
  const {join} = await import('node:path')
  const sources = new Map<string, string>()

  async function walk(dir: string, prefix: string[]): Promise<void> {
    const entries = await readdir(dir, {withFileTypes: true})
    for (const entry of entries) {
      if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        const file = entry.name.replace(/\.ts$/, '')
        const parts = [...prefix, ...(file === 'index' ? [] : [file])]
        if (parts.length > 0) {
          const text = await readFileOrThrow(join(dir, entry.name))
          sources.set(parts.join(' '), text)
        }
        continue
      }
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), [...prefix, entry.name])
      }
    }
  }

  async function readFileOrThrow(path: string): Promise<string> {
    const {readFile} = await import('node:fs/promises')
    return readFile(path, 'utf8')
  }

  await walk(commandsDir, [])
  return sources
}
