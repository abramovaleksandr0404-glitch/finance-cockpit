'use client'

import { useState, useTransition, useEffect } from 'react'
import { Check, Circle, Loader2, Repeat, Pencil } from 'lucide-react'
import { setFixedPaid } from '@/app/actions'
import { rub } from '@/lib/finance'
import type { UserProfile, Month } from '@/lib/types'

export default function FixedCostsWidget({
  user,
  month,
  monthKey,
}: {
  user: UserProfile
  month: Month | null
  monthKey: string
}) {
  const fixedPaid = (month?.fixed_paid ?? {}) as Record<string, number | boolean>
  const total = user.fixed_costs.reduce((s, f) => s + f.amount, 0)
  const paidSum = user.fixed_costs.reduce((s, f, i) => {
    const v = fixedPaid[String(i)]
    return v != null && v !== false ? s + (typeof v === 'number' ? v : f.amount) : s
  }, 0)

  return (
    <div className="card p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Repeat size={14} style={{ color: 'var(--accent-blue)' }} />
          <span className="text-sm font-medium">Постоянные расходы</span>
        </div>
        <div className="text-right">
          <div className="label">оплачено / всего</div>
          <div className="text-xs font-bold mono" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {rub(paidSum, { compact: true })} / {rub(total, { compact: true })}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        {user.fixed_costs.map((f, i) => (
          <FixedRow
            key={i}
            index={i}
            name={f.name}
            defaultAmount={f.amount}
            paidValue={fixedPaid[String(i)]}
            monthKey={monthKey}
          />
        ))}
      </div>
    </div>
  )
}

function FixedRow({
  index,
  name,
  defaultAmount,
  paidValue,
  monthKey,
}: {
  index: number
  name: string
  defaultAmount: number
  paidValue: number | boolean | undefined
  monthKey: string
}) {
  const isPaid = paidValue != null && paidValue !== false
  const currentAmount = typeof paidValue === 'number' ? paidValue : defaultAmount

  const [pending, startTransition] = useTransition()
  const [editing, setEditing] = useState(false)
  const [amount, setAmount] = useState(currentAmount)
  const [paid, setPaid] = useState(isPaid)

  // Sync local state with fresh server props (e.g. after bot marked payment).
  // Without this, a stale "not paid" button allowed double payment.
  useEffect(() => { setPaid(isPaid) }, [isPaid])
  useEffect(() => { if (!editing) setAmount(currentAmount) }, [currentAmount, editing])

  function togglePaid() {
    const next = !paid
    setPaid(next)
    startTransition(async () => {
      await setFixedPaid(monthKey, index, next, amount)
    })
  }

  function saveAmount() {
    setEditing(false)
    if (amount !== currentAmount) {
      startTransition(async () => {
        // If already paid, setFixedPaid re-applies with new amount (adjusts debit by diff)
        await setFixedPaid(monthKey, index, paid, amount)
      })
    }
  }

  return (
    <div
      className="flex items-center gap-2.5 py-2 px-2.5 rounded-md"
      style={{ background: paid ? 'rgba(34,197,94,0.05)' : 'var(--bg-hover)', border: '1px solid var(--border)' }}
    >
      {/* Pay toggle */}
      <button
        onClick={togglePaid}
        disabled={pending}
        className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 transition-all"
        style={{
          background: paid ? 'rgba(34,197,94,0.15)' : 'transparent',
          border: `1px solid ${paid ? 'rgba(34,197,94,0.4)' : 'var(--border-bright)'}`,
          cursor: pending ? 'wait' : 'pointer',
        }}
      >
        {pending ? (
          <Loader2 size={12} className="animate-spin" style={{ color: 'var(--tx-muted)' }} />
        ) : paid ? (
          <Check size={12} style={{ color: 'var(--accent-green)' }} />
        ) : (
          <Circle size={11} style={{ color: 'var(--tx-dim)' }} />
        )}
      </button>

      {/* Name */}
      <span className="text-sm flex-1 min-w-0 truncate" style={{ opacity: paid ? 0.6 : 1 }}>
        {name}
      </span>

      {/* Amount (editable) */}
      {editing ? (
        <input
          type="number"
          value={amount}
          autoFocus
          onChange={(e) => setAmount(parseInt(e.target.value, 10) || 0)}
          onBlur={saveAmount}
          onKeyDown={(e) => e.key === 'Enter' && saveAmount()}
          className="w-20 text-right text-sm mono"
          style={{
            background: 'var(--bg-base)', border: '1px solid var(--accent-blue)',
            borderRadius: '4px', padding: '2px 6px', color: 'var(--tx-primary)',
            fontFamily: 'JetBrains Mono, monospace', outline: 'none',
          }}
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="flex items-center gap-1 text-sm font-semibold mono"
          style={{ color: paid ? 'var(--accent-green)' : 'var(--tx-primary)', fontFamily: 'JetBrains Mono, monospace', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          {rub(amount, { compact: true })}
          <Pencil size={9} style={{ color: 'var(--tx-dim)' }} />
        </button>
      )}
    </div>
  )
}
