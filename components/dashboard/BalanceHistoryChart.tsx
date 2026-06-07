'use client'

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import type { DebitHistoryEntry } from '@/lib/types'

function BalanceTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: { date?: string; balance?: number; label?: string } }> }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  if (!p) return null
  return (
    <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 12 }}>
      <div style={{ color: 'var(--tx-dim)', marginBottom: 2 }}>{p.date}</div>
      <div style={{ color: 'var(--tx-main)', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>{(p.balance ?? 0).toLocaleString('ru-RU')} ₽</div>
      {p.label && <div style={{ color: 'var(--tx-muted)', marginTop: 2, maxWidth: 180 }}>{p.label}</div>}
    </div>
  )
}

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

  const timeline = [...history].slice(0, 10)

  return (
    <div style={{ background: 'var(--bg-card)', borderRadius: 12, padding: '12px 16px', border: '1px solid var(--border)' }}>
      <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--tx-main)', marginBottom: 12 }}>📈 История баланса</div>
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={chartData} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
          <defs>
            <linearGradient id="balanceFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--tx-muted)' }} />
          <YAxis tick={{ fontSize: 10, fill: 'var(--tx-muted)' }} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`} />
          <Tooltip content={<BalanceTooltip />} />
          <Area type="monotone" dataKey="balance" stroke="#3b82f6" strokeWidth={2} fill="url(#balanceFill)" dot={false} activeDot={{ r: 4 }} />
        </AreaChart>
      </ResponsiveContainer>

      {/* Timeline list */}
      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {timeline.map((h, i) => {
          const positive = h.amount >= 0
          const color = positive ? '#22c55e' : '#ef4444'
          const sign = positive ? '+' : ''
          const date = h.created_at.split('T')[0].slice(5)
          return (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, gap: 8 }}>
              <span style={{ color: 'var(--tx-dim)', flexShrink: 0 }}>{date}</span>
              <span style={{ color: 'var(--tx-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.description}</span>
              <span style={{ color, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                {sign}{Math.round(h.amount).toLocaleString('ru-RU')} ₽
              </span>
              <span style={{ color: 'var(--tx-dim)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                {Math.round(h.balance_after).toLocaleString('ru-RU')} ₽
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
