import { ReceiptText, Wallet, CreditCard } from 'lucide-react'
import type { DashboardData } from '@/lib/types'
import { rub, calcExpensesByCategory, calcMonthSummary } from '@/lib/finance'
import AddExpenseForm from './AddExpenseForm'
import DeleteExpenseBtn from './DeleteExpenseBtn'

const CATEGORY_COLORS: Record<string, string> = {
  'Такси': '#f97316', 'Продукты': '#22c55e', 'Фастфуд': '#f59e0b',
  'Кафе и рестораны': '#eab308', 'Транспорт': '#0ea5e9',
  'Витамины и здоровье': '#ec4899', 'Одежда': '#14b8a6',
  'Красота': '#f472b6', 'Развлечения': '#a855f7', 'Прочее': '#64748b',
}

function getColor(cat: string) {
  return CATEGORY_COLORS[cat] ?? '#64748b'
}

export default function ExpensesWidget({ data, monthKey }: { data: DashboardData; monthKey: string }) {
  const { expenses, cards } = data
  const categories = calcExpensesByCategory(expenses)
  const s = calcMonthSummary(data, monthKey)

  const cardName = (id: string | null) => cards.find((c) => c.id === id)?.name ?? 'карта'

  const sortedExpenses = [...expenses].sort((a, b) => b.expense_date.localeCompare(a.expense_date))
  const gaugeColor = s.varUsedPct > 90 ? 'var(--accent-red)' : s.varUsedPct > 70 ? 'var(--accent-amber)' : 'var(--accent-green)'

  return (
    <div className="card p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ReceiptText size={14} style={{ color: 'var(--accent-green)' }} />
          <span className="text-sm font-medium">Переменные траты</span>
          {expenses.length > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(34,197,94,0.1)', color: 'var(--accent-green)' }}>
              {expenses.length}
            </span>
          )}
        </div>
        <AddExpenseForm monthKey={monthKey} cards={data.cards} />
      </div>

      {/* Variable spending gauge vs limit */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="label">из лимита {rub(s.varLimit)}</span>
          <span className="text-xs font-bold" style={{ color: gaugeColor, fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
            {rub(s.variableSpent)} · осталось {rub(s.varLeft, { compact: true })}
          </span>
        </div>
        <div className="progress-track" style={{ height: '6px' }}>
          <div className="progress-fill" style={{ width: `${Math.min(s.varUsedPct, 100)}%`, background: gaugeColor }} />
        </div>
      </div>

      {/* Stacked category bar */}
      {categories.length > 0 && (
        <div className="h-2 rounded-full overflow-hidden flex gap-px">
          {categories.map((c) => (
            <div key={c.category} title={`${c.category}: ${rub(c.amount)} (${c.pct}%)`}
              style={{ width: `${c.pct}%`, background: getColor(c.category), minWidth: c.pct > 0 ? '2px' : '0' }} />
          ))}
        </div>
      )}

      {expenses.length === 0 ? (
        <div className="text-center py-6 animate-fade-in">
          <div className="text-3xl mb-2">📊</div>
          <div className="text-sm" style={{ color: 'var(--tx-muted)' }}>Трат пока нет. Нажми «Добавить» выше.</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {/* Category breakdown */}
          <div>
            <div className="label mb-2">По категориям</div>
            <div className="flex flex-col gap-2">
              {categories.slice(0, 8).map((c) => (
                <div key={c.category} className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: getColor(c.category) }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-xs truncate">{c.category}</span>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className="label">{c.pct}%</span>
                        <span className="text-xs" style={{ fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>{rub(c.amount)}</span>
                      </div>
                    </div>
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${c.pct}%`, background: getColor(c.category) }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent expenses with source */}
          <div>
            <div className="label mb-2">Последние</div>
            <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto pr-1">
              {sortedExpenses.slice(0, 15).map((e) => (
                <div key={e.id} className="group flex items-center gap-2 py-1.5 px-2 rounded-md">
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: getColor(e.category) }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs truncate">{e.description || e.category}</div>
                    <div className="label flex items-center gap-1">
                      {e.source_type === 'card'
                        ? <><CreditCard size={9} /> {cardName(e.card_id)} (кредит)</>
                        : <><Wallet size={9} /> дебет</>}
                      · {e.expense_date.slice(5)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className="text-xs font-semibold" style={{ color: 'var(--accent-red)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
                      −{rub(e.amount)}
                    </span>
                    <DeleteExpenseBtn id={e.id} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
