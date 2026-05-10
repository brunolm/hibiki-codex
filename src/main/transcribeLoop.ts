import {
  getAudioSince,
  getBytesPerSecond,
  getCurrentOffset,
  isAudioRunning
} from './audio'
import { transcribeWav } from './transcribe'
import { append } from './transcript'
import { get as getSettings } from './settings'

type Emit = (event: string, payload: unknown) => void

let lastOffset = 0
let active = 0
let timer: NodeJS.Timeout | null = null
let emit: Emit = () => {}

export function setEmitter(fn: Emit): void {
  emit = fn
}

// Resolve the max-lanes setting once per tick so live edits take effect
// without restarting transcription. Clamped to [1, 8] to keep peak CPU
// load (lanes × whisperThreads) reasonable on tiny / huge values.
function getMaxLanes(): number {
  const raw = getSettings().transcribeMaxLanes
  return Math.max(1, Math.min(8, Math.floor(raw) || 1))
}

async function tick(): Promise<void> {
  if (active >= getMaxLanes()) return
  if (!isAudioRunning()) return

  if (lastOffset === 0) lastOffset = getCurrentOffset()

  const minBytes = getBytesPerSecond()
  const slice = getAudioSince(lastOffset, minBytes)
  if (!slice) return

  // Claim the slice up front so a parallel tick gets fresh audio instead
  // of overlapping with this one. `at` is captured at claim time so emitted
  // lines stay in audio-time order even if a later, smaller tick finishes
  // first — the renderer inserts sorted by `at`.
  const at = Date.now()
  lastOffset = slice.newOffset
  active++
  try {
    if (slice.droppedBytes > 0) {
      const droppedSec = (slice.droppedBytes / getBytesPerSecond()).toFixed(0)
      emit(
        'transcribe:notice',
        `dropped ${droppedSec}s of audio (ring buffer overflow)`
      )
    }
    const text = await transcribeWav(slice.wav)
    if (text) {
      append(text)
      emit('transcribe:line', { text, at })
    }
  } catch (err) {
    emit('transcribe:error', (err as Error).message)
  } finally {
    active--
  }
}

export function start(): void {
  if (timer) return
  const interval = getSettings().transcribeIntervalSeconds * 1000
  lastOffset = 0
  active = 0
  timer = setInterval(() => {
    void tick()
  }, interval)
}

export function stop(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export function isRunning(): boolean {
  return timer !== null
}
