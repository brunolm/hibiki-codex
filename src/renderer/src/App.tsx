import { useEffect, useRef, useState } from 'react'
import type {
  DetectedEngines,
  Engine,
  Settings,
  TranscribeStatus
} from '../../preload'
import { ChatView } from './views/ChatView'
import { SettingsView } from './views/SettingsView'
import { EngineIcon } from './components/EngineIcon'
import hibikiImg from './assets/hibiki.png'

type View = 'chat' | 'settings'

export type TranscriptMessage = { id: string; text: string; at: number }
export type AiExchange = {
  id: string
  prompt: string
  response: string | null
  error: string | null
  pending: boolean
  at: number
  endedAt: number | null
  engine: Engine
}

export function App(): JSX.Element {
  const [view, setView] = useState<View>('chat')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [detectedEngines, setDetectedEngines] = useState<DetectedEngines>({
    claude: { windows: true, wsl: false },
    codex: { windows: true, wsl: false }
  })
  const [status, setStatus] = useState<TranscribeStatus>({
    running: false,
    warming: false
  })
  const [messages, setMessages] = useState<TranscriptMessage[]>([])
  const [exchanges, setExchanges] = useState<AiExchange[]>([])
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void window.api.settings.get().then(setSettings)
    void window.api.paths.detectedEngines().then(setDetectedEngines)
  }, [])

  async function recheckEngines(): Promise<void> {
    const next = await window.api.paths.recheckEngines()
    setDetectedEngines(next)
  }

  async function toggleAlwaysOnTop(): Promise<void> {
    const next = !(settings?.alwaysOnTop ?? false)
    await window.api.window.setAlwaysOnTop(next)
    if (settings) setSettings({ ...settings, alwaysOnTop: next })
  }

  // The warmup window can be near-instant on warm caches, which makes the
  // splash flicker. Hold the warming=true display for at least 3s so the
  // user actually registers the state change.
  const warmingStartedAtRef = useRef<number | null>(null)
  const warmingTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (warmingTimerRef.current !== null) {
        window.clearTimeout(warmingTimerRef.current)
      }
    }
  }, [])

  function applyStatus(next: TranscribeStatus): void {
    setStatus((prev) => {
      if (next.warming && !prev.warming) {
        warmingStartedAtRef.current = Date.now()
        if (warmingTimerRef.current !== null) {
          window.clearTimeout(warmingTimerRef.current)
          warmingTimerRef.current = null
        }
      }
      if (!next.warming && warmingStartedAtRef.current !== null) {
        const elapsed = Date.now() - warmingStartedAtRef.current
        const minMs = 3000
        if (elapsed < minMs) {
          if (warmingTimerRef.current === null) {
            warmingTimerRef.current = window.setTimeout(() => {
              warmingTimerRef.current = null
              warmingStartedAtRef.current = null
              setStatus((s) => ({ ...s, warming: false }))
            }, minMs - elapsed)
          }
          // Keep warming=true visible for now; preserve the new running flag.
          return { ...prev, running: next.running, warming: true }
        }
        warmingStartedAtRef.current = null
      }
      return next
    })
  }

  useEffect(() => {
    const offLine = window.api.transcribe.onLine((line) => {
      setMessages((m) => {
        const next = {
          id: `${line.at}-${Math.random().toString(36).slice(2, 8)}`,
          ...line
        }
        if (m.length === 0 || next.at >= m[m.length - 1]!.at) {
          return [...m, next]
        }
        const idx = m.findIndex((x) => x.at > next.at)
        return idx === -1
          ? [...m, next]
          : [...m.slice(0, idx), next, ...m.slice(idx)]
      })
    })
    const offStatus = window.api.transcribe.onStatus(applyStatus)
    const offErr = window.api.transcribe.onError((msg) => {
      setNotice(msg)
    })
    const offNotice = window.api.transcribe.onNotice((msg) => {
      setNotice(msg)
    })
    const offLog = window.api.transcribe.onAudioLog((log) => {
      if (log.level === 'error') setNotice(log.msg)
    })
    return () => {
      offLine()
      offStatus()
      offErr()
      offNotice()
      offLog()
    }
  }, [])

  async function saveSettings(next: Partial<Settings>): Promise<void> {
    const updated = await window.api.settings.save(next)
    setSettings(updated)
  }

  async function startTranscribe(): Promise<void> {
    setNotice(null)
    try {
      await window.api.transcribe.start()
    } catch (err) {
      setNotice((err as Error).message)
    }
  }

  async function stopTranscribe(): Promise<void> {
    try {
      await window.api.transcribe.stop()
    } catch (err) {
      setNotice((err as Error).message)
    }
  }

  async function clearTranscript(): Promise<void> {
    await window.api.transcribe.clear()
    setMessages([])
  }

  async function loadTranscript(): Promise<void> {
    if (
      messages.length > 0 &&
      !window.confirm('Replace the current transcript with the file contents?')
    ) {
      return
    }
    let result: { path: string; content: string } | null
    try {
      result = await window.api.transcribe.open()
    } catch (err) {
      setNotice((err as Error).message)
      return
    }
    if (!result) return
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const dayStart = today.getTime()
    const lineRe = /^\s*\[(\d{1,2}):(\d{2}):(\d{2})\]\s?(.*)$/
    const lines = result.content.split(/\r?\n/)
    const parsed: TranscriptMessage[] = []
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? ''
      if (raw.trim() === '') continue
      const m = raw.match(lineRe)
      let at: number
      let text: string
      if (m) {
        const h = Number(m[1])
        const mi = Number(m[2])
        const se = Number(m[3])
        at = dayStart + ((h * 60 + mi) * 60 + se) * 1000
        text = (m[4] ?? '').trim()
      } else {
        at = dayStart + i
        text = raw.trim()
      }
      if (text === '') continue
      parsed.push({
        id: `loaded-${i}-${Math.random().toString(36).slice(2, 8)}`,
        text,
        at
      })
    }
    await window.api.transcribe.clear()
    setMessages(parsed)
    setNotice(`Loaded ${parsed.length} message${parsed.length === 1 ? '' : 's'} from ${result.path}`)
  }

  async function saveTranscript(): Promise<void> {
    if (messages.length === 0) return
    const pad = (n: number): string => String(n).padStart(2, '0')
    const formatTime = (ms: number): string => {
      const d = new Date(ms)
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }
    const content = messages.map((m) => `[${formatTime(m.at)}] ${m.text}`).join('\r\n')
    const now = new Date()
    const stamp =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
      `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const defaultName = `transcript-${stamp}.txt`
    try {
      const path = await window.api.transcribe.save(content, defaultName)
      if (path) setNotice(`Saved transcript to ${path}`)
    } catch (err) {
      setNotice((err as Error).message)
    }
  }

  const needsExe = !settings?.whisperExe
  const needsModel = !settings?.whisperModel
  const claudeUsable = settings
    ? settings.claudeUseWsl
      ? detectedEngines.claude.wsl
      : detectedEngines.claude.windows
    : false
  const codexUsable = settings
    ? settings.codexUseWsl
      ? detectedEngines.codex.wsl
      : detectedEngines.codex.windows
    : false
  const noEngineDetected = !claudeUsable && !codexUsable
  const settingsNeedsAttention = needsExe || needsModel || noEngineDetected
  const settingsTooltip = ((): string | undefined => {
    if (!settingsNeedsAttention) return undefined
    const missing: string[] = []
    if (needsExe) missing.push('Whisper executable')
    if (needsModel) missing.push('Whisper model')
    if (noEngineDetected) missing.push('an AI engine (Claude or Codex)')
    return `Configure ${missing.join(', ')} in Settings.`
  })()

  async function submitPrompt(prompt: string): Promise<void> {
    const engines: Engine[] =
      settings?.aiEngines && settings.aiEngines.length > 0
        ? settings.aiEngines
        : ['claude']
    const n = Math.max(0, settings?.transcriptContextMessages ?? 50)
    const transcriptContext = messages
      .slice(-n)
      .map((m) => m.text)
      .join(' ')
    const stamp = Date.now()
    const newExchanges: AiExchange[] = engines.map((engine, i) => ({
      id: `${stamp}-${engine}-${Math.random().toString(36).slice(2, 8)}`,
      prompt,
      response: null,
      error: null,
      pending: true,
      at: stamp + i,
      endedAt: null,
      engine
    }))
    setExchanges((x) => [...newExchanges.slice().reverse(), ...x])

    await Promise.all(
      newExchanges.map(async (ex) => {
        try {
          const response = await window.api.ai.ask(
            ex.id,
            ex.engine,
            prompt,
            transcriptContext
          )
          const endedAt = Date.now()
          setExchanges((xs) =>
            xs.map((e) =>
              e.id === ex.id ? { ...e, response, pending: false, endedAt } : e
            )
          )
        } catch (err) {
          const endedAt = Date.now()
          setExchanges((xs) =>
            xs.map((e) =>
              e.id === ex.id
                ? {
                    ...e,
                    error: (err as Error).message,
                    pending: false,
                    endedAt
                  }
                : e
            )
          )
        }
      })
    )
  }

  function cancelExchange(id: string): void {
    void window.api.ai.cancel(id)
    setExchanges((xs) => xs.filter((e) => e.id !== id))
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src={hibikiImg} alt="" className="brand-avatar" />
          <span>Hibiki Codex</span>
        </div>
        <nav className="tabs">
          <button
            className={view === 'chat' ? 'tab active' : 'tab'}
            onClick={() => setView('chat')}
          >
            Chat
          </button>
          <button
            className={`${view === 'settings' ? 'tab active' : 'tab'}${
              settingsNeedsAttention ? ' needs-attention' : ''
            }`}
            onClick={() => setView('settings')}
            title={settingsTooltip}
          >
            Settings
          </button>
        </nav>
        <div className="status">
          {status.running ? (
            <>
              <span className="dot dot-on" />
              <span>{status.warming ? 'warming…' : 'capturing'}</span>
            </>
          ) : (
            <>
              <span className="dot dot-off" />
              <span>idle</span>
            </>
          )}
          {settings && (
            <span className="engine">
              {settings.aiEngines.map((e) => (
                <EngineIcon key={e} engine={e} size={14} />
              ))}
              <span>· {settings.whisperLanguage}</span>
            </span>
          )}
          <button
            type="button"
            className={`pin-toggle${settings?.alwaysOnTop ? ' active' : ''}`}
            onClick={() => void toggleAlwaysOnTop()}
            aria-pressed={settings?.alwaysOnTop ?? false}
            title={
              settings?.alwaysOnTop
                ? 'Unpin: stop floating above other windows'
                : 'Pin on top: keep this window above other windows'
            }
            aria-label="Pin window on top"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill={settings?.alwaysOnTop ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 17v5" />
              <path d="M9 10.76V4h6v6.76a2 2 0 0 0 .553 1.382l1.235 1.298A2 2 0 0 1 17.382 17H6.618a2 2 0 0 1-1.406-3.56l1.235-1.298A2 2 0 0 0 7 10.76" />
            </svg>
          </button>
        </div>
      </header>

      {notice && (
        <div className="notice" onClick={() => setNotice(null)}>
          {notice} <span className="dim">(click to dismiss)</span>
        </div>
      )}

      {view === 'chat' ? (
        <ChatView
          messages={messages}
          exchanges={exchanges}
          status={status}
          engines={
            settings?.aiEngines && settings.aiEngines.length > 0
              ? settings.aiEngines
              : ['claude']
          }
          onEnginesChange={(next) => void saveSettings({ aiEngines: next })}
          aiPaneWidth={settings?.aiPaneWidth ?? 480}
          onAiPaneWidthChange={(w) => void saveSettings({ aiPaneWidth: w })}
          contextMessageCount={settings?.transcriptContextMessages ?? 50}
          onContextMessageCountChange={(n) =>
            void saveSettings({ transcriptContextMessages: n })
          }
          onStart={startTranscribe}
          onStop={stopTranscribe}
          onClear={clearTranscript}
          onSave={saveTranscript}
          onLoad={loadTranscript}
          onClearAi={() => setExchanges([])}
          onSubmit={submitPrompt}
          onCancelExchange={cancelExchange}
          needsModel={needsModel}
          noEngineDetected={noEngineDetected}
          promptTemplates={settings?.promptTemplates ?? []}
        />
      ) : settings ? (
        <SettingsView
          settings={settings}
          onSave={saveSettings}
          detectedEngines={detectedEngines}
          onRecheckEngines={recheckEngines}
        />
      ) : (
        <div className="loading">loading settings…</div>
      )}
    </div>
  )
}
