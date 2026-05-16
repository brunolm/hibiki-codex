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

// Microphone-mix state. When `captureMicrophone` is on we spawn a second
// PowerShell capture in -Mode microphone and combine the two streams into
// the same ring buffer before whisper sees them. When it's off we keep the
// historical fast path (loop data → ring directly).
type Staging = { chunks: Uint8Array[]; bytes: number }
let micProc: CaptureProc | null = null
let micActive = false
const loopStaging: Staging = { chunks: [], bytes: 0 }
const micStaging: Staging = { chunks: [], bytes: 0 }
let mixTimer: ReturnType<typeof setInterval> | null = null
const MIX_BUFFER_LIMIT_BYTES = 5 * 32000 // 5s @ 16-bit mono 16kHz

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

function pushStaging(s: Staging, chunk: Uint8Array): void {
  s.chunks.push(chunk)
  s.bytes += chunk.byteLength
  // Cap the staging queue so an unresponsive partner stream can't snowball
  // into runaway memory. Trim the oldest bytes once we cross the limit.
  while (s.bytes > MIX_BUFFER_LIMIT_BYTES && s.chunks.length > 0) {
    const head = s.chunks[0]!
    const overflow = s.bytes - MIX_BUFFER_LIMIT_BYTES
    if (head.byteLength <= overflow) {
      s.chunks.shift()
      s.bytes -= head.byteLength
    } else {
      s.chunks[0] = head.subarray(overflow)
      s.bytes -= overflow
    }
  }
}

function takeStagingBytes(s: Staging, n: number): Uint8Array {
  const take = Math.min(n, s.bytes)
  const out = new Uint8Array(take)
  let written = 0
  while (written < take && s.chunks.length > 0) {
    const head = s.chunks[0]!
    const need = take - written
    if (head.byteLength <= need) {
      out.set(head, written)
      written += head.byteLength
      s.chunks.shift()
      s.bytes -= head.byteLength
    } else {
      out.set(head.subarray(0, need), written)
      s.chunks[0] = head.subarray(need)
      s.bytes -= need
      written += need
    }
  }
  return out
}

function flushStagingToRing(s: Staging): void {
  if (s.bytes === 0) return
  const out = takeStagingBytes(s, s.bytes)
  if (out.byteLength > 0) ringPush(out)
}

// Sum 16-bit little-endian PCM samples with hard clipping. Both buffers must
// be the same length and 16-bit-aligned.
function mixPcm16LE(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength)
  const av = new DataView(a.buffer, a.byteOffset, a.byteLength)
  const bv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const ov = new DataView(out.buffer, out.byteOffset, out.byteLength)
  for (let i = 0; i < a.byteLength; i += 2) {
    const sa = av.getInt16(i, true)
    const sb = bv.getInt16(i, true)
    let s = sa + sb
    if (s > 32767) s = 32767
    else if (s < -32768) s = -32768
    ov.setInt16(i, s, true)
  }
  return out
}

function pumpMix(): void {
  if (!micActive) {
    // Mic process never started, exited, or errored — fall back to
    // loopback-only by routing the loop staging straight to the ring.
    flushStagingToRing(loopStaging)
    return
  }
  // Mix whatever's mutually available; round to 16-bit-sample alignment so
  // we never split a sample across mixer runs.
  let common = Math.min(loopStaging.bytes, micStaging.bytes)
  common -= common % 2
  if (common === 0) return
  const loopBuf = takeStagingBytes(loopStaging, common)
  const micBuf = takeStagingBytes(micStaging, common)
  ringPush(mixPcm16LE(loopBuf, micBuf))
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
  const settings = getSettings()
  const mixMic = settings.captureMicrophone === true

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

  log(
    mixMic
      ? `capturing WASAPI loopback + microphone (buffer ${settings.audioBufferSeconds}s)`
      : `capturing WASAPI loopback (buffer ${settings.audioBufferSeconds}s)`
  )

  proc.stdout.on('data', (chunk: Buffer) => {
    if (chunk.byteLength === 0) return
    if (mixMic) pushStaging(loopStaging, new Uint8Array(chunk))
    else ringPush(new Uint8Array(chunk))
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

  if (!mixMic) return

  try {
    micProc = spawn(
      psh,
      ['-NoProfile', '-File', script, '-Mode', 'microphone'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    micActive = true
  } catch (err) {
    micActive = false
    log(`failed to spawn microphone capture: ${(err as Error).message}`, 'warn')
    micProc = null
  }

  if (micProc) {
    micProc.stdout.on('data', (chunk: Buffer) => {
      if (chunk.byteLength > 0) pushStaging(micStaging, new Uint8Array(chunk))
    })
    micProc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) log(`[mic] ${text}`, 'warn')
    })
    micProc.on('exit', (code) => {
      micActive = false
      micProc = null
      // Drain any unmixed loop staging so we don't lose the last second when
      // the mic side gives up partway through.
      flushStagingToRing(loopStaging)
      micStaging.chunks.length = 0
      micStaging.bytes = 0
      if (code !== 0 && code !== null)
        log(`microphone capture exited ${code} — falling back to loopback only`, 'warn')
    })
    micProc.on('error', (err) => {
      micActive = false
      log(`microphone capture error: ${err.message}`, 'warn')
    })
  }

  mixTimer = setInterval(pumpMix, 50)
}

export function stopAudioCapture(): void {
  if (proc) {
    try {
      proc.kill()
    } catch {}
  }
  if (micProc) {
    try {
      micProc.kill()
    } catch {}
  }
  if (mixTimer !== null) {
    clearInterval(mixTimer)
    mixTimer = null
  }
  proc = null
  micProc = null
  micActive = false
  started = false
  chunks = []
  totalBytes = 0
  loopStaging.chunks.length = 0
  loopStaging.bytes = 0
  micStaging.chunks.length = 0
  micStaging.bytes = 0
}

export function resetBuffer(): void {
  chunks = []
  totalBytes = 0
}
