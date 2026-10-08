// Preloaded only into the installed CLI, never into npm's dependency installation.

import dns from 'node:dns'
import dnsPromises from 'node:dns/promises'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import {registerHooks, syncBuiltinESMExports} from 'node:module'
import net from 'node:net'
import tls from 'node:tls'
import {fileURLToPath} from 'node:url'

const append = fs.appendFileSync.bind(fs)
function refuse(kind) {
  append(process.env.LEDGEROPS_SMOKE_ATTEMPTS, `${kind}\n`)
  throw new Error(`Installed-package help attempted ${kind}`)
}

globalThis.fetch = () => refuse('network:fetch')
for (const [module, methods] of [
  [http, ['request', 'get']],
  [https, ['request', 'get']],
  [net, ['connect', 'createConnection']],
  [net.Socket.prototype, ['connect']],
  [tls, ['connect']],
  [dns, ['lookup', 'resolve']],
  [dnsPromises, ['lookup', 'resolve']],
]) {
  for (const method of methods) module[method] = () => refuse(`network:${method}`)
}

function isCredentialPath(value) {
  const path = value instanceof URL ? fileURLToPath(value) : String(value)
  return /(?:^|[/\\])(?:ledgerops|xero-command-line)[/\\](?:config\.json|tokens\.json|\.encryption-key(?:\.salt)?)$/.test(
    path,
  )
}
for (const [module, methods] of [
  [fs, ['existsSync', 'readFileSync', 'readFile', 'openSync', 'open', 'createReadStream']],
  [fsPromises, ['readFile', 'open']],
]) {
  for (const method of methods) {
    const original = module[method].bind(module)
    module[method] = (path, ...args) => {
      if (isCredentialPath(path)) refuse('credential:file')
      return original(path, ...args)
    }
  }
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@napi-rs/keyring')) refuse('credential:keyring')
    return nextResolve(specifier, context)
  },
})
syncBuiltinESMExports()
