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
  readonly fixture?: () => string
  readonly args?: readonly string[]
  readonly expectedPreviewLiteral: string
  readonly expectedResultLine: string
  readonly executeResponse: unknown
  readonly optionalLookup?: Mock
  readonly targetsExistingResource?: boolean
  readonly run: (command: CommandClass, args: readonly string[]) => Promise<CommandOutput>
  readonly interactiveCalls: () => readonly unknown[]
}

/**
 * Registers the release-blocking contract shared by every gated command.
 * Command-specific suites remain responsible for payload and target binding.
 */
export function mutationCommandBoundaryTests(spec: MutationCommandBoundarySpec): void {
  const args = () => (spec.fixture ? ['--file', spec.fixture()] : [...(spec.args ?? [])])
  const body = (spec.executeResponse as {body: Record<string, Record<string, unknown>[]>}).body
  const [collection, records] = Object.entries(body)[0]
  const resource = records[0]
  const idField = Object.keys(resource).find(key => key.endsWith('ID'))
  if (!idField) throw new Error('Mutation boundary fixture must have a resource ID')

  it('previews with zero dispatch, including when --yes is supplied alone', async () => {
    for (const extra of [[], ['--yes']]) {
      spec.apiMethod.mockClear()
      const output = await spec.run(spec.command, [...args(), ...extra])
      expect(output.error).toBeUndefined()
      expect(spec.apiMethod).not.toHaveBeenCalled()
      expect(output.stdout).toContain('PREVIEW')
      expect(output.stdout).toContain(spec.expectedPreviewLiteral)
    }
  })

  it('dispatches exactly once with --execute and renders the command result', async () => {
    spec.apiMethod.mockResolvedValue(spec.executeResponse)
    const output = await spec.run(spec.command, [...args(), '--execute'])
    expect(output.error).toBeUndefined()
    expect(spec.apiMethod).toHaveBeenCalledTimes(1)
    expect(output.stdout).toContain(spec.expectedResultLine)
  })

  it('dispatches piped --execute --json once, without prompting or mixing text into stdout', async () => {
    spec.apiMethod.mockResolvedValue(spec.executeResponse)
    const output = await spec.run(spec.command, ['--json', ...args(), '--execute'])
    expect(output.error).toBeUndefined()
    expect(spec.apiMethod).toHaveBeenCalledTimes(1)
    expect(spec.interactiveCalls()).toHaveLength(0)
    expect(() => JSON.parse(output.stdout)).not.toThrow()
    expect(JSON.parse(output.stdout)).toEqual(resource)
    expect(output.stdout).not.toContain('PREVIEW')
    expect(output.stdout).not.toContain('PENDING MUTATION')
  })

  it('preserves raw JSON including warnings and empty validation errors', async () => {
    const accepted = {
      ...resource,
      hasValidationErrors: false,
      validationErrors: [],
      statusAttributeString: 'OK',
      warnings: [{message: 'warning'}],
    }
    spec.apiMethod.mockResolvedValue({body: {[collection]: [accepted]}})
    const output = await spec.run(spec.command, ['--json', ...args(), '--execute'])
    expect(output.error).toBeUndefined()
    expect(spec.apiMethod).toHaveBeenCalledTimes(1)
    expect(JSON.parse(output.stdout)).toEqual(accepted)
  })

  if (spec.optionalLookup) {
    const lookup = spec.optionalLookup
    it.each(['rejected', 'missing body', 'malformed short code'])(
      'preserves the completed mutation when the optional lookup returns %s',
      async result => {
        spec.apiMethod.mockResolvedValue(spec.executeResponse)
        if (result === 'rejected') lookup.mockRejectedValue(new Error('synthetic lookup failure'))
        else if (result === 'missing body') lookup.mockResolvedValue({})
        else lookup.mockResolvedValue({body: {organisations: [{shortCode: {malformed: true}}]}})
        const output = await spec.run(spec.command, [...args(), '--execute'])
        expect(output.error).toBeUndefined()
        expect(spec.apiMethod).toHaveBeenCalledTimes(1)
        expect(lookup).toHaveBeenCalledTimes(1)
        expect(output.stdout).toContain(spec.expectedResultLine)
        expect(output.stdout).not.toContain('View in Xero:')
      },
    )
  }

  it('keeps the default exit code when dispatch itself fails', async () => {
    spec.apiMethod.mockRejectedValue(new Error('synthetic transport failure'))
    const output = await spec.run(spec.command, ['--json', ...args(), '--execute'])
    expect(spec.apiMethod).toHaveBeenCalledTimes(1)
    expect(output.error?.message).not.toMatch(/UNCERTAIN/)
    expect((output.error as Error & {oclif?: {exit?: number}})?.oclif?.exit).toBe(2)
    expect(output.stdout).toBe('')
  })

  const invalidResponses = [
    {label: 'missing response', response: undefined},
    {label: 'null response', response: null},
    {label: 'primitive response', response: 'malformed'},
    {label: 'missing body', response: {}},
    {label: 'non-object body', response: {body: 'malformed'}},
    {label: 'missing collection', response: {body: {}}},
    {label: 'wrong resource collection', response: {body: {wrongCollection: [resource]}}},
    {label: 'empty collection', response: {body: {[collection]: []}}},
    {label: 'multiple resources', response: {body: {[collection]: [resource, resource]}}},
    {label: 'non-array collection', response: {body: {[collection]: resource}}},
    {label: 'null resource', response: {body: {[collection]: [null]}}},
    {label: 'array resource', response: {body: {[collection]: [[]]}}},
    {label: 'primitive resource', response: {body: {[collection]: ['malformed']}}},
    {label: 'missing ID', response: {body: {[collection]: [{...resource, [idField]: undefined}]}}},
    {label: 'blank ID', response: {body: {[collection]: [{...resource, [idField]: '  '}]}}},
    {label: 'null ID', response: {body: {[collection]: [{...resource, [idField]: null}]}}},
    {label: 'non-string ID', response: {body: {[collection]: [{...resource, [idField]: 123}]}}},
    ...(spec.targetsExistingResource
      ? [
          {
            label: 'mismatched target ID',
            response: {body: {[collection]: [{...resource, [idField]: 'synthetic-other-resource'}]}},
          },
        ]
      : []),
    {label: 'record errors flag', response: {body: {[collection]: [{...resource, hasErrors: true}]}}},
    {label: 'validation failure flag', response: {body: {[collection]: [{...resource, hasValidationErrors: true}]}}},
    {
      label: 'malformed validation flag',
      response: {body: {[collection]: [{...resource, hasValidationErrors: 'true'}]}},
    },
    {
      label: 'validation errors without flag',
      response: {body: {[collection]: [{...resource, validationErrors: [{message: 'synthetic rejected value'}]}]}},
    },
    {
      label: 'validation errors despite false flag',
      response: {body: {[collection]: [{...resource, hasValidationErrors: false, validationErrors: [{}]}]}},
    },
    {label: 'malformed validation errors', response: {body: {[collection]: [{...resource, validationErrors: {}}]}}},
    {label: 'body validation failure', response: {body: {[collection]: [resource], hasValidationErrors: true}}},
    {label: 'body validation errors', response: {body: {[collection]: [resource], validationErrors: [{}]}}},
    {
      label: 'provider wire validation errors',
      response: {body: {[collection]: [{...resource, ValidationErrors: [{}]}]}},
    },
    {label: 'provider error status', response: {body: {[collection]: [{...resource, statusAttributeString: 'ERROR'}]}}},
  ]
  for (const format of [[], ['--json'], ['--csv'], ['--toon']]) {
    it.each(invalidResponses)(`refuses $label after one dispatch (${format[0] ?? 'human'})`, async ({response}) => {
      spec.apiMethod.mockResolvedValue(response)
      const output = await spec.run(spec.command, [...format, ...args(), '--execute'])
      expect(spec.apiMethod).toHaveBeenCalledTimes(1)
      if (spec.optionalLookup) expect(spec.optionalLookup).not.toHaveBeenCalled()
      expect(output.error?.message).toMatch(/UNCERTAIN.*unverified/i)
      expect(output.error?.message).toMatch(/do not retry/i)
      expect(output.error?.message).not.toContain('synthetic rejected value')
      expect((output.error as Error & {oclif?: {exit?: number}})?.oclif?.exit).toBe(1)
      expect(output.stdout).not.toContain(spec.expectedResultLine)
      if (format[0] === '--json') expect(JSON.parse(output.stdout)).toBeNull()
      else expect(output.stdout).toBe('')
    })
  }
}
