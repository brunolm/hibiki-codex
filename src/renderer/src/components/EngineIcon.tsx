import type { Engine } from '../../../preload'

type Props = {
  engine: Engine
  size?: number
  title?: string
}

const ENGINE_LABEL: Record<Engine, string> = {
  claude: 'Claude',
  codex: 'Codex'
}

export function EngineIcon({ engine, size = 16, title }: Props): JSX.Element {
  const label = title ?? ENGINE_LABEL[engine]
  if (engine === 'claude') {
    return (
      <svg
        className="engine-icon engine-claude"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        role="img"
        aria-label={label}
      >
        <title>{label}</title>
        <g
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          fill="none"
        >
          <line x1="12" y1="3" x2="12" y2="21" />
          <line x1="4.5" y1="6.5" x2="19.5" y2="17.5" />
          <line x1="4.5" y1="17.5" x2="19.5" y2="6.5" />
        </g>
      </svg>
    )
  }
  return (
    <svg
      className="engine-icon engine-codex"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <path
        d="M9 6 L3 12 L9 18 M15 6 L21 12 L15 18"
        stroke="currentColor"
        strokeWidth="2.2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
