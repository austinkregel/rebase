#!/usr/bin/env node
// Assert that an updater signature was made by the key the app pins.
//
//   node scripts/check-updater-key.mjs <pubkey-file> <signature-file>
//
// Both arguments are *unwrapped* minisign files (tauri base64-wraps them, so
// callers pipe them through `base64 -d` first).
//
// This deliberately does not verify the signature cryptographically. CI signs a
// scratch file with the secret moments earlier, so the maths is not in question
// — what is unknown is whether that key is the one baked into shipped apps. A
// mismatch there builds green, uploads correctly signed artifacts, and is then
// refused by every installed client, which is the failure worth catching.
//
// minisign is not used because it is not packaged for ubuntu-22.04.
import { readFileSync } from 'node:fs'

/**
 * Line 2 of a minisign public-key or signature file base64-decodes to
 * `[2 bytes algorithm][8 bytes key id][key or signature]`. minisign prints the
 * id byte-reversed, so match that and the error reads like the tool's own.
 */
function keyId(path) {
  const body = readFileSync(path, 'utf8')
    .split('\n')
    .find((line) => line && !line.startsWith('untrusted') && !line.startsWith('trusted'))
  if (!body) throw new Error(`${path}: no key/signature line`)
  const raw = Buffer.from(body, 'base64')
  if (raw.length < 10) throw new Error(`${path}: too short to be a minisign file`)
  return Buffer.from(raw.subarray(2, 10)).reverse().toString('hex').toUpperCase()
}

const [pubPath, sigPath] = process.argv.slice(2)
if (!pubPath || !sigPath) {
  console.error('usage: check-updater-key.mjs <pubkey-file> <signature-file>')
  process.exit(2)
}

const pinned = keyId(pubPath)
const signed = keyId(sigPath)

if (pinned !== signed) {
  console.error(
    `::error::Updater signing key mismatch — signed with ${signed} but ` +
      `tauri.conf.json pins ${pinned}. Every installed app would refuse these updates.`,
  )
  process.exit(1)
}
console.log(`::notice::Updater signing key ${pinned} matches the pinned pubkey.`)
