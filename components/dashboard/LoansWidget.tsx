import { Landmark } from 'lucide-react'
import type { DashboardData } from '@/lib/types'
import { rub, calcLoansSummary } from '@/lib/finance'
import LoanRow from './LoanRow'

export default function LoansWidget({ data }: { data: DashboardData }) {
  const { loans } = data
  const summary = calcLoansSummary(data)

  return (
    <div className="card p-5 flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Landmark size={14} style={{ color: 'var(--accent-violet)' }} />
          <span className="text-sm font-medium">Кредиты</span>
          {loans.length > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-violet)' }}>
              {loans.length}
            </span>
          )}
        </div>
        <div className="text-right">
          <div className="label">общий долг</div>
          <div className="text-xs font-semibold mt-0.5" style={{ color: 'var(--accent-violet)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
            {rub(summary.totalDebt)}
          </div>
        </div>
      </div>

      {/* Summary bar */}
      {loans.length > 0 && (
        <div className="rounded-md p-3 flex items-center justify-between"
          style={{ background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.15)' }}>
          <div>
            <div className="label">платёж/мес</div>
            <div className="text-sm font-bold" style={{ color: 'var(--tx-primary)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
              {rub(summary.totalMinPayment)}
            </div>
          </div>
          <div className="text-right">
            <div className="label">нагрузка на ЗП</div>
            <div className="text-sm font-bold" style={{
              color: summary.monthlyBurden > 40 ? 'var(--accent-red)' : summary.monthlyBurden > 25 ? 'var(--accent-amber)' : 'var(--accent-green)',
              fontFamily: 'JetBrains Mono, monospace',
            }}>
              {summary.monthlyBurden}%
            </div>
          </div>
        </div>
      )}

      {/* List */}
      {loans.length === 0 ? (
        <div className="text-center py-6">
          <div className="text-2xl mb-2">🎉</div>
          <div className="text-sm" style={{ color: 'var(--tx-muted)' }}>Кредитов нет</div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {loans.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).map((loan) => (
            <LoanRow key={loan.id} loan={loan} />
          ))}
        </div>
      )}
    </div>
  )
}
