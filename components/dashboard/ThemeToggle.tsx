'use client'

import { useEffect, useState } from 'react'
import { Sun, Moon } from 'lucide-react'

export default function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')

  useEffect(() => {
    const saved = localStorage.getItem('fc-theme') as 'dark' | 'light' | null
    const initial = saved ?? 'dark'
    setTheme(initial)
    document.documentElement.setAttribute('data-theme', initial)
  }, [])

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('fc-theme', next)
    document.documentElement.setAttribute('data-theme', next)
  }

  return (
    <button
      onClick={toggle}
      title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
      className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
      style={{
        background: 'var(--bg-hover)',
        border: '1px solid var(--border)',
        cursor: 'pointer',
      }}
    >
      {theme === 'dark'
        ? <Sun size={14} style={{ color: 'var(--accent-amber)' }} />
        : <Moon size={14} style={{ color: 'var(--accent-blue)' }} />
      }
    </button>
  )
}
