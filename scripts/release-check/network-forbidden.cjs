// Loaded before the demo/help code. Fail even if application code catches the error.
const fs = require('node:fs')
const moduleApi = require('node:module')
let attempts = 0
const forbidden = () => {
  attempts += 1
  throw new Error('Release check forbids network access')
}
for (const [name, keys] of Object.entries({
  'node:net': ['connect', 'createConnection'],
  'node:tls': ['connect'],
  'node:http': ['request', 'get'],
  'node:https': ['request', 'get'],
  'node:http2': ['connect'],
  'node:dgram': ['createSocket'],
  'node:dns': ['lookup', 'resolve'],
  'node:child_process': ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'],
})) {
  const api = require(name)
  for (const key of keys) api[key] = forbidden
}
require('node:net').Socket.prototype.connect = forbidden
globalThis.fetch = forbidden
globalThis.WebSocket = forbidden
moduleApi.syncBuiltinESMExports()
process.on('exit', () => {
  if (process.env.RELEASE_NETWORK_REPORT)
    fs.writeFileSync(process.env.RELEASE_NETWORK_REPORT, JSON.stringify({attempts}))
  if (attempts) process.exitCode = 1
})
