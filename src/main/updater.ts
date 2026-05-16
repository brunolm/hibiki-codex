import { app, type BrowserWindow } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'

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

type Emitter = (status: UpdateStatus) => void

let lastStatus: UpdateStatus = { phase: 'idle' }
let emit: Emitter = () => {}

export function setEmitter(fn: Emitter): void {
  emit = fn
  // Replay the latest state to anyone who subscribes after startup so the
  // renderer's banner doesn't go blank when the user opens a fresh view.
  fn(lastStatus)
}

export function getStatus(): UpdateStatus {
  return lastStatus
}

function setStatus(next: UpdateStatus): void {
  lastStatus = next
  emit(next)
}

let initialised = false

export function init(_window: BrowserWindow): void {
  if (initialised) return
  initialised = true

  // Dev runs won't have a packaged app or a valid update feed; skip wiring up
  // the updater so the renderer never sees a "no update yml found" error.
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    setStatus({ phase: 'checking' })
  })
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    setStatus({
      phase: 'available',
      version: info.version,
      releaseDate: info.releaseDate
    })
  })
  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    setStatus({ phase: 'not-available', version: info.version })
  })
  autoUpdater.on('download-progress', (p) => {
    setStatus({
      phase: 'downloading',
      version: lastStatus.phase === 'available' ? lastStatus.version : '',
      percent: p.percent,
      bytesPerSecond: p.bytesPerSecond
    })
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    setStatus({ phase: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', (err) => {
    setStatus({ phase: 'error', message: err?.message ?? String(err) })
  })

  // Best-effort kickoff. Any networking / signature error surfaces through
  // the 'error' handler above so the renderer can show it.
  void autoUpdater.checkForUpdates().catch(() => {})
}

export function check(): void {
  if (!app.isPackaged) {
    setStatus({
      phase: 'error',
      message: 'Updates only run in a packaged build.'
    })
    return
  }
  void autoUpdater.checkForUpdates().catch((err) => {
    setStatus({ phase: 'error', message: (err as Error).message })
  })
}

export function quitAndInstall(): void {
  if (!app.isPackaged) return
  autoUpdater.quitAndInstall()
}
