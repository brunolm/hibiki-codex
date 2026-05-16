import { app, BrowserWindow, ipcMain, dialog, Menu, screen } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
import * as updater from './updater'

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

const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 800
const MIN_WIDTH = 900
const MIN_HEIGHT = 600

// True if at least 5% of the proposed window rect lands inside the work area
// of *some* connected display. Sum intersections across all displays so a
// window straddling two monitors still counts.
function isMostlyOnScreen(bounds: settings.WindowBounds): boolean {
  const totalArea = bounds.width * bounds.height
  if (totalArea <= 0) return false
  let visible = 0
  for (const d of screen.getAllDisplays()) {
    const w = d.workArea
    const ix = Math.max(
      0,
      Math.min(bounds.x + bounds.width, w.x + w.width) -
        Math.max(bounds.x, w.x)
    )
    const iy = Math.max(
      0,
      Math.min(bounds.y + bounds.height, w.y + w.height) -
        Math.max(bounds.y, w.y)
    )
    visible += ix * iy
  }
  return visible / totalArea >= 0.05
}

function createWindow(): void {
  const s = settings.get()
  const saved = s.windowBounds
  const useSaved =
    saved !== null &&
    saved.width >= MIN_WIDTH &&
    saved.height >= MIN_HEIGHT &&
    isMostlyOnScreen(saved)

  // Omit x/y when no usable saved position so Electron centers the window.
  mainWindow = new BrowserWindow({
    width: useSaved ? saved.width : DEFAULT_WIDTH,
    height: useSaved ? saved.height : DEFAULT_HEIGHT,
    ...(useSaved ? { x: saved.x, y: saved.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    icon: resolveAppIcon(),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (useSaved && s.windowMaximized) {
    mainWindow.maximize()
  }

  if (s.alwaysOnTop) {
    mainWindow.setAlwaysOnTop(true, 'screen-saver')
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
  }

  // Persist geometry on close. Use getNormalBounds() so a window that was
  // maximized when the user quit still restores its previous restored size
  // next time, not the screen-filling bounds.
  mainWindow.on('close', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) return
    try {
      const maximized = mainWindow.isMaximized()
      const b = mainWindow.getNormalBounds()
      settings.update({
        windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height },
        windowMaximized: maximized
      })
    } catch {
      // Best-effort: window may be in an odd state at close time on some
      // platforms. Don't block the close on it.
    }
  })

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

ipcMain.handle('window:setAlwaysOnTop', (_e, on: boolean) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(on, 'screen-saver')
  }
  settings.update({ alwaysOnTop: on })
})

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
  await audio.startAudioCapture()
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

ipcMain.handle('transcribe:open', async () => {
  const opts: Electron.OpenDialogOptions = {
    title: 'Open transcript',
    properties: ['openFile'],
    filters: [
      { name: 'Text', extensions: ['txt'] },
      { name: 'All files', extensions: ['*'] }
    ]
  }
  const result =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, opts)
      : await dialog.showOpenDialog(opts)
  if (result.canceled || result.filePaths.length === 0) return null
  const path = result.filePaths[0]!
  const content = await readFile(path, 'utf8')
  return { path, content }
})

ipcMain.handle(
  'transcribe:save',
  async (_e, content: string, defaultName: string) => {
    const opts = {
      title: 'Save transcript',
      defaultPath: defaultName,
      filters: [
        { name: 'Text', extensions: ['txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const result =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showSaveDialog(mainWindow, opts)
        : await dialog.showSaveDialog(opts)
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, content, 'utf8')
    return result.filePath
  }
)

ipcMain.handle(
  'ai:ask',
  async (
    _e,
    id: string,
    engine: settings.Engine,
    message: string,
    transcriptOverride: string
  ) => {
    try {
      return await ai.ask(
        id,
        engine,
        message,
        transcriptOverride ?? transcript.recent()
      )
    } catch (err) {
      // If the user aborted this request, swallow whatever error came back
      // (CanceledError from a clean kill, or a non-zero exit from a race).
      // The renderer already removed the card; there's nothing useful to show.
      if (err instanceof ai.CanceledError || ai.wasCanceled(id)) {
        return ''
      }
      throw err
    }
  }
)

ipcMain.handle('ai:cancel', (_e, id: string) => {
  ai.cancel(id)
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

ipcMain.handle('processes:list', () => audio.listAudioCapableProcessNames())

ipcMain.handle('audio:listInputDevices', () => audio.listInputDevices())
ipcMain.handle(
  'audio:testMicrophone',
  (_e, deviceId: string, durationMs?: number) =>
    audio.testMicrophone(deviceId, durationMs)
)

ipcMain.handle('updater:getStatus', () => updater.getStatus())
ipcMain.handle('updater:check', () => updater.check())
ipcMain.handle('updater:quitAndInstall', () => updater.quitAndInstall())

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
  // Drop the default Electron menu (File / Edit / View / Window / Help)
  // so the topbar is our only chrome.
  Menu.setApplicationMenu(null)
  if (process.platform === 'win32') {
    // Ensures the taskbar groups under our identity (and uses our icon)
    // instead of electron.exe in dev mode.
    app.setAppUserModelId('com.brunolm.hibikicodex')
  }
  createWindow()
  applyWslDefaults()
  updater.setEmitter((s) => send('updater:status', s))
  if (mainWindow) updater.init(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  audio.stopAudioCapture()
  transcribeLoop.stop()
  if (process.platform !== 'darwin') app.quit()
})
