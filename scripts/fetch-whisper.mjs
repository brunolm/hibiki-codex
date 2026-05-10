#!/usr/bin/env node
// Downloads the pinned Silero VAD model into resources/whisper/. Idempotent:
// a `.version` marker stores the pinned identifier and the script no-ops
// when the marker matches and the file is present.
//
// Pin lives in scripts/whisper.config.json — bump there.
//
// Note: whisper-cli + DLLs are NOT bundled. Users pick a variant
// (CPU / OpenBLAS / CUDA) via the in-app downloader because each one
// targets different hardware and ranges from 4 MB to 450 MB.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(__dirname)
const CONFIG = JSON.parse(
  readFileSync(join(__dirname, 'whisper.config.json'), 'utf-8')
)
const TARGET_DIR = join(ROOT, 'resources', 'whisper')
const VERSION_MARKER = join(TARGET_DIR, '.version')

const log = (msg) => console.log(`[fetch-whisper] ${msg}`)
const wantedTag = JSON.stringify({
  vad: `${CONFIG.vad.url}#${CONFIG.vad.filename}`
})

function isUpToDate() {
  if (!existsSync(VERSION_MARKER)) return false
  if (readFileSync(VERSION_MARKER, 'utf-8').trim() !== wantedTag) return false
  return existsSync(join(TARGET_DIR, CONFIG.vad.filename))
}

async function downloadTo(url, outPath) {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(outPath, buf)
  return buf.length
}

async function fetchVad() {
  const { url, filename } = CONFIG.vad
  log(`downloading vad: ${filename}`)
  const bytes = await downloadTo(url, join(TARGET_DIR, filename))
  log(`got ${(bytes / 1024).toFixed(1)} KB`)
}

async function main() {
  if (isUpToDate()) {
    log(`up-to-date`)
    return
  }

  mkdirSync(TARGET_DIR, { recursive: true })

  await fetchVad()

  writeFileSync(VERSION_MARKER, wantedTag + '\n')
  log(`pin: ${wantedTag}`)
}

main().catch((err) => {
  console.error(`[fetch-whisper] FAILED: ${err.message}`)
  process.exit(1)
})
