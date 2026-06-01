'use client'

import { useState, useTransition } from 'react'
import { Check, Circle, Loader2 } from 'lucide-react'
import { setSalaryAdvance, setSalaryEom, payLoan, unpayLoan } from '@/app/actions'
import type { CashflowEvent } from '@/lib/finance'

export default function EventRealizeBtn({
  monthKey,
  evt,
}: {
  monthKey: string
  evt: CashflowEvent
}) {
  const [pending, startTransition] = useTransition()
  const [done, setDone] = useState(evt.done)

  if (!evt.ref) return null

  function toggle() {
    const next = !done
    setDone(next)
    startTransition(async () => {
      const ref = evt.ref!
      if (ref.kind === 'advance') {
        await setSalaryAdvance(monthKey, next, Math.abs(evt.amount))
      } else if (ref.kind === 'eom') {
        await setSalaryEom(monthKey, next, ref.salaryAmt, ref.bonusAmt)
      } else if (ref.kind === 'loan') {
        if (next) await payLoan(monthKey, ref.loanId, ref.payment)
        else await unpayLoan(monthKey, ref.loanId, ref.payment)
      }
    })
  }

  return (
    <button
      onClick={toggle}
      disabled={pending}
      title={done ? 'Отменить' : 'Отметить выполненным'}
      className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-all"
      style={{
        background: done ? 'rgba(34,197,94,0.12)' : 'var(--bg-hover)',
        border: `1px solid ${done ? 'rgba(34,197,94,0.4)' : 'var(--border)'}`,
        cursor: pending ? 'wait' : 'pointer',
      }}
    >
      {pending ? (
        <Loader2 size={14} className="animate-spin" style={{ color: 'var(--tx-muted)' }} />
      ) : done ? (
        <Check size={14} style={{ color: 'var(--accent-green)' }} />
      ) : (
        <Circle size={13} style={{ color: 'var(--tx-muted)' }} />
      )}
    </button>
  )
}
