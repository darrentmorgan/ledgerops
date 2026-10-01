import {chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {clearCachedToken} from './auth.js'
import {getConfigDir} from './config-paths.js'

export interface Profile {
  name: string
  clientId: string
}

interface ConfigFile {
  defaultProfile?: string
  profiles: Record<string, {clientId: string}>
}

function configPath(): string {
  return join(getConfigDir(), 'config.json')
}

function ensureConfigDir(): void {
  const dir = dirname(configPath())
  if (!existsSync(dir)) {
    mkdirSync(dir, {recursive: true, mode: 0o700})
  }
  chmodSync(dir, 0o700)
}

function readConfig(): ConfigFile {
  ensureConfigDir()
  if (!existsSync(configPath())) {
    return {profiles: {}}
  }
  chmodSync(configPath(), 0o600)
  return JSON.parse(readFileSync(configPath(), 'utf-8')) as ConfigFile
}

function writeConfig(config: ConfigFile): void {
  ensureConfigDir()
  if (existsSync(configPath())) chmodSync(configPath(), 0o600)
  writeFileSync(configPath(), JSON.stringify(config, null, 2), {mode: 0o600})
}

export function addProfile(name: string, clientId: string): void {
  const config = readConfig()
  clearCachedToken(name)
  config.profiles[name] = {clientId}

  // Set as default if it's the first profile
  if (!config.defaultProfile) {
    config.defaultProfile = name
  }

  writeConfig(config)
}

export function removeProfile(name: string): void {
  const config = readConfig()
  clearCachedToken(name)
  delete config.profiles[name]

  if (config.defaultProfile === name) {
    const remaining = Object.keys(config.profiles)
    config.defaultProfile = remaining.length > 0 ? remaining[0] : undefined
  }

  writeConfig(config)
}

export function listProfiles(): {profiles: Profile[]; defaultProfile?: string} {
  const config = readConfig()
  const profiles = Object.entries(config.profiles).map(([name, data]) => ({
    name,
    clientId: data.clientId,
  }))
  return {profiles, defaultProfile: config.defaultProfile}
}

export function setDefaultProfile(name: string): void {
  const config = readConfig()
  if (!config.profiles[name]) {
    throw new Error(`Profile "${name}" not found. Run "ledgerops profile add ${name}" first.`)
  }
  config.defaultProfile = name
  writeConfig(config)
}

export function getDefaultProfile(): string | undefined {
  const config = readConfig()
  return config.defaultProfile
}

export function getProfileClientId(name: string): string {
  const config = readConfig()
  const profile = config.profiles[name]
  if (!profile) {
    throw new Error(`Profile "${name}" not found. Run "ledgerops profile list" to see available profiles.`)
  }

  return profile.clientId
}

export function profileExists(name: string): boolean {
  const config = readConfig()
  return name in config.profiles
}
