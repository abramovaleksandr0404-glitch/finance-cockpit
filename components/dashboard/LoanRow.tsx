'use client'

import { useState, useTransition } from 'react'
import { ChevronRight, Zap, Pencil, Loader2, Check, X } from 'lucide-react'
import { earlyRepayLoan, editLoanPayment } from '@/app/actions'
import { rub } from '@/lib/finance'
import { annuityPayment } from '@/lib/calc'
import type { Loan } from '@/lib/types'

export default function LoanRow({ loan }: { loan: Loan }) {
  const total = Number(loan.principal) + Number(loan.accrued_int)
  const payoffPct = Math.round(((Number(loan.original_amt) - Number(loan.principal)) / Number(loan.original_amt)) * 100)

  // Annuity payment split — rate годовая, делим на 12 для месячной (иначе % > платежа → тело уходит в минус)
  const monthlyRate = Number(loan.rate) / 12
  const interestPart = Math.round(Number(loan.principal) * monthlyRate)
  const principalPart = Math.max(0, Number(loan.min_payment) - interestPart) // для аннуитета всегда > 0

  // Months remaining and payoff date from end_date
  const monthsLeft = (() => {
    if (!loan.end_date) return null
    const now = new Date()
    const end = new Date(loan.end_date)
    return Math.max(0, (end.getFullYear() - now.getFullYear()) * 12 + end.getMonth() - now.getMonth())
  })()

  const endLabel = loan.end_date ? new Date(loan.end_date).toLocaleDateString('ru-RU', { month: 'short', year: '2-digit' }) : null

  const [mode, setMode] = useState<null | 'repay' | 'edit'>(null)
  const [pending, startTransition] = useTransition()
  const [repay, setRepay] = useState('')
  const [pay, setPay] = useState(String(loan.min_payment))

  // Preview the new payment after early repayment (annuity, same term)
  const repayNum = parseFloat(repay)
  const newPrincipal = Math.max(0, Number(loan.principal) - repayNum)
  const preview = !isNaN(repayNum) && repayNum > 0 && Number(loan.principal) > 0
    ? (monthsLeft && monthsLeft > 0 && monthlyRate > 0
        ? Math.round(annuityPayment(newPrincipal, monthlyRate, monthsLeft))
        : Math.round(Number(loan.min_payment) * newPrincipal / Number(loan.principal)))
    : null

  function doRepay() {
    if (isNaN(repayNum) || repayNum <= 0) return
    startTransition(async () => {
      await earlyRepayLoan(loan.id, repayNum)
      setRepay(''); setMode(null)
    })
  }
  function doEdit() {
    const p = parseFloat(pay)
    if (isNaN(p) || p <= 0) return
    startTransition(async () => {
      await editLoanPayment(loan.id, p)
      setMode(null)
    })
  }

  return (
    <div className="flex flex-col gap-2 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <ChevronRight size={12} style={{ color: 'var(--accent-violet)' }} />
          <span className="text-sm font-medium truncate">{loan.name}</span>
          <span className="label flex-shrink-0">{(Number(loan.rate) * 100).toFixed(2)}%</span>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-xs font-semibold" style={{ fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>{rub(total)}</div>
          <div className="label" style={{ whiteSpace: 'nowrap' }}>платёж {rub(Number(loan.min_payment))}</div>
          {Number(loan.principal) > 0 && (
            <div className="label" style={{ whiteSpace: 'nowrap' }}>тело {rub(principalPart)} · % {rub(interestPart)}</div>
          )}
        </div>
      </div>

      <div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${payoffPct}%`, background: payoffPct > 75 ? 'var(--accent-green)' : 'var(--accent-violet)' }} />
        </div>
        <div className="flex justify-between mt-0.5">
          <span className="label">погашено {payoffPct}% · до {loan.due_day === 'last' ? 'конца мес.' : loan.due_day + ' числа'}</span>
          {monthsLeft != null && endLabel && (
            <span className="label" style={{ color: monthsLeft <= 12 ? 'var(--accent-green)' : 'var(--tx-dim)', whiteSpace: 'nowrap' }}>
              {monthsLeft} мес · {endLabel}
            </span>
          )}
        </div>
      </div>

      {/* Action buttons */}
      {mode === null && (
        <div className="flex gap-2">
          <button onClick={() => setMode('repay')} className="flex items-center gap-1 text-xs px-2 py-1 rounded"
            style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', color: 'var(--accent-green)', cursor: 'pointer' }}>
            <Zap size={10} /> досрочно
          </button>
          <button onClick={() => setMode('edit')} className="flex items-center gap-1 text-xs px-2 py-1 rounded"
            style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', color: 'var(--tx-muted)', cursor: 'pointer' }}>
            <Pencil size={10} /> платёж
          </button>
        </div>
      )}

      {/* Early repayment */}
      {mode === 'repay' && (
        <div className="flex flex-col gap-2 p-2.5 rounded-md animate-slide-up" style={{ background: 'var(--bg-hover)', border: '1px solid rgba(34,197,94,0.25)' }}>
          <span className="label">Досрочное погашение (спишется с дебета, платёж пересчитается)</span>
          <div className="flex gap-1.5">
            <input type="number" value={repay} autoFocus placeholder="сумма ₽" onChange={(e) => setRepay(e.target.value)}
              className="input-base" style={{ minWidth: 0, flex: 1, fontFamily: 'JetBrains Mono, monospace', fontSize: '13px' }} />
            <button onClick={doRepay} disabled={pending} className="px-2.5 rounded-md flex items-center"
              style={{ background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)', cursor: 'pointer' }}>
              {pending ? <Loader2 size={13} className="animate-spin" style={{ color: 'var(--accent-green)' }} /> : <Check size={13} style={{ color: 'var(--accent-green)' }} />}
            </button>
            <button onClick={() => { setMode(null); setRepay('') }} className="px-2 rounded-md flex items-center"
              style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', cursor: 'pointer' }}>
              <X size={13} style={{ color: 'var(--tx-muted)' }} />
            </button>
          </div>
          {preview != null && (
            <span className="label">новый платёж: <span style={{ color: 'var(--accent-green)', fontFamily: 'JetBrains Mono, monospace' }}>{rub(preview)}</span> (было {rub(Number(loan.min_payment))})</span>
          )}
        </div>
      )}

      {/* Edit payment */}
      {mode === 'edit' && (
        <div className="flex flex-col gap-2 p-2.5 rounded-md animate-slide-up" style={{ background: 'var(--bg-hover)', border: '1px solid var(--border-bright)' }}>
          <span className="label">Ежемесячный платёж (подгони под банк)</span>
          <div className="flex gap-1.5">
            <input type="number" value={pay} autoFocus onChange={(e) => setPay(e.target.value)}
              className="input-base" style={{ minWidth: 0, flex: 1, fontFamily: 'JetBrains Mono, monospace', fontSize: '13px' }} />
            <button onClick={doEdit} disabled={pending} className="px-2.5 rounded-md flex items-center"
              style={{ background: 'rgba(6,182,212,0.15)', border: '1px solid rgba(6,182,212,0.3)', cursor: 'pointer' }}>
              {pending ? <Loader2 size={13} className="animate-spin" style={{ color: 'var(--accent-cyan)' }} /> : <Check size={13} style={{ color: 'var(--accent-cyan)' }} />}
            </button>
            <button onClick={() => { setMode(null); setPay(String(loan.min_payment)) }} className="px-2 rounded-md flex items-center"
              style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', cursor: 'pointer' }}>
              <X size={13} style={{ color: 'var(--tx-muted)' }} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
