import {createHash} from 'node:crypto'
import {gunzipSync} from 'node:zlib'
import {existsSync, realpathSync, mkdtempSync, rmSync} from 'node:fs'
import {tmpdir, userInfo} from 'node:os'
import {dirname, isAbsolute, relative, resolve, sep, win32} from 'node:path'

export const sha256 = value => createHash('sha256').update(value).digest('hex')
export const gitBlob = value => createHash('sha1').update(`blob ${value.length}\0`).update(value).digest('hex')
export function canonical(value) {
  const sorted = Array.isArray(value)
    ? value.map(item => JSON.parse(canonical(item)))
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map(key => [key, JSON.parse(canonical(value[key]))]),
        )
      : value
  return JSON.stringify(sorted).replace(
    /[\u007f-\uffff]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}
export function parseUniqueJson(text) {
  const result = JSON.parse(text)
  const tokens = text.match(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]:,]/g)
  let index = 0
  function value() {
    if (tokens[index] === '{') {
      index++
      const keys = new Set()
      while (tokens[index] !== '}') {
        const key = JSON.parse(tokens[index++])
        if (keys.has(key)) throw new Error('Duplicate JSON key')
        keys.add(key)
        index++
        value()
        if (tokens[index] === ',') index++
      }
      index++
    } else if (tokens[index] === '[') {
      index++
      while (tokens[index] !== ']') {
        value()
        if (tokens[index] === ',') index++
      }
      index++
    } else index++
  }
  value()
  return result
}
export function assertExternalPaths(root, paths) {
  const canonicalRoot = realpathSync(root)
  for (const path of paths) {
    if (!isAbsolute(path)) throw new Error('Paths must be absolute')
    const lexical = relative(resolve(root), resolve(path))
    if (!lexical || (!(lexical === '..' || lexical.startsWith(`..${sep}`)) && !isAbsolute(lexical)))
      throw new Error('Inputs and output must be outside the repository')
    let ancestor = path
    const suffix = []
    while (!existsSync(ancestor)) {
      suffix.unshift(relative(dirname(ancestor), ancestor))
      ancestor = dirname(ancestor)
    }
    const target = resolve(realpathSync(ancestor), ...suffix)
    const rel = relative(canonicalRoot, target)
    if (!rel || (!(rel === '..' || rel.startsWith(`..${sep}`)) && !isAbsolute(rel)))
      throw new Error('Inputs and output must be outside the repository')
  }
}
export function tarMembers(gzip) {
  const bytes = gunzipSync(gzip),
    result = [],
    seen = new Set()
  let offset = 0
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) {
      if (!bytes.subarray(offset).every(byte => byte === 0)) throw new Error('Data after tar terminator')
      return result
    }
    const text = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '')
    const octal = (start, end) => {
      const value = text(start, end).trim()
      if (!/^[0-7]+$/.test(value)) throw new Error('Invalid tar number')
      return Number.parseInt(value, 8)
    }
    const expected = octal(148, 156)
    const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0)
    if (sum !== expected) throw new Error('Invalid tar checksum')
    const name = [text(345, 500), text(0, 100)].filter(Boolean).join('/')
    const type = header[156]
    if (type !== 0 && type !== 48) throw new Error('Tar member must be a regular file')
    if (
      !name.startsWith('package/') ||
      name.includes(':') ||
      name.includes('\\') ||
      name.split('/').some(part => !part || part === '.' || part === '..') ||
      seen.has(name)
    )
      throw new Error('Invalid or duplicate tar member')
    seen.add(name)
    const size = octal(124, 136)
    if (!Number.isSafeInteger(size) || offset + 512 + size > bytes.length) throw new Error('Truncated tar member')
    result.push(name.slice('package/'.length))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('Missing tar terminator')
}
export function assertPack(files, pkg) {
  if (JSON.stringify(pkg.bin) !== JSON.stringify({ledgerops: 'bin/run.js'}))
    throw new Error('Expected one ledgerops executable')
  if (new Set(files).size !== files.length) throw new Error('Duplicate package member')
  for (const name of files) {
    if (
      !/^(?:bin\/[^/]+|dist\/.+|LICENSE|NOTICE|README\.md|package\.json)$/.test(name) ||
      name.split('/').some(part => !part || part === '.' || part === '..')
    )
      throw new Error(`Unexpected package member: ${name}`)
  }
  for (const name of ['bin/run.js', 'dist/index.js', 'LICENSE', 'NOTICE', 'README.md', 'package.json'])
    if (!files.includes(name)) throw new Error(`Missing package member: ${name}`)
}
export function helpEntries(output) {
  const result = {topics: [], commands: []}
  let section
  for (const line of output.split('\n')) {
    if (/^\S/.test(line)) section = line === 'TOPICS' ? 'topics' : line === 'COMMANDS' ? 'commands' : undefined
    const match = /^ {2}([a-z][a-z0-9 -]*?)(?: {2,}|$)/.exec(line)
    if (section && match) result[section].push(match[1].trim())
  }
  return result
}
export function inventoryCommands(markdown) {
  const rows = [...markdown.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1])
  if (rows.some(row => !/^ledgerops [a-z]+(?:[a-z -]*[a-z])?$/.test(row)))
    throw new Error('Inventory must use ledgerops')
  const commands = rows.map(row => row.slice('ledgerops '.length))
  if (commands.length !== 59 || new Set(commands).size !== 59) throw new Error('Expected 59 unique inventory commands')
  return commands
}
export function assertParity(actual, expected) {
  const a = [...actual].sort(),
    b = [...expected].sort()
  if (new Set(a).size !== a.length || new Set(b).size !== b.length || JSON.stringify(a) !== JSON.stringify(b))
    throw new Error('Installed help does not match generated inventory')
}
export function logicalPaths(value, roots) {
  if (typeof value === 'string') {
    for (const [path, label] of [...roots].sort((a, b) => b[0].length - a[0].length))
      value = value.replaceAll(path, label)
    return value.replaceAll('\\', '/')
  }
  if (Array.isArray(value)) return value.map(item => logicalPaths(item, roots))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, logicalPaths(item, roots)]),
    )
  return value
}
export function canonicalEvidence(evidence, reports, roots) {
  return canonical(
    logicalPaths(
      {
        schemaVersion: evidence.schemaVersion,
        scope: evidence.scope,
        status: evidence.status,
        candidate: evidence.candidate,
        tools: evidence.tools,
        inputs: evidence.inputs,
        commands: evidence.commands.map(
          ({command, args, cwd, exit, signal, error, npmOffline, stdoutSha256, stderrSha256}) => ({
            command,
            args,
            cwd,
            exit,
            signal,
            error,
            npmOffline,
            stdoutSha256,
            stderrSha256,
          }),
        ),
        checks: [...evidence.checks].sort((a, b) => a.name.localeCompare(b.name)),
        reports: [...reports].sort((a, b) => a.path.localeCompare(b.path)),
      },
      roots,
    ),
  )
}

export function createRuntimeTemp() {
  // POSIX socket addresses are short; do not derive them from checkout paths.
  const directory = mkdtempSync(resolve(process.platform === 'win32' ? tmpdir() : '/tmp', 'lo-'))
  const identity = process.geteuid ? String(process.geteuid()) : userInfo().username
  const probe = resolve(realpathSync(directory), `tsx-${identity}`, '9999999999.pipe')
  const limit = process.platform === 'win32' ? 230 : 100
  if (Buffer.byteLength(probe) > limit) {
    rmSync(directory, {recursive: true, force: true})
    throw new Error('OS temporary path exceeds the isolated IPC path budget')
  }
  return directory
}

export function isolatedEnvironment(system, work, runtimeTemp = resolve(work, 'tmp'), platform = process.platform) {
  return {
    // Windows process discovery needs these OS values; no user/auth values copy.
    PATH: system.PATH,
    SystemRoot: system.SystemRoot,
    WINDIR: system.WINDIR,
    ComSpec: system.ComSpec,
    ...(platform === 'win32' ? {SHELL: system.ComSpec} : {}),
    PATHEXT: system.PATHEXT,
    HOME: resolve(work, 'home'),
    USERPROFILE: resolve(work, 'home'),
    XDG_CONFIG_HOME: resolve(work, 'config'),
    APPDATA: resolve(work, 'config'),
    LOCALAPPDATA: resolve(work, 'local'),
    TEMP: runtimeTemp,
    TMP: runtimeTemp,
    TMPDIR: runtimeTemp,
    CI: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    npm_config_offline: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_cache: system.npm_config_cache || resolve(system.HOME || system.USERPROFILE, '.npm'),
    npm_config_userconfig: resolve(work, 'empty-user.npmrc'),
    npm_config_globalconfig: resolve(work, 'empty-global.npmrc'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: resolve(work, 'empty-gitconfig'),
  }
}

export function guardNodeOptions(path) {
  if (typeof path !== 'string' || /['"\r\n\0]/.test(path) || !(isAbsolute(path) || win32.isAbsolute(path))) {
    throw new Error('Guard preload path must be absolute and contain no quotes, newlines or NUL')
  }
  // NODE_OPTIONS parses backslashes as escapes, including on Windows.
  return `--require="${path.replaceAll('\\', '/')}"`
}
