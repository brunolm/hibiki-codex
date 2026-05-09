import { useState } from 'react'
import type { Settings } from '../../../preload'
import { EngineIcon } from '../components/EngineIcon'

type Props = {
  settings: Settings
  onSave: (next: Partial<Settings>) => Promise<void>
}

type Tab = 'whisper' | 'claude' | 'codex'

export function SettingsView({ settings, onSave }: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('whisper')
  const [draft, setDraft] = useState<Settings>(settings)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  function set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  async function pick(
    key: 'whisperExe' | 'whisperModel' | 'whisperVadModel',
    title: string,
    filters: { name: string; extensions: string[] }[]
  ): Promise<void> {
    const picked = await window.api.dialog.pickFile({ title, filters })
    if (picked) set(key, picked)
  }

  async function save(): Promise<void> {
    setSaving(true)
    try {
      await onSave(draft)
      setSavedAt(Date.now())
    } finally {
      setSaving(false)
    }
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)

  return (
    <div className="settings">
      <div className="settings-inner">
        <nav className="settings-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'whisper'}
            className={tab === 'whisper' ? 'active' : ''}
            onClick={() => setTab('whisper')}
          >
            Whisper
          </button>
          <button
            role="tab"
            aria-selected={tab === 'claude'}
            className={tab === 'claude' ? 'active' : ''}
            onClick={() => setTab('claude')}
          >
            <EngineIcon engine="claude" size={13} />
            Claude
          </button>
          <button
            role="tab"
            aria-selected={tab === 'codex'}
            className={tab === 'codex' ? 'active' : ''}
            onClick={() => setTab('codex')}
          >
            <EngineIcon engine="codex" size={13} />
            Codex
          </button>
        </nav>

        {tab === 'whisper' && (
          <section className="settings-section">
            <label>
              <span>Whisper executable</span>
              <div className="row">
                <input
                  value={draft.whisperExe}
                  onChange={(e) => set('whisperExe', e.target.value)}
                  placeholder="C:\System\whisper\whisper-cli.exe"
                />
                <button
                  onClick={() =>
                    pick('whisperExe', 'Pick whisper-cli.exe', [
                      { name: 'Executable', extensions: ['exe'] }
                    ])
                  }
                >
                  Browse
                </button>
              </div>
            </label>

            <label>
              <span>Whisper model</span>
              <div className="row">
                <input
                  value={draft.whisperModel}
                  onChange={(e) => set('whisperModel', e.target.value)}
                  placeholder="C:\System\whisper\ggml-large-v3-turbo-q8_0.bin"
                />
                <button
                  onClick={() =>
                    pick('whisperModel', 'Pick a Whisper model', [
                      { name: 'GGML model', extensions: ['bin'] }
                    ])
                  }
                >
                  Browse
                </button>
              </div>
            </label>

            <label>
              <span>VAD model (optional)</span>
              <div className="row">
                <input
                  value={draft.whisperVadModel}
                  onChange={(e) => set('whisperVadModel', e.target.value)}
                  placeholder="C:\System\whisper\ggml-silero-v5.1.2.bin"
                />
                <button
                  onClick={() =>
                    pick('whisperVadModel', 'Pick a VAD model', [
                      { name: 'GGML model', extensions: ['bin'] }
                    ])
                  }
                >
                  Browse
                </button>
              </div>
            </label>

            <label>
              <span>Language</span>
              <select
                value={draft.whisperLanguage}
                onChange={(e) =>
                  set(
                    'whisperLanguage',
                    e.target.value as Settings['whisperLanguage']
                  )
                }
              >
                <option value="ja">Japanese (ja)</option>
                <option value="en">English (en)</option>
              </select>
            </label>

            <div className="grid">
              <label>
                <span>Whisper threads</span>
                <input
                  type="number"
                  min={1}
                  max={32}
                  value={draft.whisperThreads}
                  onChange={(e) => set('whisperThreads', Number(e.target.value))}
                />
              </label>

              <label>
                <span>Transcribe interval (s)</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={draft.transcribeIntervalSeconds}
                  onChange={(e) =>
                    set('transcribeIntervalSeconds', Number(e.target.value))
                  }
                />
              </label>

              <label>
                <span>Audio buffer (s)</span>
                <input
                  type="number"
                  min={30}
                  max={1800}
                  value={draft.audioBufferSeconds}
                  onChange={(e) =>
                    set('audioBufferSeconds', Number(e.target.value))
                  }
                />
              </label>
            </div>
          </section>
        )}

        {tab === 'claude' && (
          <section className="settings-section">
            <p className="hint">
              Empty fields fall back to your <code>~/.claude/settings.json</code>{' '}
              defaults.
            </p>

            <label>
              <span>Model</span>
              <input
                value={draft.claudeModel}
                onChange={(e) => set('claudeModel', e.target.value)}
                placeholder="opus  ·  sonnet  ·  haiku  ·  or a model id"
              />
              <small>Passed as <code>--model &lt;value&gt;</code>.</small>
            </label>

            <label>
              <span>Effort</span>
              <select
                value={draft.claudeEffort}
                onChange={(e) => set('claudeEffort', e.target.value)}
              >
                <option value="">(use settings.json default)</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
              </select>
              <small>
                Passed as <code>--effort &lt;value&gt;</code>. Lower = faster &amp;
                cheaper; higher = deeper thinking.
              </small>
            </label>
          </section>
        )}

        {tab === 'codex' && (
          <section className="settings-section">
            <p className="hint">
              Empty fields fall back to your <code>~/.codex/config.toml</code>{' '}
              defaults.
            </p>

            <label>
              <span>Model</span>
              <input
                value={draft.codexModel}
                onChange={(e) => set('codexModel', e.target.value)}
                placeholder="gpt-5  ·  o3  ·  or a model id"
              />
              <small>Passed as <code>--model &lt;value&gt;</code>.</small>
            </label>
          </section>
        )}

        <div className="actions">
          <button className="primary" onClick={save} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {savedAt && !dirty && (
            <span className="saved">
              saved {new Date(savedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
