import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import './live-screen.css'

type LiveStatus = 'idle' | 'connecting' | 'live' | 'error'
type TranscriptEntry = { role: 'you' | 'gemini' | 'system'; text: string }
type ServerMessage = { setupComplete?: object; serverContent?: { interrupted?: boolean; inputTranscription?: { text?: string }; outputTranscription?: { text?: string }; modelTurn?: { parts?: Array<{ text?: string; inlineData?: { data?: string; mimeType?: string } }> } } }

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return window.btoa(binary)
}

function base64ToInt16(value: string): Int16Array {
  const binary = window.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Int16Array(bytes.buffer)
}

function pcm16FromFloat32(input: Float32Array, sourceRate: number): Uint8Array {
  const ratio = sourceRate / 16_000
  const output = new Int16Array(Math.max(1, Math.floor(input.length / ratio)))
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio)
    const end = Math.min(input.length, Math.floor((index + 1) * ratio))
    let sum = 0
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) sum += input[sourceIndex]
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)))
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return new Uint8Array(output.buffer)
}

export function LiveScreenAssistant({ onClose }: { onClose: () => void }): JSX.Element {
  const [status, setStatus] = useState<LiveStatus>('idle')
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const unsubscribeLive = useRef<(() => void) | null>(null)
  const screenStream = useRef<MediaStream | null>(null)
  const micStream = useRef<MediaStream | null>(null)
  const frameTimer = useRef<number | null>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const audioContext = useRef<AudioContext | null>(null)
  const audioProcessor = useRef<ScriptProcessorNode | null>(null)
  const audioSources = useRef(new Set<AudioBufferSourceNode>())
  const nextAudioTime = useRef(0)
  const closing = useRef(false)

  const addTranscript = (role: TranscriptEntry['role'], text: string): void => {
    if (!text.trim()) return
    setTranscript((items) => {
      const previous = items.at(-1)
      return previous?.role === role && role !== 'system'
        ? [...items.slice(0, -1), { role, text: `${previous.text}${text}` }]
        : [...items, { role, text }]
    })
  }

  const stop = (): void => {
    closing.current = true
    if (frameTimer.current !== null) window.clearInterval(frameTimer.current)
    frameTimer.current = null
    audioProcessor.current?.disconnect()
    audioProcessor.current = null
    micStream.current?.getTracks().forEach((track) => track.stop())
    screenStream.current?.getTracks().forEach((track) => track.stop())
    micStream.current = null
    screenStream.current = null
    for (const source of audioSources.current) source.stop()
    audioSources.current.clear()
    void audioContext.current?.close()
    audioContext.current = null
    unsubscribeLive.current?.()
    unsubscribeLive.current = null
    void window.api.live.stop()
    nextAudioTime.current = 0
    setStatus('idle')
  }

  useEffect(() => () => stop(), [])

  const playAudio = (data: string): void => {
    const context = audioContext.current
    if (!context) return
    const pcm = base64ToInt16(data)
    const buffer = context.createBuffer(1, pcm.length, 24_000)
    const channel = buffer.getChannelData(0)
    for (let index = 0; index < pcm.length; index += 1) channel[index] = pcm[index] / 0x8000
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    const startAt = Math.max(context.currentTime + 0.02, nextAudioTime.current)
    source.start(startAt)
    nextAudioTime.current = startAt + buffer.duration
    audioSources.current.add(source)
    source.onended = () => audioSources.current.delete(source)
  }

  const startMicrophone = async (): Promise<void> => {
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      micStream.current = media
      const context = audioContext.current ?? new AudioContext()
      audioContext.current = context
      await context.resume()
      const source = context.createMediaStreamSource(media)
      const processor = context.createScriptProcessor(4096, 1, 1)
      const mutedOutput = context.createGain()
      mutedOutput.gain.value = 0
      processor.onaudioprocess = (event) => {
        const data = bytesToBase64(pcm16FromFloat32(event.inputBuffer.getChannelData(0), context.sampleRate))
        window.api.live.send({ audio: { data, mimeType: 'audio/pcm;rate=16000' } })
      }
      source.connect(processor)
      processor.connect(mutedOutput)
      mutedOutput.connect(context.destination)
      audioProcessor.current = processor
    } catch {
      addTranscript('system', 'Microphone unavailable — screen and typed questions are still live.')
    }
  }

  const startFrames = (media: MediaStream): void => {
    const video = document.createElement('video')
    video.srcObject = media
    video.muted = true
    video.playsInline = true
    void video.play()
    const sendFrame = (): void => {
      const target = canvas.current
      if (!target || video.readyState < 2) return
      const aspect = video.videoWidth / Math.max(1, video.videoHeight)
      target.width = 768
      target.height = Math.round(768 / aspect)
      target.getContext('2d')?.drawImage(video, 0, 0, target.width, target.height)
      const data = target.toDataURL('image/jpeg', 0.62).split(',')[1]
      window.api.live.send({ video: { data, mimeType: 'image/jpeg' } })
    }
    frameTimer.current = window.setInterval(sendFrame, 1000)
  }

  const connect = async (): Promise<void> => {
    closing.current = false
    setError(null)
    setStatus('connecting')
    setTranscript([])
    try {
      const media = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false })
      screenStream.current = media
      media.getVideoTracks()[0]?.addEventListener('ended', stop, { once: true })
      const context = new AudioContext()
      audioContext.current = context
      await context.resume()
      unsubscribeLive.current = window.api.live.onMessage((event) => {
        if (event.type === 'error') { setError(event.message); setStatus('error'); return }
        if (event.type === 'closed') {
          if (!closing.current) { setError(event.reason || `Gemini Live closed unexpectedly (code ${event.code}).`); setStatus('error') }
          return
        }
        const data = event.data as ServerMessage
        const content = data.serverContent
        if (!content) return
        if (content.interrupted) {
          for (const source of audioSources.current) source.stop()
          audioSources.current.clear()
          nextAudioTime.current = 0
        }
        if (content.inputTranscription?.text) addTranscript('you', content.inputTranscription.text)
        if (content.outputTranscription?.text) addTranscript('gemini', content.outputTranscription.text)
        for (const part of content.modelTurn?.parts ?? []) {
          if (part.text) addTranscript('gemini', part.text)
          if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/pcm')) playAudio(part.inlineData.data)
        }
      })
      await window.api.live.start()
      setStatus('live')
      addTranscript('system', 'Connected. Speak naturally or type a question.')
      startFrames(media)
      void startMicrophone()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Screen sharing was cancelled.')
      setStatus('error')
    }
  }

  const sendPrompt = (): void => {
    const text = prompt.trim()
    if (!text || status !== 'live') return
    window.api.live.send({ text })
    addTranscript('you', text)
    setPrompt('')
  }

  return <div className="live-screen" role="dialog" aria-modal="true">
    <div className="live-screen__head"><div><span className="live-screen__eyebrow">GEMINI 3.1 FLASH LIVE</span><h1>Screen copilot</h1><p>Share a window, speak naturally, and get live visual help.</p></div><button className="live-screen__close" onClick={() => { stop(); onClose() }}>Close</button></div>
    <div className="live-screen__body"><div className="live-screen__preview"><canvas ref={canvas} /><div className="live-screen__preview-label"><span className={`live-screen__dot live-screen__dot--${status}`} />{status === 'live' ? 'Screen + microphone live' : status === 'connecting' ? 'Connecting…' : 'Screen preview'}</div></div><div className="live-screen__conversation"><div className="live-screen__messages" aria-live="polite">{transcript.length ? transcript.map((entry, index) => <p className={`live-screen__message live-screen__message--${entry.role}`} key={`${index}-${entry.text.slice(0, 10)}`}><strong>{entry.role === 'gemini' ? 'Gemini' : entry.role === 'you' ? 'You' : 'Status'}</strong>{entry.text}</p>) : <p className="live-screen__muted">Your visual conversation will appear here.</p>}</div><div className="live-screen__controls"><input value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') sendPrompt() }} placeholder="Ask about the screen…" disabled={status !== 'live'} /><button onClick={sendPrompt} disabled={status !== 'live'}>Send</button></div></div></div>
    <div className="live-screen__foot"><span className="live-screen__provider">Uses the encrypted Google key from Providers</span><button className="live-screen__start" onClick={status === 'live' || status === 'connecting' ? stop : () => void connect()}>{status === 'live' ? 'Stop sharing' : status === 'connecting' ? 'Cancel' : 'Start screen share'}</button>{error && <span className="live-screen__error">{error}</span>}</div>
  </div>
}
