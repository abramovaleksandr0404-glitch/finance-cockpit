import { ShoppingBag, Target } from 'lucide-react'
import type { DashboardData } from '@/lib/types'
import { rub, monthLabel } from '@/lib/finance'
import PlannedPurchaseRow from './PlannedPurchaseRow'
import SavingsGoalRow from './SavingsGoalRow'
import AddGoalForm from './AddGoalForm'

export default function GoalsWidget({ data, monthKey }: { data: DashboardData; monthKey: string }) {
  const { goals, cards, user } = data
  const planned = goals.filter((g) => g.month_key === monthKey).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
  const savings = goals.filter((g) => !g.month_key).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
  const monthName = monthLabel(monthKey).split(' ')[0]
  const plannedTotal = planned.reduce((s, g) => s + g.amount, 0)
  const plannedBought = planned.filter((g) => g.purchased).reduce((s, g) => s + g.amount, 0)

  const accountOptions = [
    { id: 'sber', label: 'Сбер дебет' },
    { id: 'tbank', label: 'Т-Банк дебет' },
    ...cards.map((c) => ({ id: c.id, label: c.name + ' (кредит)' })),
  ]

  return (
    <div className="card p-5 flex flex-col gap-4">
      {/* Planned purchases */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <ShoppingBag size={14} style={{ color: 'var(--accent-amber)' }} />
            <span className="text-sm font-medium">Плановые покупки · {monthName}</span>
          </div>
          {plannedTotal > 0 && (
            <div className="text-right">
              <span className="text-xs font-bold" style={{ color: 'var(--accent-amber)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
                {plannedBought > 0 ? `куплено ${rub(plannedBought, { compact: true })} / ` : ''}−{rub(plannedTotal)}
              </span>
            </div>
          )}
        </div>

        {planned.length === 0
          ? <div className="label text-center py-2">нет плановых покупок в этом месяце</div>
          : <div className="flex flex-col gap-1.5">
              {planned.map((g) => (
                <PlannedPurchaseRow key={g.id} id={g.id} name={g.name} amount={g.amount}
                  purchased={g.purchased ?? false} accountOptions={accountOptions} />
              ))}
            </div>
        }
        <div className="mt-2"><AddGoalForm monthKey={monthKey} kind="planned" /></div>
      </div>

      {/* Savings goals */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Target size={14} style={{ color: 'var(--accent-cyan)' }} />
            <span className="text-sm font-medium">Цели-накопления</span>
          </div>
          {savings.length > 0 && (
            <span className="label">{rub(savings.reduce((s,g)=>s+g.amount,0), { compact: true })} всего</span>
          )}
        </div>
        {savings.length === 0
          ? <div className="label text-center py-2">целей-накоплений нет</div>
          : <div className="flex flex-col gap-1.5">
              {savings.map((g) => (
                <SavingsGoalRow key={g.id} id={g.id} name={g.name} amount={g.amount} monthKey={monthKey} />
              ))}
            </div>
        }
        <div className="mt-2"><AddGoalForm monthKey={monthKey} kind="savings" /></div>
      </div>
    </div>
  )
}
