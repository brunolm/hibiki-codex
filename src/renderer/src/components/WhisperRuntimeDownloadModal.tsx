import { useEffect, useState } from 'react'
import type {
  WhisperRuntimeVariant,
  WhisperRuntimeProgress
} from '../../../preload'

type Phase = 'choose' | 'downloading' | 'extracting' | 'done' | 'error' | 'cancelled'

type Props = {
  onClose: () => void
  onInstalled: (exePath: string) => void
}

function fmtBytes(n: number): string {
  if (n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtEta(remainingBytes: number, rateBps: number): string {
  if (rateBps <= 0 || remainingBytes <= 0) return '—'
  const seconds = remainingBytes / rateBps
  if (seconds < 60) return `${Math.ceil(seconds)}s`
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}

export function WhisperRuntimeDownloadModal({
  onClose,
  onInstalled
}: Props): JSX.Element {
  const [variants, setVariants] = useState<WhisperRuntimeVariant[]>([])
  const [installed, setInstalled] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('choose')
  const [progress, setProgress] = useState<WhisperRuntimeProgress | null>(null)
  const [installedPath, setInstalledPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.whisperRuntime.list().then((v) => {
      setVariants(v)
      const rec = v.find((x) => x.recommended) ?? v[0]
      if (rec) setSelected(rec.id)
    })
    void window.api.whisperRuntime.listInstalled().then(setInstalled)
    const off = window.api.whisperRuntime.onProgress((p) => {
      setProgress(p)
      setPhase(p.phase === 'extracting' ? 'extracting' : 'downloading')
    })
    return off
  }, [])

  const selectedInstalledPath = selected ? installed[selected] : undefined
  const selectedIsInstalled = !!selectedInstalledPath

  function useExisting(): void {
    if (!selectedInstalledPath) return
    onInstalled(selectedInstalledPath)
    onClose()
  }

  async function startDownload(): Promise<void> {
    if (!selected) return
    setProgress(null)
    setError(null)
    setPhase('downloading')
    try {
      const exe = await window.api.whisperRuntime.download(selected)
      setInstalledPath(exe)
      onInstalled(exe)
      setPhase('done')
    } catch (e) {
      const msg = (e as Error).message
      if (/cancel|abort/i.test(msg)) {
        setPhase('cancelled')
      } else {
        setError(msg)
        setPhase('error')
      }
    }
  }

  async function cancel(): Promise<void> {
    await window.api.whisperRuntime.cancel()
  }

  const selectedVariant = variants.find((m) => m.id === selected)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>
            {phase === 'choose' && 'Download whisper-cli runtime'}
            {phase === 'downloading' &&
              `Downloading ${selectedVariant?.asset ?? ''}`}
            {phase === 'extracting' && 'Extracting…'}
            {phase === 'done' && 'Installed'}
            {phase === 'error' && 'Install failed'}
            {phase === 'cancelled' && 'Cancelled'}
          </h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          {phase === 'choose' && (
            <>
              <ul className="model-list">
                {variants.map((v) => (
                  <li
                    key={v.id}
                    className={selected === v.id ? 'picked' : ''}
                  >
                    <label>
                      <input
                        type="radio"
                        name="runtime"
                        value={v.id}
                        checked={selected === v.id}
                        onChange={() => setSelected(v.id)}
                      />
                      <span className="model-name">
                        {v.label}
                        {v.recommended && (
                          <span className="model-badge">recommended</span>
                        )}
                        {installed[v.id] && (
                          <span
                            className="model-badge installed"
                            title={installed[v.id]}
                          >
                            installed
                          </span>
                        )}
                      </span>
                      <span className="model-size">{fmtBytes(v.sizeBytes)}</span>
                      <span className="model-desc">{v.description}</span>
                    </label>
                  </li>
                ))}
              </ul>
              {selectedIsInstalled && selectedInstalledPath && (
                <p className="modal-hint warn">
                  <strong>{selectedVariant?.label}</strong> is already installed
                  at <code>{selectedInstalledPath}</code>. Re-download to
                  overwrite, or use the existing install.
                </p>
              )}
              <p className="modal-hint">
                Binaries are downloaded from github.com/ggml-org/whisper.cpp
                releases and extracted to the app&apos;s data folder.
              </p>
            </>
          )}

          {(phase === 'downloading' || phase === 'extracting') && (
            <ProgressView progress={progress} phase={phase} />
          )}

          {phase === 'done' && installedPath && (
            <>
              <p className="modal-ok">✓ Installed:</p>
              <p className="modal-path">{installedPath}</p>
              <p>Set as your Whisper executable.</p>
            </>
          )}

          {phase === 'error' && <p className="modal-err">{error}</p>}

          {phase === 'cancelled' && <p>Download cancelled.</p>}
        </div>

        <footer className="modal-actions">
          {phase === 'choose' && (
            <>
              <button onClick={onClose}>Cancel</button>
              {selectedIsInstalled ? (
                <>
                  <button onClick={startDownload} disabled={!selected}>
                    Re-download
                  </button>
                  <button
                    className="primary"
                    onClick={useExisting}
                    disabled={!selected}
                  >
                    Use existing
                  </button>
                </>
              ) : (
                <button
                  className="primary"
                  onClick={startDownload}
                  disabled={!selected}
                >
                  Download
                </button>
              )}
            </>
          )}
          {(phase === 'downloading' || phase === 'extracting') && (
            <button onClick={cancel}>Cancel</button>
          )}
          {(phase === 'done' || phase === 'error' || phase === 'cancelled') && (
            <button className="primary" onClick={onClose}>
              Close
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

function ProgressView({
  progress,
  phase
}: {
  progress: WhisperRuntimeProgress | null
  phase: 'downloading' | 'extracting'
}): JSX.Element {
  if (!progress) return <p>Starting…</p>
  const pct = progress.totalBytes
    ? (progress.bytesDownloaded / progress.totalBytes) * 100
    : 0
  return (
    <div className="progress-view">
      <div className="progress-bar">
        <div
          className="progress-fill"
          style={{ width: phase === 'extracting' ? '100%' : `${pct}%` }}
        />
      </div>
      <div className="progress-stats">
        {phase === 'extracting' ? (
          <span>Extracting archive…</span>
        ) : (
          <>
            <span>
              {fmtBytes(progress.bytesDownloaded)}
              {progress.totalBytes > 0 &&
                ` / ${fmtBytes(progress.totalBytes)}`}
            </span>
            <span>{fmtBytes(progress.rateBytesPerSec)}/s</span>
            {progress.totalBytes > 0 && (
              <span>
                {fmtEta(
                  progress.totalBytes - progress.bytesDownloaded,
                  progress.rateBytesPerSec
                )}{' '}
                left
              </span>
            )}
          </>
        )}
      </div>
    </div>
  )
}
