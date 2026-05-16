import { contextBridge, ipcRenderer } from 'electron'

export type Engine = 'claude' | 'codex'
export type Language = 'auto' | 'en' | 'ja'

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
  transcribeMaxLanes: number
  transcribeIntervalSeconds: number
  audioBufferSeconds: number
  captureMicrophone: boolean
  captureProcessName: string
  captureProcessMode: 'include' | 'exclude'
  aiEngines: Engine[]
  claudeModel: string
  claudeEffort: string
  codexModel: string
  claudeUseWsl: boolean
  codexUseWsl: boolean
  claudeUsePrintMode: boolean
  codexDangerouslyBypass: boolean
  wslDetectionDone: boolean
  aiPaneWidth: number
  transcriptContextMessages: number
  windowBounds: {
    x: number
    y: number
    width: number
    height: number
  } | null
  windowMaximized: boolean
  alwaysOnTop: boolean
  requestTimeoutSeconds: number
  promptTemplates: PromptTemplate[]
}

export type EngineDetection = { windows: boolean; wsl: boolean }
export type DetectedEngines = {
  claude: EngineDetection
  codex: EngineDetection
}

export type WhisperCatalogModel = {
  id: string
  filename: string
  sizeBytes: number
  group: 'multilingual' | 'japanese' | 'english'
  label: string
  description: string
  url: string
  recommended?: boolean
}

export type DownloadProgress = {
  bytesDownloaded: number
  totalBytes: number
  rateBytesPerSec: number
}

export type WhisperRuntimeVariant = {
  id: string
  label: string
  description: string
  asset: string
  sizeBytes: number
  url: string
  recommended?: boolean
}

export type WhisperRuntimeProgress = {
  phase: 'downloading' | 'extracting'
  bytesDownloaded: number
  totalBytes: number
  rateBytesPerSec: number
}

export type TranscribeStatus = { running: boolean; warming: boolean }
export type TranscribeLine = { text: string; at: number }
export type AudioLog = { msg: string; level: 'info' | 'warn' | 'error' }

export type UpdateStatus =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; version: string; releaseDate?: string }
  | { phase: 'not-available'; version: string }
  | {
      phase: 'downloading'
      version: string
      percent: number
      bytesPerSecond: number
    }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; message: string }

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
    save: (content: string, defaultName: string): Promise<string | null> =>
      ipcRenderer.invoke('transcribe:save', content, defaultName),
    open: (): Promise<{ path: string; content: string } | null> =>
      ipcRenderer.invoke('transcribe:open'),
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
    ask: (
      id: string,
      engine: Engine,
      message: string,
      transcript: string
    ): Promise<string> =>
      ipcRenderer.invoke('ai:ask', id, engine, message, transcript),
    cancel: (id: string): Promise<void> => ipcRenderer.invoke('ai:cancel', id)
  },
  paths: {
    bundledWhisperVad: (): Promise<string | null> =>
      ipcRenderer.invoke('paths:bundledWhisperVad'),
    detectedEngines: (): Promise<DetectedEngines> =>
      ipcRenderer.invoke('paths:detectedEngines'),
    recheckEngines: (): Promise<DetectedEngines> =>
      ipcRenderer.invoke('paths:recheckEngines')
  },
  models: {
    list: (): Promise<WhisperCatalogModel[]> => ipcRenderer.invoke('models:list'),
    listInstalled: (): Promise<Record<string, string>> =>
      ipcRenderer.invoke('models:listInstalled'),
    download: (modelId: string): Promise<string | null> =>
      ipcRenderer.invoke('models:download', modelId),
    cancel: (): Promise<void> => ipcRenderer.invoke('models:cancel'),
    onProgress: (cb: (p: DownloadProgress) => void): (() => void) => {
      const fn = (_e: unknown, p: DownloadProgress): void => cb(p)
      ipcRenderer.on('models:progress', fn)
      return () => ipcRenderer.off('models:progress', fn)
    }
  },
  whisperRuntime: {
    list: (): Promise<WhisperRuntimeVariant[]> =>
      ipcRenderer.invoke('whisperRuntime:list'),
    listInstalled: (): Promise<Record<string, string>> =>
      ipcRenderer.invoke('whisperRuntime:listInstalled'),
    download: (variantId: string): Promise<string> =>
      ipcRenderer.invoke('whisperRuntime:download', variantId),
    cancel: (): Promise<void> => ipcRenderer.invoke('whisperRuntime:cancel'),
    onProgress: (cb: (p: WhisperRuntimeProgress) => void): (() => void) => {
      const fn = (_e: unknown, p: WhisperRuntimeProgress): void => cb(p)
      ipcRenderer.on('whisperRuntime:progress', fn)
      return () => ipcRenderer.off('whisperRuntime:progress', fn)
    }
  },
  install: {
    claude: (): Promise<number | null> => ipcRenderer.invoke('install:claude'),
    onLog: (cb: (line: string) => void): (() => void) => {
      const fn = (_e: unknown, p: string): void => cb(p)
      ipcRenderer.on('install:log', fn)
      return () => ipcRenderer.off('install:log', fn)
    }
  },
  processes: {
    list: (): Promise<string[]> => ipcRenderer.invoke('processes:list')
  },
  platform: process.platform as NodeJS.Platform,
  window: {
    setAlwaysOnTop: (on: boolean): Promise<void> =>
      ipcRenderer.invoke('window:setAlwaysOnTop', on)
  },
  updater: {
    getStatus: (): Promise<UpdateStatus> =>
      ipcRenderer.invoke('updater:getStatus'),
    check: (): Promise<void> => ipcRenderer.invoke('updater:check'),
    quitAndInstall: (): Promise<void> =>
      ipcRenderer.invoke('updater:quitAndInstall'),
    onStatus: (cb: (s: UpdateStatus) => void): (() => void) => {
      const fn = (_e: unknown, p: UpdateStatus): void => cb(p)
      ipcRenderer.on('updater:status', fn)
      return () => ipcRenderer.off('updater:status', fn)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
