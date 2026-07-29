/* global AudioWorkletProcessor, registerProcessor, sampleRate */

/**
 * Mic capture for the Gemini Live screen copilot.
 *
 * Receives mono Float32 frames at the AudioContext rate, decimates to 16 kHz
 * PCM16 (same naive averaging the old ScriptProcessorNode path used) and posts
 * the bytes to the node, which forwards them over IPC as base64. Output format
 * is unchanged: `audio/pcm;rate=16000`, mono.
 *
 * Served as a same-origin static asset (src/renderer/public/) and loaded via
 * `audioWorklet.addModule()` in LiveScreenAssistant.tsx — a blob: module URL
 * would violate the production CSP (`script-src 'self'`, no worker-src/blob:).
 */
class LiveMicCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / 16000
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length > 0) {
      const output = new Int16Array(Math.max(1, Math.floor(channel.length / this.ratio)))
      for (let index = 0; index < output.length; index += 1) {
        const start = Math.floor(index * this.ratio)
        const end = Math.min(channel.length, Math.floor((index + 1) * this.ratio))
        let sum = 0
        for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) sum += channel[sourceIndex]
        const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)))
        output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      }
      this.port.postMessage(output.buffer, [output.buffer])
    }
    return true
  }
}

registerProcessor('live-mic-capture', LiveMicCapture)
