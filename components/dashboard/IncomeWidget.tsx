import { Briefcase, Gift, ArrowRight, Users, TrendingUp, Coins } from 'lucide-react'
import type { DashboardData } from '@/lib/types'
import { rub, calcIncome, monthLabel } from '@/lib/finance'
import { computeMonthlyBonus, computeQuarterlyBonus, sumQuarterClients, parseMonthKey, quarterOf } from '@/lib/engine'
import ClientRevenueEntry from './ClientRevenueEntry'

const GRADE_LABELS: Record<string, string> = {
  g3: 'Гр3', g4: 'Гр4', g56: 'Гр5-6', g78: 'Гр7-8', g9: 'Гр9', g10: 'Гр10',
}

export default function IncomeWidget({ data, monthKey }: { data: DashboardData; monthKey: string }) {
  const { user, allMonths } = data
  const month = allMonths.find((m) => m.month_key === monthKey) ?? null
  const inc = calcIncome(data, monthKey)
  const { m } = parseMonthKey(monthKey)

  const clients = month?.clients ?? {}
  const clientCount = Object.values(clients).reduce((s, n) => s + (n || 0), 0)
  const revenue = month?.revenue ?? 0

  // ЗАДАЧА 6: регулярные доходы (стипендия и т.п.)
  // user/month — автогенерированные типы из схемы БД; поля recurring_* читаем через безопасный каст
  const recurringIncomes = (((user as unknown) as Record<string, unknown>)?.recurring_incomes ?? []) as { day: number; name: string; amount: number }[]
  const recurringReceived = (((month as unknown) as Record<string, unknown>)?.recurring_received ?? []) as string[]

  // Bonus this month's revenue will generate (paid next month)
  const bonusNext = computeMonthlyBonus(clients, revenue, user, month?.bonus_override).net

  const nextLabel = (() => {
    const { y, m: mm } = parseMonthKey(monthKey)
    return new Date(y, mm, 1).toLocaleDateString('ru-RU', { month: 'long' })
  })()

  // Quarter progress
  const { y } = parseMonthKey(monthKey)
  const q = quarterOf(m)
  const qMonths = allMonths.filter((mo) => {
    const p = parseMonthKey(mo.month_key)
    return p.y === y && quarterOf(p.m) === q
  })
  const qClients = sumQuarterClients(qMonths)
  const qClientCount = Object.values(qClients).reduce((s, n) => s + (n || 0), 0)
  const qBonus = computeQuarterlyBonus(qClients, user)

  const clientEntries = Object.entries(clients).filter(([, n]) => n > 0)

  return (
    <div className="card p-5 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Briefcase size={14} style={{ color: 'var(--accent-blue)' }} />
        <span className="text-sm font-medium">Сделки и бонусы · {monthLabel(monthKey).split(' ')[0]}</span>
      </div>

      {/* Closed clients */}
      <div className="rounded-lg p-3" style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <Users size={12} style={{ color: 'var(--tx-muted)' }} />
            <span className="label">Закрыто клиентов</span>
          </div>
          <span className="text-lg font-bold" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{clientCount}</span>
        </div>
        {clientEntries.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {clientEntries.map(([g, n]) => (
              <span key={g} className="text-xs px-2 py-0.5 rounded"
                style={{ background: 'rgba(6,182,212,0.1)', color: 'var(--accent-cyan)', whiteSpace: 'nowrap' }}>
                {n}× {GRADE_LABELS[g] ?? g}
              </span>
            ))}
          </div>
        ) : (
          <span className="label">пока нет закрытых клиентов</span>
        )}
      </div>

      {/* Revenue → bonus next month */}
      <div className="rounded-lg p-3" style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.15)' }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <TrendingUp size={12} style={{ color: 'var(--accent-amber)' }} />
            <span className="label">Выручка месяца</span>
          </div>
          <span className="text-base font-bold" style={{ fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>{rub(revenue)}</span>
        </div>
        <div className="flex items-center gap-1.5 mt-2 pt-2" style={{ borderTop: '1px solid rgba(245,158,11,0.12)' }}>
          <ArrowRight size={11} style={{ color: 'var(--accent-amber)' }} />
          <span className="label">бонус в {nextLabel}:</span>
          <span className="text-sm font-semibold" style={{ color: 'var(--accent-amber)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
            {rub(bonusNext)}
          </span>
        </div>
      </div>

      {/* Bonus received this month (in take-home) */}
      {inc.bonusReceived > 0 && (
        <div className="flex items-center gap-2 px-1">
          <Gift size={12} style={{ color: 'var(--accent-green)' }} />
          <span className="text-xs" style={{ color: 'var(--tx-primary)' }}>Бонус в доходе этого месяца</span>
          <span className="text-xs font-semibold ml-auto" style={{ color: 'var(--accent-green)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
            +{rub(inc.bonusReceived)}
          </span>
        </div>
      )}

      {/* Quarterly bonus */}
      <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.05)', border: '1px solid rgba(139,92,246,0.15)' }}>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-1.5">
            <Coins size={12} style={{ color: 'var(--accent-violet)' }} />
            <span className="label">Квартальный бонус (Q{q})</span>
          </div>
          <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'rgba(139,92,246,0.12)', color: 'var(--accent-violet)', whiteSpace: 'nowrap' }}>
            {qClientCount} клиентов
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="label">прогноз (×{qBonus.mult})</span>
          <span className="text-sm font-semibold" style={{ color: 'var(--accent-violet)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
            {rub(qBonus.net)}
          </span>
        </div>
      </div>

      {/* ЗАДАЧА 6: Регулярные доходы */}
      {recurringIncomes.length > 0 && (
        <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
          <div className="flex items-center gap-1.5 mb-2">
            <Coins size={12} style={{ color: 'var(--accent-green)' }} />
            <span className="label">Регулярные доходы</span>
          </div>
          {recurringIncomes.map((ri) => {
            const isReceived = recurringReceived.includes(ri.name)
            return (
              <div key={ri.name} className="flex items-center justify-between" style={{ marginBottom: '0.25rem' }}>
                <span className="label" style={{ fontSize: '0.8rem' }}>
                  {ri.name} ({ri.day}-го) {isReceived ? '✅' : '⏳'}
                </span>
                <span className="text-sm font-semibold" style={{ color: isReceived ? 'var(--accent-green)' : 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
                  {rub(ri.amount)}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* Entry: add clients + deal revenue */}
      <ClientRevenueEntry monthKey={monthKey} currentClients={clients} currentRevenue={revenue} />
    </div>
  )
}
