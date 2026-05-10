import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'node:path'
import * as settings from './settings'
import * as audio from './audio'
import * as transcript from './transcript'
import * as transcribeLoop from './transcribeLoop'
import { warmupWhisper } from './transcribe'
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
    throw new Error('Configure whisper exe and model in Settings first.')
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

ipcMain.handle('paths:detectedEngines', () => aiDetect.detectEngines())
ipcMain.handle('paths:recheckEngines', () => {
  aiDetect.clearDetectionCache()
  return aiDetect.detectEngines()
})

ipcMain.handle('install:claude', async () => {
  return aiInstall.installClaude((line) => send('install:log', line))
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
