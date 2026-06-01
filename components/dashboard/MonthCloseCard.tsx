'use client'

import { useState, useTransition } from 'react'
import { Lock, Unlock, Loader2, CheckCircle2 } from 'lucide-react'
import { closeMonth, reopenMonth } from '@/app/actions'
import { rub, calcMonthSummary, getProjectedEnd, monthLabel } from '@/lib/finance'
import type { DashboardData } from '@/lib/types'

export default function MonthCloseCard({ data, monthKey }: { data: DashboardData; monthKey: string }) {
  const month = data.allMonths.find((m) => m.month_key === monthKey) ?? null
  const closed = month?.closed ?? false
  const s = calcMonthSummary(data, monthKey)
  const projEnd = getProjectedEnd(data, monthKey)
  const monthName = monthLabel(monthKey)

  const [pending, startTransition] = useTransition()

  const summary = {
    income: s.income.totalIncome,
    salary: s.income.salaryTotal,
    bonus: s.income.bonusReceived,
    variableSpent: s.variableSpent,
    fixedSpent: s.fixedSpent,
    revenue: s.revenue,
    bonusEarned: s.income.bonusEarnedThisMonth,
    endBalance: projEnd,
  }
  const stored = (month?.summary ?? summary) as typeof summary

  function close() {
    startTransition(async () => { await closeMonth(monthKey, summary) })
  }
  function reopen() {
    startTransition(async () => { await reopenMonth(monthKey) })
  }

  if (closed) {
    return (
      <div className="card p-5 flex flex-col gap-3" style={{ background: 'rgba(34,197,94,0.04)', borderColor: 'rgba(34,197,94,0.2)' }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={15} style={{ color: 'var(--accent-green)' }} />
            <span className="text-sm font-medium">{monthName} закрыт</span>
          </div>
          <button onClick={reopen} disabled={pending} className="flex items-center gap-1 text-xs px-2 py-1 rounded"
            style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', color: 'var(--tx-muted)', cursor: 'pointer' }}>
            {pending ? <Loader2 size={11} className="animate-spin" /> : <Unlock size={11} />} открыть
          </button>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <SummaryRow label="Доход на руки" value={stored.income} color="var(--accent-cyan)" />
          <SummaryRow label="Выручка" value={stored.revenue} color="var(--accent-amber)" />
          <SummaryRow label="Постоянные" value={stored.fixedSpent} />
          <SummaryRow label="Переменные" value={stored.variableSpent} />
          <SummaryRow label="Бонус получен" value={stored.bonus} color="var(--accent-green)" />
          <SummaryRow label="Бонус заработан" value={stored.bonusEarned} color="var(--accent-amber)" />
          <SummaryRow label="Остаток на конец" value={stored.endBalance} color="var(--accent-green)" bold />
        </div>
      </div>
    )
  }

  return (
    <div className="card p-4 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{monthName}</div>
        <div className="label" style={{ whiteSpace: 'normal' }}>
          доход {rub(summary.income, { compact: true })} · потрачено {rub(summary.fixedSpent + summary.variableSpent, { compact: true })} · остаток {rub(summary.endBalance, { compact: true })}
        </div>
      </div>
      <button onClick={close} disabled={pending} className="flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium"
        style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', color: 'var(--accent-green)', cursor: 'pointer' }}>
        {pending ? <Loader2 size={13} className="animate-spin" /> : <Lock size={13} />} Закрыть месяц
      </button>
    </div>
  )
}

function SummaryRow({ label, value, color, bold }: { label: string; value: number; color?: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="label">{label}</span>
      <span className={bold ? 'text-sm font-bold' : 'text-xs font-semibold'}
        style={{ color: color ?? 'var(--tx-primary)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
        {rub(value)}
      </span>
    </div>
  )
}
