import {afterEach, describe, expect, it, vi} from 'vitest'
import ContactsCreate from '../../src/commands/contacts/create.js'

// Exercise the command dispatch and real optional lookup independently of the gate harness.
describe('contact creation optional deep link', () => {
  afterEach(() => vi.restoreAllMocks())

  it('preserves a successful mutation when the organisation lookup fails', async () => {
    const resource = {contactID: 'synthetic-contact', name: 'Synthetic Contact'}
    const createContacts = vi.fn().mockResolvedValue({body: {contacts: [resource]}})
    const getOrganisations = vi.fn().mockRejectedValue(new Error('lookup unavailable'))
    const xero = {accountingApi: {createContacts, getOrganisations}}
    const command = Object.create(ContactsCreate.prototype) as ContactsCreate
    const internal = command as unknown as Record<string, unknown>
    internal.parse = vi.fn().mockResolvedValue({flags: {name: 'Synthetic Contact'}})
    internal.resolveCredentials = vi.fn().mockReturnValue({profileName: 'synthetic', clientId: 'synthetic-client'})
    let result: unknown
    internal.runGatedMutation = vi.fn(async (_flags, descriptor, dispatch) => {
      result = await dispatch(xero, 'synthetic-tenant', descriptor)
    })
    await command.run()
    expect(createContacts).toHaveBeenCalledTimes(1)
    expect(getOrganisations).toHaveBeenCalledExactlyOnceWith('synthetic-tenant')
    expect(result).toEqual({resource, resultLine: 'Contact created: Synthetic Contact (synthetic-contact)'})
  })
})
