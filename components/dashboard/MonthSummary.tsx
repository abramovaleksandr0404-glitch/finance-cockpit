'use client'

import { useRef, useState } from 'react'
import type { DashboardData, CustomCategory } from '@/lib/types'

function rub(n: number) { return Math.round(n).toLocaleString('ru-RU') + ' ₽' }

export default function MonthSummary({
  data,
  monthKey,
}: {
  data: DashboardData
  monthKey: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [copying, setCopying] = useState(false)

  const user = data.user
  const month = data.allMonths.find(m => m.month_key === monthKey)
  const expenses = data.expenses

  const debitSber = Number(user.debit_balance ?? 0)
  const debitTbank = Number(user.tbank_debit ?? 0)
  const liquid = debitSber + debitTbank

  const net = Number(user.salary_net ?? 121600)
  const advAmt = Number(month?.salary_adv_amount ?? Math.round(net / 2))
  const eomAmt = Number(month?.salary_eom_amount ?? net - advAmt)
  const bonusAmt = Number(month?.bonus_amount ?? 0)
  const advReceived = !!month?.salary_adv_received
  const eomReceived = !!month?.salary_eom_received
  const incomingTotal = (advReceived ? 0 : advAmt) + (eomReceived ? 0 : eomAmt + bonusAmt)

  const loans = data.loans
  const pendingLoans = loans.filter(l => l.paid_month !== monthKey).reduce((s, l) => s + Number(l.min_payment), 0)

  const fixedCosts = (user.fixed_costs as { name: string; amount: number }[]) ?? []
  const fixedPaid = (month?.fixed_paid as Record<string, number | boolean>) ?? {}
  const fixedTotal = fixedCosts.reduce((s, f) => s + f.amount, 0)
  let fixedPaidSum = 0
  fixedCosts.forEach((f, i) => { if (fixedPaid[String(i)]) fixedPaidSum += (typeof fixedPaid[String(i)] === 'number' ? Number(fixedPaid[String(i)]) : f.amount) })
  const fixedUnpaid = Math.max(0, fixedTotal - fixedPaidSum)

  const varBudget = Number(user.var_budget ?? 40000)
  const varSpent = expenses.reduce((s, e) => s + Number(e.amount), 0)
  const varLeft = Math.max(0, varBudget - varSpent)

  const forecast = Math.round(liquid + incomingTotal - pendingLoans - fixedUnpaid - varLeft)

  const customCategories = (data.customCategories ?? []) as CustomCategory[]
  const harmfulItems = customCategories.map(cat => {
    const spent = expenses.filter(e => (e as { custom_category_id?: string }).custom_category_id === cat.id).reduce((s, e) => s + Number(e.amount), 0)
    return { name: cat.name, spent, limit: cat.monthly_limit ?? 5000 }
  }).filter(h => h.spent > 0)

  async function captureScreenshot() {
    if (!ref.current) return
    setCopying(true)
    try {
      const { default: html2canvas } = await import('html2canvas')
      const canvas = await html2canvas(ref.current, { backgroundColor: '#0e1521', scale: 2 })
      canvas.toBlob(blob => {
        if (!blob) return
        const item = new ClipboardItem({ 'image/png': blob })
        navigator.clipboard.write([item]).then(() => setCopying(false))
      })
    } catch {
      setCopying(false)
    }
  }

  const now = new Date()
  const dateStr = now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div style={{ padding: '16px', maxWidth: '432px' }}>
      {/* Screenshot button */}
      <button
        onClick={captureScreenshot}
        disabled={copying}
        style={{
          marginBottom: '12px',
          padding: '8px 16px',
          borderRadius: '8px',
          background: 'rgba(6,182,212,0.1)',
          border: '1px solid rgba(6,182,212,0.3)',
          color: 'var(--accent-cyan)',
          cursor: copying ? 'wait' : 'pointer',
          fontSize: '13px',
          fontWeight: 500,
        }}
      >
        {copying ? '⏳ Копирую...' : '📋 Скопировать как картинку'}
      </button>

      {/* The card that will be screenshotted */}
      <div ref={ref} style={{
        width: '400px',
        background: '#0e1521',
        borderRadius: '16px',
        border: '1px solid #1e2d42',
        padding: '20px',
        fontFamily: "'DM Sans', system-ui, sans-serif",
        color: '#e2e8f0',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div>
            <div style={{ fontSize: '16px', fontWeight: 700 }}>Finance Cockpit</div>
            <div style={{ fontSize: '11px', color: '#64748b' }}>{dateStr} · {monthKey}</div>
          </div>
          <div style={{ fontSize: '20px' }}>💰</div>
        </div>

        {/* Liquidity */}
        <div style={{ background: '#131e2e', borderRadius: '10px', padding: '12px', marginBottom: '10px' }}>
          <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Ликвидность</div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: '11px', color: '#64748b' }}>Сбер</div>
              <div style={{ fontSize: '15px', fontWeight: 600 }}>{rub(debitSber)}</div>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: '#64748b' }}>Т-Банк</div>
              <div style={{ fontSize: '15px', fontWeight: 600 }}>{rub(debitTbank)}</div>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: '#64748b' }}>Итого</div>
              <div style={{ fontSize: '15px', fontWeight: 700, color: '#06b6d4' }}>{rub(liquid)}</div>
            </div>
          </div>
        </div>

        {/* Incoming */}
        {incomingTotal > 0 && (
          <div style={{ background: '#131e2e', borderRadius: '10px', padding: '12px', marginBottom: '10px' }}>
            <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Ожидается</div>
            {!advReceived && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}><span>Аванс</span><span style={{ color: '#22c55e' }}>{rub(advAmt)}</span></div>}
            {!eomReceived && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}><span>ЗП + Бонус</span><span style={{ color: '#22c55e' }}>{rub(eomAmt + bonusAmt)}</span></div>}
          </div>
        )}

        {/* Outgoing */}
        <div style={{ background: '#131e2e', borderRadius: '10px', padding: '12px', marginBottom: '10px' }}>
          <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Выходы</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '4px' }}><span>Кредиты</span><span style={{ color: '#ef4444' }}>{rub(pendingLoans)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '4px' }}><span>Постоянные</span><span style={{ color: '#f59e0b' }}>{rub(fixedUnpaid)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}><span>Переменные (остаток)</span><span style={{ color: '#64748b' }}>{rub(varLeft)}</span></div>
        </div>

        {/* Harmful */}
        {harmfulItems.length > 0 && (
          <div style={{ background: '#131e2e', borderRadius: '10px', padding: '12px', marginBottom: '10px' }}>
            <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Вредные</div>
            {harmfulItems.map((h, i) => {
              const pct = h.limit > 0 ? Math.round(h.spent / h.limit * 100) : 0
              const c = pct < 50 ? '#22c55e' : pct < 80 ? '#f59e0b' : '#ef4444'
              return (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: i < harmfulItems.length - 1 ? '4px' : 0 }}>
                  <span>{h.name}</span>
                  <span style={{ color: c }}>{rub(h.spent)} / {rub(h.limit)} ({pct}%)</span>
                </div>
              )
            })}
          </div>
        )}

        {/* Forecast */}
        <div style={{ background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.2)', borderRadius: '10px', padding: '12px' }}>
          <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Прогноз к концу месяца</div>
          <div style={{ fontSize: '22px', fontWeight: 700, color: forecast >= 0 ? '#06b6d4' : '#ef4444' }}>{rub(forecast)}</div>
          <div style={{ fontSize: '10px', color: '#334155', marginTop: '4px' }}>
            {rub(liquid)} + {rub(incomingTotal)} − {rub(pendingLoans)} − {rub(fixedUnpaid)} − {rub(varLeft)}
          </div>
        </div>
      </div>
    </div>
  )
}
