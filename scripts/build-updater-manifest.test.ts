import { describe, expect, it } from 'vitest'
import { buildManifest, ManifestError, TARGETS } from './build-updater-manifest.mjs'

/** The asset list a successful release actually produces (v0.0.7's, trimmed). */
function assets(version = '0.0.7') {
  const names = [
    `rebase_${version}_universal.app.tar.gz`,
    `rebase_${version}_universal.dmg`,
    `rebase_${version}_amd64.AppImage`,
    `rebase_${version}_amd64.deb`,
    `rebase-${version}-1.x86_64.rpm`,
    `rebase_${version}_x64-setup.exe`,
    `rebase_${version}_x64_en-US.msi`,
  ]
  // Every bundle the updater cares about ships a .sig beside it.
  const signed = [
    `rebase_${version}_universal.app.tar.gz`,
    `rebase_${version}_amd64.AppImage`,
    `rebase_${version}_x64-setup.exe`,
    `rebase_${version}_amd64.deb`,
    `rebase-${version}-1.x86_64.rpm`,
    `rebase_${version}_x64_en-US.msi`,
  ]
  return [...names, ...signed.map((n) => `${n}.sig`)].map((name) => ({
    name,
    browser_download_url: `https://github.com/o/r/releases/download/v${version}/${name}`,
  }))
}

const sig = (name: string) => `signature-for-${name}`
const build = (over: Record<string, unknown> = {}) =>
  buildManifest({
    assets: assets(),
    readSignature: sig,
    version: '0.0.7',
    notesUrl: 'https://notes',
    pubDate: '2026-08-26T19:00:00Z',
    ...over,
  })

describe('build-updater-manifest', () => {
  it('emits exactly the four targets the matrix builds', () => {
    expect(Object.keys(build().platforms).sort()).toEqual([
      'darwin-aarch64',
      'darwin-x86_64',
      'linux-x86_64',
      'windows-x86_64',
    ])
  })

  it('omits the arches nothing builds rather than pointing them at a 404', () => {
    const keys = TARGETS.map((t) => t.key)
    expect(keys).not.toContain('linux-aarch64')
    expect(keys).not.toContain('windows-aarch64')
  })

  it('serves both darwin arches from the one universal bundle', () => {
    const { platforms } = build()
    expect(platforms['darwin-aarch64'].url).toContain('_universal.app.tar.gz')
    expect(platforms['darwin-x86_64'].url).toEqual(platforms['darwin-aarch64'].url)
  })

  it('picks the AppImage for linux, not the deb or rpm', () => {
    expect(build().platforms['linux-x86_64'].url).toContain('.AppImage')
  })

  it('picks the NSIS setup.exe for windows, not the msi', () => {
    const url = build().platforms['windows-x86_64'].url
    expect(url).toContain('-setup.exe')
    expect(url).not.toContain('.msi')
  })

  it('never selects a .sig as the artifact itself', () => {
    for (const p of Object.values(build().platforms)) {
      expect(p.url.endsWith('.sig')).toBe(false)
    }
  })

  it('carries the signature and the release metadata through', () => {
    const m = build()
    expect(m.version).toBe('0.0.7')
    expect(m.pub_date).toBe('2026-08-26T19:00:00Z')
    expect(m.notes).toBe('https://notes')
    expect(m.platforms['linux-x86_64'].signature).toBe(sig('rebase_0.0.7_amd64.AppImage'))
  })

  it('fails when a platform did not build', () => {
    const without = assets().filter((a) => !a.name.includes('AppImage'))
    // Silence here would tell every Linux user they are up to date forever.
    expect(() => build({ assets: without })).toThrow(ManifestError)
    expect(() => build({ assets: without })).toThrow(/linux-x86_64.*found 0/)
  })

  it('fails when a suffix matches more than one artifact', () => {
    const extra = [
      ...assets(),
      { name: 'rebase_0.0.7-rc1_amd64.AppImage', browser_download_url: 'https://x' },
    ]
    expect(() => build({ assets: extra })).toThrow(/linux-x86_64.*found 2/)
  })

  it('fails when signing did not run for a platform', () => {
    const readSignature = (name: string) => {
      if (name.endsWith('.AppImage')) throw new Error('ENOENT')
      return sig(name)
    }
    expect(() => build({ readSignature })).toThrow(/linux-x86_64.*no \.sig/)
  })

  it('fails on an empty signature rather than shipping a blank one', () => {
    const readSignature = (name: string) => (name.endsWith('-setup.exe') ? '   ' : sig(name))
    expect(() => build({ readSignature })).toThrow(/windows-x86_64.*empty/)
  })
})
