import { useEffect, useState } from 'react'

function initialTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem('climate.theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch { /* Storage can be unavailable in a private browsing session. */ }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function useTheme() {
  const [theme, setTheme] = useState(initialTheme)
  const [manual, setManual] = useState(() => {
    try { return ['light', 'dark'].includes(localStorage.getItem('climate.theme') || '') }
    catch { return false }
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    const meta = document.querySelector('meta[name="theme-color"]')
    meta?.setAttribute('content', theme === 'dark' ? '#142333' : '#f5f7fa')
  }, [theme])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => {
      if (!manual) setTheme(event.matches ? 'dark' : 'light')
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [manual])

  function toggleTheme() {
    const next = theme === 'light' ? 'dark' : 'light'
    setTheme(next)
    setManual(true)
    try { localStorage.setItem('climate.theme', next) }
    catch { /* The theme still works without persistent storage. */ }
  }

  return { theme, toggleTheme }
}
