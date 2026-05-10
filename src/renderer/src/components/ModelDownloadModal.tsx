import { useEffect, useState } from 'react'
import type { WhisperCatalogModel, DownloadProgress } from '../../../preload'

type Phase = 'choose' | 'downloading' | 'done' | 'error' | 'cancelled'

type Props = {
  onClose: () => void
  onDownloaded: (path: string) => void
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

export function ModelDownloadModal({ onClose, onDownloaded }: Props): JSX.Element {
  const [models, setModels] = useState<WhisperCatalogModel[]>([])
  const [installed, setInstalled] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('choose')
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.models.list().then((m) => {
      setModels(m)
      const rec = m.find((x) => x.recommended) ?? m[0]
      if (rec) setSelected(rec.id)
    })
    void window.api.models.listInstalled().then(setInstalled)
    const off = window.api.models.onProgress(setProgress)
    return off
  }, [])

  const selectedInstalledPath = selected ? installed[selected] : undefined
  const selectedIsInstalled = !!selectedInstalledPath

  function useExisting(): void {
    if (!selectedInstalledPath) return
    onDownloaded(selectedInstalledPath)
    onClose()
  }

  async function startDownload(): Promise<void> {
    if (!selected) return
    setProgress(null)
    setError(null)
    setPhase('downloading')
    try {
      const path = await window.api.models.download(selected)
      if (!path) {
        // user cancelled the save dialog before download started
        setPhase('choose')
        return
      }
      setSavedPath(path)
      onDownloaded(path)
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
    await window.api.models.cancel()
  }

  const ml = models.filter((m) => m.group === 'multilingual')
  const ja = models.filter((m) => m.group === 'japanese')
  const en = models.filter((m) => m.group === 'english')
  const selectedModel = models.find((m) => m.id === selected)

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
            {phase === 'choose' && 'Download a Whisper model'}
            {phase === 'downloading' && `Downloading ${selectedModel?.filename ?? ''}`}
            {phase === 'done' && 'Downloaded'}
            {phase === 'error' && 'Download failed'}
            {phase === 'cancelled' && 'Cancelled'}
          </h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          {phase === 'choose' && (
            <>
              <ModelGroup
                title="Multilingual (Japanese, English, …)"
                models={ml}
                selected={selected}
                onPick={setSelected}
                installed={installed}
              />
              <ModelGroup
                title="Japanese-tuned (JP only)"
                models={ja}
                selected={selected}
                onPick={setSelected}
                installed={installed}
              />
              <ModelGroup
                title="English only (smaller, faster)"
                models={en}
                selected={selected}
                onPick={setSelected}
                installed={installed}
              />
              {selectedIsInstalled && selectedInstalledPath && (
                <p className="modal-hint warn">
                  <strong>{selectedModel?.filename}</strong> is already
                  downloaded at <code>{selectedInstalledPath}</code>. Re-download
                  to overwrite, or use the existing file.
                </p>
              )}
              <p className="modal-hint">
                Models are downloaded from huggingface.co into the app data
                folder.
              </p>
            </>
          )}

          {phase === 'downloading' && (
            <ProgressView progress={progress} />
          )}

          {phase === 'done' && savedPath && (
            <>
              <p className="modal-ok">✓ Saved to:</p>
              <p className="modal-path">{savedPath}</p>
              <p>Set as your Whisper model.</p>
            </>
          )}

          {phase === 'error' && (
            <p className="modal-err">{error}</p>
          )}

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
          {phase === 'downloading' && (
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

function ModelGroup({
  title,
  models,
  selected,
  onPick,
  installed
}: {
  title: string
  models: WhisperCatalogModel[]
  selected: string | null
  onPick: (id: string) => void
  installed: Record<string, string>
}): JSX.Element {
  return (
    <div className="model-group">
      <h3>{title}</h3>
      <ul className="model-list">
        {models.map((m) => (
          <li key={m.id} className={selected === m.id ? 'picked' : ''}>
            <label>
              <input
                type="radio"
                name="model"
                value={m.id}
                checked={selected === m.id}
                onChange={() => onPick(m.id)}
              />
              <span className="model-name">
                {m.label}
                {m.recommended && (
                  <span className="model-badge">recommended</span>
                )}
                {installed[m.id] && (
                  <span className="model-badge installed" title={installed[m.id]}>
                    installed
                  </span>
                )}
              </span>
              <span className="model-size">{fmtBytes(m.sizeBytes)}</span>
              <span className="model-desc">{m.description}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ProgressView({ progress }: { progress: DownloadProgress | null }): JSX.Element {
  if (!progress) return <p>Starting…</p>
  const pct = progress.totalBytes
    ? (progress.bytesDownloaded / progress.totalBytes) * 100
    : 0
  return (
    <div className="progress-view">
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="progress-stats">
        <span>
          {fmtBytes(progress.bytesDownloaded)}
          {progress.totalBytes > 0 && ` / ${fmtBytes(progress.totalBytes)}`}
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
      </div>
    </div>
  )
}
