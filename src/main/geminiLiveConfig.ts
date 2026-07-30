/**
 * Validation + defaults for the Gemini Live session config that may cross
 * `oc:live:start` from the renderer. Electron-free so it stays unit-testable.
 * Channel shape is fixed by CONTRACTS.md.
 */

/**
 * Prebuilt Live API voices. `@google/genai` exports no enum for these (checked
 * against dist/genai.d.ts) — this is the documented set; keep in sync with the
 * dropdown in src/renderer/src/components/LiveScreenAssistant.tsx.
 */
export const GEMINI_LIVE_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'
] as const

/** Resolved session config — every field present after validation. */
export type GeminiLiveConfig = {
  voice: string
  model: string
  systemInstruction: string
}

export const DEFAULT_GEMINI_LIVE_CONFIG: GeminiLiveConfig = {
  voice: 'Kore',
  model: 'gemini-3.1-flash-live-preview',
  systemInstruction:
    'You are a concise visual copilot. Watch the shared screen, answer spoken or typed questions, ' +
    'and proactively mention important visible changes. Never claim to click or change the screen.'
}

const MODEL_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const MAX_SYSTEM_INSTRUCTION_LENGTH = 4000

/**
 * Merge renderer-supplied overrides over the defaults, rejecting anything malformed.
 * `undefined`/`null` means "all defaults"; unknown keys are dropped.
 */
export function validateGeminiLiveConfig(input: unknown): GeminiLiveConfig {
  if (input === undefined || input === null) return { ...DEFAULT_GEMINI_LIVE_CONFIG }
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('live config must be an object')
  const raw = input as Record<string, unknown>
  const config = { ...DEFAULT_GEMINI_LIVE_CONFIG }

  if (raw.voice !== undefined) {
    if (typeof raw.voice !== 'string' || !(GEMINI_LIVE_VOICES as readonly string[]).includes(raw.voice)) {
      throw new Error(`voice must be one of: ${GEMINI_LIVE_VOICES.join(', ')}`)
    }
    config.voice = raw.voice
  }
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string' || !MODEL_PATTERN.test(raw.model)) {
      throw new Error('model must be 1-128 characters of letters, digits, dot, dash or underscore')
    }
    config.model = raw.model
  }
  if (raw.systemInstruction !== undefined) {
    if (typeof raw.systemInstruction !== 'string' || raw.systemInstruction.length > MAX_SYSTEM_INSTRUCTION_LENGTH) {
      throw new Error(`systemInstruction must be a string of at most ${MAX_SYSTEM_INSTRUCTION_LENGTH} characters`)
    }
    config.systemInstruction = raw.systemInstruction
  }
  return config
}
