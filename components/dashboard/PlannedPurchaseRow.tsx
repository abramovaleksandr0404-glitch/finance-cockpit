'use client'

import { useState, useTransition } from 'react'
import { Pencil, Trash2, Check, Loader2, ShoppingCart, X } from 'lucide-react'
import { updateGoal, deleteGoal, purchaseGoal } from '@/app/actions'
import { rub } from '@/lib/finance'

export default function PlannedPurchaseRow({
  id, name, amount, purchased, accountOptions,
}: {
  id: string; name: string; amount: number
  purchased: boolean
  accountOptions: { id: string; label: string }[]
}) {
  const [pending, startTransition] = useTransition()
  const [mode, setMode] = useState<null | 'edit' | 'buy'>(null)
  const [editName, setEditName] = useState(name)
  const [editAmount, setEditAmount] = useState(String(amount))
  const [buySource, setBuySource] = useState(accountOptions[0]?.id ?? 'sber')

  function saveEdit() {
    const amt = parseInt(editAmount, 10)
    if (!editName.trim() || !amt) { setMode(null); return }
    startTransition(async () => {
      await updateGoal(id, amt, editName.trim())
      setMode(null)
    })
  }

  function remove() {
    startTransition(async () => { await deleteGoal(id) })
  }

  function buy() {
    startTransition(async () => {
      await purchaseGoal(id, buySource)
      setMode(null)
    })
  }

  return (
    <div className="flex flex-col" style={{ borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border)' }}>
      {/* Main row */}
      <div className="flex items-center gap-2 py-2.5 px-3"
        style={{ background: purchased ? 'rgba(34,197,94,0.05)' : 'var(--bg-hover)', opacity: purchased ? 0.75 : 1 }}>
        {purchased && <Check size={12} style={{ color: 'var(--accent-green)', flexShrink: 0 }} />}
        <span className="text-sm flex-1 min-w-0 truncate" style={{ textDecoration: purchased ? 'line-through' : 'none' }}>
          {name}
        </span>
        <span className="text-sm font-bold flex-shrink-0"
          style={{ color: purchased ? 'var(--accent-green)' : 'var(--accent-amber)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
          {rub(amount)}
        </span>
        {pending
          ? <Loader2 size={12} className="animate-spin flex-shrink-0" style={{ color: 'var(--tx-muted)' }} />
          : !purchased && (
            <div className="flex items-center gap-0.5 flex-shrink-0">
              <button onClick={() => setMode(mode === 'edit' ? null : 'edit')} title="Редактировать"
                className="p-1.5 rounded" style={{ background: 'none', border: 'none', cursor: 'pointer', color: mode === 'edit' ? 'var(--accent-cyan)' : 'var(--tx-dim)' }}>
                <Pencil size={12} />
              </button>
              <button onClick={() => setMode(mode === 'buy' ? null : 'buy')} title="Купить"
                className="p-1.5 rounded" style={{ background: 'none', border: 'none', cursor: 'pointer', color: mode === 'buy' ? 'var(--accent-green)' : 'var(--tx-dim)' }}>
                <ShoppingCart size={12} />
              </button>
              <button onClick={remove} title="Удалить"
                className="p-1.5 rounded" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tx-dim)' }}>
                <Trash2 size={12} />
              </button>
            </div>
          )
        }
      </div>

      {/* Edit panel */}
      {mode === 'edit' && (
        <div className="px-3 py-2.5 flex flex-col gap-2 animate-slide-up"
          style={{ background: 'rgba(6,182,212,0.05)', borderTop: '1px solid rgba(6,182,212,0.2)' }}>
          <div className="label">Редактировать</div>
          <input type="text" value={editName} autoFocus autoComplete="off"
            onChange={(e) => setEditName(e.target.value)}
            placeholder="Название" className="input-base" style={{ fontSize: '14px' }} />
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

      {/* Buy panel */}
      {mode === 'buy' && (
        <div className="px-3 py-2.5 flex flex-col gap-2 animate-slide-up"
          style={{ background: 'rgba(34,197,94,0.05)', borderTop: '1px solid rgba(34,197,94,0.2)' }}>
          <div className="label">Купить · списать с</div>
          <div className="flex gap-2">
            <select value={buySource} onChange={(e) => setBuySource(e.target.value)}
              className="input-base flex-1" style={{ fontSize: '13px' }}>
              {accountOptions.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
            <button onClick={buy} disabled={pending}
              className="px-3 rounded-lg flex items-center gap-1.5 text-sm font-medium flex-shrink-0"
              style={{ background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)', color: 'var(--accent-green)', cursor: 'pointer' }}>
              {pending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Купить
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
