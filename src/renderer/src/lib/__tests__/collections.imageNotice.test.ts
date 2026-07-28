import { describe, expect, it } from 'vitest'
import { makeImageNotice, type NoticeImage } from '../collections'
import { isFilePart, isTextPart } from '../types'

const IMAGES: NoticeImage[] = [
  { id: 'img-1', dataUrl: 'data:image/png;base64,aaaa', filename: 'first.png' },
  { id: 'img-2', dataUrl: 'data:image/png;base64,bbbb', filename: 'second.png' }
]

describe('makeImageNotice', () => {
  it('builds an assistant message with a text caption followed by one file part per image', () => {
    const msg = makeImageNotice('session-1', 'Here are your images', IMAGES)

    expect(msg.info.role).toBe('assistant')
    expect(msg.parts).toHaveLength(1 + IMAGES.length)

    const [textPart, ...filePartsRaw] = msg.parts
    expect(textPart).toBeDefined()
    expect(textPart!.type).toBe('text')
    if (isTextPart(textPart!)) {
      expect(textPart.text).toBe('Here are your images')
    }

    expect(filePartsRaw).toHaveLength(IMAGES.length)
    for (const part of filePartsRaw) {
      expect(part.type).toBe('file')
    }
  })

  it('gives each file part the correct mime, filename, and url', () => {
    const msg = makeImageNotice('session-1', 'caption', IMAGES)
    const fileParts = msg.parts.slice(1)

    fileParts.forEach((part, i) => {
      expect(isFilePart(part)).toBe(true)
      if (isFilePart(part)) {
        expect(part.mime).toBe('image/png')
        expect(part.filename).toBe(IMAGES[i]!.filename)
        expect(part.url).toBe(IMAGES[i]!.dataUrl)
      }
    })
  })

  it('gives every part a unique id, and every part.messageID equal to info.id', () => {
    const msg = makeImageNotice('session-1', 'caption', IMAGES)

    const ids = msg.parts.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)

    for (const part of msg.parts) {
      expect(part.messageID).toBe(msg.info.id)
    }
  })

  it('sets info.time.created to Math.floor(createdAt / 1000) for an explicit createdAt', () => {
    const createdAt = 1_700_000_123_456
    const msg = makeImageNotice('session-1', 'caption', IMAGES, createdAt)
    expect(msg.info.time.created).toBe(Math.floor(createdAt / 1000))
  })

  it('produces just the text part, with a stable id, when given zero images', () => {
    const msg = makeImageNotice('session-1', 'no images here', [])

    expect(msg.parts).toHaveLength(1)
    expect(msg.parts[0]!.type).toBe('text')
    expect(typeof msg.info.id).toBe('string')
    expect(msg.info.id.length).toBeGreaterThan(0)
    // Every part still belongs to the message.
    expect(msg.parts[0]!.messageID).toBe(msg.info.id)
  })

  it('produces file parts that satisfy isFilePart and mime.startsWith("image/") — the combination MessageView relies on for thumbnails', () => {
    const msg = makeImageNotice('session-1', 'caption', IMAGES)
    const fileParts = msg.parts.slice(1)

    expect(fileParts.length).toBeGreaterThan(0)
    for (const part of fileParts) {
      expect(isFilePart(part)).toBe(true)
      if (isFilePart(part)) {
        expect(part.mime.startsWith('image/')).toBe(true)
      }
    }
  })
})
