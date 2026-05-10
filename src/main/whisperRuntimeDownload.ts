import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, unlinkSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  unlink
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { whisperRuntimeDir } from './paths'
import {
  WHISPER_RUNTIME_VARIANTS,
  type WhisperRuntimeVariant
} from './whisperRuntimeCatalog'

export type RuntimeProgress = {
  phase: 'downloading' | 'extracting'
  bytesDownloaded: number
  totalBytes: number
  rateBytesPerSec: number
}
export type RuntimeProgressCallback = (info: RuntimeProgress) => void

let controller: AbortController | null = null
let cleanupOnAbort: (() => void) | null = null

function expandZipWithPwsh(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'pwsh',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Force -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}'`
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stderr = ''
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Expand-Archive exited ${code}: ${stderr.trim().slice(0, 300)}`))
    })
  })
}

function safeUnlink(p: string): void {
  if (existsSync(p)) {
    try {
      unlinkSync(p)
    } catch {}
  }
}

// Walk a freshly extracted directory and find the first whisper-cli.exe.
// Most variants put it at the root, but some zips have a `Release/` folder.
async function findWhisperCliExe(dir: string): Promise<string | null> {
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const d = stack.pop()!
    let entries: string[]
    try {
      entries = await readdir(d)
    } catch {
      continue
    }
    for (const name of entries) {
      const full = join(d, name)
      const s = await stat(full).catch(() => null)
      if (!s) continue
      if (s.isDirectory()) stack.push(full)
      else if (name.toLowerCase() === 'whisper-cli.exe') return full
    }
  }
  return null
}

// Move every file under `srcDir` into `destDir` (flat), preserving DLLs +
// the exe. Avoids leaving an extra `Release/` indirection in userData/.
async function flattenInto(srcDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  const stack: string[] = [srcDir]
  while (stack.length > 0) {
    const d = stack.pop()!
    const entries = await readdir(d)
    for (const name of entries) {
      const full = join(d, name)
      const s = await stat(full).catch(() => null)
      if (!s) continue
      if (s.isDirectory()) {
        stack.push(full)
      } else {
        await rename(full, join(destDir, name)).catch(async () => {
          // Cross-volume fallback (rare): copy then delete.
          await copyFile(full, join(destDir, name))
          await unlink(full)
        })
      }
    }
  }
}

export async function downloadAndInstall(
  variantId: string,
  onProgress: RuntimeProgressCallback
): Promise<string> {
  if (controller) {
    throw new Error('a whisper runtime download is already in progress')
  }
  const variant: WhisperRuntimeVariant | undefined =
    WHISPER_RUNTIME_VARIANTS.find((v) => v.id === variantId)
  if (!variant) throw new Error(`unknown variant: ${variantId}`)

  controller = new AbortController()
  const sig = controller.signal

  const tmpRoot = join(tmpdir(), `hibiki-whisper-${Date.now()}`)
  const zipPath = join(tmpRoot, variant.asset)
  const extractDir = join(tmpRoot, 'extracted')
  const finalDir = whisperRuntimeDir(variant.id)

  cleanupOnAbort = (): void => {
    safeUnlink(zipPath)
    void rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
    void rm(finalDir, { recursive: true, force: true }).catch(() => {})
  }

  try {
    await mkdir(tmpRoot, { recursive: true })
    await mkdir(dirname(finalDir), { recursive: true })

    // 1) Stream-download the zip with progress.
    const res = await fetch(variant.url, { signal: sig })
    if (!res.ok) {
      throw new Error(`download failed: ${res.status} ${res.statusText}`)
    }
    const totalBytes = Number(res.headers.get('content-length')) || variant.sizeBytes
    if (!res.body) throw new Error('response has no body')

    const fileStream = createWriteStream(zipPath)
    let bytesDownloaded = 0
    let lastEmitMs = Date.now()
    let lastBytes = 0

    const reader = res.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (sig.aborted) throw new Error('cancelled')
        await new Promise<void>((resolve, reject) => {
          fileStream.write(value, (err) => (err ? reject(err) : resolve()))
        })
        bytesDownloaded += value.byteLength
        const now = Date.now()
        if (now - lastEmitMs >= 200) {
          const rate = ((bytesDownloaded - lastBytes) * 1000) / (now - lastEmitMs)
          onProgress({
            phase: 'downloading',
            bytesDownloaded,
            totalBytes,
            rateBytesPerSec: rate
          })
          lastEmitMs = now
          lastBytes = bytesDownloaded
        }
      }
    } finally {
      await new Promise<void>((resolve) => fileStream.end(() => resolve()))
    }

    onProgress({
      phase: 'downloading',
      bytesDownloaded,
      totalBytes,
      rateBytesPerSec: 0
    })

    if (sig.aborted) throw new Error('cancelled')

    // 2) Extract via pwsh Expand-Archive (no extra npm dep).
    onProgress({
      phase: 'extracting',
      bytesDownloaded,
      totalBytes,
      rateBytesPerSec: 0
    })
    await rm(extractDir, { recursive: true, force: true })
    await expandZipWithPwsh(zipPath, extractDir)

    if (sig.aborted) throw new Error('cancelled')

    // 3) Move flattened contents into the per-variant userData dir.
    await rm(finalDir, { recursive: true, force: true })
    await flattenInto(extractDir, finalDir)

    const exe = await findWhisperCliExe(finalDir)
    if (!exe) {
      throw new Error('whisper-cli.exe not found in extracted archive')
    }

    return exe
  } catch (err) {
    if (cleanupOnAbort) cleanupOnAbort()
    throw err
  } finally {
    controller = null
    cleanupOnAbort = null
    // Always remove the zip + extract dir; keep finalDir if install succeeded.
    safeUnlink(zipPath)
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  }
}

export function cancelRuntimeDownload(): void {
  if (controller) controller.abort()
  if (cleanupOnAbort) cleanupOnAbort()
}
