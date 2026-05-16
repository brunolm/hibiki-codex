import { useEffect, useMemo, useRef, useState } from 'react'
import type { Engine, PromptTemplate, TranscribeStatus } from '../../../preload'
import type { AiExchange, TranscriptMessage } from '../App'
import { EngineIcon } from '../components/EngineIcon'
import { filterTemplates, mergeTemplates } from '../promptTemplates'
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
  onSave: () => void
  onLoad: () => void
  onClearAi: () => void
  onSubmit: (prompt: string) => void
  onCancelExchange: (id: string) => void
  needsModel: boolean
  noEngineDetected: boolean
  promptTemplates: PromptTemplate[]
  captureMicrophone: boolean
  onToggleCaptureMicrophone: () => void
}

const ENGINES: Engine[] = ['claude', 'codex']
const MIN_AI_WIDTH = 280
const MAX_AI_WIDTH = 900

const HISTORY_STORAGE_KEY = 'hibiki:chat-input-history'
const HISTORY_MAX = 50

function loadInputHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: string[] = []
    for (const x of parsed) if (typeof x === 'string') out.push(x)
    return out.slice(-HISTORY_MAX)
  } catch {
    return []
  }
}

function saveInputHistory(history: string[]): void {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history))
  } catch {
    // localStorage may be unavailable; history just won't persist.
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  const min = Math.floor(ms / 60000)
  const sec = Math.round((ms % 60000) / 1000)
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`
}

function SpeakerDivider(): JSX.Element {
  return (
    <div
      className="speaker-divider"
      role="separator"
      aria-label="Speaker change"
    >
      <span className="speaker-divider-label">⏵ speaker change</span>
    </div>
  )
}

function exchangeToMarkdown(e: AiExchange): string {
  const time = new Date(e.at).toLocaleString()
  const lines = [
    `### ${e.engine} · ${time}`,
    '',
    `**Prompt:**`,
    '',
    e.prompt,
    ''
  ]
  if (e.response !== null && e.response !== '') {
    lines.push('**Response:**', '', e.response)
  }
  if (e.error) {
    lines.push('**Error:**', '', e.error)
  }
  return lines.join('\n')
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
    onSave,
    onLoad,
    onClearAi,
    onSubmit,
    onCancelExchange,
    needsModel,
    noEngineDetected,
    promptTemplates,
    captureMicrophone,
    onToggleCaptureMicrophone
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
  const [inputHistory, setInputHistory] = useState<string[]>(() => loadInputHistory())
  const historyIndexRef = useRef<number | null>(null)
  const draftRef = useRef<string>('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const escTimerRef = useRef<number | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const copyTimerRef = useRef<number | null>(null)
  const messagesContainerRef = useRef<HTMLDivElement | null>(null)
  const [stickToBottom, setStickToBottom] = useState(true)

  const allTemplates = useMemo(
    () => mergeTemplates(promptTemplates),
    [promptTemplates]
  )
  // The palette is open when the input starts with "/" and the slash token
  // (everything before the first whitespace) is at most one word — i.e. the
  // user hasn't typed past the command name yet.
  const slashMatch = /^\/(\S*)$/.exec(input)
  const paletteOpen = slashMatch !== null
  const paletteMatches = paletteOpen
    ? filterTemplates(allTemplates, slashMatch![1] ?? '')
    : []
  const [paletteIndex, setPaletteIndex] = useState(0)
  useEffect(() => {
    if (paletteIndex >= paletteMatches.length) setPaletteIndex(0)
  }, [paletteMatches.length, paletteIndex])

  function applyTemplate(t: PromptTemplate): void {
    setInput(t.body)
    historyIndexRef.current = null
    draftRef.current = ''
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      const end = el.value.length
      el.selectionStart = end
      el.selectionEnd = end
      el.focus()
    })
  }

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
    }
  }, [])

  function flashCopied(key: string): void {
    setCopiedKey(key)
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedKey(null)
      copyTimerRef.current = null
    }, 1200)
  }

  async function copyText(text: string, key: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      flashCopied(key)
    } catch {
      // Clipboard may be blocked in some contexts; silently skip.
    }
  }

  function moveCaretToEnd(): void {
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      const end = el.value.length
      el.selectionStart = end
      el.selectionEnd = end
    })
  }

  function moveCaretToStart(): void {
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.selectionStart = 0
      el.selectionEnd = 0
      el.scrollTop = 0
    })
  }

  useEffect(() => {
    return () => {
      if (escTimerRef.current !== null) {
        window.clearTimeout(escTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!stickToBottom) return
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, stickToBottom])

  // Track whether the user has scrolled away from the bottom. Anything within
  // ~40px of the bottom counts as "stuck" so smooth-scroll jitter and 1px
  // rounding don't accidentally unstick us.
  function onMessagesScroll(): void {
    const el = messagesContainerRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const nearBottom = distance <= 40
    setStickToBottom((prev) => (prev === nearBottom ? prev : nearBottom))
  }

  function jumpToLatest(): void {
    setStickToBottom(true)
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  function submit(): void {
    const text = input.trim()
    if (!text || sendBlocked) return
    onSubmit(text)
    setInput('')
    setInputHistory((h) => {
      const last = h.length > 0 ? h[h.length - 1] : undefined
      const next = last === text ? h : [...h, text]
      const trimmed = next.length > HISTORY_MAX ? next.slice(-HISTORY_MAX) : next
      saveInputHistory(trimmed)
      return trimmed
    })
    historyIndexRef.current = null
    draftRef.current = ''
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (paletteOpen && paletteMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPaletteIndex((i) => (i + 1) % paletteMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPaletteIndex((i) =>
          i <= 0 ? paletteMatches.length - 1 : i - 1
        )
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        applyTemplate(paletteMatches[paletteIndex]!)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        applyTemplate(paletteMatches[paletteIndex]!)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setInput('')
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
      return
    }
    if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const ta = e.currentTarget
      if (
        ta.selectionStart === 0 &&
        ta.selectionEnd === 0 &&
        inputHistory.length > 0
      ) {
        e.preventDefault()
        if (historyIndexRef.current === null) {
          draftRef.current = input
          historyIndexRef.current = inputHistory.length - 1
        } else if (historyIndexRef.current > 0) {
          historyIndexRef.current -= 1
        } else {
          return
        }
        setInput(inputHistory[historyIndexRef.current] ?? '')
        moveCaretToStart()
        return
      }
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const ta = e.currentTarget
      const atEnd =
        ta.selectionStart === ta.value.length &&
        ta.selectionEnd === ta.value.length
      if (atEnd && historyIndexRef.current !== null) {
        e.preventDefault()
        const next = historyIndexRef.current + 1
        if (next >= inputHistory.length) {
          historyIndexRef.current = null
          setInput(draftRef.current)
          draftRef.current = ''
        } else {
          historyIndexRef.current = next
          setInput(inputHistory[next] ?? '')
        }
        moveCaretToEnd()
        return
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      if (escTimerRef.current !== null) {
        window.clearTimeout(escTimerRef.current)
        escTimerRef.current = null
        setInput('')
        historyIndexRef.current = null
        draftRef.current = ''
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
          <div className="pane-title">
            <h2>Live transcript</h2>
            <div className="icon-button-group" role="group" aria-label="Transcript file actions">
              <button
                type="button"
                className="icon-button"
                onClick={onLoad}
                title="Open transcript from file"
                aria-label="Open transcript"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                </svg>
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={onSave}
                disabled={messages.length === 0}
                title="Save transcript to file"
                aria-label="Save transcript"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
                  <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
                  <path d="M7 3v4a1 1 0 0 0 1 1h7" />
                </svg>
              </button>
            </div>
          </div>
          <div className="pane-actions">
            <button
              type="button"
              className={`mic-toggle${captureMicrophone ? ' active' : ''}`}
              onClick={onToggleCaptureMicrophone}
              aria-pressed={captureMicrophone}
              title={
                captureMicrophone
                  ? 'Microphone mix is on — click to stop mixing the mic in'
                  : 'Microphone mix is off — click to mix your mic into the transcript'
              }
              aria-label={
                captureMicrophone
                  ? 'Turn microphone mix off'
                  : 'Turn microphone mix on'
              }
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0" />
                <line x1="12" y1="18" x2="12" y2="22" />
                <line x1="8" y1="22" x2="16" y2="22" />
                {!captureMicrophone && <line x1="3" y1="3" x2="21" y2="21" />}
              </svg>
            </button>
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

        <div className="messages-wrap">
        <div
          className="messages"
          ref={messagesContainerRef}
          onScroll={onMessagesScroll}
        >
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
              const items: JSX.Element[] = []
              messages.forEach((m, i) => {
                const inContext = i >= cutoff
                const segments = m.text
                  .split('[SPEAKER_TURN]')
                  .map((s) => s.trim())
                segments.forEach((seg, si) => {
                  // Render a divider BEFORE every segment past the first, so
                  // the line lives in the gap above the new speaker's bubble
                  // (or above a trailing-empty slot — which then collapses to
                  // just a divider between this bubble and the next message).
                  if (si > 0) {
                    items.push(<SpeakerDivider key={`${m.id}-div-${si}`} />)
                  }
                  if (!seg) return
                  items.push(
                    <div
                      key={`${m.id}-${si}`}
                      className={
                        inContext
                          ? 'message in-context'
                          : 'message out-of-context'
                      }
                    >
                      <div className="message-time">
                        {new Date(m.at).toLocaleTimeString()}
                      </div>
                      <div className="message-text">{seg}</div>
                    </div>
                  )
                })
              })
              return items
            })()
          )}
          <div ref={messagesEndRef} />
        </div>
          {!stickToBottom && messages.length > 0 && (
            <button
              type="button"
              className="jump-to-latest"
              onClick={jumpToLatest}
              title="Auto-scroll is paused. Click to jump to the latest message."
            >
              ↓ Jump to latest
            </button>
          )}
        </div>

        <div className="composer">
          {paletteOpen && paletteMatches.length > 0 && (
            <div className="slash-palette" role="listbox" aria-label="Prompt templates">
              {paletteMatches.map((t, i) => (
                <button
                  key={t.name}
                  type="button"
                  role="option"
                  aria-selected={i === paletteIndex}
                  className={
                    i === paletteIndex
                      ? 'slash-palette-item active'
                      : 'slash-palette-item'
                  }
                  onMouseEnter={() => setPaletteIndex(i)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    applyTemplate(t)
                  }}
                  title={t.body}
                >
                  <span className="slash-palette-name">/{t.name}</span>
                  <span className="slash-palette-body">{t.body}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask the AI about what you've heard…  (Enter to send · Shift+Enter for newline · / for templates · ↑/↓ history · Esc Esc to clear)"
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
                            ? 'Claude (claude)'
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
                  {e.pending && (
                    <>
                      <span className="pending">thinking…</span>
                      <button
                        type="button"
                        className="ai-abort"
                        onClick={() => onCancelExchange(e.id)}
                        title="Abort this request"
                        aria-label="Abort this request"
                      >
                        Abort
                      </button>
                    </>
                  )}
                </header>
                <div className="ai-prompt">{e.prompt}</div>
                {e.response !== null && (
                  <div className="ai-response">{e.response}</div>
                )}
                {e.error && <div className="ai-error">{e.error}</div>}
                {!e.pending && (e.response || e.error) && (
                  <div className="ai-card-actions">
                    <button
                      type="button"
                      className="ai-copy"
                      onClick={() =>
                        void copyText(e.response ?? '', `${e.id}:text`)
                      }
                      disabled={!e.response}
                      title="Copy response as plain text"
                    >
                      {copiedKey === `${e.id}:text` ? 'copied!' : 'copy'}
                    </button>
                    <button
                      type="button"
                      className="ai-copy"
                      onClick={() =>
                        void copyText(exchangeToMarkdown(e), `${e.id}:md`)
                      }
                      title="Copy prompt + response as Markdown"
                    >
                      {copiedKey === `${e.id}:md` ? 'copied!' : 'copy md'}
                    </button>
                  </div>
                )}
              </article>
            ))
          )}
        </div>
      </aside>
    </div>
  )
}
