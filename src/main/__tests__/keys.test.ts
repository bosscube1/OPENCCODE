import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'

// Create a unique temp directory for this test suite
const testTmpDir = join(tmpdir(), `opencode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
mkdirSync(testTmpDir, { recursive: true })

// Mock electron BEFORE importing keys.ts
vi.mock('electron', () => ({
  app: {
    getPath: () => testTmpDir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('enc:' + s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, '')
  }
}))

// Now import keys module (which will use the mocked electron)
import { setKey, deleteKey, listKeys, loadByokEnv, setMcpSecrets, getMcpSecrets, deleteMcpSecrets } from '../keys'

describe('keys module', () => {
  beforeEach(() => {
    // Clean up encrypted stores before each test.
    for (const filename of ['byok-keys.json', 'mcp-secrets.json']) {
      const storePath = join(testTmpDir, filename)
      if (existsSync(storePath)) rmSync(storePath)
    }
  })

  afterEach(() => {
    // Clean up encrypted stores after each test.
    for (const filename of ['byok-keys.json', 'mcp-secrets.json']) {
      const storePath = join(testTmpDir, filename)
      if (existsSync(storePath)) rmSync(storePath)
    }
  })

  it('setKey and listKeys with masked tail for last 4 chars', () => {
    setKey('groq', 'gsk_secret123')
    const rows = listKeys()

    const groqRow = rows.find((r) => r.providerID === 'groq')
    expect(groqRow).toBeDefined()
    expect(groqRow?.maskedTail).toBe('t123') // last 4 chars of 'gsk_secret123'
    expect(groqRow?.envVar).toBe('GROQ_API_KEY')

    // Ensure the full key is never exposed
    const fullKeyInRows = rows.some((r) => JSON.stringify(r).includes('gsk_secret123'))
    expect(fullKeyInRows).toBe(false)
  })

  it('loadByokEnv returns plaintext via mocked decrypt', () => {
    setKey('groq', 'gsk_secret123')
    const env = loadByokEnv()

    expect(env.GROQ_API_KEY).toBe('gsk_secret123')
  })

  it('loadByokEnv includes alias expansion for GEMINI_API_KEY', () => {
    setKey('google', 'test-gemini-key')
    const env = loadByokEnv()

    expect(env.GEMINI_API_KEY).toBe('test-gemini-key')
    // Check for Gemini aliases defined in env.ts
    expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBe('test-gemini-key')
    expect(env.GOOGLE_API_KEY).toBe('test-gemini-key')
  })

  it('loadByokEnv includes alias expansion for HUGGINGFACE_API_KEY', () => {
    setKey('huggingface', 'hf_test_key')
    const env = loadByokEnv()

    expect(env.HUGGINGFACE_API_KEY).toBe('hf_test_key')
    expect(env.HF_TOKEN).toBe('hf_test_key')
  })

  it('loadByokEnv includes alias expansion for NVIDIA_NIM_API_KEY', () => {
    setKey('nvidia', 'nvidia_test_key')
    const env = loadByokEnv()

    expect(env.NVIDIA_NIM_API_KEY).toBe('nvidia_test_key')
    expect(env.NVIDIA_API_KEY).toBe('nvidia_test_key')
  })

  it('listKeys never exposes the full key', () => {
    setKey('groq', 'gsk_verylongsecretkey123')
    setKey('openai', 'sk_live_abcdefghijklmnop')

    const rows = listKeys()
    const rowsJson = JSON.stringify(rows)

    expect(rowsJson).not.toContain('gsk_verylongsecretkey123')
    expect(rowsJson).not.toContain('sk_live_abcdefghijklmnop')

    // Only masked tails should be present
    expect(rowsJson).toContain('y123')
    expect(rowsJson).toContain('mnop')
  })

  it('deleteKey removes key from listKeys', () => {
    setKey('groq', 'gsk_secret123')
    let rows = listKeys()
    expect(rows.some((r) => r.providerID === 'groq')).toBe(true)

    deleteKey('groq')
    rows = listKeys()
    expect(rows.some((r) => r.providerID === 'groq')).toBe(false)
  })

  it('deleteKey removes key from loadByokEnv', () => {
    setKey('groq', 'gsk_secret123')
    let env = loadByokEnv()
    expect(env.GROQ_API_KEY).toBe('gsk_secret123')

    deleteKey('groq')
    env = loadByokEnv()
    expect(env.GROQ_API_KEY).toBeUndefined()
  })

  it('setKey with unknown providerID throws', () => {
    expect(() => setKey('unknown-provider', 'some_key')).toThrow('Unknown provider: unknown-provider')
  })

  it('setKey with empty key throws', () => {
    expect(() => setKey('groq', '')).toThrow(/empty key/)
    expect(() => setKey('groq', '   ')).toThrow(/empty key/)
  })

  it('encrypts MCP credentials separately from workspace configuration', () => {
    setMcpSecrets('C:\\Workspace', 'remote', {
      headers: { Authorization: 'Bearer secret' },
      oauthClientSecret: 'oauth-secret'
    })
    expect(getMcpSecrets('C:\\Workspace', 'remote')).toEqual({
      headers: { Authorization: 'Bearer secret' },
      oauthClientSecret: 'oauth-secret'
    })
    const raw = readFileSync(join(testTmpDir, 'mcp-secrets.json'), 'utf8')
    expect(raw).not.toContain('Bearer secret')
    expect(raw).not.toContain('oauth-secret')
    deleteMcpSecrets('C:\\Workspace', 'remote')
    expect(getMcpSecrets('C:\\Workspace', 'remote')).toBeUndefined()
  })

  it('multiple keys can be stored and listed independently', () => {
    setKey('groq', 'gsk_secret123')
    setKey('openai', 'sk_live_abc')
    setKey('anthropic', 'sk-ant-xyz')

    const rows = listKeys()
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.providerID).sort()).toEqual(['anthropic', 'groq', 'openai'])
  })

  it('listKeys with short key produces null maskedTail', () => {
    setKey('groq', 'abc') // Only 3 chars, less than 4
    const rows = listKeys()

    const groqRow = rows.find((r) => r.providerID === 'groq')
    expect(groqRow?.maskedTail).toBeNull()
  })
})
