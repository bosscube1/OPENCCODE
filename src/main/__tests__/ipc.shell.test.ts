import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadIpc, HOSTILE_STRINGS, HOSTILE_OBJECTS, expectRejectsAll, type IpcHarness } from './ipcHarness'

describe('ipc shell module', () => {
  let h: IpcHarness

  beforeEach(async () => {
    h = await loadIpc()
  })

  describe('oc:status', () => {
    it('calls getStatus and returns server status', async () => {
      const result = await h.invoke('oc:status')
      expect(h.mocks.getStatus).toHaveBeenCalledTimes(1)
      expect(result).toEqual({ state: 'ready' })
    })
  })

  describe('oc:restart', () => {
    it('calls restartServer and returns the result', async () => {
      const result = await h.invoke('oc:restart')
      expect(h.mocks.restartServer).toHaveBeenCalledTimes(1)
      expect(result).toEqual({ state: 'ready' })
    })
  })

  describe('oc:pickDirectory', () => {
    it('calls showOpenDialog and returns the first path', async () => {
      h.mocks.showOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/path/to/project', '/other/path']
      })
      const result = await h.invoke('oc:pickDirectory')
      expect(h.mocks.showOpenDialog).toHaveBeenCalledTimes(1)
      expect(result).toBe('/path/to/project')
    })

    it('returns null when user cancels', async () => {
      h.mocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
      const result = await h.invoke('oc:pickDirectory')
      expect(result).toBeNull()
    })

    it('returns null when no paths are returned', async () => {
      h.mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] })
      const result = await h.invoke('oc:pickDirectory')
      expect(result).toBeNull()
    })
  })

  describe('oc:pickFiles', () => {
    it('calls showOpenDialog with multiSelections and returns paths', async () => {
      h.mocks.showOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/file1.txt', '/file2.txt']
      })
      const result = await h.invoke('oc:pickFiles')
      expect(h.mocks.showOpenDialog).toHaveBeenCalledTimes(1)
      // When fromWebContents returns null, dialog.showOpenDialog is called with just options
      const call = h.mocks.showOpenDialog.mock.calls[0]
      const options = call[0] // Since owner is null, options is the first arg
      expect(options.properties).toContain('multiSelections')
      expect(result).toEqual(['/file1.txt', '/file2.txt'])
    })

    it('returns empty array when user cancels', async () => {
      h.mocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
      const result = await h.invoke('oc:pickFiles')
      expect(result).toEqual([])
    })
  })

  describe('oc:clipboard:saveImage', () => {
    it('saves a base64 image and returns the file path', async () => {
      const args = {
        data: Buffer.from('image data').toString('base64'),
        ext: 'png'
      }
      const result = await h.invoke('oc:clipboard:saveImage', args)
      expect(typeof result).toBe('string')
      expect(result).toContain('.png')
    })

    it('rejects non-object args', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:clipboard:saveImage', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects missing or invalid data field', async () => {
      await expect(h.invoke('oc:clipboard:saveImage', { data: '', ext: 'png' })).rejects.toThrow()
      await expect(h.invoke('oc:clipboard:saveImage', { data: 123, ext: 'png' })).rejects.toThrow()
    })

    it('rejects missing or invalid ext field', async () => {
      const data = Buffer.from('x').toString('base64')
      await expect(h.invoke('oc:clipboard:saveImage', { data, ext: '' })).rejects.toThrow()
      await expect(h.invoke('oc:clipboard:saveImage', { data, ext: 'svg' })).rejects.toThrow()
    })

    it('rejects unsupported file extensions', async () => {
      const data = Buffer.from('x').toString('base64')
      await expect(h.invoke('oc:clipboard:saveImage', { data, ext: 'exe' })).rejects.toThrow()
    })

    it('accepts supported extensions (png, jpg, jpeg, gif, webp)', async () => {
      const data = Buffer.from('x').toString('base64')
      for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp']) {
        const result = await h.invoke('oc:clipboard:saveImage', { data, ext })
        expect(result).toContain(`.${ext}`)
      }
    })
  })

  describe('oc:openExternal', () => {
    it('opens http URLs via shell.openExternal', async () => {
      await h.invoke('oc:openExternal', 'http://example.com')
      expect(h.mocks.openExternal).toHaveBeenCalledOnce()
      expect(h.mocks.openExternal).toHaveBeenCalledWith('http://example.com/')
    })

    it('opens https URLs via shell.openExternal', async () => {
      await h.invoke('oc:openExternal', 'https://example.com/path')
      expect(h.mocks.openExternal).toHaveBeenCalledOnce()
      expect(h.mocks.openExternal).toHaveBeenCalledWith('https://example.com/path')
    })

    it('rejects non-string URLs', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:openExternal', value),
        HOSTILE_STRINGS
      )
    })

    it('rejects malformed URLs', async () => {
      await expect(h.invoke('oc:openExternal', 'not a url')).rejects.toThrow(/malformed/)
    })

    it('rejects file: scheme', async () => {
      await expect(h.invoke('oc:openExternal', 'file:///etc/passwd')).rejects.toThrow(/non-http/)
    })

    it('rejects javascript: scheme', async () => {
      await expect(h.invoke('oc:openExternal', 'javascript:alert(1)')).rejects.toThrow(/non-http/)
    })

    it('rejects data: scheme', async () => {
      await expect(h.invoke('oc:openExternal', 'data:text/html,<h1>XSS</h1>')).rejects.toThrow(/non-http/)
    })

    it('rejects vbscript: scheme', async () => {
      await expect(h.invoke('oc:openExternal', 'vbscript:msgbox "x"')).rejects.toThrow(/non-http/)
    })

    it('rejects scheme-relative URLs (//evil.com)', async () => {
      await expect(h.invoke('oc:openExternal', '//evil.com')).rejects.toThrow(/malformed/)
    })
  })

  describe('oc:providers', () => {
    it('calls getClient().config.providers and enriches result with linkedProviderIDs', async () => {
      h.mocks.getClient.mockReturnValueOnce({
        config: {
          providers: async () => ({
            data: {
              providers: [{ id: 'openai', name: 'OpenAI' }],
              default: { chat: 'gpt-4' }
            },
            error: undefined,
            response: { ok: true, status: 200, statusText: 'OK' }
          })
        }
      })
      h.mocks.getAuthorizedProviderIDs.mockReturnValueOnce(['openai', 'anthropic'])

      const result = await h.invoke('oc:providers')
      expect(result.providers).toEqual([{ id: 'openai', name: 'OpenAI' }])
      expect(result.default).toEqual({ chat: 'gpt-4' })
      expect(result.linkedProviderIDs).toEqual(['openai', 'anthropic'])
    })
  })

  describe('oc:permission:reply', () => {
    it('sends permission reply with once response', async () => {
      const args = {
        directory: '/project',
        sessionID: 'sess-123',
        permissionID: 'perm-456',
        response: 'once'
      }
      h.mocks.getClient.mockReturnValueOnce({
        postSessionIdPermissionsPermissionId: async () => ({
          data: true,
          error: undefined,
          response: { ok: true, status: 200, statusText: 'OK' }
        })
      })
      await h.invoke('oc:permission:reply', args)
      expect(h.mocks.getClient).toHaveBeenCalled()
    })

    it('rejects non-object args', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:permission:reply', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects missing required fields', async () => {
      await expect(h.invoke('oc:permission:reply', { directory: '/x' })).rejects.toThrow()
      await expect(h.invoke('oc:permission:reply', { directory: '/x', sessionID: 'x' })).rejects.toThrow()
      await expect(
        h.invoke('oc:permission:reply', { directory: '/x', sessionID: 'x', permissionID: 'x' })
      ).rejects.toThrow()
    })

    it('rejects invalid permission responses', async () => {
      const base = {
        directory: '/project',
        sessionID: 'sess-123',
        permissionID: 'perm-456'
      }
      await expect(h.invoke('oc:permission:reply', { ...base, response: 'invalid' })).rejects.toThrow()
      await expect(h.invoke('oc:permission:reply', { ...base, response: 'allow' })).rejects.toThrow()
    })

    it('accepts valid responses (once, always, reject)', async () => {
      h.mocks.getClient.mockReturnValue({
        postSessionIdPermissionsPermissionId: async () => ({
          data: true,
          error: undefined,
          response: { ok: true, status: 200, statusText: 'OK' }
        })
      })
      for (const response of ['once', 'always', 'reject']) {
        const args = {
          directory: '/project',
          sessionID: 'sess-123',
          permissionID: 'perm-456',
          response
        }
        await expect(h.invoke('oc:permission:reply', args)).resolves.not.toThrow()
      }
    })
  })

  describe('oc:config:permission:set', () => {
    it('sets permission config after validation', async () => {
      const args = {
        directory: '/project',
        permission: { 'some-permission': 'always' }
      }
      const result = await h.invoke('oc:config:permission:set', args)
      expect(h.mocks.validatePermissionConfig).toHaveBeenCalled()
      expect(h.mocks.setPermissionConfig).toHaveBeenCalled()
      expect(result).toBe(true)
    })

    it('rejects non-object args', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:config:permission:set', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects missing directory field', async () => {
      await expect(h.invoke('oc:config:permission:set', { permission: {} })).rejects.toThrow()
    })
  })

  describe('oc:appSettings:get', () => {
    it('returns app settings', async () => {
      h.mocks.appSettingsGet.mockReturnValueOnce({ settings: { theme: 'dark' } })
      const result = await h.invoke('oc:appSettings:get')
      expect(h.mocks.appSettingsGet).toHaveBeenCalledTimes(1)
      expect(result).toEqual({ settings: { theme: 'dark' } })
    })
  })

  describe('oc:appSettings:set', () => {
    it('sets app settings with a patch object', async () => {
      h.mocks.appSettingsSet.mockReturnValueOnce({ settings: { theme: 'light', fontSize: 14 } })
      const patch = { theme: 'light', fontSize: 14 }
      const result = await h.invoke('oc:appSettings:set', patch)
      expect(h.mocks.appSettingsSet).toHaveBeenCalledWith(patch)
      expect(result).toEqual({ settings: { theme: 'light', fontSize: 14 } })
    })

    it('allows any patch argument type', async () => {
      h.mocks.appSettingsSet.mockReturnValueOnce({ settings: {} })
      await expect(h.invoke('oc:appSettings:set', { foo: 'bar' })).resolves.not.toThrow()
      await expect(h.invoke('oc:appSettings:set', 'string')).resolves.not.toThrow()
      await expect(h.invoke('oc:appSettings:set', 123)).resolves.not.toThrow()
    })
  })

  describe('oc:liveWindow:open', () => {
    it('calls liveWindow.show()', async () => {
      await h.invoke('oc:liveWindow:open')
      expect(h.mocks.liveWindowShow).toHaveBeenCalledTimes(1)
    })
  })

  describe('oc:liveWindow:close', () => {
    it('gets the window and closes it if not destroyed', async () => {
      const mockWindow = {
        isDestroyed: vi.fn(() => false),
        close: vi.fn()
      }
      h.mocks.liveWindowGetWindow.mockReturnValueOnce(mockWindow)
      await h.invoke('oc:liveWindow:close')
      expect(h.mocks.liveWindowGetWindow).toHaveBeenCalledTimes(1)
      expect(mockWindow.close).toHaveBeenCalledTimes(1)
    })

    it('does not call close on destroyed window', async () => {
      const mockWindow = {
        isDestroyed: vi.fn(() => true),
        close: vi.fn()
      }
      h.mocks.liveWindowGetWindow.mockReturnValueOnce(mockWindow)
      await h.invoke('oc:liveWindow:close')
      expect(mockWindow.close).not.toHaveBeenCalled()
    })

    it('handles null window gracefully', async () => {
      h.mocks.liveWindowGetWindow.mockReturnValueOnce(null)
      await expect(h.invoke('oc:liveWindow:close')).resolves.not.toThrow()
    })
  })

  describe('oc:liveWindow:setAlwaysOnTop', () => {
    it('sets always on top with boolean true', async () => {
      await h.invoke('oc:liveWindow:setAlwaysOnTop', true)
      expect(h.mocks.liveWindowSetAlwaysOnTop).toHaveBeenCalledWith(true)
    })

    it('sets always on top with boolean false', async () => {
      await h.invoke('oc:liveWindow:setAlwaysOnTop', false)
      expect(h.mocks.liveWindowSetAlwaysOnTop).toHaveBeenCalledWith(false)
    })

    it('rejects non-boolean values', async () => {
      await expect(h.invoke('oc:liveWindow:setAlwaysOnTop', 'true')).rejects.toThrow(/boolean/)
      await expect(h.invoke('oc:liveWindow:setAlwaysOnTop', 1)).rejects.toThrow(/boolean/)
      await expect(h.invoke('oc:liveWindow:setAlwaysOnTop', null)).rejects.toThrow(/boolean/)
    })
  })

  describe('oc:quick:submit', () => {
    it('trims and submits text', async () => {
      await h.invoke('oc:quick:submit', '  hello world  ')
      expect(h.mocks.onQuickSubmit).toHaveBeenCalledWith('hello world')
    })

    it('rejects non-string input', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:quick:submit', value),
        HOSTILE_STRINGS
      )
    })

    it('rejects empty or whitespace-only input', async () => {
      await expect(h.invoke('oc:quick:submit', '   ')).rejects.toThrow()
      await expect(h.invoke('oc:quick:submit', '')).rejects.toThrow()
    })
  })

  describe('oc:live:start', () => {
    it('calls startGeminiLive with event.sender and config', async () => {
      const config = { model: 'gemini-2.0-flash' }
      await h.invoke('oc:live:start', config)
      expect(h.mocks.startGeminiLive).toHaveBeenCalledOnce()
      // Check that it was called with event.sender and config
      const call = h.mocks.startGeminiLive.mock.calls[0]
      expect(call[0]).toBeDefined() // event.sender
      expect(call[1]).toEqual(config)
    })
  })

  describe('oc:live:stop', () => {
    it('calls stopGeminiLive with event.sender.id', async () => {
      await h.invoke('oc:live:stop')
      expect(h.mocks.stopGeminiLive).toHaveBeenCalledOnce()
      expect(h.mocks.stopGeminiLive).toHaveBeenCalledWith(1) // stubEvent returns id = 1
    })
  })

  describe('oc:live:send', () => {
    it('sends audio data to gemini live', async () => {
      const input = { audio: 'base64...', timestamp: 12345 }
      h.send('oc:live:send', input)
      expect(h.mocks.sendGeminiLive).toHaveBeenCalledOnce()
      const call = h.mocks.sendGeminiLive.mock.calls[0]
      expect(call[0]).toBe(1) // event.sender.id
      expect(call[1]).toEqual(input)
    })

    it('is registered as ipcMain.on, not handle', () => {
      expect(h.has('oc:live:send')).toBe(false) // on() listeners are not in handle registry
    })
  })

  describe('oc:live:saveTranscript', () => {
    it('saves transcript and returns path', async () => {
      const messages = [{ role: 'user', content: 'hello' }]
      const args = { messages }
      const result = await h.invoke('oc:live:saveTranscript', args)
      expect(h.mocks.saveLiveTranscript).toHaveBeenCalledWith(messages)
      expect(result).toBe('C:/tmp/transcript.md')
    })

    it('rejects non-object args', async () => {
      await expect(h.invoke('oc:live:saveTranscript', 'string')).rejects.toThrow()
      await expect(h.invoke('oc:live:saveTranscript', 123)).rejects.toThrow()
      await expect(h.invoke('oc:live:saveTranscript', null)).rejects.toThrow()
    })

    it('rejects array args', async () => {
      await expect(h.invoke('oc:live:saveTranscript', [])).rejects.toThrow()
    })
  })

  describe('oc:live:transcripts:reveal', () => {
    it('calls revealTranscriptsFolder', async () => {
      await h.invoke('oc:live:transcripts:reveal')
      expect(h.mocks.revealTranscriptsFolder).toHaveBeenCalledTimes(1)
    })
  })

  describe('oc:crashlog:read', () => {
    it('returns crash log report', async () => {
      h.mocks.readCrashLog.mockReturnValueOnce({ entries: [{ time: 123, message: 'error' }] })
      const result = await h.invoke('oc:crashlog:read')
      expect(h.mocks.readCrashLog).toHaveBeenCalledTimes(1)
      expect(result).toEqual({ entries: [{ time: 123, message: 'error' }] })
    })
  })

  describe('oc:crashlog:reveal', () => {
    it('gets crash log path and shows it in folder', async () => {
      h.mocks.getCrashLogPath.mockReturnValueOnce('C:/tmp/crash.log')
      await h.invoke('oc:crashlog:reveal')
      expect(h.mocks.getCrashLogPath).toHaveBeenCalledTimes(1)
      expect(h.mocks.showItemInFolder).toHaveBeenCalledWith('C:/tmp/crash.log')
    })

    it('handles empty log path gracefully', async () => {
      h.mocks.getCrashLogPath.mockReturnValueOnce(null)
      await h.invoke('oc:crashlog:reveal')
      expect(h.mocks.showItemInFolder).not.toHaveBeenCalled()
    })
  })

  describe('module coverage', () => {
    it('registers all shell-module channels', () => {
      const channels = h.channels()
      const shellChannels = [
        'oc:status',
        'oc:restart',
        'oc:pickDirectory',
        'oc:pickFiles',
        'oc:clipboard:saveImage',
        'oc:openExternal',
        'oc:providers',
        'oc:permission:reply',
        'oc:config:permission:set',
        'oc:appSettings:get',
        'oc:appSettings:set',
        'oc:liveWindow:open',
        'oc:liveWindow:close',
        'oc:liveWindow:setAlwaysOnTop',
        'oc:quick:submit',
        'oc:live:start',
        'oc:live:stop',
        'oc:live:saveTranscript',
        'oc:live:transcripts:reveal',
        'oc:crashlog:read',
        'oc:crashlog:reveal'
      ]
      for (const channel of shellChannels) {
        expect(channels).toContain(channel)
      }
    })
  })
})
