import { useEffect, useState } from 'react'
import type { Engine, Settings, TranscribeStatus } from '../../preload'
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
  engine: Engine
}

export function App(): JSX.Element {
  const [view, setView] = useState<View>('chat')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [status, setStatus] = useState<TranscribeStatus>({
    running: false,
    warming: false
  })
  const [messages, setMessages] = useState<TranscriptMessage[]>([])
  const [exchanges, setExchanges] = useState<AiExchange[]>([])
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void window.api.settings.get().then(setSettings)
  }, [])

  useEffect(() => {
    const offLine = window.api.transcribe.onLine((line) => {
      setMessages((m) => [
        ...m,
        { id: `${line.at}-${Math.random().toString(36).slice(2, 8)}`, ...line }
      ])
    })
    const offStatus = window.api.transcribe.onStatus(setStatus)
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
          setExchanges((xs) =>
            xs.map((e) =>
              e.id === ex.id ? { ...e, response, pending: false } : e
            )
          )
        } catch (err) {
          setExchanges((xs) =>
            xs.map((e) =>
              e.id === ex.id
                ? { ...e, error: (err as Error).message, pending: false }
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
            className={view === 'settings' ? 'tab active' : 'tab'}
            onClick={() => setView('settings')}
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
        />
      ) : settings ? (
        <SettingsView settings={settings} onSave={saveSettings} />
      ) : (
        <div className="loading">loading settings…</div>
      )}
    </div>
  )
}
