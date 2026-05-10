import { createWriteStream, existsSync, unlinkSync } from 'node:fs'

export type ProgressInfo = {
  bytesDownloaded: number
  totalBytes: number
  rateBytesPerSec: number
}
export type ProgressCallback = (info: ProgressInfo) => void

let currentController: AbortController | null = null
let currentTargetPath: string | null = null

function deletePartial(): void {
  if (currentTargetPath && existsSync(currentTargetPath)) {
    try {
      unlinkSync(currentTargetPath)
    } catch {
      // best-effort cleanup
    }
  }
}

export async function startDownload(
  url: string,
  targetPath: string,
  onProgress: ProgressCallback
): Promise<void> {
  if (currentController) {
    throw new Error('a download is already in progress')
  }
  const controller = new AbortController()
  currentController = controller
  currentTargetPath = targetPath

  const fileStream = createWriteStream(targetPath)
  let bytesDownloaded = 0
  let lastEmitMs = Date.now()
  let lastBytes = 0

  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      throw new Error(`download failed: ${res.status} ${res.statusText}`)
    }
    const totalBytes = Number(res.headers.get('content-length')) || 0
    if (!res.body) throw new Error('response has no body')

    const reader = res.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (controller.signal.aborted) throw new Error('cancelled')
      await new Promise<void>((resolve, reject) => {
        fileStream.write(value, (err) => (err ? reject(err) : resolve()))
      })
      bytesDownloaded += value.byteLength
      const now = Date.now()
      if (now - lastEmitMs >= 250) {
        const rate = ((bytesDownloaded - lastBytes) * 1000) / (now - lastEmitMs)
        onProgress({ bytesDownloaded, totalBytes, rateBytesPerSec: rate })
        lastEmitMs = now
        lastBytes = bytesDownloaded
      }
    }

    await new Promise<void>((resolve, reject) => {
      fileStream.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })
    onProgress({ bytesDownloaded, totalBytes, rateBytesPerSec: 0 })
  } catch (err) {
    fileStream.destroy()
    deletePartial()
    throw err
  } finally {
    currentController = null
    currentTargetPath = null
  }
}

export function cancelDownload(): void {
  if (currentController) {
    currentController.abort()
  }
}

export function isDownloading(): boolean {
  return currentController !== null
}
