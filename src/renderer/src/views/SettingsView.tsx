import { useEffect, useState } from 'react'
import type { DetectedEngines, PromptTemplate, Settings } from '../../../preload'
import { EngineIcon } from '../components/EngineIcon'
import { ClaudeInstallPanel } from '../components/ClaudeInstallPanel'
import { ModelDownloadModal } from '../components/ModelDownloadModal'
import { WhisperRuntimeDownloadModal } from '../components/WhisperRuntimeDownloadModal'
import { BUILT_IN_TEMPLATES } from '../promptTemplates'

type Props = {
  settings: Settings
  onSave: (next: Partial<Settings>) => Promise<void>
  detectedEngines: DetectedEngines | null
  onRecheckEngines: () => Promise<void> | void
}

type Tab = 'general' | 'whisper' | 'claude' | 'codex' | 'templates'

// Which Settings keys each tab owns — used by per-tab Reset to scope itself
// to only the fields visible in the active tab.
const TAB_FIELDS: Record<Tab, (keyof Settings)[]> = {
  general: ['requestTimeoutSeconds'],
  whisper: [
    'whisperExe',
    'whisperModel',
    'whisperVadModel',
    'whisperLanguage',
    'whisperThreads',
    'transcribeMaxLanes',
    'transcribeIntervalSeconds',
    'audioBufferSeconds',
    'captureMicrophone',
    'captureProcessName',
    'captureProcessMode',
    'whisperDiarize',
    'whisperDiarizeModel'
  ],
  claude: ['claudeUseWsl', 'claudeUsePrintMode', 'claudeModel', 'claudeEffort'],
  codex: ['codexUseWsl', 'codexDangerouslyBypass', 'codexModel'],
  templates: ['promptTemplates']
}

// Mirrors the defaults in src/main/settings.ts. Keep these two in sync — the
// Reset button reads from here, the main process initialises new installs
// from there. They have to agree.
const DEFAULTS: Settings = {
  whisperExe: '',
  whisperModel: '',
  whisperVadModel: '',
  whisperLanguage: 'auto',
  whisperThreads: 4,
  transcribeMaxLanes: 2,
  transcribeIntervalSeconds: 12,
  audioBufferSeconds: 300,
  captureMicrophone: false,
  captureProcessName: '',
  captureProcessMode: 'include',
  whisperDiarize: false,
  whisperDiarizeModel: '',
  aiEngines: ['claude'],
  claudeModel: '',
  claudeEffort: '',
  codexModel: '',
  claudeUseWsl: false,
  codexUseWsl: false,
  claudeUsePrintMode: false,
  codexDangerouslyBypass: false,
  wslDetectionDone: false,
  aiPaneWidth: 480,
  transcriptContextMessages: 50,
  windowBounds: null,
  windowMaximized: false,
  alwaysOnTop: false,
  requestTimeoutSeconds: 300,
  promptTemplates: []
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
  const [tab, setTab] = useState<Tab>('general')
  const [draft, setDraft] = useState<Settings>(settings)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [confirmResetTab, setConfirmResetTab] = useState<Tab | null>(null)
  const [bundledVad, setBundledVad] = useState<string | null>(null)
  const [showModelModal, setShowModelModal] = useState(false)
  const [showRuntimeModal, setShowRuntimeModal] = useState(false)
  const [showDiarizeModelModal, setShowDiarizeModelModal] = useState(false)

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
    key:
      | 'whisperExe'
      | 'whisperModel'
      | 'whisperVadModel'
      | 'whisperDiarizeModel',
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
    general: 'General',
    whisper: 'Whisper',
    claude: 'Claude',
    codex: 'Codex',
    templates: 'Templates'
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)

  return (
    <>
      <div className="settings">
        <div className="settings-inner">
          <nav className="settings-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === 'general'}
              className={tab === 'general' ? 'active' : ''}
              onClick={() => setTab('general')}
            >
              General
            </button>
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
            <button
              role="tab"
              aria-selected={tab === 'templates'}
              className={tab === 'templates' ? 'active' : ''}
              onClick={() => setTab('templates')}
            >
              Templates
            </button>
          </nav>

          {tab === 'general' && (
            <section className="settings-section">
              <label>
                <span>
                  Request timeout (seconds)
                  <span
                    className="help-icon"
                    role="img"
                    aria-label="help"
                    title="Hard ceiling on a single AI request. When it fires, the spawned claude/codex process is killed and the request errors out. 300s = 5 minutes."
                  >
                    ?
                  </span>
                </span>
                <input
                  type="number"
                  min={10}
                  max={3600}
                  value={draft.requestTimeoutSeconds ?? DEFAULTS.requestTimeoutSeconds}
                  onChange={(e) =>
                    set('requestTimeoutSeconds', Number(e.target.value))
                  }
                />
                <small>
                  Kills the claude/codex process if it runs longer than this.
                </small>
              </label>
            </section>
          )}

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
                  <option value="auto">Auto-detect</option>
                  <option value="ja">Japanese (ja)</option>
                  <option value="en">English (en)</option>
                </select>
                <small>
                  Auto-detect adds latency and can be unreliable on short audio
                  chunks. Single-language-tuned models (Anime Whisper, Kotoba
                  Whisper, *.en) ignore this.
                </small>
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
                    Parallel lanes
                    <span
                      className="help-icon"
                      role="img"
                      aria-label="help"
                      title="How many whisper-cli inferences can run at once. With a fast model, 1 is plenty. If transcription falls behind the interval (e.g. on a slow CPU + large model), raise this so a new chunk can start while the previous one finishes. Peak CPU = lanes × Whisper threads."
                    >
                      ?
                    </span>
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={draft.transcribeMaxLanes}
                    onChange={(e) =>
                      set('transcribeMaxLanes', Number(e.target.value))
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

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={draft.captureMicrophone}
                  onChange={(e) =>
                    set('captureMicrophone', e.target.checked)
                  }
                />
                <span>
                  Mix in microphone
                  <small>
                    Capture your default microphone alongside system audio and
                    feed the mix to whisper. Useful for transcribing a call
                    that includes your own voice. Takes effect on the next
                    Start.
                  </small>
                </span>
              </label>

              <ProcessCapturePicker
                name={draft.captureProcessName}
                mode={draft.captureProcessMode}
                onNameChange={(v) => set('captureProcessName', v)}
                onModeChange={(v) => set('captureProcessMode', v)}
              />

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={draft.whisperDiarize}
                  onChange={(e) => set('whisperDiarize', e.target.checked)}
                />
                <span>
                  Speaker diarization
                  <small>
                    Pass <code>--tinydiarize</code> to whisper-cli so the
                    transcript includes <code>[SPEAKER_TURN]</code> markers at
                    detected speaker change points. When the toggle is on the
                    diarization model below is used instead of the main
                    Whisper model.
                  </small>
                </span>
              </label>

              <label>
                <span>
                  TinyDiarize model
                  {draft.whisperDiarize && !draft.whisperDiarizeModel && (
                    <span className="required-tag">required</span>
                  )}
                </span>
                <div className="row">
                  <input
                    className={
                      draft.whisperDiarize && !draft.whisperDiarizeModel
                        ? 'required-empty'
                        : ''
                    }
                    value={draft.whisperDiarizeModel}
                    onChange={(e) =>
                      set('whisperDiarizeModel', e.target.value)
                    }
                    placeholder="C:\path\to\ggml-small.en-tdrz.bin"
                  />
                  <button
                    onClick={() =>
                      pick(
                        'whisperDiarizeModel',
                        'Pick a TinyDiarize model',
                        [{ name: 'GGML model', extensions: ['bin'] }]
                      )
                    }
                  >
                    Browse
                  </button>
                  <button onClick={() => setShowDiarizeModelModal(true)}>
                    Download…
                  </button>
                </div>
                <small>
                  Used only while <strong>Speaker diarization</strong> is on.
                  Leave empty to fall back to the main Whisper model (which
                  must itself be a tdrz-named file for the flag to apply).
                </small>
              </label>
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

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={draft.claudeUsePrintMode}
                  onChange={(e) =>
                    set('claudeUsePrintMode', e.target.checked)
                  }
                />
                <span>
                  Use print mode (<code>-p</code>)
                  <small>
                    Counts against a separate usage quota from interactive
                    Claude Code sessions. Off by default.
                  </small>
                </span>
              </label>

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

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={draft.codexDangerouslyBypass}
                  onChange={(e) =>
                    set('codexDangerouslyBypass', e.target.checked)
                  }
                />
                <span>
                  Use <code>--dangerously-bypass-approvals-and-sandbox</code>
                  <small>
                    Skips every approval prompt and the sandbox. Off by
                    default — codex runs with <code>-a on-request</code> and
                    decides when to pause for approval; if it does, there's no
                    stdin to answer on so the request will hang until you
                    cancel.
                  </small>
                </span>
              </label>

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

          {tab === 'templates' && (
            <section className="settings-section">
              <p className="hint">
                Type <code>/</code> in the chat composer to summon templates by
                name. Built-in entries are always available; user entries below
                override built-ins with the same name and add new ones.
              </p>

              <TemplatesEditor
                templates={draft.promptTemplates}
                onChange={(t) => set('promptTemplates', t)}
              />

              <details className="templates-builtin">
                <summary>Built-in templates</summary>
                <ul>
                  {BUILT_IN_TEMPLATES.map((t) => (
                    <li key={t.name}>
                      <code>/{t.name}</code> — {t.body}
                    </li>
                  ))}
                </ul>
              </details>
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
      {showDiarizeModelModal && (
        <ModelDownloadModal
          title="Download a TinyDiarize model"
          filter={(m) => /tdrz/i.test(m.filename)}
          onClose={() => setShowDiarizeModelModal(false)}
          onDownloaded={(path) => {
            set('whisperDiarizeModel', path)
            void onSave({ whisperDiarizeModel: path })
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

function ProcessCapturePicker({
  name,
  mode,
  onNameChange,
  onModeChange
}: {
  name: string
  mode: 'include' | 'exclude'
  onNameChange: (v: string) => void
  onModeChange: (v: 'include' | 'exclude') => void
}): JSX.Element {
  const [processes, setProcesses] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false)

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      const list = await window.api.processes.list()
      setProcesses(list)
    } finally {
      setLoading(false)
    }
  }

  return (
    <label>
      <span>
        Capture from process (per-app loopback)
      </span>
      <div className="row">
        <input
          list="hibiki-process-list"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="(empty = whole-system loopback)  ·  e.g. Discord.exe"
        />
        <select
          value={mode}
          onChange={(e) => onModeChange(e.target.value as 'include' | 'exclude')}
          title="include = capture this app + its child processes; exclude = capture everything else"
        >
          <option value="include">include tree</option>
          <option value="exclude">exclude tree</option>
        </select>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          title="Refresh the list of running processes"
        >
          {loading ? '…' : 'Refresh'}
        </button>
      </div>
      <datalist id="hibiki-process-list">
        {(processes ?? []).map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <small>
        Captures audio from a single Windows process via{' '}
        <code>AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK</code>. Needs
        Windows 10 2004+. Click <strong>Refresh</strong>, then pick from the
        dropdown — the picker shows every running <code>.exe</code>, not just
        the ones with active audio sessions. Leave the field empty to fall
        back to whole-system loopback. Takes effect on the next Start.
      </small>
    </label>
  )
}

function TemplatesEditor({
  templates,
  onChange
}: {
  templates: PromptTemplate[]
  onChange: (next: PromptTemplate[]) => void
}): JSX.Element {
  function update(i: number, patch: Partial<PromptTemplate>): void {
    onChange(templates.map((t, j) => (j === i ? { ...t, ...patch } : t)))
  }
  function remove(i: number): void {
    onChange(templates.filter((_, j) => j !== i))
  }
  function add(): void {
    onChange([...templates, { name: '', body: '' }])
  }
  return (
    <div className="templates-editor">
      {templates.length === 0 ? (
        <p className="hint dim">No custom templates yet.</p>
      ) : (
        templates.map((t, i) => (
          <div key={i} className="template-row">
            <div className="template-row-head">
              <label className="template-name">
                <span>Name</span>
                <input
                  value={t.name}
                  onChange={(e) => update(i, { name: e.target.value })}
                  placeholder="my-prompt"
                  spellCheck={false}
                />
              </label>
              <button
                type="button"
                className="danger"
                onClick={() => remove(i)}
                title="Remove this template"
              >
                Remove
              </button>
            </div>
            <label className="template-body">
              <span>Body</span>
              <textarea
                value={t.body}
                rows={3}
                onChange={(e) => update(i, { body: e.target.value })}
                placeholder="What this template should ask the AI…"
              />
            </label>
          </div>
        ))
      )}
      <button type="button" onClick={add}>
        + Add template
      </button>
    </div>
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
