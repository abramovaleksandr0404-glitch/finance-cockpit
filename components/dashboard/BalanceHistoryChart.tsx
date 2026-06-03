'use client'

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import type { DebitHistoryEntry } from '@/lib/types'

export default function BalanceHistoryChart({ history }: { history?: DebitHistoryEntry[] }) {
  if (!history || history.length < 5) {
    return (
      <div style={{ background: 'var(--bg-card)', borderRadius: 12, padding: '12px 16px', border: '1px solid var(--border)', textAlign: 'center' }}>
        <span style={{ fontSize: 13, color: 'var(--tx-muted)' }}>📈 История баланса накапливается...</span>
      </div>
    )
  }

  const chartData = [...history].reverse().map(h => ({
    date: h.created_at.split('T')[0].slice(5), // MM-DD
    balance: Math.round(h.balance_after),
    label: h.description,
  }))

  return (
    <div style={{ background: 'var(--bg-card)', borderRadius: 12, padding: '12px 16px', border: '1px solid var(--border)' }}>
      <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--tx-main)', marginBottom: 12 }}>📈 История баланса</div>
      <ResponsiveContainer width="100%" height={140}>
        <LineChart data={chartData} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--tx-muted)' }} />
          <YAxis tick={{ fontSize: 10, fill: 'var(--tx-muted)' }} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`} />
          <Tooltip
            formatter={(v: number, _: string, p: { payload?: { label?: string } }) => [
              `${v.toLocaleString('ru-RU')} ₽`,
              p.payload?.label ?? 'Баланс',
            ]}
          />
          <Line type="monotone" dataKey="balance" stroke="#3b82f6" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
