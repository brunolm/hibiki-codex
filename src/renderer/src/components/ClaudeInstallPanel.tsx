import { useEffect, useRef, useState } from 'react'

type Phase = 'idle' | 'installing' | 'success' | 'failed'

type Props = {
  onInstalled: () => void
  useWsl: boolean
}

const COMMANDS: { os: 'Windows' | 'macOS' | 'Linux / WSL'; cmd: string }[] = [
  { os: 'Windows', cmd: 'winget install Anthropic.ClaudeCode' },
  { os: 'macOS', cmd: 'brew install --cask claude-code' },
  { os: 'Linux / WSL', cmd: 'curl -fsSL https://claude.ai/install.sh | bash' }
]

export function ClaudeInstallPanel({ onInstalled, useWsl }: Props): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const [log, setLog] = useState('')
  const [exitCode, setExitCode] = useState<number | null>(null)
  const logRef = useRef<HTMLPreElement | null>(null)
  // The auto-installer shells out to winget on the Windows host, so it only
  // helps when the user is targeting the Windows-side claude binary.
  const canAutoInstall = window.api.platform === 'win32' && !useWsl

  useEffect(() => {
    const off = window.api.install.onLog((line) => {
      setLog((prev) => prev + line)
    })
    return off
  }, [])

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [log])

  async function install(): Promise<void> {
    setLog('')
    setExitCode(null)
    setPhase('installing')
    try {
      const code = await window.api.install.claude()
      setExitCode(code)
      if (code === 0) {
        setPhase('success')
        onInstalled()
      } else {
        setPhase('failed')
      }
    } catch (err) {
      setLog((prev) => prev + '\n' + (err as Error).message)
      setPhase('failed')
    }
  }

  function copy(cmd: string): void {
    void navigator.clipboard.writeText(cmd)
  }

  return (
    <div className="install-panel">
      <p className="install-headline">
        The <code>claude</code> CLI was not found on{' '}
        {useWsl ? 'WSL' : 'PATH'}.
      </p>

      {canAutoInstall ? (
        <div className="install-actions">
          <button
            className="primary"
            onClick={install}
            disabled={phase === 'installing'}
          >
            {phase === 'installing'
              ? 'Installing…'
              : phase === 'success'
                ? 'Installed ✓'
                : 'Install via winget'}
          </button>
          <button onClick={onInstalled} disabled={phase === 'installing'}>
            Re-check
          </button>
        </div>
      ) : (
        <div className="install-actions">
          <button onClick={onInstalled}>Re-check</button>
        </div>
      )}

      {phase !== 'idle' && (
        <pre className="install-log" ref={logRef}>
          {log || (phase === 'installing' ? 'Starting winget…' : '')}
          {phase === 'failed' && exitCode !== null && `\n\n[exited ${exitCode}]`}
        </pre>
      )}

      <details className="install-manual">
        <summary>Manual install commands</summary>
        <ul>
          {COMMANDS.map((c) => (
            <li key={c.os}>
              <span className="install-os">{c.os}</span>
              <code className="install-cmd">{c.cmd}</code>
              <button className="install-copy" onClick={() => copy(c.cmd)}>
                Copy
              </button>
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}
