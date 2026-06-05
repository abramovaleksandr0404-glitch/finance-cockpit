'use client'

import type { CustomCategory, Expense } from '@/lib/types'

export default function HarmfulExpensesWidget({
  customCategories,
  expenses,
}: {
  customCategories: CustomCategory[]
  expenses: Expense[]
}) {
  if (!customCategories.length) return null

  return (
    <div className="widget">
      <div className="widget-header">
        <span>📉 Вредные расходы</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {customCategories.map(cat => {
          const catExpenses = expenses.filter(e => (e as { custom_category_id?: string }).custom_category_id === cat.id)
          const spent = catExpenses.reduce((s, e) => s + Number(e.amount), 0)
          const limit = cat.monthly_limit ?? 5000
          const pct = limit > 0 ? Math.min(100, Math.round(spent / limit * 100)) : 0
          const barColor = pct < 50 ? '#22c55e' : pct < 80 ? '#f59e0b' : '#ef4444'

          return (
            <div key={cat.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px' }}>
                <span style={{ fontSize: '13px', fontWeight: 600 }}>{cat.name}</span>
                <span style={{ fontSize: '12px', color: barColor, fontVariantNumeric: 'tabular-nums' }}>
                  {Math.round(spent).toLocaleString('ru-RU')} / {Math.round(limit).toLocaleString('ru-RU')} ₽
                  {' '}({pct}%)
                </span>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: '4px', height: '6px', overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: '4px', transition: 'width 0.4s ease' }} />
              </div>
              {catExpenses.length > 0 && (
                <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  {catExpenses.slice(0, 5).map((e, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--tx-muted)' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>
                        {String(e.expense_date).slice(5)} {(e as { description?: string | null }).description ?? ''}
                      </span>
                      <span style={{ flexShrink: 0, marginLeft: '8px' }}>
                        {Math.round(Number(e.amount)).toLocaleString('ru-RU')} ₽
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
