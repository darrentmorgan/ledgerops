import {expect, it, type Mock} from 'vitest'

export interface CommandClass {
  run(args?: string[], config?: {root: string}): Promise<unknown>
}

export interface CommandOutput {
  readonly error?: Error
  readonly stdout: string
  readonly stderr: string
}

export interface MutationCommandBoundarySpec {
  readonly command: CommandClass
  readonly apiMethod: Mock
  readonly fixture: () => string
  readonly expectedPreviewLiteral: string
  readonly expectedResultLine: string
  readonly executeResponse: unknown
  readonly run: (command: CommandClass, args: readonly string[]) => Promise<CommandOutput>
  readonly interactiveCalls: () => readonly unknown[]
}

/**
 * Registers the release-blocking contract shared by every gated command.
 * Command-specific suites remain responsible for payload and target binding.
 */
export function mutationCommandBoundaryTests(spec: MutationCommandBoundarySpec): void {
  it('previews with zero dispatch, including when --yes is supplied alone', async () => {
    for (const extra of [[], ['--yes']]) {
      spec.apiMethod.mockClear()
      const output = await spec.run(spec.command, ['--file', spec.fixture(), ...extra])
      expect(output.error).toBeUndefined()
      expect(spec.apiMethod).not.toHaveBeenCalled()
      expect(output.stdout).toContain('PREVIEW')
      expect(output.stdout).toContain(spec.expectedPreviewLiteral)
    }
  })

  it('dispatches exactly once with --execute and renders the command result', async () => {
    spec.apiMethod.mockResolvedValue(spec.executeResponse)
    const output = await spec.run(spec.command, ['--file', spec.fixture(), '--execute'])
    expect(output.error).toBeUndefined()
    expect(spec.apiMethod).toHaveBeenCalledTimes(1)
    expect(output.stdout).toContain(spec.expectedResultLine)
  })

  it('dispatches piped --execute --json once, without prompting or mixing text into stdout', async () => {
    spec.apiMethod.mockResolvedValue(spec.executeResponse)
    const output = await spec.run(spec.command, ['--json', '--file', spec.fixture(), '--execute'])
    expect(output.error).toBeUndefined()
    expect(spec.apiMethod).toHaveBeenCalledTimes(1)
    expect(spec.interactiveCalls()).toHaveLength(0)
    expect(() => JSON.parse(output.stdout)).not.toThrow()
    expect(output.stdout).not.toContain('PREVIEW')
    expect(output.stdout).not.toContain('PENDING MUTATION')
  })
}
