import { describe, expect, it } from 'vitest'
import { guessMime, joinPath, toFileUrl } from '../fileurl'

describe('fileurl helpers', () => {
  it('converts Windows paths to proper 3-slash file:// URLs', () => {
    expect(toFileUrl('C:\\Users\\Hp\\document.txt')).toBe('file:///C:/Users/Hp/document.txt')
    expect(toFileUrl('C:/Users/Hp/space file.png')).toBe('file:///C:/Users/Hp/space%20file.png')
  })

  it('guesses mime types from extension', () => {
    expect(guessMime('code.ts')).toBe('text/typescript')
    expect(guessMime('photo.png')).toBe('image/png')
    expect(guessMime('photo.jpg')).toBe('image/jpeg')
    expect(guessMime('data.json')).toBe('application/json')
    expect(guessMime('doc.pdf')).toBe('application/pdf')
    expect(guessMime('unknown.xyz')).toBe('application/octet-stream')
  })

  it('joins directory and filename safely', () => {
    expect(joinPath('C:\\Users\\Hp', 'file.txt')).toBe('C:/Users/Hp/file.txt')
    expect(joinPath('C:/Users/Hp/', '/file.txt')).toBe('C:/Users/Hp/file.txt')
  })
})
