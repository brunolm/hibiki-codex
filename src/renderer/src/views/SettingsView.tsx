import { useEffect, useState } from 'react'
import type { DetectedEngines, Settings } from '../../../preload'
import { EngineIcon } from '../components/EngineIcon'
import { ClaudeInstallPanel } from '../components/ClaudeInstallPanel'
import { ModelDownloadModal } from '../components/ModelDownloadModal'
import { WhisperRuntimeDownloadModal } from '../components/WhisperRuntimeDownloadModal'

type Props = {
  settings: Settings
  onSave: (next: Partial<Settings>) => Promise<void>
  detectedEngines: DetectedEngines | null
  onRecheckEngines: () => Promise<void> | void
}

type Tab = 'whisper' | 'claude' | 'codex'

// Which Settings keys each tab owns — used by per-tab Reset to scope itself
// to only the fields visible in the active tab.
const TAB_FIELDS: Record<Tab, (keyof Settings)[]> = {
  whisper: [
    'whisperExe',
    'whisperModel',
    'whisperVadModel',
    'whisperLanguage',
    'whisperThreads',
    'transcribeIntervalSeconds',
    'audioBufferSeconds'
  ],
  claude: ['claudeUseWsl', 'claudeModel', 'claudeEffort'],
  codex: ['codexUseWsl', 'codexModel']
}

// Mirrors the defaults in src/main/settings.ts. Keep these two in sync — the
// Reset button reads from here, the main process initialises new installs
// from there. They have to agree.
const DEFAULTS: Settings = {
  whisperExe: '',
  whisperModel: '',
  whisperVadModel: '',
  whisperLanguage: 'ja',
  whisperThreads: 4,
  transcribeIntervalSeconds: 12,
  audioBufferSeconds: 300,
  aiEngines: ['claude'],
  claudeModel: '',
  claudeEffort: '',
  codexModel: '',
  claudeUseWsl: false,
  codexUseWsl: false,
  wslDetectionDone: false,
  aiPaneWidth: 480,
  transcriptContextMessages: 50
}

function copyTabFields(from: Settings, into: Settings, t: Tab): Settings {
  const out = { ...into } as Record<string, unknown>
  const src = from as Record<string, unknown>
  for (const k of TAB_FIELDS[t]) out[k] = src[k]
  return out as Settings
}

function tabDiffers(a: Settings, b: Settings, t: Tab): boolean {
  const av = a as Record<string, unknown>
  const bv = b as Record<string, unknown>
  for (const k of TAB_FIELDS[t]) if (av[k] !== bv[k]) return true
  return false
}

export function SettingsView({
  settings,
  onSave,
  detectedEngines,
  onRecheckEngines
}: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('whisper')
  const [draft, setDraft] = useState<Settings>(settings)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [confirmResetTab, setConfirmResetTab] = useState<Tab | null>(null)
  const [bundledVad, setBundledVad] = useState<string | null>(null)
  const [showModelModal, setShowModelModal] = useState(false)
  const [showRuntimeModal, setShowRuntimeModal] = useState(false)

  useEffect(() => {
    void window.api.paths.bundledWhisperVad().then(setBundledVad)
  }, [])

  const claudeDet = detectedEngines?.claude ?? { windows: true, wsl: false }
  const codexDet = detectedEngines?.codex ?? { windows: true, wsl: false }
  const claudeUsable = draft.claudeUseWsl ? claudeDet.wsl : claudeDet.windows
  const codexUsable = draft.codexUseWsl ? codexDet.wsl : codexDet.windows
  const noEngineDetected =
    detectedEngines !== null && !claudeUsable && !codexUsable

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

  function cancelAll(): void {
    setDraft(settings)
  }
  function resetTab(t: Tab): void {
    setDraft((d) => copyTabFields(DEFAULTS, d, t))
  }

  const canResetCurrentTab = tabDiffers(draft, DEFAULTS, tab)

  const tabLabels: Record<Tab, string> = {
    whisper: 'Whisper',
    claude: 'Claude',
    codex: 'Codex'
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)

  return (
    <>
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
              className={`${tab === 'claude' ? 'active' : ''}${
                noEngineDetected && !claudeUsable ? ' needs-attention' : ''
              }`}
              onClick={() => setTab('claude')}
              title={
                !claudeUsable
                  ? `Claude CLI not detected on ${draft.claudeUseWsl ? 'WSL' : 'PATH'}.`
                  : undefined
              }
            >
              <EngineIcon engine="claude" size={13} />
              Claude
            </button>
            <button
              role="tab"
              aria-selected={tab === 'codex'}
              className={`${tab === 'codex' ? 'active' : ''}${
                noEngineDetected && !codexUsable ? ' needs-attention' : ''
              }`}
              onClick={() => setTab('codex')}
              title={
                !codexUsable
                  ? `Codex CLI not detected on ${draft.codexUseWsl ? 'WSL' : 'PATH'}.`
                  : undefined
              }
            >
              <EngineIcon engine="codex" size={13} />
              Codex
            </button>
          </nav>

          {tab === 'whisper' && (
            <section className="settings-section">
              <label>
                <span>
                  Whisper executable
                  {!draft.whisperExe && (
                    <span className="required-tag">required</span>
                  )}
                </span>
                <div className="row">
                  <input
                    className={!draft.whisperExe ? 'required-empty' : ''}
                    value={draft.whisperExe}
                    onChange={(e) => set('whisperExe', e.target.value)}
                    placeholder="C:\path\to\whisper-cli.exe"
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
                  <button onClick={() => setShowRuntimeModal(true)}>
                    Download…
                  </button>
                </div>
                <small className={!draft.whisperExe ? 'required' : ''}>
                  Point at an existing <code>whisper-cli.exe</code>, or download
                  one (CPU / CUDA variants).
                </small>
              </label>

              <label>
                <span>
                  Whisper model
                  {!draft.whisperModel && (
                    <span className="required-tag">required</span>
                  )}
                </span>
                <div className="row">
                  <input
                    className={!draft.whisperModel ? 'required-empty' : ''}
                    value={draft.whisperModel}
                    onChange={(e) => set('whisperModel', e.target.value)}
                    placeholder="C:\path\to\ggml-<model>.bin"
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
                  <button onClick={() => setShowModelModal(true)}>
                    Download…
                  </button>
                </div>
                <small className={!draft.whisperModel ? 'required' : ''}>
                  Pick an existing <code>.bin</code> on disk, or download one
                  from the curated list.
                </small>
              </label>

              <label>
                <span>VAD model (optional)</span>
                <div className="row">
                  <input
                    value={draft.whisperVadModel}
                    onChange={(e) => set('whisperVadModel', e.target.value)}
                    placeholder={
                      bundledVad
                        ? `(bundled) ${bundledVad}`
                        : '(none bundled — optional)'
                    }
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
                <small>Leave empty to use the bundled Silero VAD model.</small>
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
                  <span>
                    Whisper threads
                    <span
                      className="help-icon"
                      role="img"
                      aria-label="help"
                      title="How much of your CPU to use when transcribing. Higher = faster transcription, but uses more of your computer's power. 4 works well on most machines. If your computer feels slow while transcribing, try lowering this."
                    >
                      ?
                    </span>
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={32}
                    value={draft.whisperThreads}
                    onChange={(e) =>
                      set('whisperThreads', Number(e.target.value))
                    }
                  />
                </label>

                <label>
                  <span>
                    Transcribe interval (s)
                    <span
                      className="help-icon"
                      role="img"
                      aria-label="help"
                      title="How often new text appears in the transcript, in seconds. A lower number means lines show up sooner, but your computer has to work more often. Try 2–4 seconds for snappier transcription; higher numbers reduce CPU load."
                    >
                      ?
                    </span>
                  </span>
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
                  <span>
                    Audio buffer (s)
                    <span
                      className="help-icon"
                      role="img"
                      aria-label="help"
                      title="How many seconds of recent audio to keep on hand. If transcription falls behind for a moment, the app uses this to catch up. Larger = safer for long sessions, but uses a bit more memory. 300 seconds (5 minutes) is plenty for most uses."
                    >
                      ?
                    </span>
                  </span>
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
              <DetectionRow
                detection={claudeDet}
                useWsl={draft.claudeUseWsl}
                onToggleWsl={(v) => set('claudeUseWsl', v)}
              />
              {detectedEngines !== null && !claudeUsable && (
                <ClaudeInstallPanel
                  useWsl={draft.claudeUseWsl}
                  onInstalled={() => void onRecheckEngines()}
                />
              )}
              <p className="hint">
                Empty fields fall back to your{' '}
                <code>~/.claude/settings.json</code> defaults.
              </p>

              <label>
                <span>Model</span>
                <input
                  value={draft.claudeModel}
                  onChange={(e) => set('claudeModel', e.target.value)}
                  placeholder="opus  ·  sonnet  ·  haiku  ·  or a model id"
                />
                <small>
                  Passed as <code>--model &lt;value&gt;</code>.
                </small>
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
                  Passed as <code>--effort &lt;value&gt;</code>. Lower = faster
                  &amp; cheaper; higher = deeper thinking.
                </small>
              </label>
            </section>
          )}

          {tab === 'codex' && (
            <section className="settings-section">
              <DetectionRow
                detection={codexDet}
                useWsl={draft.codexUseWsl}
                onToggleWsl={(v) => set('codexUseWsl', v)}
              />
              {detectedEngines !== null && !codexUsable && (
                <p className="hint warn">
                  The <code>codex</code> CLI was not found on{' '}
                  {draft.codexUseWsl ? 'WSL' : 'PATH'}. Install the OpenAI Codex
                  CLI to enable this engine.
                </p>
              )}
              <p className="hint">
                Empty fields fall back to your{' '}
                <code>~/.codex/config.toml</code> defaults.
              </p>

              <label>
                <span>Model</span>
                <input
                  value={draft.codexModel}
                  onChange={(e) => set('codexModel', e.target.value)}
                  placeholder="gpt-5  ·  o3  ·  or a model id"
                />
                <small>
                  Passed as <code>--model &lt;value&gt;</code>.
                </small>
              </label>
            </section>
          )}

          <div className="actions">
            <div className="actions-left">
              <button
                className="primary"
                onClick={save}
                disabled={!dirty || saving}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={cancelAll}
                disabled={!dirty || saving}
                title="Discard all unsaved changes across every tab."
              >
                Cancel
              </button>
              {savedAt && !dirty && (
                <span className="saved">
                  saved {new Date(savedAt).toLocaleTimeString()}
                </span>
              )}
            </div>
            <div className="actions-right">
              <button
                className="danger"
                onClick={() => setConfirmResetTab(tab)}
                disabled={!canResetCurrentTab}
                title={`Reset the ${tabLabels[tab]} tab's fields to their default values.`}
              >
                Reset to defaults
              </button>
            </div>
          </div>
        </div>
      </div>
      {showModelModal && (
        <ModelDownloadModal
          onClose={() => setShowModelModal(false)}
          onDownloaded={(path) => {
            set('whisperModel', path)
            void onSave({ whisperModel: path })
          }}
        />
      )}
      {showRuntimeModal && (
        <WhisperRuntimeDownloadModal
          onClose={() => setShowRuntimeModal(false)}
          onInstalled={(exePath) => {
            set('whisperExe', exePath)
            void onSave({ whisperExe: exePath })
          }}
        />
      )}
      {confirmResetTab && (
        <div
          className="modal-overlay"
          onClick={() => setConfirmResetTab(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="reset-confirm-title"
        >
          <div
            className="modal confirm-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="reset-confirm-title">Reset to defaults?</h2>
              <button
                className="modal-close"
                onClick={() => setConfirmResetTab(null)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <p>
                This will reset all{' '}
                <strong>{tabLabels[confirmResetTab]}</strong> settings to their
                default values. Other tabs are not affected.
              </p>
              <p>
                You&apos;ll still need to click <strong>Save</strong> to keep
                the change.
              </p>
            </div>
            <div className="modal-actions">
              <button onClick={() => setConfirmResetTab(null)}>Cancel</button>
              <button
                className="danger solid"
                onClick={() => {
                  resetTab(confirmResetTab)
                  setConfirmResetTab(null)
                }}
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function DetectionRow({
  detection,
  useWsl,
  onToggleWsl
}: {
  detection: { windows: boolean; wsl: boolean }
  useWsl: boolean
  onToggleWsl: (v: boolean) => void
}): JSX.Element {
  const tag = (label: string, found: boolean): JSX.Element => (
    <span className={`detect-tag ${found ? 'ok' : 'off'}`}>
      {found ? '✓' : '·'} {label}
    </span>
  )
  return (
    <div className="detection-row">
      <div className="detection-tags">
        {tag('Windows', detection.windows)}
        {tag('WSL', detection.wsl)}
      </div>
      <label className="detection-wsl-toggle">
        <input
          type="checkbox"
          checked={useWsl}
          onChange={(e) => onToggleWsl(e.target.checked)}
        />
        <span>Use WSL</span>
      </label>
    </div>
  )
}
