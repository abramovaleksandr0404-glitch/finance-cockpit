'use client'

import { ChevronLeft, ChevronRight, Dot } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { monthLabel, currentMonthKey } from '@/lib/finance'
import { prevMonthKey } from '@/lib/engine'

function nextMonthKey(key: string): string {
  const [y, m] = key.split('-').map(Number)
  const d = new Date(y, m, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function MonthSwitcher({ monthKey }: { monthKey: string }) {
  const router = useRouter()
  const isCurrent = monthKey === currentMonthKey()
  const label = monthLabel(monthKey)

  function go(key: string) {
    router.push(`/dashboard?m=${key}`)
  }

  return (
    <div className="flex items-center justify-center gap-2">
      <button
        onClick={() => go(prevMonthKey(monthKey))}
        className="w-9 h-9 rounded-lg flex items-center justify-center transition-all"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', cursor: 'pointer' }}
      >
        <ChevronLeft size={16} style={{ color: 'var(--tx-muted)' }} />
      </button>

      <div
        className="flex items-center gap-2 px-4 h-9 rounded-lg min-w-[180px] justify-center"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
      >
        {isCurrent && <Dot size={20} style={{ color: 'var(--accent-green)', margin: '-6px' }} />}
        <span className="text-sm font-semibold capitalize" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>
          {label}
        </span>
        {isCurrent && <span className="label">сейчас</span>}
      </div>

      <button
        onClick={() => go(nextMonthKey(monthKey))}
        className="w-9 h-9 rounded-lg flex items-center justify-center transition-all"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', cursor: 'pointer' }}
      >
        <ChevronRight size={16} style={{ color: 'var(--tx-muted)' }} />
      </button>

      {!isCurrent && (
        <button
          onClick={() => go(currentMonthKey())}
          className="text-xs px-2.5 h-9 rounded-lg transition-all"
          style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--accent-blue)', cursor: 'pointer' }}
        >
          К текущему
        </button>
      )}
    </div>
  )
}
