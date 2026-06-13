import { describe, expect, it } from 'vitest'
import {
  extName,
  isImage,
  isMarkdown,
  isVideo,
  mimeCategory,
  mimeForPath,
} from './mime'

describe('mime', () => {
  it('extracts lowercase extensions, OS-aware', () => {
    expect(extName('/a/b/photo.PNG')).toBe('png')
    expect(extName('C:\\docs\\readme.md')).toBe('md')
    expect(extName('/no/ext/Makefile')).toBe('')
    expect(extName('/hidden/.gitignore')).toBe('') // dot-file, not an extension
  })

  it('maps developer file types to MIME', () => {
    expect(mimeForPath('/x/icon.svg')).toBe('image/svg+xml')
    expect(mimeForPath('/x/clip.mp4')).toBe('video/mp4')
    expect(mimeForPath('/x/song.mp3')).toBe('audio/mpeg')
    expect(mimeForPath('/x/doc.pdf')).toBe('application/pdf')
    expect(mimeForPath('/x/bundle.zip')).toBe('application/zip')
    expect(mimeForPath('/x/README.md')).toBe('text/markdown')
  })

  it('falls back to octet-stream for unknown types', () => {
    expect(mimeForPath('/x/main.ts')).toBe('application/octet-stream')
  })

  it('derives category and guards', () => {
    expect(mimeCategory('image/png')).toBe('image')
    expect(isImage('image/webp')).toBe(true)
    expect(isVideo('video/webm')).toBe(true)
    expect(isMarkdown('text/markdown')).toBe(true)
    expect(isImage('application/pdf')).toBe(false)
  })
})
