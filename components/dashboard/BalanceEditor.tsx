'use client'

import { useState, useTransition } from 'react'
import { Pencil, Check, X, Loader2 } from 'lucide-react'
import { updateDebitBalance, updateTbankDebit } from '@/app/actions'
import { rub } from '@/lib/finance'

interface Props {
  currentBalance: number
  kind?: 'sber' | 'tbank'
}

export default function BalanceEditor({ currentBalance, kind = 'sber' }: Props) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(String(currentBalance))
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function handleSave() {
    setError(null)
    const fd = new FormData()
    fd.set('balance', value)
    startTransition(async () => {
      const result = kind === 'tbank' ? await updateTbankDebit(fd) : await updateDebitBalance(fd)
      if (result?.error) {
        setError(result.error)
      } else {
        setEditing(false)
      }
    })
  }

  function handleCancel() {
    setValue(String(currentBalance))
    setEditing(false)
    setError(null)
  }

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="flex items-center gap-1.5 group"
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
      >
        <span
          className="text-xl font-bold mono"
          style={{
            color: currentBalance >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
            fontFamily: 'JetBrains Mono, monospace',
          }}
        >
          {rub(currentBalance)}
        </span>
        <Pencil
          size={11}
          style={{ color: 'var(--tx-muted)', opacity: 0, transition: 'opacity 0.15s' }}
          className="group-hover:opacity-100"
        />
      </button>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') handleCancel() }}
          autoFocus
          className="input-base mono text-lg font-bold"
          style={{
            fontFamily: 'JetBrains Mono, monospace',
            width: '160px',
            color: 'var(--accent-green)',
            padding: '4px 8px',
          }}
        />
        <button
          onClick={handleSave}
          disabled={pending}
          className="p-1.5 rounded-md transition-colors"
          style={{ background: 'rgba(34,197,94,0.1)', color: 'var(--accent-green)', border: '1px solid rgba(34,197,94,0.2)' }}
        >
          {pending ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
        </button>
        <button
          onClick={handleCancel}
          className="p-1.5 rounded-md transition-colors"
          style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--accent-red)', border: '1px solid rgba(239,68,68,0.2)' }}
        >
          <X size={13} />
        </button>
      </div>

      {/* Delta hint */}
      {(() => {
        const delta = parseFloat(value) - currentBalance
        if (isNaN(delta) || delta === 0) return null
        return (
          <div className="text-xs px-2 py-0.5 rounded"
            style={{ fontFamily: 'JetBrains Mono, monospace', color: delta > 0 ? 'var(--accent-green)' : 'var(--accent-red)', background: delta > 0 ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)' }}>
            {delta > 0 ? '+' : ''}{rub(delta)}
          </div>
        )
      })()}
      {error && <div className="text-xs" style={{ color: 'var(--accent-red)' }}>{error}</div>}
    </div>
  )
}
