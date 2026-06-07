'use client'

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
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
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={chartData} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
          <defs>
            <linearGradient id="balGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--tx-muted)' }} />
          <YAxis tick={{ fontSize: 10, fill: 'var(--tx-muted)' }} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`} />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const d = payload[0].payload as { date: string; balance: number; label: string }
              return (
                <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: 11, maxWidth: 200 }}>
                  <div style={{ color: 'var(--tx-muted)', marginBottom: 2 }}>{d.date}</div>
                  <div style={{ color: '#3b82f6', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>{d.balance.toLocaleString('ru-RU')} ₽</div>
                  {d.label && <div style={{ color: 'var(--tx-dim)', marginTop: 2, whiteSpace: 'normal' }}>{d.label}</div>}
                </div>
              )
            }}
          />
          <Area type="monotone" dataKey="balance" stroke="#3b82f6" strokeWidth={2} dot={false} fill="url(#balGradient)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
