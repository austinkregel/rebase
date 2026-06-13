import { afterEach, describe, expect, it } from 'vitest'
import { registerViewer, viewerFor, viewerForMime } from './viewers'

const Stub = { name: 'Stub', render: () => null }
const disposers: (() => void)[] = []
function add(v: Parameters<typeof registerViewer>[0]) {
  disposers.push(registerViewer(v))
}

afterEach(() => {
  disposers.splice(0).forEach((d) => d())
})

describe('viewers registry', () => {
  it('matches exact MIME over wildcard over catch-all', () => {
    add({ id: 'any', mimeTypes: ['*'], binary: true, component: Stub })
    add({ id: 'img', mimeTypes: ['image/*'], binary: true, component: Stub })
    add({ id: 'svg', mimeTypes: ['image/svg+xml'], binary: false, component: Stub })

    expect(viewerForMime('image/svg+xml')?.id).toBe('svg') // exact wins
    expect(viewerForMime('image/png')?.id).toBe('img') // wildcard beats catch-all
    expect(viewerForMime('audio/mpeg')?.id).toBe('any') // only catch-all matches
  })

  it('breaks ties by descending priority then id', () => {
    add({ id: 'low', mimeTypes: ['application/pdf'], binary: true, component: Stub, priority: 1 })
    add({ id: 'high', mimeTypes: ['application/pdf'], binary: true, component: Stub, priority: 5 })
    expect(viewerForMime('application/pdf')?.id).toBe('high')
  })

  it('returns undefined when nothing matches', () => {
    add({ id: 'img', mimeTypes: ['image/*'], binary: true, component: Stub })
    expect(viewerForMime('application/pdf')).toBeUndefined()
  })

  it('resolves a viewer from a file path via its MIME type', () => {
    add({ id: 'md', mimeTypes: ['text/markdown'], binary: false, component: Stub })
    expect(viewerFor('/repo/README.md')?.id).toBe('md')
    expect(viewerFor('/repo/main.ts')).toBeUndefined() // plain text → editor
  })

  it('disposes registrations', () => {
    const dispose = registerViewer({ id: 'temp', mimeTypes: ['application/zip'], binary: true, component: Stub })
    expect(viewerForMime('application/zip')?.id).toBe('temp')
    dispose()
    expect(viewerForMime('application/zip')).toBeUndefined()
  })
})
