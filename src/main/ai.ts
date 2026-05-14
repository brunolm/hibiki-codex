import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Engine } from './settings'
import { get as getSettings } from './settings'
import { getDefaultWslShell } from './aiDetect'

// Wrap a command + args with `wsl <shell> -ilc ...` when running through the
// default WSL distro. We need a login + interactive shell so the user's
// startup files (~/.profile, ~/.bashrc, ~/.zshrc, ~/.zprofile, …) get sourced
// — without that, user-local PATH additions (e.g. ~/.local/bin) aren't
// visible. The shell is detected from the user's passwd entry so a zsh-by-
// default WSL works the same as a bash one. Args are passed through the
// shell's positional parameters and then `exec`-replaced into the real
// command, which avoids any shell-quoting hazards on the prompt string.
async function wrap(
  cmd: string,
  args: string[],
  useWsl: boolean
): Promise<{ cmd: string; args: string[] }> {
  if (!useWsl) return { cmd, args }
  const shell = await getDefaultWslShell()
  return {
    cmd: 'wsl',
    args: ['-e', shell, '-ilc', 'exec "$@"', '_wrap', cmd, ...args]
  }
}

// Convert a Windows path (`C:\Users\...\file`) into a WSL-mounted path
// (`/mnt/c/Users/.../file`) so a Linux process running through `wsl` can
// read/write it. Anything that doesn't look like a Windows path is returned
// unchanged.
function toWslPath(winPath: string): string {
  const m = winPath.match(/^([A-Za-z]):\\(.*)$/)
  if (!m) return winPath
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

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

type ActiveEntry = { proc: ChildProcess; canceled: boolean }
const active = new Map<string, ActiveEntry>()
// Recently canceled ids — used by the IPC layer to swallow any rejection
// that arrives after the user aborted, including races where the spawned
// process exits non-zero around the same time cancel() is processed.
const canceledIds = new Set<string>()

type RunResult = { code: number | null; stdout: string; stderr: string }

export class CanceledError extends Error {
  constructor() {
    super('canceled')
    this.name = 'CanceledError'
  }
}

function run(
  id: string,
  cmd: string,
  args: string[],
  timeoutMs?: number
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const entry: ActiveEntry = { proc, canceled: false }
    active.set(id, entry)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            try {
              proc.kill()
            } catch {}
          }, timeoutMs)
        : null
    proc.stdout?.on('data', (c: Buffer) => (stdout += c.toString()))
    proc.stderr?.on('data', (c: Buffer) => (stderr += c.toString()))
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer)
      active.delete(id)
      reject(err)
    })
    proc.on('exit', (code) => {
      if (timer) clearTimeout(timer)
      active.delete(id)
      if (entry.canceled) {
        reject(new CanceledError())
        return
      }
      if (timedOut) {
        const seconds = Math.round((timeoutMs ?? 0) / 1000)
        reject(new Error(`request timed out after ${seconds}s`))
        return
      }
      resolve({ code, stdout, stderr })
    })
  })
}

async function askClaude(id: string, prompt: string): Promise<string> {
  const {
    claudeModel,
    claudeEffort,
    claudeUseWsl,
    claudeUsePrintMode,
    requestTimeoutSeconds
  } = getSettings()
  const args: string[] = []
  if (claudeUsePrintMode) args.push('-p')
  args.push('--permission-mode', 'auto')
  if (claudeModel.trim()) args.push('--model', claudeModel.trim())
  if (claudeEffort.trim()) args.push('--effort', claudeEffort.trim())
  // Print mode (-p) accepts a positional prompt directly. Non-print mode needs
  // `--` so a prompt starting with `-` isn't mis-parsed as a flag, and relies
  // on stdin being an immediate EOF (run() uses stdio: 'ignore', which maps to
  // NUL on Windows). This mirrors the Claude-AskSimple PowerShell pattern.
  if (claudeUsePrintMode) args.push(prompt)
  else args.push('--', prompt)

  const wrapped = await wrap('claude', args, claudeUseWsl)
  const { code, stdout, stderr } = await run(
    id,
    wrapped.cmd,
    wrapped.args,
    requestTimeoutSeconds * 1000
  )
  if (code !== 0) {
    throw new Error(`claude exited ${code}: ${stderr.trim().slice(0, 500)}`)
  }
  return stdout.trim()
}

async function askCodex(id: string, prompt: string): Promise<string> {
  // `codex exec` writes a session header + token stats to stdout; the only
  // reliable way to extract just the final assistant message is to capture it
  // via `--output-last-message <FILE>`. We always create the temp file on the
  // Windows side, but pass codex the WSL-mounted form (/mnt/c/...) so a
  // codex-in-WSL process can write to the same underlying file.
  const {
    codexModel,
    codexUseWsl,
    codexDangerouslyBypass,
    requestTimeoutSeconds
  } = getSettings()
  const dir = await mkdtemp(join(tmpdir(), 'codex-out-'))
  const outFileWin = join(dir, 'last.txt')
  const outFileForCodex = codexUseWsl ? toWslPath(outFileWin) : outFileWin
  try {
    // `--dangerously-bypass-approvals-and-sandbox` and `-a/--ask-for-approval`
    // are top-level codex flags — they must come *before* the `exec`
    // subcommand or codex rejects them with "unexpected argument".
    const args: string[] = []
    if (codexDangerouslyBypass) args.push('--dangerously-bypass-approvals-and-sandbox')
    else args.push('-a', 'on-request')
    args.push(
      'exec',
      '--skip-git-repo-check',
      '--color',
      'never',
      '--output-last-message',
      outFileForCodex
    )
    if (codexModel.trim()) args.push('--model', codexModel.trim())
    args.push(prompt)
    const wrapped = await wrap('codex', args, codexUseWsl)
    const { code, stdout, stderr } = await run(
      id,
      wrapped.cmd,
      wrapped.args,
      requestTimeoutSeconds * 1000
    )
    if (code !== 0) {
      const detail = stderr.trim() || stdout.trim()
      throw new Error(`codex exited ${code}: ${detail.slice(0, 500)}`)
    }
    const text = await readFile(outFileWin, 'utf-8').catch(() => '')
    return text.trim() || stdout.trim()
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export function ask(
  id: string,
  engine: Engine,
  message: string,
  transcript: string
): Promise<string> {
  const prompt = buildPrompt({ transcript, message })
  return engine === 'claude' ? askClaude(id, prompt) : askCodex(id, prompt)
}

export function cancel(id: string): void {
  canceledIds.add(id)
  const entry = active.get(id)
  if (entry) {
    entry.canceled = true
    try {
      entry.proc.kill()
    } catch {}
  }
  // Forget the id after a grace window so the Set doesn't grow unbounded.
  setTimeout(() => canceledIds.delete(id), 30_000)
}

export function wasCanceled(id: string): boolean {
  return canceledIds.has(id)
}
