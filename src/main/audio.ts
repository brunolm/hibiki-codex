import { spawn, execFile, type ChildProcessByStdio } from 'node:child_process'
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

export type InputDevice = { id: string; name: string; isDefault: boolean }

// Spawn the WASAPI script in list-inputs mode and parse the JSON it emits to
// stdout. Resolves to [] on any failure so the UI just shows an empty picker
// instead of crashing.
export function listInputDevices(): Promise<InputDevice[]> {
  return new Promise((resolve) => {
    const psh = process.env['AUDIO_POWERSHELL'] || 'pwsh'
    const script = resolveLoopbackScript()
    const child = spawn(
      psh,
      ['-NoProfile', '-File', script, '-Mode', 'list-inputs'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString('utf8')
    })
    child.stderr.on('data', (b: Buffer) => {
      err += b.toString()
    })
    child.on('error', () => resolve([]))
    child.on('exit', (code) => {
      if (code !== 0) {
        log(`list-inputs exited ${code}: ${err.trim().slice(0, 300)}`, 'warn')
        resolve([])
        return
      }
      try {
        const parsed = JSON.parse(out) as unknown
        if (!Array.isArray(parsed)) {
          resolve([])
          return
        }
        resolve(parsed as InputDevice[])
      } catch {
        resolve([])
      }
    })
  })
}

// Run a short microphone capture and return the peak 16-bit absolute sample
// amplitude (0..32767) so the Settings → Test button can give the user
// concrete feedback that the picked device is actually producing audio.
export function testMicrophone(
  deviceId: string,
  durationMs: number = 2000
): Promise<{ peak: number; samples: number }> {
  return new Promise((resolve) => {
    const psh = process.env['AUDIO_POWERSHELL'] || 'pwsh'
    const script = resolveLoopbackScript()
    const args = ['-NoProfile', '-File', script, '-Mode', 'microphone']
    if (deviceId) args.push('-DeviceId', deviceId)
    const child = spawn(psh, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let peak = 0
    let samples = 0
    let err = ''
    child.stdout.on('data', (b: Buffer) => {
      for (let i = 0; i + 1 < b.length; i += 2) {
        const s = b.readInt16LE(i)
        const abs = s < 0 ? -s : s
        if (abs > peak) peak = abs
      }
      samples += b.length / 2
    })
    child.stderr.on('data', (b: Buffer) => {
      err += b.toString()
    })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
    }, durationMs)
    child.on('exit', () => {
      clearTimeout(timer)
      if (err.trim()) log(`[mic-test] ${err.trim().slice(0, 300)}`, 'warn')
      resolve({ peak, samples })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      log(`mic test spawn error: ${e.message}`, 'warn')
      resolve({ peak: 0, samples: 0 })
    })
  })
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

function resolveProcessScript(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'wasapi-process.ps1')
  }
  return join(__dirname, '..', '..', 'resources', 'wasapi-process.ps1')
}

// Resolve an executable basename (e.g. "Discord.exe") to a PID via tasklist.
// Returns the lowest-numbered matching PID; with the AUDIOCLIENT process
// loopback INCLUDE-TREE mode this is fine for multi-process apps because the
// tree rooted at any one of their PIDs still covers the audio session.
export function listAudioCapableProcessNames(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'tasklist.exe',
      ['/NH', '/FO', 'CSV'],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve([])
          return
        }
        const names = new Set<string>()
        for (const raw of stdout.split(/\r?\n/)) {
          const line = raw.trim()
          if (!line) continue
          // CSV with quoted fields. First field is the image name.
          const m = /^"([^"]+)"/.exec(line)
          if (!m) continue
          const name = m[1]!
          if (!/\.exe$/i.test(name)) continue
          names.add(name)
        }
        resolve(Array.from(names).sort((a, b) => a.localeCompare(b)))
      }
    )
  })
}

function resolveProcessPid(imageName: string): Promise<number | null> {
  return new Promise((resolve) => {
    const normalized = /\.exe$/i.test(imageName) ? imageName : `${imageName}.exe`
    execFile(
      'tasklist.exe',
      ['/NH', '/FO', 'CSV', '/FI', `IMAGENAME eq ${normalized}`],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        // CSV fields: "Image Name","PID","Session Name","Session#","Mem Usage"
        const pids: number[] = []
        for (const raw of stdout.split(/\r?\n/)) {
          const line = raw.trim()
          if (!line) continue
          const m = /^"[^"]+","(\d+)"/.exec(line)
          if (!m) continue
          const pid = Number(m[1])
          if (Number.isFinite(pid)) pids.push(pid)
        }
        if (pids.length === 0) {
          resolve(null)
          return
        }
        // INCLUDE_TREE captures descendants too — picking the smallest PID
        // (= oldest, usually the root parent) maximises the chance of
        // capturing every renderer/helper child of multi-process apps.
        pids.sort((a, b) => a - b)
        resolve(pids[0] ?? null)
      }
    )
  })
}

export async function startAudioCapture(): Promise<void> {
  if (started) return
  started = true

  const psh = process.env['AUDIO_POWERSHELL'] || 'pwsh'
  const settings = getSettings()
  const mixMic = settings.captureMicrophone === true
  const targetProcess = settings.captureProcessName?.trim() ?? ''

  // Choose between system-loopback and per-process loopback for the primary
  // source. Mic mixing (if on) runs independently below.
  let loopArgs: string[]
  let sourceLabel: string
  if (targetProcess) {
    const pid = await resolveProcessPid(targetProcess)
    if (pid === null) {
      started = false
      log(
        `process loopback target "${targetProcess}" is not running — start it first or clear Settings → Whisper → Capture from process`,
        'error'
      )
      return
    }
    const procScript = resolveProcessScript()
    const mode = settings.captureProcessMode === 'exclude' ? 'exclude' : 'include'
    loopArgs = [
      '-NoProfile',
      '-File',
      procScript,
      '-ProcessId',
      String(pid),
      '-Mode',
      mode
    ]
    sourceLabel = `process loopback (${targetProcess} pid=${pid} mode=${mode})`
  } else {
    loopArgs = ['-NoProfile', '-File', resolveLoopbackScript()]
    sourceLabel = 'WASAPI loopback'
  }

  try {
    proc = spawn(psh, loopArgs, {
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
      ? `capturing ${sourceLabel} + microphone (buffer ${settings.audioBufferSeconds}s)`
      : `capturing ${sourceLabel} (buffer ${settings.audioBufferSeconds}s)`
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
    // The mic uses the system loopback script in microphone mode — even when
    // the primary loop source is a per-process capture, the user's mic is a
    // global device, not part of any one app's tree.
    const micArgs = [
      '-NoProfile',
      '-File',
      resolveLoopbackScript(),
      '-Mode',
      'microphone'
    ]
    if (settings.captureMicrophoneDevice) {
      micArgs.push('-DeviceId', settings.captureMicrophoneDevice)
    }
    micProc = spawn(psh, micArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
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
