import { spawn, type ChildProcess } from 'node:child_process'
import { clearDetectionCache } from './aiDetect'

type LogCallback = (line: string) => void

let current: ChildProcess | null = null

// Install Claude Code via winget on Windows. Returns the process exit code.
// Streams stdout + stderr to onLog as raw chunks; callers handle line splitting
// and progress-glyph stripping for display.
// On a successful exit, clears the engine-detection cache so the next
// `detectEngines()` call sees the freshly-installed binary.
export function installClaude(onLog: LogCallback): Promise<number | null> {
  if (current) {
    return Promise.reject(new Error('an install is already in progress'))
  }
  if (process.platform !== 'win32') {
    return Promise.reject(
      new Error(
        'automatic install is only wired up for Windows. Use the manual command for your OS.'
      )
    )
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(
      'winget',
      [
        'install',
        '--id',
        'Anthropic.ClaudeCode',
        '-e',
        '--accept-package-agreements',
        '--accept-source-agreements'
      ],
      { windowsHide: true }
    )
    current = proc

    proc.stdout?.on('data', (c: Buffer) => onLog(c.toString()))
    proc.stderr?.on('data', (c: Buffer) => onLog(c.toString()))

    proc.on('error', (err) => {
      current = null
      reject(err)
    })

    proc.on('exit', (code) => {
      current = null
      if (code === 0) clearDetectionCache()
      resolve(code)
    })
  })
}
