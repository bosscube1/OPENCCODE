import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { isTrustedRendererUrl } from '../trustedUrl'

describe('isTrustedRendererUrl', () => {
  describe('dev mode (rendererUrl provided)', () => {
    const rendererUrl = 'http://127.0.0.1:5173'

    it('allows navigation to the exact same origin and protocol', () => {
      expect(isTrustedRendererUrl('http://127.0.0.1:5173', rendererUrl, '')).toBe(true)
      expect(isTrustedRendererUrl('http://127.0.0.1:5173/', rendererUrl, '')).toBe(true)
      expect(isTrustedRendererUrl('http://127.0.0.1:5173/page', rendererUrl, '')).toBe(true)
    })

    it('rejects different ports', () => {
      expect(isTrustedRendererUrl('http://127.0.0.1:5174', rendererUrl, '')).toBe(false)
      expect(isTrustedRendererUrl('http://127.0.0.1:3000', rendererUrl, '')).toBe(false)
    })

    it('rejects different protocols on the same host', () => {
      expect(isTrustedRendererUrl('https://127.0.0.1:5173', rendererUrl, '')).toBe(false)
    })

    it('rejects the security case: http://127.0.0.1:5173@evil.example', () => {
      // A naive startsWith check would pass this, but the @ makes it a different origin.
      // The URL parser treats everything before @ as userinfo, and the origin is evil.example.
      expect(isTrustedRendererUrl('http://127.0.0.1:5173@evil.example', rendererUrl, '')).toBe(false)
    })

    it('rejects different hosts entirely', () => {
      expect(isTrustedRendererUrl('http://localhost:5173', rendererUrl, '')).toBe(false)
      expect(isTrustedRendererUrl('http://example.com', rendererUrl, '')).toBe(false)
    })
  })

  describe('packaged mode (rendererUrl undefined)', () => {
    it('allows file: URLs that resolve to the exact renderer HTML path', () => {
      const htmlPath = resolve('/app/out/renderer/index.html')
      const fileUrl = pathToFileURL(htmlPath).href
      expect(isTrustedRendererUrl(fileUrl, undefined, htmlPath)).toBe(true)
    })

    it('rejects file: URLs to sibling files', () => {
      const htmlPath = resolve('/app/out/renderer/index.html')
      const siblingPath = resolve('/app/out/renderer/sibling.html')
      const sibling = pathToFileURL(siblingPath).href
      expect(isTrustedRendererUrl(sibling, undefined, htmlPath)).toBe(false)
    })

    it('rejects file: URLs to parent directories', () => {
      const htmlPath = resolve('/app/out/renderer/index.html')
      const parentPath = resolve('/app/out/index.html')
      const parent = pathToFileURL(parentPath).href
      expect(isTrustedRendererUrl(parent, undefined, htmlPath)).toBe(false)
    })

    it('rejects http: URLs in packaged mode', () => {
      const htmlPath = resolve('/app/out/renderer/index.html')
      expect(isTrustedRendererUrl('http://127.0.0.1:5173', undefined, htmlPath)).toBe(false)
    })

    it('rejects UNC-style file URLs with non-empty hostnames', () => {
      const htmlPath = resolve('/app/out/renderer/index.html')
      // file://host/share/x.html has a non-empty hostname
      expect(isTrustedRendererUrl('file://server/share/index.html', undefined, htmlPath)).toBe(false)
    })
  })

  describe('garbage input', () => {
    it('returns false for unparseable strings without throwing', () => {
      expect(isTrustedRendererUrl('not a url', 'http://localhost:5173', '/tmp/index.html')).toBe(false)
    })

    it('returns false for empty strings without throwing', () => {
      expect(isTrustedRendererUrl('', 'http://localhost:5173', '/tmp/index.html')).toBe(false)
    })

    it('returns false for malformed URLs without throwing', () => {
      expect(isTrustedRendererUrl('ht!tp://example.com', undefined, '/tmp/index.html')).toBe(false)
    })

    it('returns false for random strings without throwing', () => {
      expect(isTrustedRendererUrl('\\\\server\\share\\file.html', undefined, '/tmp/index.html')).toBe(false)
    })
  })
})
