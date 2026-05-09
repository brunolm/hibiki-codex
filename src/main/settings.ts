import { app } from 'electron'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

export type Engine = 'claude' | 'codex'
export type Language = 'en' | 'ja'

export type Settings = {
  whisperExe: string
  whisperModel: string
  whisperVadModel: string
  whisperLanguage: Language
  whisperThreads: number
  transcribeIntervalSeconds: number
  audioBufferSeconds: number
  // Engines to run when a prompt is submitted. At least one.
  aiEngines: Engine[]
  // Per-engine overrides. Empty string = use the engine's own default
  // (i.e. ~/.claude/settings.json for Claude; ~/.codex/config.toml for Codex).
  claudeModel: string
  claudeEffort: string
  codexModel: string
  // UI: width of the AI response panel in pixels.
  aiPaneWidth: number
  // How many latest transcript messages to include as context when sending
  // a prompt to the AI engine.
  transcriptContextMessages: number
}

const defaults: Settings = {
  whisperExe: '',
  whisperModel: '',
  whisperVadModel: '',
  whisperLanguage: 'ja',
  whisperThreads: 4,
  transcribeIntervalSeconds: 12,
  audioBufferSeconds: 300,
  aiEngines: ['claude'],
  claudeModel: '',
  claudeEffort: '',
  codexModel: '',
  aiPaneWidth: 480,
  transcriptContextMessages: 50
}

let filePath = ''
let cached: Settings = { ...defaults }

export function init(): Settings {
  filePath = join(app.getPath('userData'), 'settings.json')

  // One-time migration from the previous app name (`ai-transcribe-prompt`).
  // If no settings exist at the new location but old ones do, copy them over.
  if (!existsSync(filePath)) {
    const legacyPath = join(
      app.getPath('appData'),
      'ai-transcribe-prompt',
      'settings.json'
    )
    if (existsSync(legacyPath)) {
      try {
        mkdirSync(dirname(filePath), { recursive: true })
        copyFileSync(legacyPath, filePath)
      } catch {
        // Migration is best-effort — fall through to defaults if anything fails.
      }
    }
  }

  if (existsSync(filePath)) {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<Settings> & {
        aiEngine?: Engine
      }
      // Migrate old single-engine field
      if (!raw.aiEngines && raw.aiEngine) {
        raw.aiEngines = [raw.aiEngine]
      }
      delete raw.aiEngine
      const merged = { ...defaults, ...raw }
      if (!Array.isArray(merged.aiEngines) || merged.aiEngines.length === 0) {
        merged.aiEngines = [...defaults.aiEngines]
      }
      cached = merged
    } catch {
      cached = { ...defaults }
    }
  } else {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(defaults, null, 2))
  }
  return cached
}

export function get(): Settings {
  return cached
}

export function update(next: Partial<Settings>): Settings {
  cached = { ...cached, ...next }
  writeFileSync(filePath, JSON.stringify(cached, null, 2))
  return cached
}
