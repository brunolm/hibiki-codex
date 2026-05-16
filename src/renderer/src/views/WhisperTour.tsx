import { useEffect, useState } from 'react'

export type WhisperSubTab = 'general' | 'models' | 'capture'

type TourStep = {
  // CSS selector for the element to highlight. The tour finds it after the
  // requested sub-tab is active and tries a handful of frames in case the
  // DOM hasn't caught up to a sub-tab switch yet.
  selector: string
  subTab: WhisperSubTab
  title: string
  body: React.ReactNode
}

// The tour walks the user through every Whisper field worth explaining —
// required setup first (Models), then tuning knobs (General), then capture-
// source choices. Users can hit End any time.
const STEPS: TourStep[] = [
  {
    selector: '[data-tour="whisperExe"]',
    subTab: 'models',
    title: 'Whisper executable',
    body: (
      <>
        Path to <code>whisper-cli.exe</code>, the local speech-to-text engine.
        Click <strong>Download…</strong> to fetch one if you don&apos;t have
        it yet — the CUDA 12.4 build is recommended for NVIDIA GPUs (~200 MB
        RAM at runtime); the CPU build works on any machine.
      </>
    )
  },
  {
    selector: '[data-tour="whisperModel"]',
    subTab: 'models',
    title: 'Whisper model',
    body: (
      <>
        The neural-net weights whisper-cli loads. <strong>Large v3 Turbo
        (q8_0)</strong> is a good default — fast, high quality, multilingual.
        Pick a Japanese-tuned model (Anime Whisper / Kotoba) for Japanese
        content, or <code>*.en</code> for English-only.
      </>
    )
  },
  {
    selector: '[data-tour="whisperVadModel"]',
    subTab: 'models',
    title: 'VAD model (optional)',
    body: (
      <>
        Voice-activity detection — helps whisper skip silent stretches and
        cut hallucinations on quiet audio. Leave empty to use the bundled
        Silero VAD; only override if you have a custom one.
      </>
    )
  },
  {
    selector: '[data-tour="whisperDiarizeModel"]',
    subTab: 'models',
    title: 'TinyDiarize model (optional)',
    body: (
      <>
        Only used when <em>Speaker diarization</em> is enabled (under
        <em> Capture &amp; runtime</em>). Click <strong>Download…</strong> to
        grab <code>small.en-tdrz</code>, the only tinydiarize-tuned model
        that exists. English only.
      </>
    )
  },
  {
    selector: '[data-tour="language"]',
    subTab: 'general',
    title: 'Language',
    body: (
      <>
        Auto-detect adds a little latency and can be flaky on short audio
        chunks. If you know what language you&apos;ll be transcribing, pick
        it explicitly. Single-language-tuned models (Anime / Kotoba /{' '}
        <code>*.en</code>) ignore this.
      </>
    )
  },
  {
    selector: '[data-tour="threads"]',
    subTab: 'general',
    title: 'Whisper threads',
    body: (
      <>
        How many CPU cores whisper-cli uses per inference. 4 is fine on most
        machines. Lower it if your computer feels sluggish during transcription;
        peak CPU = <em>lanes × threads</em>.
      </>
    )
  },
  {
    selector: '[data-tour="lanes"]',
    subTab: 'general',
    title: 'Parallel lanes',
    body: (
      <>
        How many transcriptions can run at once. 1 is plenty with a fast
        model. Raise this only if transcription is consistently falling
        behind the interval (a new chunk arrives while the previous one is
        still running).
      </>
    )
  },
  {
    selector: '[data-tour="interval"]',
    subTab: 'general',
    title: 'Transcribe interval',
    body: (
      <>
        How often a new transcript line appears, in seconds. Lower = snappier
        but more CPU. 4–8 seconds is the sweet spot for live captions; bump
        higher for low-power machines.
      </>
    )
  },
  {
    selector: '[data-tour="audioBuffer"]',
    subTab: 'general',
    title: 'Audio buffer',
    body: (
      <>
        How many seconds of rolling audio to keep on hand so transcription
        can catch up after a stall. 300 s (5 min) is plenty for most
        sessions; bump up for very long meetings.
      </>
    )
  },
  {
    selector: '[data-tour="micDevice"]',
    subTab: 'capture',
    title: 'Microphone device',
    body: (
      <>
        Which input the mic-mix uses. The mic mix itself is toggled live
        from the 🎤 button next to <em>Start</em> in the chat view — this
        picker just chooses the device. Click <strong>Test</strong> here to
        verify the mic is producing audio.
      </>
    )
  },
  {
    selector: '[data-tour="loopbackDevice"]',
    subTab: 'capture',
    title: 'Audio output device',
    body: (
      <>
        Which playback endpoint WASAPI loopback captures from. Default =
        whatever Windows is currently playing through. Useful if you have
        multiple outputs and only want to transcribe one. Ignored when
        <em> Capture from process</em> is set.
      </>
    )
  },
  {
    selector: '[data-tour="processCapture"]',
    subTab: 'capture',
    title: 'Capture from process',
    body: (
      <>
        Capture audio from a single Windows process (and its child
        processes) instead of the whole system. Useful for picking out just
        Discord or just Spotify. Requires Windows 10 2004+ — click{' '}
        <strong>Refresh</strong> to list running processes.
      </>
    )
  },
  {
    selector: '[data-tour="diarize"]',
    subTab: 'capture',
    title: 'Speaker diarization (beta)',
    body: (
      <>
        Adds a <code>[SPEAKER_TURN]</code> marker (rendered as a divider
        between message bubbles) whenever whisper detects a speaker change.
        Requires a tdrz-tuned model — set the <em>TinyDiarize model</em>{' '}
        under <em>Models</em> first.
      </>
    )
  }
]

type Props = {
  onClose: () => void
  // Lets the tour switch the visible sub-tab when the next step lives on a
  // different one. The parent owns sub-tab state.
  onSubTabChange: (sub: WhisperSubTab) => void
}

export function WhisperTour({ onClose, onSubTabChange }: Props): JSX.Element | null {
  const [stepIndex, setStepIndex] = useState(0)
  const step = STEPS[stepIndex]!
  const [rect, setRect] = useState<DOMRect | null>(null)

  // Switch to the sub-tab this step lives on whenever the step changes.
  useEffect(() => {
    onSubTabChange(step.subTab)
  }, [step.subTab, onSubTabChange])

  // Locate the target element after the sub-tab swap, retrying for a handful
  // of frames in case the DOM hasn't caught up to a parent re-render yet.
  // Also re-measures on window resize and on any scroll in the page so the
  // spotlight tracks the field while the settings pane scrolls.
  useEffect(() => {
    let cancelled = false
    let raf = 0
    let attempts = 0
    let interval: ReturnType<typeof setInterval> | null = null

    function tryFind(): void {
      if (cancelled) return
      const el = document.querySelector(step.selector) as HTMLElement | null
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        setRect(el.getBoundingClientRect())
        // Smooth-scroll runs over ~300ms — re-measure a few times so the
        // spotlight stays glued to the field during the animation.
        let ticks = 0
        interval = setInterval(() => {
          if (cancelled || ticks++ > 6) {
            if (interval) clearInterval(interval)
            return
          }
          setRect(el.getBoundingClientRect())
        }, 80)
      } else if (attempts < 30) {
        attempts++
        raf = requestAnimationFrame(tryFind)
      } else {
        // Target never appeared — bail out by clearing the rect so we render
        // nothing for this step. User can advance or end the tour.
        setRect(null)
      }
    }

    tryFind()

    function onResizeOrScroll(): void {
      const el = document.querySelector(step.selector) as HTMLElement | null
      if (el) setRect(el.getBoundingClientRect())
    }
    window.addEventListener('resize', onResizeOrScroll)
    window.addEventListener('scroll', onResizeOrScroll, true)

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      if (interval) clearInterval(interval)
      window.removeEventListener('resize', onResizeOrScroll)
      window.removeEventListener('scroll', onResizeOrScroll, true)
    }
  }, [step.selector])

  // Keyboard shortcuts: Esc closes, arrows advance.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        next()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        prev()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex])

  function next(): void {
    if (stepIndex < STEPS.length - 1) setStepIndex(stepIndex + 1)
    else onClose()
  }
  function prev(): void {
    if (stepIndex > 0) setStepIndex(stepIndex - 1)
  }

  // Pad the spotlight slightly so a thin field reads as a clear highlight.
  const pad = 8
  const tooltipWidth = 360
  const margin = 16
  const tooltipMaxHeight = 240

  let tooltipLeft = margin
  let tooltipTop = margin
  if (rect) {
    // Horizontal: align tooltip left edge with the spotlight, but clamp
    // inside the viewport.
    tooltipLeft = Math.max(
      margin,
      Math.min(window.innerWidth - tooltipWidth - margin, rect.left - pad)
    )
    // Vertical: place below the spotlight if there's room; else above.
    const spaceBelow = window.innerHeight - rect.bottom - pad
    if (spaceBelow >= tooltipMaxHeight + margin) {
      tooltipTop = rect.bottom + pad + 8
    } else {
      tooltipTop = Math.max(margin, rect.top - pad - tooltipMaxHeight - 8)
    }
  }

  return (
    <>
      {rect && (
        <div
          className="tour-spotlight"
          style={{
            left: rect.left - pad,
            top: rect.top - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2
          }}
        />
      )}
      <div
        className="tour-tooltip"
        style={{ left: tooltipLeft, top: tooltipTop, width: tooltipWidth }}
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-title"
      >
        <div className="tour-step-counter">
          Step {stepIndex + 1} of {STEPS.length}
        </div>
        <h3 id="tour-title">{step.title}</h3>
        <div className="tour-body">{step.body}</div>
        {!rect && (
          <p className="tour-missing">
            Couldn&apos;t find this field on the page — it may have moved or
            been removed. Use Next to continue.
          </p>
        )}
        <div className="tour-actions">
          <button type="button" onClick={onClose}>
            End tour
          </button>
          <div className="tour-actions-right">
            <button
              type="button"
              onClick={prev}
              disabled={stepIndex === 0}
              title="Previous step (←)"
            >
              ← Previous
            </button>
            <button
              type="button"
              className="primary"
              onClick={next}
              title={
                stepIndex === STEPS.length - 1
                  ? 'Close the tour'
                  : 'Next step (→)'
              }
            >
              {stepIndex === STEPS.length - 1 ? 'Finish' : 'Next →'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
