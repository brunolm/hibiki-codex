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
  try {
    const { stdout } = await pExecFile(
      'wsl',
      ['-e', 'bash', '-ilc', `command -v ${cmd}`],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true }
    )
    const path = stdout.trim()
    if (!path) return false
    // Reject Windows binaries reflected through WSL interop (/mnt/<drive>/...).
    if (/^\/mnt\/[a-zA-Z]\//.test(path)) return false
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
}
