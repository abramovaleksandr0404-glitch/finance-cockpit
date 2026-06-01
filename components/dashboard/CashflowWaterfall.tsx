import { ArrowUp, ArrowDown, TrendingUp, Wallet, ShoppingBag } from 'lucide-react'
import type { DashboardData } from '@/lib/types'
import { rub, getProjectedEnd, getPlannedRemainder, getCashflowEvents, getMonthStartBalance, monthGoalsTotal, monthLabel } from '@/lib/finance'
import EventRealizeBtn from './EventRealizeBtn'

export default function CashflowWaterfall({ data, monthKey }: { data: DashboardData; monthKey: string }) {
  const projEnd = getProjectedEnd(data, monthKey)
  const plannedTotal = monthGoalsTotal(data, monthKey)
  const plannedRemainder = getPlannedRemainder(data, monthKey)
  const events = getCashflowEvents(data, monthKey)
  const startBalance = getMonthStartBalance(data, monthKey)
  const monthName = monthLabel(monthKey).split(' ')[0]

  // Running balance: only PENDING events move it (done already baked into start)
  let running = startBalance
  const rows = events.map((e) => {
    if (!e.done) running += e.amount
    return { ...e, balanceAfter: running, showBalance: !e.done }
  })

  function eventColor(type: string, amount: number) {
    if (amount > 0) return 'var(--accent-green)'
    if (type === 'loan') return 'var(--accent-violet)'
    if (type === 'fixed') return 'var(--accent-amber)'
    return 'var(--accent-red)'
  }

  return (
    <div className="card overflow-hidden">
      {/* Hero */}
      <div className="p-5 sm:p-6"
        style={{
          background: projEnd >= 0
            ? 'linear-gradient(135deg, rgba(34,197,94,0.12), rgba(6,182,212,0.06))'
            : 'linear-gradient(135deg, rgba(239,68,68,0.12), rgba(245,158,11,0.06))',
          borderBottom: '1px solid var(--border)',
        }}>
        <div className="flex items-center gap-1.5 mb-1">
          <TrendingUp size={13} style={{ color: projEnd >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }} />
          <span className="label">Остаток к концу {monthName}</span>
        </div>
        <div className="text-3xl sm:text-4xl font-bold leading-none"
          style={{ color: projEnd >= 0 ? 'var(--accent-green)' : 'var(--accent-red)', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>
          {rub(projEnd)}
        </div>
        <div className="flex items-center gap-1.5 mt-2.5">
          <Wallet size={11} style={{ color: 'var(--tx-muted)' }} />
          <span className="label">старт {rub(startBalance)} · деньги на счёте к концу месяца</span>
        </div>

        {/* Planned purchases → planned remainder */}
        {plannedTotal > 0 && (
          <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <div className="flex items-center gap-1.5 mb-1">
              <ShoppingBag size={11} style={{ color: 'var(--accent-amber)', flexShrink: 0 }} />
              <span className="label">после плановых покупок (−{rub(plannedTotal, { compact: true })})</span>
            </div>
            <div className="text-2xl font-bold"
              style={{ color: plannedRemainder >= 0 ? 'var(--accent-cyan)' : 'var(--accent-red)', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>
              {rub(plannedRemainder)}
            </div>
          </div>
        )}
      </div>

      {/* Waterfall */}
      <div className="p-4 sm:p-5">
        <div className="label mb-3">Движение денег в {monthName} · отмечай галочкой что получено/оплачено</div>

        {/* Start row */}
        <div className="flex items-center gap-3 pb-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)' }}>
            <Wallet size={14} style={{ color: 'var(--tx-muted)' }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">{monthName === monthLabel(monthKey).split(' ')[0] ? 'Старт месяца' : 'Дебет сейчас'}</div>
            <div className="label">баланс на начало</div>
          </div>
          <div className="text-sm font-bold mono" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{rub(startBalance)}</div>
        </div>

        {/* Events */}
        <div className="relative">
          <div className="absolute left-4 top-0 bottom-0" style={{ width: '1px', background: 'var(--border)', transform: 'translateX(-0.5px)' }} />
          <div className="flex flex-col gap-2">
            {rows.map((e, i) => (
              <div key={i} className="flex items-center gap-3 relative z-10">
                {/* Realize button or static icon */}
                {e.ref ? (
                  <EventRealizeBtn monthKey={monthKey} evt={e} />
                ) : (
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: eventColor(e.type, e.amount) + '1a', border: `1px solid ${eventColor(e.type, e.amount)}40` }}>
                    {e.amount > 0 ? <ArrowUp size={13} style={{ color: eventColor(e.type, e.amount) }} /> : <ArrowDown size={13} style={{ color: eventColor(e.type, e.amount) }} />}
                  </div>
                )}

                <div className="flex-1 min-w-0" style={{ opacity: e.done ? 0.5 : 1 }}>
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium truncate">{e.desc}</span>
                    <span className="label flex-shrink-0">{e.day} числа</span>
                  </div>
                  <div className="label truncate">{e.sub}</div>
                </div>

                <div className="text-right flex-shrink-0" style={{ opacity: e.done ? 0.5 : 1 }}>
                  <div className="text-sm font-semibold mono" style={{ color: eventColor(e.type, e.amount), fontFamily: 'JetBrains Mono, monospace' }}>
                    {e.amount > 0 ? '+' : '−'}{rub(Math.abs(e.amount), { compact: true })}
                  </div>
                  {e.showBalance && (
                    <div className="label mono" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{rub(e.balanceAfter, { compact: true })}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 mt-4 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="flex items-center gap-1.5"><ArrowUp size={11} style={{ color: 'var(--accent-green)' }} /><span className="label">придёт</span></div>
          <div className="flex items-center gap-1.5"><ArrowDown size={11} style={{ color: 'var(--accent-amber)' }} /><span className="label">спишется</span></div>
        </div>
      </div>
    </div>
  )
}
