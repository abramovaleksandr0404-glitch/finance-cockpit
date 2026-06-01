'use client'

import { useState, useTransition } from 'react'
import { Plus, X, Check, Loader2 } from 'lucide-react'
import { addGoal } from '@/app/actions'

export default function AddGoalForm({ monthKey, kind }: { monthKey: string; kind: 'planned' | 'savings' }) {
  const [open, setOpen] = useState(false)
  const [goalName, setGoalName] = useState('')
  const [goalAmount, setGoalAmount] = useState('')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState('')

  function submit() {
    if (!goalName.trim()) { setError('Введи название'); return }
    const amt = parseInt(goalAmount, 10)
    if (!amt || amt <= 0) { setError('Введи сумму'); return }
    setError('')

    const fd = new FormData()
    fd.set('goal_name', goalName.trim())
    fd.set('amount', String(amt))
    fd.set('month_key', kind === 'planned' ? monthKey : '')

    startTransition(async () => {
      const r = await addGoal(fd)
      if (!r?.error) {
        setGoalName(''); setGoalAmount(''); setOpen(false)
      } else {
        setError(r.error)
      }
    })
  }

  const label = kind === 'planned' ? 'плановую покупку' : 'цель-накопление'
  const accent = kind === 'planned' ? 'var(--accent-amber)' : 'var(--accent-cyan)'

  return (
    <div>
      <button onClick={() => { setOpen((v) => !v); setError('') }}
        className="flex items-center gap-1.5 text-xs transition-all py-1"
        style={{ color: open ? 'var(--accent-red)' : 'var(--tx-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>
        {open ? <X size={11} /> : <Plus size={11} />}
        {open ? 'отмена' : `+ добавить ${label}`}
      </button>

      {open && (
        <div className="mt-2 rounded-lg p-3 flex flex-col gap-2 animate-slide-up"
          style={{ background: 'var(--bg-hover)', border: `1px solid ${accent}40` }}>
          {/* Goal name — full width, no autocomplete */}
          <div>
            <label className="label block mb-1">Название</label>
            <input
              type="text"
              value={goalName}
              onChange={(e) => setGoalName(e.target.value)}
              placeholder={kind === 'planned' ? 'Например: Новый телефон' : 'Например: Отпуск в Турции'}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="input-base"
              style={{ fontSize: '15px' }}
            />
          </div>

          {/* Amount + submit on same row */}
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="label block mb-1">Сумма ₽</label>
              <input
                type="number"
                value={goalAmount}
                onChange={(e) => setGoalAmount(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder="0"
                className="input-base"
                style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '15px' }}
              />
            </div>
            <div className="flex flex-col justify-end">
              <button onClick={submit} disabled={pending}
                className="h-10 px-4 rounded-lg flex items-center gap-1.5 text-sm font-medium"
                style={{ background: `${accent}18`, border: `1px solid ${accent}50`, color: accent, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                {pending ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                Добавить
              </button>
            </div>
          </div>

          {error && <div className="text-xs" style={{ color: 'var(--accent-red)' }}>{error}</div>}
        </div>
      )}
    </div>
  )
}
