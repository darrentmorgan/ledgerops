import {buildImplementedCommands, collectCommandSources} from './scanner.js'
import {TARGET_CAPABILITIES} from './targets.js'
import {buildInventory, renderInventory} from './render.js'
import {mkdir, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const COMMANDS_DIR = join(REPO_ROOT, 'src', 'commands')
const OUTPUT_PATH = join(REPO_ROOT, 'docs', 'xero-endpoint-inventory.md')

export async function generateInventory(): Promise<string> {
  const sources = await collectCommandSources(COMMANDS_DIR)
  const commands = buildImplementedCommands({sources})
  return renderInventory(buildInventory(commands, TARGET_CAPABILITIES))
}

export async function main(): Promise<void> {
  const markdown = await generateInventory()
  await mkdir(dirname(OUTPUT_PATH), {recursive: true})
  await writeFile(OUTPUT_PATH, markdown, 'utf8')
  process.stdout.write(`wrote ${OUTPUT_PATH}\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
