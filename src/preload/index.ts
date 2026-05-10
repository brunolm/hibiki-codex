import { contextBridge, ipcRenderer } from 'electron'

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
  aiEngines: Engine[]
  claudeModel: string
  claudeEffort: string
  codexModel: string
  claudeUseWsl: boolean
  codexUseWsl: boolean
  wslDetectionDone: boolean
  aiPaneWidth: number
  transcriptContextMessages: number
}

export type EngineDetection = { windows: boolean; wsl: boolean }
export type DetectedEngines = {
  claude: EngineDetection
  codex: EngineDetection
}

export type TranscribeStatus = { running: boolean; warming: boolean }
export type TranscribeLine = { text: string; at: number }
export type AudioLog = { msg: string; level: 'info' | 'warn' | 'error' }

const api = {
  rust: {
    hello: (name: string): Promise<string> => ipcRenderer.invoke('rust:hello', name),
    computePi: (n: number): Promise<number> => ipcRenderer.invoke('rust:computePi', n)
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    save: (next: Partial<Settings>): Promise<Settings> =>
      ipcRenderer.invoke('settings:save', next)
  },
  dialog: {
    pickFile: (opts: {
      title?: string
      filters?: { name: string; extensions: string[] }[]
    }): Promise<string | null> => ipcRenderer.invoke('dialog:pickFile', opts)
  },
  transcribe: {
    start: (): Promise<void> => ipcRenderer.invoke('transcribe:start'),
    stop: (): Promise<void> => ipcRenderer.invoke('transcribe:stop'),
    clear: (): Promise<void> => ipcRenderer.invoke('transcribe:clear'),
    onLine: (cb: (line: TranscribeLine) => void): (() => void) => {
      const fn = (_e: unknown, p: TranscribeLine): void => cb(p)
      ipcRenderer.on('transcribe:line', fn)
      return () => ipcRenderer.off('transcribe:line', fn)
    },
    onStatus: (cb: (status: TranscribeStatus) => void): (() => void) => {
      const fn = (_e: unknown, p: TranscribeStatus): void => cb(p)
      ipcRenderer.on('transcribe:status', fn)
      return () => ipcRenderer.off('transcribe:status', fn)
    },
    onError: (cb: (msg: string) => void): (() => void) => {
      const fn = (_e: unknown, p: string): void => cb(p)
      ipcRenderer.on('transcribe:error', fn)
      return () => ipcRenderer.off('transcribe:error', fn)
    },
    onNotice: (cb: (msg: string) => void): (() => void) => {
      const fn = (_e: unknown, p: string): void => cb(p)
      ipcRenderer.on('transcribe:notice', fn)
      return () => ipcRenderer.off('transcribe:notice', fn)
    },
    onAudioLog: (cb: (log: AudioLog) => void): (() => void) => {
      const fn = (_e: unknown, p: AudioLog): void => cb(p)
      ipcRenderer.on('audio:log', fn)
      return () => ipcRenderer.off('audio:log', fn)
    }
  },
  ai: {
    ask: (engine: Engine, message: string, transcript: string): Promise<string> =>
      ipcRenderer.invoke('ai:ask', engine, message, transcript),
    cancel: (): Promise<void> => ipcRenderer.invoke('ai:cancel')
  },
  paths: {
    detectedEngines: (): Promise<DetectedEngines> =>
      ipcRenderer.invoke('paths:detectedEngines'),
    recheckEngines: (): Promise<DetectedEngines> =>
      ipcRenderer.invoke('paths:recheckEngines')
  },
  install: {
    claude: (): Promise<number | null> => ipcRenderer.invoke('install:claude'),
    onLog: (cb: (line: string) => void): (() => void) => {
      const fn = (_e: unknown, p: string): void => cb(p)
      ipcRenderer.on('install:log', fn)
      return () => ipcRenderer.off('install:log', fn)
    }
  },
  platform: process.platform as NodeJS.Platform
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
