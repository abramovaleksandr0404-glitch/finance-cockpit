'use client'

import { useMemo } from 'react'
import { BarChart2, TrendingUp, ArrowUp, ArrowDown, Minus } from 'lucide-react'
import { rub, calcIncome, monthLabel } from '@/lib/finance'
import { parseMonthKey } from '@/lib/engine'
import type { DashboardData } from '@/lib/types'

// ── Month analytics helper ─────────────────────────────────────────────────
interface MonthStats {
  key: string
  label: string
  revenue: number
  income: number
  varSpent: number
  fixedSpent: number
  clients: number
  bonus: number
  bonusNext: number
}

function buildStats(data: DashboardData): MonthStats[] {
  const { allMonths, allExpenses } = data
  const sorted = [...allMonths].sort((a, b) => a.month_key.localeCompare(b.month_key))

  return sorted.map((m) => {
    const inc = calcIncome(data, m.month_key)
    const varSpent = allExpenses
      .filter((e) => e.month_key === m.month_key)
      .reduce((s, e) => s + e.amount, 0)
    const fp = m.fixed_paid ?? {}
    const fixedSpent = data.user.fixed_costs.reduce((s, f, i) => {
      const v = fp[String(i)]
      return v != null && v !== false ? s + (typeof v === 'number' ? v : f.amount) : s
    }, 0)
    const clients = Object.values(m.clients ?? {}).reduce((s, n) => s + (Number(n) || 0), 0)
    return {
      key: m.month_key,
      label: monthLabel(m.month_key).split(' ')[0],
      revenue: m.revenue ?? 0,
      income: inc.totalIncome,
      varSpent,
      fixedSpent,
      clients,
      bonus: inc.bonusReceived,
      bonusNext: inc.bonusEarnedThisMonth,
    }
  })
}

// ── Delta badge ─────────────────────────────────────────────────────────────
function Delta({ cur, prev }: { cur: number; prev: number }) {
  if (prev === 0) return null
  const pct = Math.round(((cur - prev) / prev) * 100)
  if (Math.abs(pct) < 1) return <span className="label">≈ то же</span>
  const up = pct > 0
  const Icon = up ? ArrowUp : ArrowDown
  return (
    <span className="flex items-center gap-0.5 text-xs font-semibold"
      style={{ color: up ? 'var(--accent-green)' : 'var(--accent-red)' }}>
      <Icon size={10} />
      {Math.abs(pct)}%
    </span>
  )
}

// ── Mini bar chart (SVG) ─────────────────────────────────────────────────────
function MiniBarChart({
  series,
  labels,
  color = 'var(--accent-cyan)',
  height = 56,
}: {
  series: number[]
  labels: string[]
  color?: string
  height?: number
}) {
  const max = Math.max(...series, 1)
  const barW = 28, gap = 8, svgW = series.length * (barW + gap) - gap

  return (
    <svg viewBox={`0 0 ${svgW} ${height + 14}`} style={{ width: '100%', maxWidth: svgW * 1.5, height: 'auto' }}>
      {series.map((v, i) => {
        const barH = Math.max(2, (v / max) * height)
        const x = i * (barW + gap)
        const y = height - barH
        return (
          <g key={i}>
            <rect x={x} y={y} width={barW} height={barH} rx="3" fill={color} opacity={0.85} />
            <text x={x + barW / 2} y={height + 12} fontSize="8" fill="var(--tx-muted)"
              textAnchor="middle" fontFamily="DM Sans,sans-serif">
              {labels[i]}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// ── Main panel ──────────────────────────────────────────────────────────────
export default function AnalyticsPanel({ data, monthKey }: { data: DashboardData; monthKey: string }) {
  const stats = useMemo(() => buildStats(data), [data])

  const cur = stats.find((s) => s.key === monthKey)
  const sorted = [...stats].sort((a, b) => b.key.localeCompare(a.key))
  const curIdx = sorted.findIndex((s) => s.key === monthKey)
  const prev = sorted[curIdx + 1] ?? null

  if (stats.length === 0) return null

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <BarChart2 size={14} style={{ color: 'var(--accent-cyan)' }} />
        <span className="text-sm font-medium">Аналитика · история</span>
      </div>

      {/* Month comparison */}
      {cur && (
        <div className="card p-4 flex flex-col gap-3">
          <div className="label">
            {prev ? `${cur.label} vs ${prev.label}` : cur.label}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <MetricRow label="Выручка" cur={cur.revenue} prev={prev?.revenue} />
            <MetricRow label="Доход на руки" cur={cur.income} prev={prev?.income} />
            <MetricRow label="Постоянные" cur={cur.fixedSpent} prev={prev?.fixedSpent} inverted />
            <MetricRow label="Переменные" cur={cur.varSpent} prev={prev?.varSpent} inverted />
            <MetricRow label="Бонус получен" cur={cur.bonus} prev={prev?.bonus} />
            <MetricRow label="Клиентов" cur={cur.clients} prev={prev?.clients} unit="" />
          </div>

          {!prev && (
            <div className="label text-center py-2">
              сравнение появится когда закроется следующий месяц
            </div>
          )}
        </div>
      )}

      {/* Revenue trend chart */}
      {stats.length > 1 && (
        <div className="card p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <TrendingUp size={13} style={{ color: 'var(--accent-amber)' }} />
              <span className="label">Выручка по месяцам</span>
            </div>
            <span className="text-xs font-semibold" style={{ color: 'var(--accent-amber)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
              {rub(Math.max(...stats.map((s) => s.revenue)), { compact: true })} пик
            </span>
          </div>
          <MiniBarChart
            series={stats.map((s) => s.revenue)}
            labels={stats.map((s) => s.label.slice(0, 3))}
            color="var(--accent-amber)"
          />
        </div>
      )}

      {/* Income trend */}
      {stats.length > 1 && (
        <div className="card p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <TrendingUp size={13} style={{ color: 'var(--accent-cyan)' }} />
              <span className="label">Доход на руки</span>
            </div>
            <span className="text-xs font-semibold" style={{ color: 'var(--accent-cyan)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
              {rub(Math.max(...stats.map((s) => s.income)), { compact: true })} макс
            </span>
          </div>
          <MiniBarChart
            series={stats.map((s) => s.income)}
            labels={stats.map((s) => s.label.slice(0, 3))}
            color="var(--accent-cyan)"
          />
        </div>
      )}

      {/* Variable spending by category (if any data) */}
      {data.allExpenses.length > 0 && (
        <CategoryBreakdown data={data} />
      )}

      {data.allExpenses.length === 0 && (
        <div className="card p-4 text-center">
          <div className="text-2xl mb-2">📊</div>
          <div className="text-sm" style={{ color: 'var(--tx-muted)' }}>
            Тренды по категориям появятся как только начнёшь вносить расходы
          </div>
        </div>
      )}
    </div>
  )
}

function MetricRow({ label, cur, prev, inverted = false, unit = '₽' }: {
  label: string; cur: number; prev?: number; inverted?: boolean; unit?: string
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="label">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold" style={{ fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
          {unit === '₽' ? rub(cur, { compact: true }) : cur}
        </span>
        {prev != null && prev !== cur && (
          <Delta
            cur={inverted ? -cur : cur}
            prev={inverted ? -prev : prev}
          />
        )}
        {prev != null && prev === cur && <Minus size={10} style={{ color: 'var(--tx-dim)' }} />}
      </div>
    </div>
  )
}

function CategoryBreakdown({ data }: { data: DashboardData }) {
  const months = useMemo(() => {
    const keys = [...new Set(data.allExpenses.map((e) => e.month_key))].sort((a, b) => b.localeCompare(a)).slice(0, 3)
    const cats = [...new Set(data.allExpenses.map((e) => e.category))]
    return { keys, cats }
  }, [data.allExpenses])

  if (months.keys.length === 0) return null

  const totals = months.cats.map((cat) => ({
    cat,
    total: data.allExpenses.filter((e) => e.category === cat).reduce((s, e) => s + e.amount, 0),
  })).sort((a, b) => b.total - a.total).slice(0, 5)

  const COLORS = ['var(--accent-cyan)', 'var(--accent-amber)', 'var(--accent-violet)', 'var(--accent-green)', 'var(--accent-pink)']

  return (
    <div className="card p-4 flex flex-col gap-3">
      <div className="label">Расходы по категориям</div>
      <div className="flex flex-col gap-2">
        {totals.map(({ cat, total }, i) => (
          <div key={cat} className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: COLORS[i] }} />
            <span className="text-xs flex-1 truncate">{cat}</span>
            <span className="text-xs font-semibold" style={{ fontFamily: 'JetBrains Mono, monospace', color: COLORS[i], whiteSpace: 'nowrap' }}>
              {rub(total, { compact: true })}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
