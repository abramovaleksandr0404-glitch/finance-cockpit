import { Wallet, ArrowDownToLine, TrendingDown, CreditCard } from 'lucide-react'
import type { DashboardData } from '@/lib/types'
import { rub, calcMonthSummary, calcLoansSummary } from '@/lib/finance'

export default function StatsBar({ data, monthKey }: { data: DashboardData; monthKey: string }) {
  const { user } = data
  const s = calcMonthSummary(data, monthKey)
  const loans = calcLoansSummary(data)
  const totalLiquid = user.debit_balance + (user.tbank_debit ?? 0)

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 stagger">
      {/* Liquid accounts */}
      <div className="card card-hover rounded-lg p-4 flex flex-col gap-2"
        style={{ background: 'rgba(34,197,94,0.05)', borderColor: 'var(--border)' }}>
        <div className="flex items-center justify-between">
          <span className="label">Ликвидность</span>
          <Wallet size={14} style={{ color: 'var(--accent-green)' }} />
        </div>
        <div className="text-xl font-bold" style={{ color: 'var(--accent-green)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
          {rub(totalLiquid)}
        </div>
        <div className="text-xs" style={{ color: 'var(--tx-muted)', whiteSpace: 'nowrap' }}>
          Сбер {rub(user.debit_balance, { compact: true })}
          {(user.tbank_debit ?? 0) > 0 && <> · Т-Банк {rub(user.tbank_debit, { compact: true })}</>}
        </div>
      </div>

      {/* Real income this month */}
      <div className="card card-hover rounded-lg p-4 flex flex-col gap-2"
        style={{ background: 'rgba(6,182,212,0.06)', borderColor: 'var(--border)' }}>
        <div className="flex items-center justify-between">
          <span className="label">Доход на руки</span>
          <ArrowDownToLine size={14} style={{ color: 'var(--accent-cyan)' }} />
        </div>
        <div className="text-xl font-bold" style={{ color: 'var(--accent-cyan)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
          {rub(s.income.totalIncome)}
        </div>
        <div className="text-xs" style={{ color: 'var(--tx-muted)', whiteSpace: 'nowrap' }}>
          ЗП {rub(s.income.salaryTotal, { compact: true })}
          {s.income.bonusReceived > 0 && <> + бонус {rub(s.income.bonusReceived, { compact: true })}</>}
        </div>
      </div>

      {/* Spent — fixed + variable split */}
      <div className="card card-hover rounded-lg p-4 flex flex-col gap-2"
        style={{ background: 'rgba(30,45,66,0.4)', borderColor: 'var(--border)' }}>
        <div className="flex items-center justify-between">
          <span className="label">Потрачено за месяц</span>
          <TrendingDown size={14} style={{ color: 'var(--tx-primary)' }} />
        </div>
        <div className="text-xl font-bold" style={{ color: 'var(--tx-primary)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
          {rub(s.totalSpent)}
        </div>
        <div className="text-xs flex flex-col gap-0.5" style={{ color: 'var(--tx-muted)' }}>
          <span style={{ whiteSpace: 'nowrap' }}>постоянные {rub(s.fixedSpent, { compact: true })}</span>
          <span style={{ whiteSpace: 'nowrap' }}>переменные {rub(s.variableSpent, { compact: true })}</span>
        </div>
      </div>

      {/* Loan debt */}
      <div className="card card-hover rounded-lg p-4 flex flex-col gap-2"
        style={{ background: 'rgba(139,92,246,0.06)', borderColor: 'var(--border)' }}>
        <div className="flex items-center justify-between">
          <span className="label">Долг по кредитам</span>
          <CreditCard size={14} style={{ color: 'var(--accent-violet)' }} />
        </div>
        <div className="text-xl font-bold" style={{ color: 'var(--accent-violet)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
          {rub(loans.totalDebt, { compact: true })}
        </div>
        <div className="text-xs" style={{ color: 'var(--tx-muted)', whiteSpace: 'nowrap' }}>
          платёж/мес {rub(loans.totalMinPayment, { compact: true })}
        </div>
      </div>
    </div>
  )
}
