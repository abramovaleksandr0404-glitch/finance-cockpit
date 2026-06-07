import { CreditCard, Wallet } from 'lucide-react'
import type { DashboardData } from '@/lib/types'
import { rub, pct } from '@/lib/finance'
import BalanceEditor from './BalanceEditor'

export default function CardsWidget({ data }: { data: DashboardData }) {
  const { cards, user } = data
  const totalAvailable = cards.reduce((s, c) => s + Math.max(0, c.card_limit - c.current_debt), 0)
  const totalDebt = cards.reduce((s, c) => s + c.current_debt, 0)
  const totalDebit = (user.debit_balance ?? 0) + (user.tbank_debit ?? 0)
  const netPosition = totalDebit - totalDebt

  function barColor(debt: number, limit: number) {
    const used = pct(debt, limit)
    if (used > 80) return 'var(--accent-red)'
    if (used > 50) return 'var(--accent-amber)'
    return 'var(--accent-cyan)'
  }

  return (
    <div className="card p-5 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Wallet size={14} style={{ color: 'var(--accent-green)' }} />
        <span className="text-sm font-medium">Счета и карты</span>
      </div>

      {/* Debit accounts */}
      <div className="flex flex-col gap-2">
        <div className="label">Дебетовые счета</div>
        <div className="flex items-center justify-between py-2 px-3 rounded-md"
          style={{ background: 'rgba(34,197,94,0.05)', border: '1px solid var(--border)' }}>
          <span className="text-sm">Сбер</span>
          <BalanceEditor currentBalance={user.debit_balance} kind="sber" />
        </div>
        <div className="flex items-center justify-between py-2 px-3 rounded-md"
          style={{ background: 'rgba(245,206,8,0.05)', border: '1px solid var(--border)' }}>
          <span className="text-sm">Т-Банк</span>
          <BalanceEditor currentBalance={user.tbank_debit ?? 0} kind="tbank" />
        </div>
      </div>

      {/* Net position */}
      {totalDebt > 0 && (
        <div className="flex items-center justify-between py-2 px-3 rounded-md"
          style={{ background: netPosition < 0 ? 'rgba(239,68,68,0.05)' : 'rgba(34,197,94,0.05)', border: '1px solid var(--border)' }}>
          <span className="text-sm">Чистая позиция</span>
          <span className="text-xs font-semibold" style={{ color: netPosition < 0 ? 'var(--accent-red)' : 'var(--accent-green)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
            {netPosition >= 0 ? '+' : ''}{rub(netPosition)}
          </span>
        </div>
      )}

      {/* Credit cards */}
      {cards.length > 0 && (
        <div className="flex flex-col gap-3" style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
          <div className="flex items-center justify-between">
            <div className="label">Кредитные карты</div>
            {totalDebt === 0
              ? <span className="text-xs" style={{ color: 'var(--accent-green)' }}>долгов нет</span>
              : <span className="text-xs" style={{ color: 'var(--accent-red)', fontFamily: 'JetBrains Mono, monospace' }}>долг {rub(totalDebt, { compact: true })}</span>
            }
          </div>
          {cards.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).map((card) => {
            const available = Math.max(0, card.card_limit - card.current_debt)
            const usedPct = pct(card.current_debt, card.card_limit)
            return (
              <div key={card.id} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <CreditCard size={11} style={{ color: 'var(--tx-dim)' }} />
                    <span className="text-sm">{card.name}</span>
                  </div>
                  <div className="text-right" style={{ whiteSpace: 'nowrap' }}>
                    {card.current_debt > 0
                      ? <>
                          <span className="text-xs" style={{ color: 'var(--accent-red)', fontFamily: 'JetBrains Mono, monospace' }}>−{rub(card.current_debt, { compact: true })}</span>
                          <span className="label"> · доступно {rub(available, { compact: true })}</span>
                        </>
                      : <span className="text-xs" style={{ color: 'var(--accent-cyan)', fontFamily: 'JetBrains Mono, monospace' }}>доступно {rub(card.card_limit, { compact: true })}</span>
                    }
                  </div>
                </div>
                {card.current_debt > 0 && (
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${usedPct}%`, background: barColor(card.current_debt, card.card_limit) }} />
                  </div>
                )}
              </div>
            )
          })}
          {totalAvailable > 0 && totalDebt === 0 && (
            <div className="label">кредитная линия {rub(totalAvailable, { compact: true })}</div>
          )}
        </div>
      )}
    </div>
  )
}
