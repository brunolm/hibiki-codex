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
export type Language = 'auto' | 'en' | 'ja'

export type WindowBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type PromptTemplate = {
  name: string
  body: string
}

export type Settings = {
  whisperExe: string
  whisperModel: string
  whisperVadModel: string
  whisperLanguage: Language
  whisperThreads: number
  // Max concurrent whisper-cli inferences. >1 lets a new tick start while
  // the previous one is still running; peak CPU = transcribeMaxLanes ×
  // whisperThreads. 1 = strictly serial.
  transcribeMaxLanes: number
  transcribeIntervalSeconds: number
  audioBufferSeconds: number
  // When true, capture the default microphone alongside system loopback and
  // mix the two streams (sample-aligned, hard-clipped 16-bit add) before
  // handing off to whisper. Lets the user transcribe a conversation that
  // includes their own voice without configuring a separate mic capture.
  captureMicrophone: boolean
  // When non-empty, capture audio from this process (and its tree by
  // default) via AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK instead of the
  // whole-system loopback. Value is an executable basename ("Discord.exe").
  // Requires Windows 10 2004+ at runtime.
  captureProcessName: string
  // 'include' captures the target PID and every descendant; 'exclude'
  // captures everything *except* that tree (useful for "everything but
  // Discord", or for capturing your DAW while muting the browser).
  captureProcessMode: 'include' | 'exclude'
  // Pass `--tinydiarize` to whisper-cli so emitted text contains
  // `[SPEAKER_TURN]` markers at detected speaker changes. Only works with
  // tinydiarize-tuned models (e.g. ggml-small.en-tdrz.bin).
  whisperDiarize: boolean
  // Dedicated path to a tinydiarize-tuned `.bin`. When set and `whisperDiarize`
  // is on, transcription uses this model instead of `whisperModel` so users
  // can keep a high-quality main model (e.g. large-v3-turbo) and only swap
  // to the smaller tdrz model when they need speaker turns. Empty = fall back
  // to `whisperModel` (which still has to be tdrz-named for the flag to apply).
  whisperDiarizeModel: string
  // Engines to run when a prompt is submitted. At least one.
  aiEngines: Engine[]
  // Per-engine overrides. Empty string = use the engine's own default
  // (i.e. ~/.claude/settings.json for Claude; ~/.codex/config.toml for Codex).
  claudeModel: string
  claudeEffort: string
  codexModel: string
  // Invoke the engine through `wsl -e <engine> ...` instead of the Windows-side
  // binary. Useful when the user installed the CLI inside their WSL distro.
  claudeUseWsl: boolean
  codexUseWsl: boolean
  // When true, pass `-p` (print mode) to claude. Print mode counts against a
  // separate usage quota from the interactive Claude Code REPL, so users who
  // want to keep this app's calls off their main subscription can opt in.
  claudeUsePrintMode: boolean
  // When true, pass `--dangerously-bypass-approvals-and-sandbox` to codex —
  // fully unattended (no approval prompts, no sandbox). Default: false, which
  // runs codex in `-a on-request` "autopilot-ish" mode: codex decides when it
  // needs to ask before running a command.
  codexDangerouslyBypass: boolean
  // One-time gate: have we already pre-applied WSL defaults based on detection?
  wslDetectionDone: boolean
  // UI: width of the AI response panel in pixels.
  aiPaneWidth: number
  // How many latest transcript messages to include as context when sending
  // a prompt to the AI engine.
  transcriptContextMessages: number
  // Persisted window geometry. null = use defaults (centered, 1280x800).
  windowBounds: WindowBounds | null
  windowMaximized: boolean
  // Keep the window above all other windows (pin-on-top).
  alwaysOnTop: boolean
  // Hard timeout for a single AI request, in seconds. The spawned claude/codex
  // process is killed when this fires and the caller sees a timeout error.
  requestTimeoutSeconds: number
  // User-defined slash-command prompt templates. Built-in templates are added
  // at the renderer; user entries here can override built-ins by name and
  // extend the list with anything the user finds themselves typing often.
  promptTemplates: PromptTemplate[]
}

const defaults: Settings = {
  whisperExe: '',
  whisperModel: '',
  whisperVadModel: '',
  whisperLanguage: 'auto',
  whisperThreads: 4,
  transcribeMaxLanes: 2,
  transcribeIntervalSeconds: 12,
  audioBufferSeconds: 300,
  captureMicrophone: false,
  captureProcessName: '',
  captureProcessMode: 'include',
  whisperDiarize: false,
  whisperDiarizeModel: '',
  aiEngines: ['claude'],
  claudeModel: '',
  claudeEffort: '',
  codexModel: '',
  claudeUseWsl: false,
  codexUseWsl: false,
  claudeUsePrintMode: false,
  codexDangerouslyBypass: false,
  wslDetectionDone: false,
  aiPaneWidth: 480,
  transcriptContextMessages: 50,
  windowBounds: null,
  windowMaximized: false,
  alwaysOnTop: false,
  requestTimeoutSeconds: 300,
  promptTemplates: []
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
