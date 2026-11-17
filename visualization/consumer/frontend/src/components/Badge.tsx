import type { ReactNode } from 'react'

export function Badge({ children, tone = 'neutral', dot = false }: {
  children: ReactNode
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'blue'
  dot?: boolean
}) {
  return <span className={`badge badge--${tone}`}>
    {dot && <span className="status-dot" aria-hidden="true" />}{children}
  </span>
}
