import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import * as settings from './settings'
import * as audio from './audio'
import * as transcript from './transcript'
import * as transcribeLoop from './transcribeLoop'
import { warmupWhisper, cancelTranscriptions } from './transcribe'
import {
  bundledWhisperVad,
  whisperModelsRoot,
  whisperRuntimeDir
} from './paths'
import { WHISPER_CATALOG } from './whisperCatalog'
import { cancelDownload, startDownload } from './modelDownload'
import { WHISPER_RUNTIME_VARIANTS } from './whisperRuntimeCatalog'
import {
  cancelRuntimeDownload,
  downloadAndInstall as downloadWhisperRuntime
} from './whisperRuntimeDownload'
import * as ai from './ai'
import * as aiDetect from './aiDetect'
import * as aiInstall from './aiInstall'

type NativeApi = {
  hello(name: string): string
  computePi(iterations: number): number
}

const nativeModulePath = app.isPackaged
  ? join(process.resourcesPath, 'native')
  : join(__dirname, '..', '..', 'native')

const native: NativeApi = require(nativeModulePath)

let mainWindow: BrowserWindow | null = null

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function resolveAppIcon(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'app-icon.png')
    : join(__dirname, '..', '..', 'resources', 'app-icon.png')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    icon: resolveAppIcon(),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

audio.setLogger((msg, level = 'info') => {
  send('audio:log', { msg, level })
})

transcribeLoop.setEmitter((event, payload) => {
  send(event, payload)
})

ipcMain.handle('rust:hello', (_e, name: string) => native.hello(name))
ipcMain.handle('rust:computePi', (_e, iter: number) => native.computePi(iter))

ipcMain.handle('settings:get', () => settings.get())
ipcMain.handle('settings:save', (_e, next: Partial<settings.Settings>) =>
  settings.update(next)
)

ipcMain.handle(
  'dialog:pickFile',
  async (
    _e,
    opts: { title?: string; filters?: { name: string; extensions: string[] }[] }
  ) => {
    const result = await dialog.showOpenDialog({
      title: opts.title,
      properties: ['openFile'],
      filters: opts.filters
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  }
)

ipcMain.handle('transcribe:start', async () => {
  const s = settings.get()
  if (!s.whisperExe || !s.whisperModel) {
    throw new Error(
      'Configure a whisper executable and model in Settings (use the Download… buttons if you don\'t have them yet).'
    )
  }
  audio.startAudioCapture()
  send('transcribe:status', { running: true, warming: true })
  try {
    await warmupWhisper()
  } catch (err) {
    send('transcribe:error', `whisper warmup failed: ${(err as Error).message}`)
  }
  transcribeLoop.start()
  send('transcribe:status', { running: true, warming: false })
})

ipcMain.handle('transcribe:stop', () => {
  transcribeLoop.stop()
  audio.stopAudioCapture()
  // Abort any whisper inferences that were already running so a long tick
  // doesn't keep burning CPU after the user clicks Stop.
  cancelTranscriptions()
  send('transcribe:status', { running: false, warming: false })
})

ipcMain.handle('transcribe:clear', () => {
  transcript.clear()
})

ipcMain.handle(
  'ai:ask',
  async (
    _e,
    engine: settings.Engine,
    message: string,
    transcriptOverride: string
  ) => {
    return ai.ask(engine, message, transcriptOverride ?? transcript.recent())
  }
)

ipcMain.handle('ai:cancel', () => {
  ai.cancel()
})

ipcMain.handle('paths:bundledWhisperVad', () => bundledWhisperVad())
ipcMain.handle('paths:detectedEngines', () => aiDetect.detectEngines())
ipcMain.handle('paths:recheckEngines', () => {
  aiDetect.clearDetectionCache()
  return aiDetect.detectEngines()
})

ipcMain.handle('install:claude', async () => {
  return aiInstall.installClaude((line) => send('install:log', line))
})

ipcMain.handle('models:list', () => WHISPER_CATALOG)

ipcMain.handle('models:listInstalled', () => {
  const root = whisperModelsRoot()
  const result: Record<string, string> = {}
  for (const m of WHISPER_CATALOG) {
    const p = join(root, m.filename)
    if (existsSync(p)) result[m.id] = p
  }
  return result
})

ipcMain.handle('models:download', async (_e, modelId: string) => {
  const model = WHISPER_CATALOG.find((m) => m.id === modelId)
  if (!model) throw new Error(`unknown model: ${modelId}`)

  // Save into <userData>/models/<filename>. Mirrors the whisper-runtime
  // layout — no save dialog, no Downloads-folder pollution.
  const dir = whisperModelsRoot()
  await mkdir(dir, { recursive: true })
  const destPath = join(dir, model.filename)

  await startDownload(model.url, destPath, (info) => {
    send('models:progress', info)
  })
  return destPath
})

ipcMain.handle('models:cancel', () => {
  cancelDownload()
})

ipcMain.handle('whisperRuntime:list', () => WHISPER_RUNTIME_VARIANTS)

ipcMain.handle('whisperRuntime:listInstalled', () => {
  const result: Record<string, string> = {}
  for (const v of WHISPER_RUNTIME_VARIANTS) {
    const exe = join(whisperRuntimeDir(v.id), 'whisper-cli.exe')
    if (existsSync(exe)) result[v.id] = exe
  }
  return result
})

ipcMain.handle('whisperRuntime:download', async (_e, variantId: string) => {
  return downloadWhisperRuntime(variantId, (info) => {
    send('whisperRuntime:progress', info)
  })
})

ipcMain.handle('whisperRuntime:cancel', () => {
  cancelRuntimeDownload()
})

function applyWslDefaults(): void {
  const s = settings.get()
  if (s.wslDetectionDone) return
  void aiDetect.detectEngines().then((det) => {
    const next: Partial<settings.Settings> = { wslDetectionDone: true }
    if (!det.claude.windows && det.claude.wsl) next.claudeUseWsl = true
    if (!det.codex.windows && det.codex.wsl) next.codexUseWsl = true
    settings.update(next)
  })
}

void app.whenReady().then(() => {
  settings.init()
  if (process.platform === 'win32') {
    // Ensures the taskbar groups under our identity (and uses our icon)
    // instead of electron.exe in dev mode.
    app.setAppUserModelId('com.brunolm.hibikicodex')
  }
  createWindow()
  applyWslDefaults()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  audio.stopAudioCapture()
  transcribeLoop.stop()
  if (process.platform !== 'darwin') app.quit()
})
