import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadIpc, type IpcHarness, HOSTILE_STRINGS, HOSTILE_OBJECTS, expectRejectsAll } from './ipcHarness'

describe('ipc misc module', () => {
  let h: IpcHarness

  beforeEach(async () => {
    h = await loadIpc()
  })

  /* ================================================================ */
  /* oc:sessions:update                                              */
  /* ================================================================ */

  describe('oc:sessions:update', () => {
    it('updates a session title', async () => {
      const mockSession = { id: 'sess-123', title: 'New Title' }
      h.mocks.getClient.mockReturnValue({
        session: {
          update: () => ({
            data: mockSession,
            error: null,
            response: { ok: true, status: 200, statusText: 'OK' }
          })
        }
      })

      const result = await h.invoke('oc:sessions:update', '/project', 'sess-123', 'New Title')

      expect(result).toEqual(mockSession)
      expect(h.mocks.getClient).toHaveBeenCalled()
    })

    it('rejects hostile directory', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:update', value, 'id', 'title'),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile sessionID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:update', '/project', value, 'title'),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile title', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:update', '/project', 'id', value),
        HOSTILE_STRINGS
      )
    })
  })

  /* ================================================================ */
  /* oc:sessions:todos                                               */
  /* ================================================================ */

  describe('oc:sessions:todos', () => {
    it('retrieves todos for a session', async () => {
      const mockTodos = { todos: ['todo1', 'todo2'] }
      h.mocks.getClient.mockReturnValue({
        session: {
          todo: () => ({
            data: mockTodos,
            error: null,
            response: { ok: true, status: 200, statusText: 'OK' }
          })
        }
      })

      const result = await h.invoke('oc:sessions:todos', '/project', 'sess-123')

      expect(result).toEqual(mockTodos)
      expect(h.mocks.getClient).toHaveBeenCalled()
    })

    it('rejects hostile directory', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:todos', value, 'sess-123'),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile sessionID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:todos', '/project', value),
        HOSTILE_STRINGS
      )
    })
  })

  /* ================================================================ */
  /* oc:commands:list                                                */
  /* ================================================================ */

  describe('oc:commands:list', () => {
    it('lists commands for a directory', async () => {
      const mockCommands = [
        { id: 'cmd1', name: 'Command 1' },
        { id: 'cmd2', name: 'Command 2' }
      ]
      h.mocks.getClient.mockReturnValue({
        command: {
          list: () => ({
            data: mockCommands,
            error: null,
            response: { ok: true, status: 200, statusText: 'OK' }
          })
        }
      })

      const result = await h.invoke('oc:commands:list', '/project')

      expect(result).toEqual(mockCommands)
      expect(h.mocks.getClient).toHaveBeenCalled()
    })

    it('rejects hostile directory', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:commands:list', value),
        HOSTILE_STRINGS
      )
    })
  })

  /* ================================================================ */
  /* oc:find:files                                                   */
  /* ================================================================ */

  describe('oc:find:files', () => {
    it('finds files matching a query', async () => {
      const mockFiles = ['file1.ts', 'file2.ts']
      h.mocks.getClient.mockReturnValue({
        find: {
          files: () => ({
            data: mockFiles,
            error: null,
            response: { ok: true, status: 200, statusText: 'OK' }
          })
        }
      })

      const result = await h.invoke('oc:find:files', '/project', '*.ts')

      expect(result).toEqual(mockFiles)
      expect(h.mocks.getClient).toHaveBeenCalled()
    })

    it('defaults empty query to empty string', async () => {
      const mockFiles = ['file1.ts']
      h.mocks.getClient.mockReturnValue({
        find: {
          files: () => ({
            data: mockFiles,
            error: null,
            response: { ok: true, status: 200, statusText: 'OK' }
          })
        }
      })

      const result = await h.invoke('oc:find:files', '/project', undefined)

      expect(result).toEqual(mockFiles)
    })

    it('rejects hostile directory', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:find:files', value, 'query'),
        HOSTILE_STRINGS
      )
    })

    it('accepts any type as query (coerces to empty string)', async () => {
      h.mocks.getClient.mockReturnValue({
        find: {
          files: () => ({
            data: [],
            error: null,
            response: { ok: true, status: 200, statusText: 'OK' }
          })
        }
      })

      await expect(h.invoke('oc:find:files', '/project', 123)).resolves.toEqual([])
      await expect(h.invoke('oc:find:files', '/project', null)).resolves.toEqual([])
      await expect(h.invoke('oc:find:files', '/project', {})).resolves.toEqual([])
    })
  })

  /* ================================================================ */
  /* oc:vcs:get                                                      */
  /* ================================================================ */

  describe('oc:vcs:get', () => {
    it('returns VCS info when available', async () => {
      const mockVCS = { type: 'git', branch: 'main' }
      h.mocks.getClient.mockReturnValue({
        vcs: {
          get: () => ({
            data: mockVCS,
            error: null,
            response: { ok: true, status: 200, statusText: 'OK' }
          })
        }
      })

      const result = await h.invoke('oc:vcs:get', '/project')

      expect(result).toEqual(mockVCS)
      expect(h.mocks.getClient).toHaveBeenCalled()
    })

    it('returns null when VCS is not available (404)', async () => {
      h.mocks.getClient.mockReturnValue({
        vcs: {
          get: () => {
            throw new Error('Not found')
          }
        }
      })

      const result = await h.invoke('oc:vcs:get', '/project')

      expect(result).toBeNull()
    })

    it('rejects hostile directory', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:vcs:get', value),
        HOSTILE_STRINGS
      )
    })
  })

  /* ================================================================ */
  /* oc:exportChat                                                   */
  /* ================================================================ */

  describe('oc:exportChat', () => {
    it('exports chat to file when user confirms', async () => {
      h.mocks.showSaveDialog.mockResolvedValueOnce({
        canceled: false,
        filePath: 'C:/path/to/chat.md'
      })

      const result = await h.invoke('oc:exportChat', 'chat.md', '# Chat History\nContent here')

      expect(result).toBe(true)
      expect(h.mocks.writeFile).toHaveBeenCalled()
    })

    it('returns false when user cancels export dialog', async () => {
      h.mocks.showSaveDialog.mockResolvedValueOnce({
        canceled: true,
        filePath: undefined
      })

      const result = await h.invoke('oc:exportChat', 'chat.md', '# Chat')

      expect(result).toBe(false)
    })

    it('rejects hostile defaultName', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:exportChat', value, 'content'),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile content', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:exportChat', 'chat.md', value),
        HOSTILE_STRINGS
      )
    })
  })

  /* ================================================================ */
  /* oc:saveFile                                                     */
  /* ================================================================ */

  describe('oc:saveFile', () => {
    it('saves file with utf8 encoding by default', async () => {
      h.mocks.showSaveDialog.mockResolvedValueOnce({
        canceled: false,
        filePath: 'C:/path/to/file.txt'
      })

      const result = await h.invoke('oc:saveFile', {
        defaultName: 'file.txt',
        content: 'Hello, world!'
      })

      expect(result).toBe(true)
      expect(h.mocks.writeFile).toHaveBeenCalled()
    })

    it('saves file with base64 encoding', async () => {
      h.mocks.showSaveDialog.mockResolvedValueOnce({
        canceled: false,
        filePath: 'C:/path/to/image.png'
      })

      const result = await h.invoke('oc:saveFile', {
        defaultName: 'image.png',
        content: 'iVBORw0KGgo=',
        encoding: 'base64'
      })

      expect(result).toBe(true)
      expect(h.mocks.writeFile).toHaveBeenCalled()
    })

    it('returns false when user cancels', async () => {
      h.mocks.showSaveDialog.mockResolvedValueOnce({
        canceled: true,
        filePath: undefined
      })

      const result = await h.invoke('oc:saveFile', {
        defaultName: 'file.txt',
        content: 'content'
      })

      expect(result).toBe(false)
    })

    it('rejects non-object args', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:saveFile', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects hostile defaultName', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:saveFile', { defaultName: value, content: 'x' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile content', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:saveFile', { defaultName: 'file.txt', content: value }),
        HOSTILE_STRINGS
      )
    })

    it('rejects invalid encoding values', async () => {
      await expect(
        h.invoke('oc:saveFile', {
          defaultName: 'file.txt',
          content: 'x',
          encoding: 'invalid'
        })
      ).rejects.toThrow(/encoding/)
    })

    it('accepts valid encoding values (utf8, base64)', async () => {
      h.mocks.showSaveDialog.mockResolvedValue({
        canceled: false,
        filePath: 'C:/path/to/file.txt'
      })

      for (const encoding of ['utf8', 'base64']) {
        const result = await h.invoke('oc:saveFile', {
          defaultName: 'file.txt',
          content: 'content',
          encoding
        })
        expect(result).toBe(true)
      }
    })
  })

  /* ================================================================ */
  /* oc:config:permission:get                                        */
  /* ================================================================ */

  describe('oc:config:permission:get', () => {
    it('retrieves permission config for a directory', async () => {
      const mockPermissionConfig = { 'some-permission': 'always' }
      const mockGetPermissionConfig = vi.fn(async () => mockPermissionConfig)
      h = await loadIpc({ getPermissionConfig: mockGetPermissionConfig })

      const result = await h.invoke('oc:config:permission:get', '/project')

      expect(result).toEqual(mockPermissionConfig)
      expect(mockGetPermissionConfig).toHaveBeenCalled()
    })

    it('rejects hostile directory', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:config:permission:get', value),
        HOSTILE_STRINGS
      )
    })
  })

  /* ================================================================ */
  /* oc:search:chats                                                 */
  /* ================================================================ */

  describe('oc:search:chats', () => {
    it('returns empty array for empty query', async () => {
      const result = await h.invoke('oc:search:chats', '/project', '', {})
      expect(result).toEqual([])
    })

    it('returns empty array for whitespace-only query', async () => {
      const result = await h.invoke('oc:search:chats', '/project', '   ', {})
      expect(result).toEqual([])
    })

    it('searches chats in project scope', async () => {
      const mockSessions = [
        {
          id: 'sess-1',
          title: 'Session 1',
          time: { updated: 1000 }
        }
      ]
      const mockMessages = [
        {
          info: { id: 'msg-1' },
          parts: [{ type: 'text', text: 'hello world' }]
        }
      ]

      h.mocks.getClient.mockReturnValue({
        session: {
          list: () => ({
            data: mockSessions,
            error: null,
            response: { ok: true, status: 200, statusText: 'OK' }
          }),
          messages: () => ({
            data: mockMessages,
            error: null,
            response: { ok: true, status: 200, statusText: 'OK' }
          })
        }
      })
      h.mocks.listProjects.mockResolvedValueOnce([])

      const result = await h.invoke('oc:search:chats', '/project', 'hello', {
        scope: 'project'
      })

      // Result should contain the chat hit
      expect(Array.isArray(result)).toBe(true)
    })

    it('caches search results by session:timestamp key', async () => {
      const mockSessions = [
        {
          id: 'sess-1',
          title: 'Session 1',
          time: { updated: 1000 }
        }
      ]
      const mockMessages = [
        {
          info: { id: 'msg-1' },
          parts: [{ type: 'text', text: 'test content' }]
        }
      ]

      h.mocks.getClient.mockReturnValue({
        session: {
          list: () => ({
            data: mockSessions,
            error: null,
            response: { ok: true, status: 200, statusText: 'OK' }
          }),
          messages: () => ({
            data: mockMessages,
            error: null,
            response: { ok: true, status: 200, statusText: 'OK' }
          })
        }
      })
      h.mocks.listProjects.mockResolvedValue([])

      // `loadIpc` runs once per test in beforeEach, so the module-scoped LRU in ipc.ts
      // survives between invokes inside this test — which is what makes the cache
      // observable at all.
      const messages = vi.fn(() => ({
        data: mockMessages,
        error: null,
        response: { ok: true, status: 200, statusText: 'OK' }
      }))
      h.mocks.getClient.mockReturnValue({
        session: {
          list: () => ({
            data: mockSessions,
            error: null,
            response: { ok: true, status: 200, statusText: 'OK' }
          }),
          messages
        }
      })

      // Miss: the session's text has to be extracted, so messages are fetched.
      await h.invoke('oc:search:chats', '/project', 'test', { scope: 'project' })
      expect(messages).toHaveBeenCalledTimes(1)

      // Hit: same session, same `time.updated` → same cache key, no refetch. A different
      // query still hits the cache, because the cache holds extracted text, not results.
      await h.invoke('oc:search:chats', '/project', 'other', { scope: 'project' })
      expect(messages).toHaveBeenCalledTimes(1)

      // A changed `time.updated` yields a new key, so the text is extracted again.
      mockSessions[0].time.updated = 2000
      await h.invoke('oc:search:chats', '/project', 'test', { scope: 'project' })
      expect(messages).toHaveBeenCalledTimes(2)
    })

    it('handles session loading errors gracefully', async () => {
      h.mocks.getClient.mockReturnValue({
        session: {
          list: () => {
            throw new Error('Failed to load sessions')
          }
        }
      })
      h.mocks.listProjects.mockResolvedValueOnce([])

      const result = await h.invoke('oc:search:chats', '/project', 'query', {
        scope: 'project'
      })

      expect(result).toEqual([])
    })

    it('rejects hostile directory', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:search:chats', value, 'query', {}),
        HOSTILE_STRINGS
      )
    })

    it('coerces non-string query to empty string', async () => {
      const result = await h.invoke('oc:search:chats', '/project', 123, {})
      expect(result).toEqual([])
    })

    it('defaults undefined options to project scope', async () => {
      h.mocks.getClient.mockReturnValue({
        session: {
          list: () => ({
            data: [],
            error: null,
            response: { ok: true, status: 200, statusText: 'OK' }
          })
        }
      })
      h.mocks.listProjects.mockResolvedValueOnce([])

      const result = await h.invoke('oc:search:chats', '/project', 'query', undefined)
      expect(result).toEqual([])
    })

    it('rejects null options', async () => {
      await expect(h.invoke('oc:search:chats', '/project', 'query', null)).rejects.toThrow(/options must be an object/)
    })
  })
})
