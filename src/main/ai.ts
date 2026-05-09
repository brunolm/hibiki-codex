import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Engine } from './settings'
import { get as getSettings } from './settings'

function buildPrompt(args: { transcript: string; message: string }): string {
  const { transcript, message } = args
  const today = new Date().toISOString().slice(0, 10)
  const block = transcript
    ? `Recent audio transcript (most recent on the right; transcribed locally with whisper.cpp, so expect some errors):\n${transcript}\n\n`
    : '(No transcript yet — audio capture is still warming up.)\n\n'
  return `Today's date: ${today}

${block}The user's question (answer this; the transcript above is context only):
${message}`
}

let active: ChildProcess | null = null

type RunResult = { code: number | null; stdout: string; stderr: string }

function run(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    active = proc
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (c: Buffer) => (stdout += c.toString()))
    proc.stderr?.on('data', (c: Buffer) => (stderr += c.toString()))
    proc.on('error', (err) => {
      if (active === proc) active = null
      reject(err)
    })
    proc.on('exit', (code) => {
      if (active === proc) active = null
      resolve({ code, stdout, stderr })
    })
  })
}

async function askClaude(prompt: string): Promise<string> {
  const { claudeModel, claudeEffort } = getSettings()
  const args: string[] = ['-p']
  if (claudeModel.trim()) args.push('--model', claudeModel.trim())
  if (claudeEffort.trim()) args.push('--effort', claudeEffort.trim())
  args.push(prompt)

  const { code, stdout, stderr } = await run('claude', args)
  if (code !== 0) {
    throw new Error(`claude exited ${code}: ${stderr.trim().slice(0, 500)}`)
  }
  return stdout.trim()
}

async function askCodex(prompt: string): Promise<string> {
  // `codex exec` writes a session header + token stats to stdout; the only
  // reliable way to extract just the final assistant message is to capture it
  // via `--output-last-message <FILE>`.
  const { codexModel } = getSettings()
  const dir = await mkdtemp(join(tmpdir(), 'codex-out-'))
  const outFile = join(dir, 'last.txt')
  try {
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--color', 'never',
      '--output-last-message', outFile
    ]
    if (codexModel.trim()) args.push('--model', codexModel.trim())
    args.push(prompt)
    const { code, stdout, stderr } = await run('codex', args)
    if (code !== 0) {
      const detail = stderr.trim() || stdout.trim()
      throw new Error(`codex exited ${code}: ${detail.slice(0, 500)}`)
    }
    const text = await readFile(outFile, 'utf-8').catch(() => '')
    return text.trim() || stdout.trim()
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export function ask(
  engine: Engine,
  message: string,
  transcript: string
): Promise<string> {
  const prompt = buildPrompt({ transcript, message })
  return engine === 'claude' ? askClaude(prompt) : askCodex(prompt)
}

export function cancel(): void {
  if (active) {
    try {
      active.kill()
    } catch {}
    active = null
  }
}
