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
// Live runtime flag — flipped by setCaptureMicrophone() so the user can
// toggle the mic mix from the chat view without stopping transcription.
// Distinct from settings.captureMicrophone because the persisted setting
// might differ from the current capture state (e.g. mic process died but
// the setting stays on).
let mixMicEnabled = false
let mixMicDeviceId = ''
const loopStaging: Staging = { chunks: [], bytes: 0 }
const micStaging: Staging = { chunks: [], bytes: 0 }
let mixTimer: ReturnType<typeof setInterval> | null = null
const MIX_BUFFER_LIMIT_BYTES = 5 * 32000 // 5s @ 16-bit mono 16kHz
// Last time a loopback chunk arrived while mic-mix is active. WASAPI loopback
// stops emitting packets when the Windows audio engine has nothing to render,
// so a silent system would leave the mix pump starved forever. We use this
// to detect the dormant state and flush mic data through alone.
let lastLoopChunkAt = 0
// Grace period before treating loopback as dormant. Has to be long enough
// to absorb normal jitter between loop and mic packet arrivals, short
// enough that the user's voice still feels responsive when they're not
// playing anything else.
const LOOP_DORMANT_GRACE_MS = 250

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

// Spawn the WASAPI script in list-{inputs,outputs} mode and parse the JSON
// it emits. Resolves to [] on any failure so the UI just shows an empty
// picker instead of crashing.
function listEndpoints(direction: 'inputs' | 'outputs'): Promise<InputDevice[]> {
  return new Promise((resolve) => {
    const psh = process.env['AUDIO_POWERSHELL'] || 'pwsh'
    const script = resolveLoopbackScript()
    const mode = direction === 'inputs' ? 'list-inputs' : 'list-outputs'
    const child = spawn(
      psh,
      ['-NoProfile', '-File', script, '-Mode', mode],
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
        log(`${mode} exited ${code}: ${err.trim().slice(0, 300)}`, 'warn')
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

export function listInputDevices(): Promise<InputDevice[]> {
  return listEndpoints('inputs')
}

export function listOutputDevices(): Promise<InputDevice[]> {
  return listEndpoints('outputs')
}

// Run a short WASAPI capture against the picked device and return the peak
// 16-bit absolute sample amplitude (0..32767). Used by both the mic and
// audio-output Settings → Test buttons so the user can verify the picked
// device is actually producing audio without committing to a full Start.
function peakCapture(
  mode: 'microphone' | 'loopback',
  deviceId: string,
  durationMs: number,
  logTag: string
): Promise<{ peak: number; samples: number }> {
  return new Promise((resolve) => {
    const psh = process.env['AUDIO_POWERSHELL'] || 'pwsh'
    const script = resolveLoopbackScript()
    const args = ['-NoProfile', '-File', script, '-Mode', mode]
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
      if (err.trim()) log(`[${logTag}] ${err.trim().slice(0, 300)}`, 'warn')
      resolve({ peak, samples })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      log(`${logTag} spawn error: ${e.message}`, 'warn')
      resolve({ peak: 0, samples: 0 })
    })
  })
}

export function testMicrophone(
  deviceId: string,
  durationMs: number = 2000
): Promise<{ peak: number; samples: number }> {
  return peakCapture('microphone', deviceId, durationMs, 'mic-test')
}

// Probe loopback (system audio) for `durationMs` and report the peak
// amplitude. Result is 0 if nothing is playing — WASAPI loopback emits no
// packets during system-wide silence.
export function testLoopback(
  deviceId: string,
  durationMs: number = 2000
): Promise<{ peak: number; samples: number }> {
  return peakCapture('loopback', deviceId, durationMs, 'loopback-test')
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
  if (common > 0) {
    const loopBuf = takeStagingBytes(loopStaging, common)
    const micBuf = takeStagingBytes(micStaging, common)
    ringPush(mixPcm16LE(loopBuf, micBuf))
  }
  // If the loop side has been quiet long enough that we're confident WASAPI
  // is in its "nothing is playing" suspend state, flush mic data alone.
  // Without this, a user transcribing only their voice (no system audio)
  // would never see their words reach whisper — the mic queue would just
  // grow until the 5s cap dropped the oldest bytes.
  const now = Date.now()
  if (
    micStaging.bytes >= 2 &&
    now - lastLoopChunkAt > LOOP_DORMANT_GRACE_MS
  ) {
    let n = micStaging.bytes
    n -= n % 2
    if (n > 0) ringPush(takeStagingBytes(micStaging, n))
  }
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
    // Pin the loopback to a specific render endpoint when the user has
    // picked one. Empty = let the script fall back to GetDefaultAudioEndpoint
    // (whatever Windows is currently playing through).
    if (settings.captureLoopbackDevice) {
      loopArgs.push('-DeviceId', settings.captureLoopbackDevice)
      sourceLabel = `WASAPI loopback (device=${settings.captureLoopbackDevice})`
    } else {
      sourceLabel = 'WASAPI loopback'
    }
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
    // Read mixMicEnabled live so a runtime toggle re-routes the loop bytes
    // to the staging mixer without having to restart capture.
    if (mixMicEnabled) {
      lastLoopChunkAt = Date.now()
      pushStaging(loopStaging, new Uint8Array(chunk))
    } else {
      ringPush(new Uint8Array(chunk))
    }
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

  // Sync the live runtime flag to the persisted setting at Start so the
  // user's last toggle survives across restarts. The chat-view button updates
  // both the setting and this flag at runtime via setCaptureMicrophone().
  mixMicEnabled = mixMic
  mixMicDeviceId = settings.captureMicrophoneDevice ?? ''

  if (!mixMic) return

  // Seed lastLoopChunkAt so the dormant-loop fallback only kicks in after the
  // grace period from this Start, not immediately because of the epoch-0
  // initial value.
  lastLoopChunkAt = Date.now()

  spawnMicCapture()

  if (!mixTimer) mixTimer = setInterval(pumpMix, 50)
}

function spawnMicCapture(): void {
  if (micProc) return // already running
  const psh = process.env['AUDIO_POWERSHELL'] || 'pwsh'
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
    if (mixMicDeviceId) {
      micArgs.push('-DeviceId', mixMicDeviceId)
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
    return
  }

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

function killMicCapture(): void {
  if (micProc) {
    try {
      micProc.kill()
    } catch {}
    // The exit handler above will null micProc, clear micActive, flush loop
    // staging, and reset micStaging. Don't duplicate that work here.
  }
}

// Toggle the microphone-mix live. Safe to call at any time, including when
// capture isn't running — the flag is read by startAudioCapture too. Pass a
// non-empty deviceId to override the persisted captureMicrophoneDevice.
export function setCaptureMicrophone(enabled: boolean, deviceId: string): void {
  const deviceChanged = enabled && deviceId !== mixMicDeviceId
  const wasEnabled = mixMicEnabled
  mixMicEnabled = enabled
  mixMicDeviceId = deviceId

  if (!started) return // not capturing — flag is enough; Start will honour it

  if (enabled && !wasEnabled) {
    // Turn on mid-capture. Loop bytes that arrived in the last few ms went
    // straight to the ring; that's fine — only new bytes get staged for mix.
    lastLoopChunkAt = Date.now()
    spawnMicCapture()
    if (!mixTimer) mixTimer = setInterval(pumpMix, 50)
    log('microphone mix: on', 'info')
    return
  }

  if (!enabled && wasEnabled) {
    // Turn off mid-capture. Drain any in-flight loop bytes back to the ring
    // (they were staged for a mix that's no longer going to happen) and stop
    // the mix pump.
    killMicCapture()
    flushStagingToRing(loopStaging)
    if (mixTimer) {
      clearInterval(mixTimer)
      mixTimer = null
    }
    log('microphone mix: off', 'info')
    return
  }

  if (enabled && deviceChanged && micProc) {
    // Device picker change while mic is on — respawn against the new device.
    killMicCapture()
    spawnMicCapture()
  }
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
  lastLoopChunkAt = 0
}

export function resetBuffer(): void {
  chunks = []
  totalBytes = 0
}
