import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { app } from 'electron'
import { join } from 'node:path'
import { get as getSettings } from './settings'

type CaptureProc = ChildProcessByStdio<null, Readable, Readable>

const SAMPLE_RATE = 16000
const CHANNELS = 1
const BYTES_PER_SAMPLE = 2
const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE

let chunks: Uint8Array[] = []
let totalBytes = 0
let totalBytesEver = 0
let proc: CaptureProc | null = null
let started = false

type LogFn = (msg: string, level?: 'info' | 'warn' | 'error') => void
let log: LogFn = () => {}

export function setLogger(fn: LogFn): void {
  log = fn
}

function ringPush(chunk: Uint8Array): void {
  chunks.push(chunk)
  totalBytes += chunk.byteLength
  totalBytesEver += chunk.byteLength
  const max = getSettings().audioBufferSeconds * BYTES_PER_SECOND
  while (totalBytes > max && chunks.length > 0) {
    const head = chunks[0]!
    const overflow = totalBytes - max
    if (head.byteLength <= overflow) {
      chunks.shift()
      totalBytes -= head.byteLength
    } else {
      chunks[0] = head.subarray(overflow)
      totalBytes -= overflow
    }
  }
}

function sliceLastBytes(bytes: number): Uint8Array {
  const take = Math.min(bytes, totalBytes)
  const out = new Uint8Array(take)
  let written = 0
  let skip = totalBytes - take
  for (const c of chunks) {
    if (skip >= c.byteLength) {
      skip -= c.byteLength
      continue
    }
    const piece = skip > 0 ? c.subarray(skip) : c
    skip = 0
    out.set(piece, written)
    written += piece.byteLength
  }
  return out
}

function buildWav(pcm: Uint8Array): Uint8Array {
  const dataLen = pcm.byteLength
  const buf = new ArrayBuffer(44 + dataLen)
  const view = new DataView(buf)
  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataLen, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, CHANNELS, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, BYTES_PER_SECOND, true)
  view.setUint16(32, CHANNELS * BYTES_PER_SAMPLE, true)
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true)
  writeStr(36, 'data')
  view.setUint32(40, dataLen, true)
  const out = new Uint8Array(buf)
  out.set(pcm, 44)
  return out
}

export function getBufferedSeconds(): number {
  return totalBytes / BYTES_PER_SECOND
}

export function isAudioRunning(): boolean {
  return started && proc !== null
}

export function getCurrentOffset(): number {
  return totalBytesEver
}

export function getBytesPerSecond(): number {
  return BYTES_PER_SECOND
}

export function getAudioSince(
  fromOffset: number,
  minBytes: number
): { wav: Uint8Array; newOffset: number; droppedBytes: number } | null {
  if (!started) return null
  const oldestAvailable = totalBytesEver - totalBytes
  const startOffset = Math.max(fromOffset, oldestAvailable)
  const droppedBytes = Math.max(0, oldestAvailable - fromOffset)
  const available = totalBytesEver - startOffset
  if (available < minBytes) return null
  const pcm = sliceLastBytes(available)
  return { wav: buildWav(pcm), newOffset: totalBytesEver, droppedBytes }
}

function resolveLoopbackScript(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'wasapi-loopback.ps1')
  }
  return join(__dirname, '..', '..', 'resources', 'wasapi-loopback.ps1')
}

export function startAudioCapture(): void {
  if (started) return
  started = true

  const script = resolveLoopbackScript()
  const psh = process.env['AUDIO_POWERSHELL'] || 'pwsh'

  try {
    proc = spawn(psh, ['-NoProfile', '-File', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    started = false
    log(`failed to spawn capture (${psh}): ${(err as Error).message}`, 'error')
    return
  }

  log(`capturing WASAPI loopback (buffer ${getSettings().audioBufferSeconds}s)`)

  proc.stdout.on('data', (chunk: Buffer) => {
    if (chunk.byteLength > 0) ringPush(new Uint8Array(chunk))
  })

  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text) log(`[capture] ${text}`, 'error')
  })

  proc.on('exit', (code) => {
    started = false
    proc = null
    if (code !== 0 && code !== null) log(`capture exited ${code}`, 'error')
  })

  proc.on('error', (err) => {
    started = false
    log(`capture process error: ${err.message}`, 'error')
  })
}

export function stopAudioCapture(): void {
  if (proc) {
    try {
      proc.kill()
    } catch {}
  }
  proc = null
  started = false
  chunks = []
  totalBytes = 0
}

export function resetBuffer(): void {
  chunks = []
  totalBytes = 0
}
