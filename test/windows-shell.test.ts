import {describe, expect, it} from 'vitest'
import {supplyWindowsShell} from './windows-shell.js'

describe('Windows test shell lifecycle', () => {
  it('supplies only ComSpec and restores an absent SHELL', () => {
    const env: NodeJS.ProcessEnv = {ComSpec: 'C:\\Windows\\System32\\cmd.exe', OTHER: 'unchanged'}
    const restore = supplyWindowsShell(env, 'win32')
    expect(env).toEqual({
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      SHELL: 'C:\\Windows\\System32\\cmd.exe',
      OTHER: 'unchanged',
    })
    restore()
    expect(env).toEqual({ComSpec: 'C:\\Windows\\System32\\cmd.exe', OTHER: 'unchanged'})
  })

  it('preserves an existing shell without requiring ComSpec', () => {
    const env = {SHELL: 'existing-shell'}
    supplyWindowsShell(env, 'win32')()
    expect(env).toEqual({SHELL: 'existing-shell'})
  })

  it('restores an empty shell exactly', () => {
    const env = {SHELL: '', ComSpec: 'cmd.exe'}
    const restore = supplyWindowsShell(env, 'win32')
    expect(env.SHELL).toBe('cmd.exe')
    restore()
    expect(env.SHELL).toBe('')
  })

  it('fails closed without ComSpec and leaves non-Windows environments alone', () => {
    expect(() => supplyWindowsShell({}, 'win32')).toThrow('ComSpec is required')
    const env = {}
    supplyWindowsShell(env, 'darwin')()
    expect(env).toEqual({})
  })
})
