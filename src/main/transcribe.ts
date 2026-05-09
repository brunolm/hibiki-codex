import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile, unlink } from 'node:fs/promises'
import { get as getSettings } from './settings'

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

function runProcess(
  cmd: string,
  args: string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
    proc.on('error', reject)
    proc.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

export async function warmupWhisper(): Promise<void> {
  await transcribeWav(silentWav1s())
}

export async function transcribeWav(wav: Uint8Array): Promise<string> {
  const s = getSettings()
  if (!s.whisperExe) throw new Error('whisper exe is not configured (settings)')
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
    if (s.whisperVadModel) {
      args.push('--vad', '--vad-model', s.whisperVadModel)
    }
    const { code, stdout, stderr } = await runProcess(s.whisperExe, args)
    if (code !== 0) {
      throw new Error(`whisper-cli exited ${code}: ${stderr.trim().slice(0, 300)}`)
    }
    return stdout.replace(/\s+/g, ' ').trim()
  } finally {
    await unlink(tmp).catch(() => {})
  }
}
