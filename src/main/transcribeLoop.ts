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
let inFlight = false
let timer: NodeJS.Timeout | null = null
let emit: Emit = () => {}

export function setEmitter(fn: Emit): void {
  emit = fn
}

async function tick(): Promise<void> {
  if (inFlight) return
  if (!isAudioRunning()) return

  if (lastOffset === 0) lastOffset = getCurrentOffset()

  const minBytes = getBytesPerSecond()
  const slice = getAudioSince(lastOffset, minBytes)
  if (!slice) return

  inFlight = true
  try {
    if (slice.droppedBytes > 0) {
      const droppedSec = (slice.droppedBytes / getBytesPerSecond()).toFixed(0)
      emit('transcribe:notice', `dropped ${droppedSec}s of audio (ring buffer overflow)`)
    }
    const text = await transcribeWav(slice.wav)
    lastOffset = slice.newOffset
    if (text) {
      append(text)
      emit('transcribe:line', { text, at: Date.now() })
    }
  } catch (err) {
    emit('transcribe:error', (err as Error).message)
  } finally {
    inFlight = false
  }
}

export function start(): void {
  if (timer) return
  const interval = getSettings().transcribeIntervalSeconds * 1000
  lastOffset = 0
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
