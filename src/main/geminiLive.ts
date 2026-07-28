import { GoogleGenAI, Modality, type Session } from '@google/genai'
import type { WebContents } from 'electron'
import { loadByokEnv } from './keys'

export type GeminiLiveInput = {
  audio?: { data: string; mimeType: 'audio/pcm;rate=16000' }
  video?: { data: string; mimeType: 'image/jpeg' }
  text?: string
}

type LiveConnection = { client: GoogleGenAI; session: Session }
const connections = new Map<number, LiveConnection>()

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

export async function startGeminiLive(contents: WebContents): Promise<void> {
  stopGeminiLive(contents.id)
  const client = new GoogleGenAI({ apiKey: getApiKey(), httpOptions: { apiVersion: 'v1beta' } })
  try {
    const session = await client.live.connect({
      model: 'gemini-3.1-flash-live-preview',
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
        systemInstruction: 'You are a concise visual copilot. Watch the shared screen, answer spoken or typed questions, and proactively mention important visible changes. Never claim to click or change the screen.'
      },
      callbacks: {
        onmessage: (message) => send(contents, { type: 'message', data: message }),
        onerror: (event) => send(contents, { type: 'error', message: safeError(event.error ?? event.message ?? 'Gemini Live connection error.') }),
        onclose: (event) => {
          connections.delete(contents.id)
          send(contents, { type: 'closed', code: event.code, reason: event.reason })
        }
      }
    })
    connections.set(contents.id, { client, session })
    contents.once('destroyed', () => stopGeminiLive(contents.id))
  } catch (error) {
    throw new Error(`Unable to start Gemini Live: ${safeError(error)}`)
  }
}

export function sendGeminiLive(contentsID: number, input: GeminiLiveInput): void {
  const connection = connections.get(contentsID)
  if (!connection) return
  if (input.text !== undefined) {
    if (input.text.length > 32_000) return
    connection.session.sendRealtimeInput({ text: input.text })
  } else if (input.audio !== undefined) {
    if (input.audio.data.length > 256_000) return
    connection.session.sendRealtimeInput({ audio: input.audio })
  } else if (input.video !== undefined) {
    if (input.video.data.length > 3_000_000) return
    connection.session.sendRealtimeInput({ video: input.video })
  }
}

export function stopGeminiLive(contentsID: number): void {
  const connection = connections.get(contentsID)
  if (!connection) return
  connections.delete(contentsID)
  connection.session.close()
}

export function stopAllGeminiLive(): void {
  for (const id of [...connections.keys()]) stopGeminiLive(id)
}
