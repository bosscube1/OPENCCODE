import { GoogleGenAI, Modality, type LiveConnectConfig, type LiveServerMessage, type Session } from '@google/genai'
import { webContents, type WebContents } from 'electron'
import { validateGeminiLiveConfig, type GeminiLiveConfig } from './geminiLiveConfig'
import { loadByokEnv } from './keys'

export type GeminiLiveInput = {
  audio?: { data: string; mimeType: 'audio/pcm;rate=16000' }
  video?: { data: string; mimeType: 'image/jpeg' }
  text?: string
}

type LiveConnection = {
  client: GoogleGenAI
  /** Null while a reconnect is in flight (the socket closed but the session may resume). */
  session: Session | null
  contents: WebContents
  config: GeminiLiveConfig
  /** Latest handle from `sessionResumptionUpdate`; fed back into connect on reconnect. */
  resumptionHandle?: string
  /** Set by stopGeminiLive so the close callback skips the reconnect path. */
  userStopped: boolean
  /** True while the bounded reconnect loop is running — drops are expected then, not errors. */
  reconnecting: boolean
  /** Rate-limits drop warnings so a streaming mic cannot spam the renderer. */
  lastDropWarningAt: number
}

const connections = new Map<number, LiveConnection>()

const MAX_RECONNECT_ATTEMPTS = 3
const CLOSE_NORMAL = 1000
const CLOSE_ABNORMAL = 1006
const DROP_WARNING_INTERVAL_MS = 2000

function getApiKey(): string {
  const env = loadByokEnv()
  const key = env.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY
  if (!key) throw new Error('No Google API key is configured. Add Google under Providers first.')
  return key
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/([?&]key=)[^&\s]+/gi, '$1[redacted]')
}

function send(contents: WebContents, payload: unknown): void {
  if (!contents.isDestroyed()) contents.send('oc:live:message', payload)
}

function liveConnectConfig(config: GeminiLiveConfig, resumptionHandle?: string): LiveConnectConfig {
  return {
    responseModalities: [Modality.AUDIO],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } } },
    systemInstruction: config.systemInstruction,
    // Empty object enables resumption on a fresh session; a stored handle resumes.
    sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {},
    // Sliding-window compression keeps long screen-share sessions under the context cap.
    contextWindowCompression: { triggerTokens: '25600', slidingWindow: { targetTokens: '12800' } }
  }
}

function connectSession(connection: LiveConnection): Promise<Session> {
  return connection.client.live.connect({
    model: connection.config.model,
    config: liveConnectConfig(connection.config, connection.resumptionHandle),
    callbacks: {
      onmessage: (message: LiveServerMessage) => {
        const handle = message.sessionResumptionUpdate?.newHandle
        if (handle) connection.resumptionHandle = handle
        send(connection.contents, { type: 'message', data: message })
      },
      onerror: (event) => send(connection.contents, { type: 'error', message: safeError(event.error ?? event.message ?? 'Gemini Live connection error.') }),
      onclose: (event) => void handleClose(connection, event)
    }
  })
}

function handleClose(connection: LiveConnection, event: CloseEvent): void {
  const id = connection.contents.id
  connection.session = null
  // User-initiated stop, a superseded connection, or a clean close: report and move on.
  if (connection.userStopped || connections.get(id) !== connection || event.code === CLOSE_NORMAL) {
    if (connections.get(id) === connection) connections.delete(id)
    send(connection.contents, { type: 'closed', code: event.code, reason: event.reason })
    return
  }
  // Unexpected drop: try to resume with the stored resumption handle.
  void reconnect(connection)
}

async function reconnect(connection: LiveConnection): Promise<void> {
  const id = connection.contents.id
  connection.reconnecting = true
  try {
    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      if (connection.userStopped || connections.get(id) !== connection) return
      send(connection.contents, { type: 'reconnecting', attempt, maxAttempts: MAX_RECONNECT_ATTEMPTS })
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)))
      if (connection.userStopped || connections.get(id) !== connection) return
      try {
        const session = await connectSession(connection)
        // A stop may have landed while the socket was being opened.
        if (connection.userStopped || connections.get(id) !== connection) {
          session.close()
          return
        }
        connection.session = session
        return
      } catch {
        // Attempt numbers already surface through the reconnecting events; only
        // exhaustion needs its own signal (the closed event below).
      }
    }
    connections.delete(id)
    send(connection.contents, {
      type: 'closed',
      code: CLOSE_ABNORMAL,
      reason: `Connection lost; ${MAX_RECONNECT_ATTEMPTS} reconnect attempts failed.`
    })
  } finally {
    connection.reconnecting = false
  }
}

export async function startGeminiLive(contents: WebContents, rawConfig?: unknown): Promise<void> {
  const config = validateGeminiLiveConfig(rawConfig)
  stopGeminiLive(contents.id)
  const connection: LiveConnection = {
    client: new GoogleGenAI({ apiKey: getApiKey(), httpOptions: { apiVersion: 'v1beta' } }),
    session: null,
    contents,
    config,
    userStopped: false,
    reconnecting: false,
    lastDropWarningAt: 0
  }
  try {
    connection.session = await connectSession(connection)
  } catch (error) {
    throw new Error(`Unable to start Gemini Live: ${safeError(error)}`)
  }
  connections.set(contents.id, connection)
  contents.once('destroyed', () => stopGeminiLive(contents.id))
}

export function sendGeminiLive(contentsID: number, input: GeminiLiveInput): void {
  const connection = connections.get(contentsID)
  if (!connection) {
    warnDropped(contentsID, undefined, 'no live session')
    return
  }
  if (!connection.session) {
    // Mid-reconnect drops are expected — the UI already shows the reconnecting state.
    if (!connection.reconnecting) warnDropped(contentsID, connection, 'no live session')
    return
  }
  try {
    if (input.text !== undefined) {
      if (input.text.length > 32_000) { warnDropped(contentsID, connection, 'text over 32k characters'); return }
      connection.session.sendRealtimeInput({ text: input.text })
    } else if (input.audio !== undefined) {
      if (input.audio.data.length > 256_000) { warnDropped(contentsID, connection, 'audio chunk too large'); return }
      connection.session.sendRealtimeInput({ audio: input.audio })
    } else if (input.video !== undefined) {
      if (input.video.data.length > 3_000_000) { warnDropped(contentsID, connection, 'video frame too large'); return }
      connection.session.sendRealtimeInput({ video: input.video })
    }
  } catch (error) {
    warnDropped(contentsID, connection, safeError(error))
  }
}

let lastOrphanDropWarningAt = 0

/** Surface a dropped payload instead of failing silently; rate-limited per connection. */
function warnDropped(contentsID: number, connection: LiveConnection | undefined, detail: string): void {
  const now = Date.now()
  if (connection) {
    if (now - connection.lastDropWarningAt < DROP_WARNING_INTERVAL_MS) return
    connection.lastDropWarningAt = now
  } else {
    if (now - lastOrphanDropWarningAt < DROP_WARNING_INTERVAL_MS) return
    lastOrphanDropWarningAt = now
  }
  const contents = connection?.contents ?? webContents.fromId(contentsID)
  if (contents) send(contents, { type: 'error', message: `Dropped live input (${detail}).` })
}

export function stopGeminiLive(contentsID: number): void {
  const connection = connections.get(contentsID)
  if (!connection) return
  connection.userStopped = true
  connections.delete(contentsID)
  connection.session?.close()
}

export function stopAllGeminiLive(): void {
  for (const id of [...connections.keys()]) stopGeminiLive(id)
}
