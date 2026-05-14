import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export type Engine = 'claude' | 'codex'

export type EngineDetection = {
  windows: boolean
  wsl: boolean
}

export type DetectedEngines = {
  claude: EngineDetection
  codex: EngineDetection
}

const pExecFile = promisify(execFile)

const PROBE_TIMEOUT_MS = 8_000

// Cached default-shell path inside the WSL distro. We need this because
// hardcoding `bash -ilc` only sources bash startup files — if the user's
// default shell is zsh, their PATH additions in ~/.zshrc/~/.zprofile aren't
// visible to bash, and detection (and invocation) silently misses binaries
// like claude / codex installed via npm/cargo into ~/.local/bin etc.
let cachedShell: string | null = null

export async function getDefaultWslShell(): Promise<string> {
  if (cachedShell) return cachedShell
  if (process.platform !== 'win32') {
    cachedShell = '/bin/bash'
    return cachedShell
  }
  try {
    const { stdout } = await pExecFile(
      'wsl',
      ['-e', 'sh', '-c', 'getent passwd "$(whoami)" | cut -d: -f7'],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true }
    )
    const shell = stdout.trim()
    cachedShell = shell || '/bin/bash'
    return cachedShell
  } catch {
    cachedShell = '/bin/bash'
    return cachedShell
  }
}

async function isOnWindowsPath(cmd: string): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await pExecFile('where', [cmd], {
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true
      })
      return stdout.trim().length > 0
    } catch {
      return false
    }
  }
  // POSIX fallback (useful for dev on Linux/macOS, although the app targets Windows)
  try {
    const { stdout } = await pExecFile('which', [cmd], {
      timeout: PROBE_TIMEOUT_MS
    })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

async function isOnWslPath(cmd: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const shell = await getDefaultWslShell()
  // bash and zsh both accept `-ilc` (interactive + login + command); that's
  // enough to source the user's startup files where their PATH gets extended.
  try {
    const { stdout } = await pExecFile(
      'wsl',
      ['-e', shell, '-ilc', `command -v ${cmd}`],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true }
    )
    const path = stdout.trim()
    if (!path) return false
    // Reject *only* obvious Windows-only binaries reflected through WSL
    // interop — i.e. `/mnt/<drive>/.../foo.exe|.cmd|.bat|.ps1`. Bare-name
    // wrappers under /mnt/ (e.g. mise's unix-style `codex` shim shipped
    // alongside `codex.cmd`) execute fine through WSL via the user's shell,
    // so we accept them.
    if (/^\/mnt\/[a-zA-Z]\/.*\.(exe|cmd|bat|ps1)$/i.test(path)) return false
    return true
  } catch {
    return false
  }
}

let cached: DetectedEngines | null = null
let inflight: Promise<DetectedEngines> | null = null

async function probeAll(): Promise<DetectedEngines> {
  const [claudeWin, claudeWsl, codexWin, codexWsl] = await Promise.all([
    isOnWindowsPath('claude'),
    isOnWslPath('claude'),
    isOnWindowsPath('codex'),
    isOnWslPath('codex')
  ])
  return {
    claude: { windows: claudeWin, wsl: claudeWsl },
    codex: { windows: codexWin, wsl: codexWsl }
  }
}

export function detectEngines(): Promise<DetectedEngines> {
  if (cached) return Promise.resolve(cached)
  if (inflight) return inflight
  inflight = probeAll()
    .then((result) => {
      cached = result
      return result
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function clearDetectionCache(): void {
  cached = null
  cachedShell = null
}
