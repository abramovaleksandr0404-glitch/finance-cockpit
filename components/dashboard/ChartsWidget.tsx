'use client'

import { useState } from 'react'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine, Cell,
} from 'recharts'
import type { DashboardData } from '@/lib/types'

const CAT_COLORS: Record<string, string> = {
  'Еда и кафе': '#3b82f6',
  'Транспорт': '#10b981',
  'Здоровье': '#ef4444',
  'Развлечения': '#f59e0b',
  'Одежда': '#8b5cf6',
  'Инвестиции': '#06b6d4',
  'Прочее': '#6b7280',
}

export default function ChartsWidget({ data, monthKey }: { data: DashboardData; monthKey: string }) {
  const [collapsed, setCollapsed] = useState(true)

  // Группировка по категориям
  const byCategory = data.expenses.reduce((acc, e) => {
    acc[e.category] = (acc[e.category] ?? 0) + e.amount
    return acc
  }, {} as Record<string, number>)
  const catData = Object.entries(byCategory)
    .map(([name, value]) => ({ name, value: Math.round(value), fill: CAT_COLORS[name] ?? '#ef4444' }))
    .filter((c) => c.value > 0) // только реальные категории, без нулевых
    .sort((a, b) => b.value - a.value)

  // Тренд по дням
  const [year, mon] = monthKey.split('-').map(Number)
  const daysInMonth = new Date(year, mon, 0).getDate()
  const varBudget = data.user.var_budget
  const dailyIdeal = varBudget / daysInMonth
  const byDay: Record<number, number> = {}
  for (const e of data.expenses) {
    const d = Number(e.expense_date.split('-')[2])
    byDay[d] = (byDay[d] ?? 0) + e.amount
  }
  let cumulative = 0
  const trendData = Array.from({ length: daysInMonth }, (_, i) => {
    const day = i + 1
    cumulative += byDay[day] ?? 0
    return { day, actual: Math.round(cumulative), ideal: Math.round(dailyIdeal * day) }
  })

  if (data.expenses.length === 0) return null

  return (
    <div style={{ background: 'var(--bg-card)', borderRadius: 12, padding: '12px 16px', border: '1px solid var(--border)' }}>
      <button
        onClick={() => setCollapsed(v => !v)}
        style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}
      >
        <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--tx-main)' }}>📊 Аналитика трат</span>
        <span style={{ color: 'var(--tx-muted)', fontSize: 12 }}>{collapsed ? '▼ развернуть' : '▲ свернуть'}</span>
      </button>

      {!collapsed && (
        <div style={{ marginTop: 16 }}>
          {/* По категориям */}
          <div style={{ marginBottom: 8, fontSize: 12, fontWeight: 600, color: 'var(--tx-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>По категориям</div>
          <ResponsiveContainer width="100%" height={Math.max(120, catData.length * 32)}>
            <BarChart data={catData} layout="vertical" margin={{ left: 0, right: 16, top: 0, bottom: 0 }}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11, fill: 'var(--tx-muted)' }} />
              <Tooltip formatter={(v: number) => `${v.toLocaleString('ru-RU')} ₽`} />
              <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                {catData.map((entry, i) => (
                  <Cell key={i} fill={entry.fill} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>

          {/* Тренд */}
          <div style={{ marginTop: 16, marginBottom: 8, fontSize: 12, fontWeight: 600, color: 'var(--tx-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Тренд vs идеальный темп</div>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={trendData} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'var(--tx-muted)' }} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--tx-muted)' }} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`} />
              <Tooltip formatter={(v: number) => `${v.toLocaleString('ru-RU')} ₽`} />
              <Line type="monotone" dataKey="actual" stroke="#3b82f6" strokeWidth={2} dot={false} name="Факт" />
              <Line type="monotone" dataKey="ideal" stroke="#6b7280" strokeWidth={1} strokeDasharray="4 2" dot={false} name="Идеал" />
              <ReferenceLine y={varBudget} stroke="#ef4444" strokeDasharray="4 2" label={{ value: 'Лимит', position: 'right', fontSize: 10, fill: '#ef4444' }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
