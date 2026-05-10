import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

function bundledWhisperDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'whisper')
    : join(__dirname, '..', '..', 'resources', 'whisper')
}

export function bundledWhisperVad(): string | null {
  const p = join(bundledWhisperDir(), 'ggml-silero-v5.1.2.bin')
  return existsSync(p) ? p : null
}

export function resolveWhisperVad(override: string): string | null {
  return override || bundledWhisperVad()
}

// Where downloaded whisper-cli variants live. Each variant gets its own
// subdir so multiple variants can coexist and the user switches via the
// whisperExe setting.
export function whisperRuntimeRoot(): string {
  return join(app.getPath('userData'), 'whisper-runtime')
}

export function whisperRuntimeDir(variantId: string): string {
  return join(whisperRuntimeRoot(), variantId)
}

// Where downloaded whisper .bin models live. Mirrors whisperRuntimeRoot —
// kept under the app's userData folder so they survive uninstalls of the
// portable build and don't pollute the user's Downloads.
export function whisperModelsRoot(): string {
  return join(app.getPath('userData'), 'models')
}
