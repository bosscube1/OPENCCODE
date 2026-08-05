import { beforeEach, describe, expect, it } from 'vitest'
import { loadIpc, HOSTILE_STRINGS, HOSTILE_OBJECTS, expectRejectsAll, type IpcHarness } from './ipcHarness'

describe('ipc.mcpKeys', () => {
  let h: IpcHarness

  beforeEach(async () => {
    h = await loadIpc()
  })

  /* ================================================================== */
  /* MCP channels: oc:mcp:*                                             */
  /* ================================================================== */

  describe('oc:mcp:status', () => {
    it('calls getMcpSnapshot with the client and directory', async () => {
      const result = await h.invoke('oc:mcp:status', '/project/dir')
      expect(h.mocks.getMcpSnapshot).toHaveBeenCalledWith(expect.anything(), '/project/dir')
      expect(result).toEqual({ servers: [] })
    })

    it('rejects hostile directory arguments', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:mcp:status', value),
        HOSTILE_STRINGS
      )
    })
  })

  describe('oc:mcp:add', () => {
    it('calls addMcp with the client, directory, name, and config', async () => {
      const config = { command: 'node', args: ['index.js'] }
      const result = await h.invoke('oc:mcp:add', {
        directory: '/project/dir',
        name: 'my-server',
        config
      })
      expect(h.mocks.addMcp).toHaveBeenCalledWith(
        expect.anything(),
        '/project/dir',
        'my-server',
        config,
        expect.any(Function),
        expect.any(Function)
      )
      expect(result).toEqual({ servers: [] })
    })

    it('rejects a non-object argument', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:mcp:add', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects hostile directory values in the args object', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:mcp:add', { directory: value, name: 'test', config: {} }),
        HOSTILE_STRINGS
      )
    })
  })

  describe('oc:mcp:remove', () => {
    it('calls removeMcp with the client, directory, and name', async () => {
      const result = await h.invoke('oc:mcp:remove', {
        directory: '/project/dir',
        name: 'my-server'
      })
      expect(h.mocks.removeMcp).toHaveBeenCalledWith(
        expect.anything(),
        '/project/dir',
        'my-server',
        expect.any(Function),
        expect.any(Function)
      )
      expect(result).toEqual({ servers: [] })
    })

    it('rejects a non-object argument', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:mcp:remove', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects hostile directory values in the args object', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:mcp:remove', { directory: value, name: 'test' }),
        HOSTILE_STRINGS
      )
    })
  })

  describe('oc:mcp:connect', () => {
    it('calls connectMcp with the client, directory, and name', async () => {
      const result = await h.invoke('oc:mcp:connect', {
        directory: '/project/dir',
        name: 'my-server'
      })
      expect(h.mocks.connectMcp).toHaveBeenCalledWith(
        expect.anything(),
        '/project/dir',
        'my-server'
      )
      expect(result).toEqual({ servers: [] })
    })

    it('rejects a non-object argument', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:mcp:connect', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects hostile directory values in the args object', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:mcp:connect', { directory: value, name: 'test' }),
        HOSTILE_STRINGS
      )
    })
  })

  describe('oc:mcp:disconnect', () => {
    it('calls disconnectMcp with the client, directory, and name', async () => {
      const result = await h.invoke('oc:mcp:disconnect', {
        directory: '/project/dir',
        name: 'my-server'
      })
      expect(h.mocks.disconnectMcp).toHaveBeenCalledWith(
        expect.anything(),
        '/project/dir',
        'my-server'
      )
      expect(result).toEqual({ servers: [] })
    })

    it('rejects a non-object argument', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:mcp:disconnect', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects hostile directory values in the args object', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:mcp:disconnect', { directory: value, name: 'test' }),
        HOSTILE_STRINGS
      )
    })
  })

  describe('oc:mcp:auth', () => {
    it('calls authMcp with the client, directory, name, and openExternal callback', async () => {
      const result = await h.invoke('oc:mcp:auth', {
        directory: '/project/dir',
        name: 'my-server'
      })
      expect(h.mocks.authMcp).toHaveBeenCalledWith(
        expect.anything(),
        '/project/dir',
        'my-server',
        expect.any(Function)
      )
      expect(result).toEqual({ servers: [] })
    })

    it('rejects a non-object argument', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:mcp:auth', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects hostile directory values in the args object', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:mcp:auth', { directory: value, name: 'test' }),
        HOSTILE_STRINGS
      )
    })
  })

  /* ================================================================== */
  /* Keys channels: oc:keys:*                                           */
  /* SECURITY: keys are never returned to the renderer; only masked     */
  /* rows are visible. listKeys must always mask sensitive fields.      */
  /* ================================================================== */

  describe('oc:keys:list', () => {
    it('calls listKeys and returns masked rows (no raw secrets)', async () => {
      h.mocks.listKeys.mockReturnValue([
        { providerID: 'openai', masked: '*****key', added: 1000, lastUsed: null }
      ])
      const result = await h.invoke('oc:keys:list')
      expect(h.mocks.listKeys).toHaveBeenCalledTimes(1)
      expect(result).toEqual([
        { providerID: 'openai', masked: '*****key', added: 1000, lastUsed: null }
      ])
      // Assert that the result contains only masked representations, not raw keys
      expect(JSON.stringify(result)).not.toContain('sk-')
    })

    it('handles empty key list', async () => {
      h.mocks.listKeys.mockReturnValue([])
      const result = await h.invoke('oc:keys:list')
      expect(result).toEqual([])
    })

    it('takes no arguments', async () => {
      h.mocks.listKeys.mockReturnValue([])
      // This should succeed with no arguments
      const result = await h.invoke('oc:keys:list')
      expect(result).toEqual([])
    })
  })

  describe('oc:keys:set', () => {
    it('calls setKey with providerID and key, and does not echo the key back', async () => {
      // Mock a successful set
      h.mocks.setKey.mockImplementation(() => {
        // setKey doesn't return anything
      })

      const result = await h.invoke('oc:keys:set', {
        providerID: 'openai',
        key: 'sk-1234567890abcdefg'
      })

      expect(h.mocks.setKey).toHaveBeenCalledWith('openai', 'sk-1234567890abcdefg')
      // setKey returns void, so result should be undefined
      expect(result).toBeUndefined()
    })

    it('rejects a non-object argument', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:keys:set', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects hostile providerID values', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:keys:set', { providerID: value, key: 'test' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile key values', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:keys:set', { providerID: 'openai', key: value }),
        HOSTILE_STRINGS
      )
    })

    it('wraps setKey errors to hide the raw key in the error message', async () => {
      h.mocks.setKey.mockImplementation(() => {
        throw new Error('Invalid key format')
      })

      const secretKey = 'sk-secret123'
      try {
        await h.invoke('oc:keys:set', { providerID: 'openai', key: secretKey })
        throw new Error('Should have thrown')
      } catch (error) {
        // Verify the error is wrapped and does not leak the raw key
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain('Failed to store key for provider openai')
        expect((error as Error).message).not.toContain(secretKey)
      }
    })
  })

  describe('oc:keys:delete', () => {
    it('calls deleteKey with providerID', async () => {
      h.mocks.deleteKey.mockImplementation(() => {
        // deleteKey doesn't return anything
      })

      const result = await h.invoke('oc:keys:delete', 'openai')

      expect(h.mocks.deleteKey).toHaveBeenCalledWith('openai')
      expect(result).toBeUndefined()
    })

    it('rejects hostile providerID values', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:keys:delete', value),
        HOSTILE_STRINGS
      )
    })

    it('accepts different provider IDs', async () => {
      h.mocks.deleteKey.mockImplementation(() => {
        // no-op
      })

      const providers = ['openai', 'anthropic', 'google', 'custom-provider']
      for (const provider of providers) {
        await h.invoke('oc:keys:delete', provider)
        expect(h.mocks.deleteKey).toHaveBeenCalledWith(provider)
      }
    })
  })

  describe('oc:keys:test', () => {
    it('calls testKey with providerID and returns result with ok flag', async () => {
      h.mocks.testKey.mockResolvedValue({ ok: true })

      const result = await h.invoke('oc:keys:test', 'openai')

      expect(h.mocks.testKey).toHaveBeenCalledWith('openai')
      expect(result).toEqual({ ok: true })
    })

    it('returns result with ok false and optional status/detail on failure', async () => {
      h.mocks.testKey.mockResolvedValue({
        ok: false,
        status: 401,
        detail: 'Unauthorized'
      })

      const result = await h.invoke('oc:keys:test', 'openai')

      expect(result).toEqual({
        ok: false,
        status: 401,
        detail: 'Unauthorized'
      })
    })

    it('rejects hostile providerID values', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:keys:test', value),
        HOSTILE_STRINGS
      )
    })

    it('handles async rejection from testKey', async () => {
      h.mocks.testKey.mockRejectedValue(new Error('Network error'))

      await expect(h.invoke('oc:keys:test', 'openai')).rejects.toThrow('Network error')
    })
  })

  /* ================================================================== */
  /* Security assertions: verify no raw secrets leak back to renderer   */
  /* ================================================================== */

  describe('security: no raw secrets in responses', () => {
    it('oc:keys:list never includes unmasked keys in the response', async () => {
      // Mock a row with a masked key
      h.mocks.listKeys.mockReturnValue([
        {
          providerID: 'openai',
          masked: 'sk-****-masked',
          added: Date.now(),
          lastUsed: null
        }
      ])

      const result = await h.invoke('oc:keys:list')
      const json = JSON.stringify(result)

      // Assert no common secret patterns
      expect(json).not.toMatch(/sk-[a-zA-Z0-9]{20,}/)
      expect(json).not.toMatch(/api[_-]?key[_=:].*[^\s"']/i)
    })

    it('oc:keys:set does not return the key in its response', async () => {
      const testKey = 'sk-super-secret-key-12345'
      h.mocks.setKey.mockImplementation(() => {
        // no-op
      })

      const result = await h.invoke('oc:keys:set', {
        providerID: 'openai',
        key: testKey
      })

      // setKey returns void
      expect(result).toBeUndefined()

      // Verify the mock was called with the key (it's stored, just not returned)
      expect(h.mocks.setKey).toHaveBeenCalledWith('openai', testKey)
    })

    it('oc:keys:delete does not return deleted key data', async () => {
      h.mocks.deleteKey.mockImplementation(() => {
        // no-op
      })

      const result = await h.invoke('oc:keys:delete', 'openai')

      // deleteKey returns void
      expect(result).toBeUndefined()
    })

    it('error messages in oc:keys:set do not echo the raw key', async () => {
      const secretKey = 'sk-this-is-secret-information'
      h.mocks.setKey.mockImplementation(() => {
        throw new Error('Validation failed: key format is invalid')
      })

      try {
        await h.invoke('oc:keys:set', { providerID: 'openai', key: secretKey })
        throw new Error('Should have thrown')
      } catch (error) {
        if (error instanceof Error) {
          // The handler catches and re-wraps the error, never exposing the key
          expect(error.message).toContain('Failed to store key for provider openai')
          expect(error.message).not.toContain(secretKey)
        }
      }
    })
  })

  /* ================================================================== */
  /* Registration verification                                          */
  /* ================================================================== */

  describe('channel registration', () => {
    it('all MCP and keys channels are registered', () => {
      const requiredChannels = [
        'oc:mcp:status',
        'oc:mcp:add',
        'oc:mcp:remove',
        'oc:mcp:connect',
        'oc:mcp:disconnect',
        'oc:mcp:auth',
        'oc:keys:list',
        'oc:keys:set',
        'oc:keys:delete',
        'oc:keys:test'
      ]

      for (const channel of requiredChannels) {
        expect(h.has(channel)).toBe(true)
      }
    })
  })

  /* ================================================================== */
  /* Known behaviors / edge cases                                       */
  /* ================================================================== */

  describe('MCP handler edge cases', () => {
    it('oc:mcp:add passes through args.name without validation (currently unvalidated)', async () => {
      // Note: args.name is not validated at the IPC boundary; it's passed directly to addMcp.
      // This is a current behavior. The downstream service may or may not validate it.
      h.mocks.addMcp.mockResolvedValue({ servers: [] })

      // Passing undefined name — currently passes through without validation
      await h.invoke('oc:mcp:add', {
        directory: '/project/dir',
        name: undefined,
        config: {}
      })
      expect(h.mocks.addMcp).toHaveBeenCalledWith(
        expect.anything(),
        '/project/dir',
        undefined,
        {},
        expect.any(Function),
        expect.any(Function)
      )
    })

    it('oc:mcp:add passes through args.config without validation (currently unvalidated)', async () => {
      // Note: args.config is not validated at the IPC boundary; it's passed directly to addMcp.
      h.mocks.addMcp.mockResolvedValue({ servers: [] })

      // Passing undefined config — currently passes through without validation
      await h.invoke('oc:mcp:add', {
        directory: '/project/dir',
        name: 'test',
        config: undefined
      })
      expect(h.mocks.addMcp).toHaveBeenCalledWith(
        expect.anything(),
        '/project/dir',
        'test',
        undefined,
        expect.any(Function),
        expect.any(Function)
      )
    })

    it('oc:mcp:remove passes through args.name without validation', async () => {
      h.mocks.removeMcp.mockResolvedValue({ servers: [] })

      // Passing null name — currently passes through without validation
      await h.invoke('oc:mcp:remove', {
        directory: '/project/dir',
        name: null
      })
      expect(h.mocks.removeMcp).toHaveBeenCalledWith(
        expect.anything(),
        '/project/dir',
        null,
        expect.any(Function),
        expect.any(Function)
      )
    })

    it('oc:mcp:connect passes through args.name without validation', async () => {
      h.mocks.connectMcp.mockResolvedValue({ servers: [] })

      await h.invoke('oc:mcp:connect', {
        directory: '/project/dir',
        name: null
      })
      expect(h.mocks.connectMcp).toHaveBeenCalledWith(
        expect.anything(),
        '/project/dir',
        null
      )
    })

    it('oc:mcp:disconnect passes through args.name without validation', async () => {
      h.mocks.disconnectMcp.mockResolvedValue({ servers: [] })

      await h.invoke('oc:mcp:disconnect', {
        directory: '/project/dir',
        name: null
      })
      expect(h.mocks.disconnectMcp).toHaveBeenCalledWith(
        expect.anything(),
        '/project/dir',
        null
      )
    })

    it('oc:mcp:auth passes through args.name without validation', async () => {
      h.mocks.authMcp.mockResolvedValue({ servers: [] })

      await h.invoke('oc:mcp:auth', {
        directory: '/project/dir',
        name: null
      })
      expect(h.mocks.authMcp).toHaveBeenCalledWith(
        expect.anything(),
        '/project/dir',
        null,
        expect.any(Function)
      )
    })
  })
})
