import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Mutable state read by the mocked electron module below. Declared via vi.hoisted so it exists
// before the hoisted vi.mock factory runs (see https://vitest.dev/api/vi.html#vi-hoisted).
const state = vi.hoisted(() => ({ userDataPath: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.userDataPath }
}))

import { deleteImage, listImages, readImage, readIndex, reconcile, saveImage } from '../nanogptImages'

/** A real, decodable 1x1 transparent PNG. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function imagesDirPath(): string {
  return join(state.userDataPath, 'nanogpt-images')
}

function indexPath(): string {
  return join(imagesDirPath(), 'index.json')
}

describe('nanogptImages', () => {
  beforeEach(() => {
    state.userDataPath = mkdtempSync(join(tmpdir(), 'opencode-nanogptimg-'))
  })

  afterEach(() => {
    rmSync(state.userDataPath, { recursive: true, force: true })
  })

  describe('readIndex', () => {
    it('returns an empty index when no file exists', () => {
      expect(readIndex()).toEqual({ version: 1, images: [] })
    })

    it('returns an empty index and does not throw when the file is corrupt', () => {
      mkdirSync(imagesDirPath(), { recursive: true })
      writeFileSync(indexPath(), '{ not json', 'utf8')
      expect(() => readIndex()).not.toThrow()
      expect(readIndex()).toEqual({ version: 1, images: [] })
    })

    it('drops malformed entries: missing id, non-string prompt, non-string model', () => {
      mkdirSync(imagesDirPath(), { recursive: true })
      const raw = {
        version: 1,
        images: [
          { prompt: 'no id', model: 'm', createdAt: 1, bytes: 1 }, // missing id
          { id: 'a', prompt: 123, model: 'm', createdAt: 1, bytes: 1 }, // non-string prompt
          { id: 'b', prompt: 'p', model: 42, createdAt: 1, bytes: 1 }, // non-string model
          { id: 'ok', prompt: 'p', model: 'm', createdAt: 1, bytes: 1 } // well-formed
        ]
      }
      writeFileSync(indexPath(), JSON.stringify(raw), 'utf8')
      const index = readIndex()
      expect(index.images).toHaveLength(1)
      expect(index.images[0]?.id).toBe('ok')
    })
  })

  describe('saveImage', () => {
    it('writes a real PNG file and returns metadata with correct bytes and createdAt', () => {
      const decoded = Buffer.from(TINY_PNG_BASE64, 'base64')
      const meta = saveImage({
        base64: TINY_PNG_BASE64,
        sessionID: 's1',
        prompt: 'a cat',
        model: 'nano-banana'
      })

      expect(meta.bytes).toBe(decoded.byteLength)
      expect(Number.isFinite(meta.createdAt)).toBe(true)

      const pngPath = join(imagesDirPath(), `${meta.id}.png`)
      expect(existsSync(pngPath)).toBe(true)
    })

    it('throws when given an empty base64 string', () => {
      expect(() =>
        saveImage({ base64: '', sessionID: null, prompt: 'p', model: 'm' })
      ).toThrow()
    })
  })

  describe('listImages', () => {
    it('returns newest first', () => {
      const first = saveImage({
        base64: TINY_PNG_BASE64,
        sessionID: 's1',
        prompt: 'first',
        model: 'm'
      })
      const second = saveImage({
        base64: TINY_PNG_BASE64,
        sessionID: 's1',
        prompt: 'second',
        model: 'm'
      })
      // saveImage stamps createdAt via Date.now(); force a deterministic order regardless of
      // clock resolution by rewriting the index with explicit timestamps.
      const index = readIndex()
      const rewritten = {
        version: 1 as const,
        images: index.images.map((meta) =>
          meta.id === first.id
            ? { ...meta, createdAt: 1000 }
            : meta.id === second.id
              ? { ...meta, createdAt: 2000 }
              : meta
        )
      }
      writeFileSync(indexPath(), `${JSON.stringify(rewritten, null, 2)}\n`, 'utf8')

      const listed = listImages()
      expect(listed.map((m) => m.id)).toEqual([second.id, first.id])
    })

    it('scopes to a session and excludes entries saved with sessionID: null', () => {
      const scoped = saveImage({
        base64: TINY_PNG_BASE64,
        sessionID: 's1',
        prompt: 'p',
        model: 'm'
      })
      const otherSession = saveImage({
        base64: TINY_PNG_BASE64,
        sessionID: 's2',
        prompt: 'p',
        model: 'm'
      })
      const noSession = saveImage({
        base64: TINY_PNG_BASE64,
        sessionID: null,
        prompt: 'p',
        model: 'm'
      })

      const listed = listImages('s1')
      const ids = listed.map((m) => m.id)
      expect(ids).toContain(scoped.id)
      expect(ids).not.toContain(otherSession.id)
      expect(ids).not.toContain(noSession.id)
    })
  })

  describe('readImage', () => {
    it('round-trips the exact base64 that was saved', () => {
      const meta = saveImage({
        base64: TINY_PNG_BASE64,
        sessionID: null,
        prompt: 'p',
        model: 'm'
      })
      expect(readImage(meta.id)).toBe(TINY_PNG_BASE64)
    })

    it('returns null for an unknown but well-formed id', () => {
      expect(readImage(randomUUID())).toBeNull()
    })
  })

  describe('path-traversal guard', () => {
    // Two levels above imagesDir() (userDataPath/nanogpt-images) is tmpdir() itself, so a
    // "../../<name>" id — if the traversal guard failed — would resolve to a real file here.
    // Placing a sentinel there and asserting it is never returned proves the guard actually
    // prevents escaping the images directory, not merely that it rejects a hardcoded string.
    const sentinelName = `nanogptimg-traversal-target-${Date.now()}.txt`
    const outsideFile = join(tmpdir(), sentinelName)

    beforeEach(() => {
      writeFileSync(outsideFile, 'do not read me', 'utf8')
    })

    afterEach(() => {
      try {
        unlinkSync(outsideFile)
      } catch {
        /* best effort */
      }
    })

    it('readImage rejects traversal ids, returning null instead of the outside file', () => {
      expect(readImage('../../etc/passwd')).toBeNull()
      expect(readImage(`../../${sentinelName}`)).toBeNull()
    })

    it('readImage rejects other malformed ids: a/b, .., empty string, valid-id+.png suffix', () => {
      expect(readImage('a/b')).toBeNull()
      expect(readImage('..')).toBeNull()
      expect(readImage('')).toBeNull()
      expect(readImage(`${randomUUID()}.png`)).toBeNull()
    })

    it('deleteImage throws on traversal ids rather than deleting anything', () => {
      expect(() => deleteImage('../../foo')).toThrow()
      expect(() => deleteImage(`../../${sentinelName}`)).toThrow()
      expect(() => deleteImage('a/b')).toThrow()
      expect(() => deleteImage('..')).toThrow()
      expect(() => deleteImage('')).toThrow()
      expect(() => deleteImage(`${randomUUID()}.png`)).toThrow()

      // Confirm the file outside the images dir survived every attempt above.
      expect(existsSync(outsideFile)).toBe(true)
    })
  })

  describe('deleteImage', () => {
    it('removes both the file and the index entry', () => {
      const meta = saveImage({
        base64: TINY_PNG_BASE64,
        sessionID: null,
        prompt: 'p',
        model: 'm'
      })
      const pngPath = join(imagesDirPath(), `${meta.id}.png`)
      expect(existsSync(pngPath)).toBe(true)

      deleteImage(meta.id)

      expect(existsSync(pngPath)).toBe(false)
      expect(readIndex().images.find((m) => m.id === meta.id)).toBeUndefined()
    })

    it('does not throw when called for an unknown but valid id', () => {
      expect(() => deleteImage(randomUUID())).not.toThrow()
    })
  })

  describe('reconcile', () => {
    it('drops an index entry whose PNG was deleted out from under it', () => {
      const meta = saveImage({
        base64: TINY_PNG_BASE64,
        sessionID: null,
        prompt: 'p',
        model: 'm'
      })
      const pngPath = join(imagesDirPath(), `${meta.id}.png`)
      unlinkSync(pngPath)

      const result = reconcile()

      expect(result.removedEntries).toBe(1)
      expect(readIndex().images.find((m) => m.id === meta.id)).toBeUndefined()
    })

    it('deletes an orphan PNG with no index entry, and never deletes index.json', () => {
      mkdirSync(imagesDirPath(), { recursive: true })
      const orphanId = randomUUID()
      writeFileSync(join(imagesDirPath(), `${orphanId}.png`), Buffer.from([1, 2, 3]))
      // Ensure index.json exists so we can assert it survives.
      writeFileSync(indexPath(), `${JSON.stringify({ version: 1, images: [] }, null, 2)}\n`, 'utf8')

      const result = reconcile()

      expect(result.removedFiles).toBe(1)
      expect(existsSync(join(imagesDirPath(), `${orphanId}.png`))).toBe(false)
      expect(existsSync(indexPath())).toBe(true)
    })
  })

  describe('retention (MAX_RETAINED cap)', () => {
    it('prunes the single oldest entry when a save pushes the count past 500', () => {
      // Exercising the real 501-image path via 501 saveImage() calls would be slow and slightly
      // indirect (Date.now() resolution could tie createdAt across fast writes). Instead we seed
      // the index directly with 500 synthetic, strictly-ordered entries plus their on-disk PNGs —
      // this is an honest exercise of the exact prune logic in saveImage() (readIndex -> sort by
      // createdAt -> drop oldest past the cap -> unlink -> rewrite index), just without paying for
      // 500 real encode/decode round trips.
      mkdirSync(imagesDirPath(), { recursive: true })
      const synthetic = Array.from({ length: 500 }, (_, i) => {
        const id = randomUUID()
        writeFileSync(join(imagesDirPath(), `${id}.png`), Buffer.from([0]))
        return {
          id,
          sessionID: null,
          prompt: 'p',
          model: 'm',
          createdAt: 1000 + i, // strictly increasing; index 0 is the oldest
          bytes: 1
        }
      })
      writeFileSync(indexPath(), `${JSON.stringify({ version: 1, images: synthetic }, null, 2)}\n`, 'utf8')

      const oldest = synthetic[0]!
      const newest = saveImage({
        base64: TINY_PNG_BASE64,
        sessionID: null,
        prompt: 'newest',
        model: 'm'
      })

      const index = readIndex()
      expect(index.images).toHaveLength(500)
      expect(index.images.find((m) => m.id === oldest.id)).toBeUndefined()
      expect(index.images.find((m) => m.id === newest.id)).toBeDefined()
      expect(existsSync(join(imagesDirPath(), `${oldest.id}.png`))).toBe(false)
      expect(existsSync(join(imagesDirPath(), `${newest.id}.png`))).toBe(true)
    })
  })
})
