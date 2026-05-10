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
          onClearAi={() => setExchanges([])}
          onSubmit={submitPrompt}
          needsModel={needsModel}
          noEngineDetected={noEngineDetected}
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
