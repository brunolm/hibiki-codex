import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile, unlink } from 'node:fs/promises'
import { get as getSettings } from './settings'
import { resolveWhisperVad } from './paths'

function silentWav1s(): Uint8Array {
  const SR = 16000
  const dataLen = SR * 2
  const buf = new ArrayBuffer(44 + dataLen)
  const v = new DataView(buf)
  const s = (o: number, t: string): void => {
    for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i))
  }
  s(0, 'RIFF')
  v.setUint32(4, 36 + dataLen, true)
  s(8, 'WAVE')
  s(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, SR, true)
  v.setUint32(28, SR * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  s(36, 'data')
  v.setUint32(40, dataLen, true)
  return new Uint8Array(buf)
}

// All in-flight whisper-cli children, so a Stop click can SIGKILL them
// instead of waiting for them to finish on their own.
const liveChildren = new Set<ChildProcess>()

function runProcess(
  cmd: string,
  args: string[]
): Promise<{ code: number | null; stdout: string; stderr: string; killed: boolean }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true })
    liveChildren.add(proc)
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
    proc.on('error', (err) => {
      liveChildren.delete(proc)
      reject(err)
    })
    proc.on('exit', (code, signal) => {
      liveChildren.delete(proc)
      resolve({ code, stdout, stderr, killed: signal !== null })
    })
  })
}

export async function warmupWhisper(): Promise<void> {
  await transcribeWav(silentWav1s())
}

export async function transcribeWav(wav: Uint8Array): Promise<string> {
  const s = getSettings()
  const exe = s.whisperExe
  if (!exe) {
    throw new Error(
      'whisper exe is not configured — pick or download one in Settings'
    )
  }
  if (!s.whisperModel) throw new Error('whisper model is not configured (settings)')

  const tmp = join(
    tmpdir(),
    `hibiki-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
  )
  await writeFile(tmp, wav)
  try {
    const args = [
      '-m', s.whisperModel,
      '-f', tmp,
      '-l', s.whisperLanguage,
      '-t', String(s.whisperThreads),
      '-fa',
      '-nt',
      '--no-prints'
    ]
    const vad = resolveWhisperVad(s.whisperVadModel)
    if (vad) {
      args.push('--vad', '--vad-model', vad)
    }
    // tinydiarize emits [SPEAKER_TURN] markers inline at detected speaker
    // change points. Only works on tdrz-tuned models — silently no-op the
    // flag for non-tdrz models so users don't see a confusing whisper-cli
    // error when the toggle is on but the loaded model can't honour it.
    if (s.whisperDiarize && /tdrz/i.test(s.whisperModel)) {
      args.push('--tinydiarize')
    }
    const { code, stdout, stderr, killed } = await runProcess(exe, args)
    // If the user clicked Stop, we killed the process — return empty so the
    // tick loop doesn't surface the non-zero exit as an error.
    if (killed) return ''
    if (code !== 0) {
      throw new Error(`whisper-cli exited ${code}: ${stderr.trim().slice(0, 300)}`)
    }
    return stdout.replace(/\s+/g, ' ').trim()
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

// Kill every in-flight whisper-cli so Stop is immediate end-to-end. Safe to
// call even when nothing's running — the set is just empty.
export function cancelTranscriptions(): void {
  for (const proc of liveChildren) {
    try {
      proc.kill()
    } catch {}
  }
  liveChildren.clear()
}
