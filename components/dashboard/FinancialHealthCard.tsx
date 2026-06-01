'use client'

import { Zap, Percent, Clock, ShoppingBag } from 'lucide-react'
import {
  rub, pct,
  dailyBudgetAllowance, savingsRate, daysUntilPayday, daysRemainingInMonth,
  calcMonthSummary,
} from '@/lib/finance'
import type { DashboardData } from '@/lib/types'

export default function FinancialHealthCard({ data, monthKey }: { data: DashboardData; monthKey: string }) {
  const daily = dailyBudgetAllowance(data, monthKey)
  const rate = savingsRate(data, monthKey)
  const daysLeft = daysRemainingInMonth(monthKey)
  const payday = daysUntilPayday(data, monthKey)
  const s = calcMonthSummary(data, monthKey)
  const varBudget = data.user.var_budget
  const varSpent = s.variableSpent
  const varLeft = Math.max(0, varBudget - varSpent)
  const varPct = Math.min(100, Math.round(pct(varSpent, varBudget)))

  const rateColor = rate > 40 ? 'var(--accent-green)' : rate > 20 ? 'var(--accent-amber)' : 'var(--accent-red)'
  const dailyColor = daily > 1500 ? 'var(--accent-green)' : daily > 800 ? 'var(--accent-amber)' : 'var(--accent-red)'
  const varColor = varPct < 60 ? 'var(--accent-green)' : varPct < 85 ? 'var(--accent-amber)' : 'var(--accent-red)'

  return (
    <div className="card p-4 flex flex-col gap-4">

      {/* Variable spending gauge */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <ShoppingBag size={13} style={{ color: varColor, flexShrink: 0 }} />
            <span className="label">Переменные траты</span>
          </div>
          <span className="label" style={{ color: varColor }}>{varPct}%</span>
        </div>
        <div className="progress-track" style={{ height: '6px' }}>
          <div className="progress-fill" style={{ width: `${varPct}%`, background: varColor }} />
        </div>
        <div className="flex justify-between mt-1.5">
          <span className="text-sm font-bold" style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--tx-primary)', whiteSpace: 'nowrap' }}>
            {rub(varSpent, { compact: true })} потрачено
          </span>
          <span className="text-sm font-semibold" style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--tx-muted)', whiteSpace: 'nowrap' }}>
            из {rub(varBudget, { compact: true })}
          </span>
        </div>
      </div>

      {/* Daily budget + savings rate */}
      <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>

        {/* Daily budget */}
        <div>
          <div className="flex items-center gap-1 mb-1">
            <Zap size={11} style={{ color: dailyColor, flexShrink: 0 }} />
            <span className="label">Дневной бюджет</span>
          </div>
          <div className="text-2xl font-bold" style={{ color: dailyColor, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>
            {rub(daily, { compact: true })}
          </div>
          <div className="label" style={{ marginTop: '2px' }}>
            {rub(varLeft, { compact: true })} / {daysLeft} дней
          </div>
        </div>

        {/* Savings rate */}
        <div>
          <div className="flex items-center gap-1 mb-1">
            <Percent size={11} style={{ color: rateColor, flexShrink: 0 }} />
            <span className="label">Норма сбережений</span>
          </div>
          <div className="text-2xl font-bold" style={{ color: rateColor, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>
            {rate > 0 ? `${rate}%` : '—'}
          </div>
          <div className="label" style={{ marginTop: '2px' }}>
            остаётся от дохода
          </div>
        </div>
      </div>

      {/* Days until payday */}
      <div className="flex items-center gap-2 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
        <Clock size={12} style={{ color: 'var(--accent-cyan)', flexShrink: 0 }} />
        {payday ? (
          <>
            <span className="label flex-1">{payday.label}</span>
            <span className="text-sm font-bold" style={{ color: 'var(--accent-cyan)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
              {payday.days === 0 ? 'сегодня' : `через ${payday.days} дн.`}
            </span>
          </>
        ) : (
          <span className="label">все выплаты получены ✓</span>
        )}
      </div>
    </div>
  )
}
