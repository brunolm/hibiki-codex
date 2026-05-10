import { useEffect, useRef, useState } from 'react'
import type { Engine, TranscribeStatus } from '../../../preload'
import type { AiExchange, TranscriptMessage } from '../App'
import { EngineIcon } from '../components/EngineIcon'
import hibikiImg from '../assets/hibiki.png'
import warmupImg from '../assets/warmup.png'

type Props = {
  messages: TranscriptMessage[]
  exchanges: AiExchange[]
  status: TranscribeStatus
  engines: Engine[]
  onEnginesChange: (engines: Engine[]) => void
  aiPaneWidth: number
  onAiPaneWidthChange: (width: number) => void
  contextMessageCount: number
  onContextMessageCountChange: (n: number) => void
  onStart: () => void
  onStop: () => void
  onClear: () => void
  onClearAi: () => void
  onSubmit: (prompt: string) => void
  needsModel: boolean
  noEngineDetected: boolean
}

const ENGINES: Engine[] = ['claude', 'codex']
const MIN_AI_WIDTH = 280
const MAX_AI_WIDTH = 900

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  const min = Math.floor(ms / 60000)
  const sec = Math.round((ms % 60000) / 1000)
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`
}

export function ChatView(props: Props): JSX.Element {
  const {
    messages,
    exchanges,
    status,
    engines,
    onEnginesChange,
    aiPaneWidth,
    onAiPaneWidthChange,
    contextMessageCount,
    onContextMessageCountChange,
    onStart,
    onStop,
    onClear,
    onClearAi,
    onSubmit,
    needsModel,
    noEngineDetected
  } = props

  const sendBlocked = needsModel || noEngineDetected
  const sendBlockedReason =
    needsModel && noEngineDetected
      ? 'Set a Whisper model and install Claude or Codex CLI first.'
      : needsModel
        ? 'Set a Whisper model in Settings first.'
        : noEngineDetected
          ? 'Neither Claude nor Codex CLI is on PATH. Install one to enable AI requests.'
          : undefined

  const [width, setWidth] = useState(aiPaneWidth)
  const [dragging, setDragging] = useState(false)
  const layoutRef = useRef<HTMLDivElement | null>(null)
  const widthRef = useRef(width)
  widthRef.current = width

  useEffect(() => {
    if (!dragging) setWidth(aiPaneWidth)
  }, [aiPaneWidth, dragging])

  useEffect(() => {
    if (!dragging) return
    function onMove(e: MouseEvent): void {
      const el = layoutRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const next = Math.max(
        MIN_AI_WIDTH,
        Math.min(MAX_AI_WIDTH, rect.right - e.clientX)
      )
      setWidth(next)
    }
    function onUp(): void {
      setDragging(false)
      onAiPaneWidthChange(widthRef.current)
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, onAiPaneWidthChange])

  function toggleEngine(e: Engine): void {
    if (engines.includes(e)) {
      if (engines.length === 1) return // keep at least one selected
      onEnginesChange(engines.filter((x) => x !== e))
    } else {
      onEnginesChange(ENGINES.filter((x) => engines.includes(x) || x === e))
    }
  }
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const escTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (escTimerRef.current !== null) {
        window.clearTimeout(escTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  function submit(): void {
    const text = input.trim()
    if (!text || sendBlocked) return
    onSubmit(text)
    setInput('')
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      if (escTimerRef.current !== null) {
        window.clearTimeout(escTimerRef.current)
        escTimerRef.current = null
        setInput('')
      } else {
        escTimerRef.current = window.setTimeout(() => {
          escTimerRef.current = null
        }, 600)
      }
    }
  }

  return (
    <div
      className="chat-layout"
      ref={layoutRef}
      style={{ gridTemplateColumns: `minmax(0, 1fr) 6px ${width}px` }}
    >
      <section className="chat-pane">
        <div className="pane-header">
          <h2>Live transcript</h2>
          <div className="pane-actions">
            {status.running ? (
              <button onClick={onStop}>Stop</button>
            ) : (
              <button className="primary" onClick={onStart}>
                Start
              </button>
            )}
            <button onClick={onClear} disabled={messages.length === 0}>
              Clear
            </button>
          </div>
        </div>

        <div className="messages">
          {messages.length === 0 ? (
            status.warming ? (
              <div className="empty warmup-empty">
                <img
                  src={warmupImg}
                  alt="Warming up the transcription model…"
                  className="warmup-image"
                />
                <p className="warmup-caption">warming up…</p>
              </div>
            ) : (
              <div className="empty">
                {status.running
                  ? 'Listening… start playing audio.'
                  : 'Press Start to begin transcription.'}
              </div>
            )
          ) : (
            (() => {
              const cutoff = Math.max(0, messages.length - contextMessageCount)
              return messages.map((m, i) => {
                const inContext = i >= cutoff
                return (
                  <div
                    key={m.id}
                    className={
                      inContext ? 'message in-context' : 'message out-of-context'
                    }
                  >
                    <div className="message-time">
                      {new Date(m.at).toLocaleTimeString()}
                    </div>
                    <div className="message-text">{m.text}</div>
                  </div>
                )
              })
            })()
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask the AI about what you've heard…  (Enter to send · Shift+Enter for newline · Esc Esc to clear)"
            rows={3}
          />
          <div className="composer-controls">
            <div className="composer-controls-left">
              <div className="engine-picker" role="group" aria-label="AI engines">
                {ENGINES.map((e) => {
                  const selected = engines.includes(e)
                  const onlyOne = selected && engines.length === 1
                  return (
                    <button
                      key={e}
                      type="button"
                      aria-pressed={selected}
                      className={selected ? 'active' : ''}
                      onClick={() => toggleEngine(e)}
                      title={
                        onlyOne
                          ? `${e} (at least one engine must stay selected)`
                          : e === 'claude'
                            ? 'Claude (claude -p)'
                            : 'Codex (codex exec)'
                      }
                    >
                      <EngineIcon engine={e} size={14} />
                      <span>{e}</span>
                    </button>
                  )
                })}
              </div>
              <label
                className="context-selector"
                title="Latest N transcript messages sent as context (and highlighted in chat)"
              >
                <span>context</span>
                <input
                  type="number"
                  min={0}
                  max={500}
                  value={contextMessageCount}
                  onChange={(e) =>
                    onContextMessageCountChange(
                      Math.max(
                        0,
                        Math.min(500, Number(e.target.value) || 0)
                      )
                    )
                  }
                />
              </label>
            </div>
            <button
              className="primary"
              onClick={submit}
              disabled={sendBlocked || !input.trim()}
              title={sendBlockedReason}
            >
              Send
            </button>
          </div>
        </div>
      </section>

      <div
        className={dragging ? 'splitter dragging' : 'splitter'}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize AI panel"
        onMouseDown={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDoubleClick={() => {
          setWidth(480)
          onAiPaneWidthChange(480)
        }}
        title="Drag to resize · double-click to reset"
      />

      <aside className="ai-pane">
        <div className="pane-header">
          <h2>AI responses</h2>
          <div className="pane-actions">
            <button onClick={onClearAi} disabled={exchanges.length === 0}>
              Clear
            </button>
          </div>
        </div>
        <div className="ai-list">
          {exchanges.length === 0 ? (
            <div className="empty hibiki-empty">
              <img src={hibikiImg} alt="Hibiki" className="hibiki-mascot" />
              <p className="hibiki-tagline">
                Ask me about what you've heard.
              </p>
            </div>
          ) : (
            exchanges.map((e) => (
              <article key={e.id} className="ai-card">
                <header>
                  <span className="ai-engine">
                    <EngineIcon engine={e.engine} size={14} title={e.engine} />
                    <span>{e.engine}</span>
                  </span>
                  <span className="ai-time">
                    {new Date(e.at).toLocaleTimeString()}
                    {e.endedAt !== null && (
                      <span className="ai-duration" title="Time taken to answer">
                        {' · '}
                        {formatDuration(e.endedAt - e.at)}
                      </span>
                    )}
                  </span>
                  {e.pending && <span className="pending">thinking…</span>}
                </header>
                <div className="ai-prompt">{e.prompt}</div>
                {e.response !== null && (
                  <div className="ai-response">{e.response}</div>
                )}
                {e.error && <div className="ai-error">{e.error}</div>}
              </article>
            ))
          )}
        </div>
      </aside>
    </div>
  )
}
