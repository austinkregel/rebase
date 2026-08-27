#!/usr/bin/env node
// Assemble the Tauri updater manifest (latest.json) from a release's assets.
//
//   node scripts/build-updater-manifest.mjs \
//     --assets assets.json --sig-dir sigs --tag v1.2.3 --repo owner/name --out latest.json
//
// This lives in a script rather than inline in release.yml so it can be unit
// tested. The logic only ever *runs* during a tagged release, which is a
// forty-minute feedback loop and the worst possible place to discover a typo;
// the tests run on every push instead.
//
// The caller does the dumb I/O — fetch the asset list, download every *.sig —
// and this decides which of them matter and whether the set is complete.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Updater key -> the artifact suffix serving it. macOS builds universal, so one
 * .app.tar.gz answers for both darwin arches.
 *
 * linux-aarch64 and windows-aarch64 are absent deliberately: the release matrix
 * does not build them. A key naming an artifact that was never built would hand
 * those users a 404 mid-update, whereas an absent key simply means they are
 * never offered one. See docs/AUTO-UPDATE.md.
 */
export const TARGETS = [
  { key: 'darwin-aarch64', suffix: '_universal.app.tar.gz' },
  { key: 'darwin-x86_64', suffix: '_universal.app.tar.gz' },
  { key: 'linux-x86_64', suffix: '.AppImage' },
  { key: 'windows-x86_64', suffix: '-setup.exe' },
]

export class ManifestError extends Error {}

/**
 * @param assets      GitHub release assets: [{ name, browser_download_url }]
 * @param readSignature  (artifactName) => signature text for `${artifactName}.sig`
 */
export function buildManifest({ assets, readSignature, version, notesUrl, pubDate }) {
  const platforms = {}

  for (const { key, suffix } of TARGETS) {
    // A .sig ends with its artifact's suffix too ('.AppImage.sig'), so exclude
    // signatures before matching or every target is ambiguous.
    const matches = assets.filter((a) => a.name.endsWith(suffix) && !a.name.endsWith('.sig'))

    if (matches.length !== 1) {
      throw new ManifestError(
        `${key}: expected exactly 1 artifact ending "${suffix}", found ${matches.length}` +
          (matches.length ? ` (${matches.map((m) => m.name).join(', ')})` : ''),
      )
    }
    const artifact = matches[0]

    let signature
    try {
      signature = readSignature(artifact.name)
    } catch (err) {
      throw new ManifestError(
        `${key}: "${artifact.name}" has no .sig — updater signing did not run for this platform (${err.message})`,
      )
    }
    if (!signature || !signature.trim()) {
      throw new ManifestError(`${key}: "${artifact.name}.sig" is empty.`)
    }

    platforms[key] = { signature: signature.trim(), url: artifact.browser_download_url }
  }

  return { version, notes: notesUrl, pub_date: pubDate, platforms }
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`)
    return i === -1 ? undefined : argv[i + 1]
  }
  const assetsPath = arg('assets')
  const sigDir = arg('sig-dir')
  const tag = arg('tag')
  const repo = arg('repo')
  const out = arg('out') ?? 'latest.json'
  if (!assetsPath || !sigDir || !tag || !repo) {
    console.error(
      'usage: build-updater-manifest.mjs --assets <file> --sig-dir <dir> --tag <tag> --repo <owner/name> [--out <file>]',
    )
    process.exit(2)
  }

  const assets = JSON.parse(readFileSync(assetsPath, 'utf8'))
  const manifest = buildManifest({
    assets,
    readSignature: (name) => readFileSync(join(sigDir, `${name}.sig`), 'utf8'),
    version: tag.replace(/^v/, ''),
    notesUrl: `See https://github.com/${repo}/releases/tag/${tag}`,
    pubDate: arg('pub-date') ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  })

  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
  for (const [key, p] of Object.entries(manifest.platforms)) {
    console.log(`  ${key} -> ${p.url.split('/').pop()}`)
  }
  console.log(`::notice::Assembled ${out} for ${manifest.version}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    if (err instanceof ManifestError) {
      console.error(`::error::${err.message}`)
      process.exit(1)
    }
    throw err
  }
}
