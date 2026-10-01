import {afterAll} from 'vitest'
import {supplyWindowsShell} from './windows-shell.js'

// Avoid Oclif's unrelated PowerShell/CIM discovery in in-process command tests.
// Clean child processes retain their separate isolated environment and guards.
const restoreShell = supplyWindowsShell(process.env, process.platform)
afterAll(restoreShell)
