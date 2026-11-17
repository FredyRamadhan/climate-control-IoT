import { useCallback, useEffect, useState } from 'react'
import type { Connection, Dashboard } from '../types'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseDashboard(value: unknown): Dashboard {
  if (!record(value) || !record(value.health) || typeof value.health.mqtt !== 'boolean'
    || typeof value.server_time !== 'string' || !record(value.metadata)) {
    throw new Error('Respons layanan tidak valid')
  }
  // Schema mismatches remain available through the API, but non-object node payloads
  // must not break the dashboard while a device is starting up.
  const normalized = { ...value }
  for (const key of ['transmit', 'receive', 'transmit_status', 'receive_status', 'weather', 'command']) {
    if (!record(normalized[key])) normalized[key] = null
  }
  return normalized as unknown as Dashboard
}

export function useDashboard() {
  const [data, setData] = useState<Dashboard | null>(null)
  const [connection, setConnection] = useState<Connection>('loading')
  const [refreshing, setRefreshing] = useState(false)
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    let controller: AbortController | null = null
    let running = false

    async function poll() {
      if (disposed || running) return
      clearTimeout(timer)
      if (document.hidden) return
      running = true
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 8000)
      setRefreshing(true)
      try {
        const response = await fetch('/api/dashboard', {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
          cache: 'no-store',
        })
        if (!response.ok) throw new Error('Layanan tidak dapat dihubungi')
        const dashboard = parseDashboard(await response.json())
        if (!disposed) {
          setData(dashboard)
          setConnection('online')
        }
      } catch {
        if (!disposed) setConnection('offline')
      } finally {
        clearTimeout(timeout)
        running = false
        if (!disposed) {
          setRefreshing(false)
          timer = setTimeout(poll, 3000)
        }
      }
    }

    function onVisibilityChange() {
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    void poll()
    return () => {
      disposed = true
      clearTimeout(timer)
      controller?.abort()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [revision])

  return { data, connection, refreshing, refresh }
}
