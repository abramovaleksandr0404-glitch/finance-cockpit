'use client'

import { useState, useTransition } from 'react'
import { Pencil, Trash2, Loader2, CalendarPlus, X, Check } from 'lucide-react'
import { deleteGoal, updateGoalDetails } from '@/app/actions'
import { rub, monthLabel } from '@/lib/finance'

function nextMonths(from: string): { key: string; label: string }[] {
  const [y, m] = from.split('-').map(Number)
  const months = []
  for (let i = 0; i <= 5; i++) {
    const d = new Date(y, m - 1 + i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    months.push({ key, label: monthLabel(key).split(' ')[0] })
  }
  return months
}

export default function SavingsGoalRow({
  id, name, amount, monthKey,
}: {
  id: string; name: string; amount: number; monthKey: string
}) {
  const [pending, startTransition] = useTransition()
  const [mode, setMode] = useState<null | 'edit' | 'move'>(null)
  const [editName, setEditName] = useState(name)
  const [editAmount, setEditAmount] = useState(String(amount))
  const [targetMonth, setTargetMonth] = useState(monthKey)
  const months = nextMonths(monthKey)

  function saveEdit() {
    const amt = parseInt(editAmount, 10)
    if (!editName.trim() || !amt) { setMode(null); return }
    startTransition(async () => {
      await updateGoalDetails(id, { name: editName.trim(), amount: amt })
      setMode(null)
    })
  }

  function remove() {
    startTransition(async () => { await deleteGoal(id) })
  }

  function moveToMonth() {
    startTransition(async () => {
      await updateGoalDetails(id, { month_key: targetMonth })
      setMode(null)
    })
  }

  return (
    <div className="flex flex-col" style={{ borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border)' }}>
      {/* Main row */}
      <div className="flex items-center gap-2 py-2.5 px-3" style={{ background: 'var(--bg-hover)' }}>
        <span className="text-sm flex-1 min-w-0 truncate">{name}</span>
        <span className="text-sm font-bold flex-shrink-0"
          style={{ color: 'var(--accent-cyan)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
          {rub(amount)}
        </span>
        {pending
          ? <Loader2 size={12} className="animate-spin flex-shrink-0" style={{ color: 'var(--tx-muted)' }} />
          : <div className="flex items-center gap-0.5 flex-shrink-0">
              <button onClick={() => setMode(mode === 'edit' ? null : 'edit')} title="Редактировать"
                className="p-1.5 rounded" style={{ background: 'none', border: 'none', cursor: 'pointer', color: mode === 'edit' ? 'var(--accent-cyan)' : 'var(--tx-dim)' }}>
                <Pencil size={12} />
              </button>
              <button onClick={() => setMode(mode === 'move' ? null : 'move')} title="Запланировать в месяц"
                className="p-1.5 rounded" style={{ background: 'none', border: 'none', cursor: 'pointer', color: mode === 'move' ? 'var(--accent-amber)' : 'var(--tx-dim)' }}>
                <CalendarPlus size={12} />
              </button>
              <button onClick={remove} title="Удалить"
                className="p-1.5 rounded" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tx-dim)' }}>
                <Trash2 size={12} />
              </button>
            </div>
        }
      </div>

      {/* Edit panel */}
      {mode === 'edit' && (
        <div className="px-3 py-2.5 flex flex-col gap-2 animate-slide-up"
          style={{ background: 'rgba(6,182,212,0.05)', borderTop: '1px solid rgba(6,182,212,0.2)' }}>
          <div className="label">Редактировать цель</div>
          <input type="text" value={editName} autoFocus autoComplete="off"
            onChange={(e) => setEditName(e.target.value)}
            placeholder="Название цели" className="input-base" style={{ fontSize: '14px' }} />
          <div className="flex gap-2">
            <input type="number" value={editAmount} onChange={(e) => setEditAmount(e.target.value)}
              placeholder="Сумма ₽" className="input-base flex-1"
              style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '14px' }} />
            <button onClick={saveEdit} disabled={pending}
              className="px-3 rounded-lg flex items-center gap-1.5 text-sm font-medium flex-shrink-0"
              style={{ background: 'rgba(6,182,212,0.15)', border: '1px solid rgba(6,182,212,0.3)', color: 'var(--accent-cyan)', cursor: 'pointer' }}>
              {pending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Сохранить
            </button>
            <button onClick={() => setMode(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>
              <X size={12} style={{ color: 'var(--tx-muted)' }} />
            </button>
          </div>
        </div>
      )}

      {/* Move to month panel */}
      {mode === 'move' && (
        <div className="px-3 py-2.5 flex flex-col gap-2 animate-slide-up"
          style={{ background: 'rgba(245,158,11,0.05)', borderTop: '1px solid rgba(245,158,11,0.2)' }}>
          <div className="label">Запланировать в месяц</div>
          <div className="flex flex-wrap gap-1.5">
            {months.map((mo) => (
              <button key={mo.key} onClick={() => setTargetMonth(mo.key)}
                className="text-xs px-2.5 py-1.5 rounded-md font-medium"
                style={{ background: targetMonth === mo.key ? 'rgba(245,158,11,0.2)' : 'var(--bg-base)', border: `1px solid ${targetMonth === mo.key ? 'var(--accent-amber)' : 'var(--border)'}`, color: targetMonth === mo.key ? 'var(--accent-amber)' : 'var(--tx-muted)', cursor: 'pointer' }}>
                {mo.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={moveToMonth} disabled={pending}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium"
              style={{ background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.3)', color: 'var(--accent-amber)', cursor: 'pointer' }}>
              {pending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Перенести
            </button>
            <button onClick={() => setMode(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>
              <X size={12} style={{ color: 'var(--tx-muted)' }} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
