'use client'

import { useState, useMemo } from 'react'
import { TrendingDown } from 'lucide-react'
import { projectDebt, monthsToZero, totalInterestRemaining } from '@/lib/engine'
import { rub } from '@/lib/finance'
import type { DashboardData } from '@/lib/types'

export default function DebtChartWidget({ data }: { data: DashboardData }) {
  const { loans } = data
  const [extra, setExtra] = useState(0)
  const [targetYear, setTargetYear] = useState(2029)

  // Memoize activeLoans first (deps used in subsequent memos)
  const activeLoans = useMemo(
    () => loans.filter((l) => Number(l.principal) > 0),
    [loans]
  )

  // Reverse calc: extra needed to close debt by targetYear
  const { requiredExtra, savedByGoal } = useMemo(() => {
    if (activeLoans.length === 0) return { requiredExtra: 0, savedByGoal: 0 }
    const now = new Date()
    const targetMonths = Math.max(1, (targetYear - now.getFullYear()) * 12 - now.getMonth())
    let lo = 0, hi = 300_000
    for (let i = 0; i < 35; i++) {
      const mid = Math.round((lo + hi) / 2)
      if (monthsToZero(activeLoans, mid) <= targetMonths) hi = mid
      else lo = mid + 1
    }
    const saved = Math.max(0, totalInterestRemaining(activeLoans, 0) - totalInterestRemaining(activeLoans, hi))
    return { requiredExtra: hi, savedByGoal: saved }
  }, [activeLoans, targetYear])

  // Must call all hooks before any conditional return
  const { baseSeries, extraSeries, baseMonths, extraMonths, baseInterest, extraInterest } = useMemo(() => {
    if (activeLoans.length === 0) return {
      baseSeries: [0], extraSeries: null, baseMonths: 0, extraMonths: 0, baseInterest: 0, extraInterest: 0
    }
    const bs = projectDebt(activeLoans, 0, 120)
    const es = extra > 0 ? projectDebt(activeLoans, extra, 120) : null
    const bm = monthsToZero(activeLoans, 0)
    const em = extra > 0 ? monthsToZero(activeLoans, extra) : bm
    const bi = totalInterestRemaining(activeLoans, 0)
    const ei = extra > 0 ? totalInterestRemaining(activeLoans, extra) : bi
    return { baseSeries: bs, extraSeries: es, baseMonths: bm, extraMonths: em, baseInterest: bi, extraInterest: ei }
  }, [activeLoans, extra])

  if (activeLoans.length === 0) return null

  const maxDebt = baseSeries[0]
  const maxMonths = baseSeries.length - 1
  const W = 560, H = 200, padL = 8, padR = 8, padT = 12, padB = 12
  const plotW = W - padL - padR, plotH = H - padT - padB

  const xFor = (i: number) => padL + (i / maxMonths) * plotW
  const yFor = (v: number) => padT + (1 - v / maxDebt) * plotH
  const pathFor = (series: number[]) =>
    series.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yFor(v).toFixed(1)}`).join(' ')

  const yearMarks = []
  for (let m = 12; m <= maxMonths; m += 12) yearMarks.push(m)

  const monthsText = (n: number) => {
    const y = Math.floor(n / 12), mo = n % 12
    const parts = []
    if (y > 0) parts.push(`${y}г`)
    if (mo > 0) parts.push(`${mo}мес`)
    return parts.join(' ') || '0'
  }

  const saved = baseInterest - extraInterest
  const monthsSaved = baseMonths - extraMonths

  return (
    <div className="card p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingDown size={14} style={{ color: 'var(--accent-violet)' }} />
          <span className="text-sm font-medium">Закрытие долга</span>
        </div>
        <div className="text-right">
          <div className="label">погашение</div>
          <div className="text-xs font-bold" style={{ color: extra > 0 ? 'var(--accent-green)' : 'var(--accent-violet)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
            {monthsText(extra > 0 ? extraMonths : baseMonths)}
          </div>
        </div>
      </div>

      {/* Overpayment summary — stacked vertically to prevent text merge on mobile */}
      <div className="rounded-md p-3 flex flex-col gap-2"
        style={{ background: 'rgba(139,92,246,0.05)', border: '1px solid rgba(139,92,246,0.15)' }}>
        <div className="flex items-center justify-between gap-2">
          <div className="label">переплата % за всё время</div>
          <div className="text-sm font-bold flex-shrink-0" style={{ color: 'var(--accent-violet)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
            {rub(extra > 0 ? extraInterest : baseInterest)}
          </div>
        </div>
        {extra > 0 && saved > 0 && (
          <div className="flex items-center justify-between gap-2">
            <div className="label">экономия при досрочных</div>
            <div className="text-sm font-bold flex-shrink-0" style={{ color: 'var(--accent-green)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
              −{rub(saved)}
            </div>
          </div>
        )}
      </div>

      {/* SVG Chart */}
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
        {yearMarks.map((m) => (
          <g key={m}>
            <line x1={xFor(m)} y1={padT} x2={xFor(m)} y2={padT + plotH} stroke="var(--border)" strokeWidth="1" strokeDasharray="2 3" />
            <text x={xFor(m)} y={H - 1} fontSize="8" fill="var(--tx-dim)" textAnchor="middle">{m / 12}г</text>
          </g>
        ))}
        <path d={pathFor(baseSeries)} fill="none" stroke="var(--accent-violet)" strokeWidth="2" />
        {extraSeries && <path d={pathFor(extraSeries)} fill="none" stroke="var(--accent-green)" strokeWidth="2" />}
        <circle cx={xFor(0)} cy={yFor(maxDebt)} r="3" fill="var(--accent-violet)" />
        {/* Zero point markers */}
        {baseMonths < maxMonths && (
          <circle cx={xFor(baseMonths)} cy={yFor(0)} r="3" fill="var(--accent-violet)" />
        )}
        {extraSeries && extraMonths < maxMonths && (
          <circle cx={xFor(extraMonths)} cy={yFor(0)} r="3" fill="var(--accent-green)" />
        )}
      </svg>

      <div className="flex items-center gap-4 text-xs flex-wrap">
        <div className="flex items-center gap-1.5">
          <div style={{ width: 12, height: 2, background: 'var(--accent-violet)' }} />
          <span className="label">мин. платёж · переплата {rub(baseInterest, { compact: true })}</span>
        </div>
        {extra > 0 && (
          <div className="flex items-center gap-1.5">
            <div style={{ width: 12, height: 2, background: 'var(--accent-green)' }} />
            <span className="label">+досрочные
              {monthsSaved > 0 && ` · быстрее на ${monthsText(monthsSaved)}`}
            </span>
          </div>
        )}
      </div>

      {/* Debt payoff goal: how much extra per month to close by target year */}
      <div className="rounded-lg p-3" style={{ background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.15)' }}>
        <div className="label mb-2">Цель: закрыть долг к</div>
        <div className="flex gap-1.5 mb-2">
          {[2028, 2029, 2030, 2031].map((y) => (
            <button key={y} onClick={() => setTargetYear(y)}
              className="flex-1 py-1 text-xs rounded-md font-medium"
              style={{ background: targetYear === y ? 'rgba(34,197,94,0.18)' : 'var(--bg-base)', border: `1px solid ${targetYear === y ? 'var(--accent-green)' : 'var(--border)'}`, color: targetYear === y ? 'var(--accent-green)' : 'var(--tx-muted)', cursor: 'pointer' }}>
              {y}
            </button>
          ))}
        </div>
        {requiredExtra === 0 ? (
          <div className="label text-center">уже укладываешься по минималке 🎉</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="label">доп. платёж/мес</div>
              <div className="text-sm font-bold flex-shrink-0" style={{ color: 'var(--accent-green)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
                {rub(requiredExtra, { compact: true })}
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="label">экономия на %</div>
              <div className="text-sm font-bold flex-shrink-0" style={{ color: 'var(--accent-cyan)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
                −{rub(savedByGoal, { compact: true })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Extra payment slider */}
      <div>
        <div className="label mb-1">доп. платёж в месяц (досрочное погашение)</div>
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <span className="label">0</span>
          <span className="text-sm font-bold" style={{ color: 'var(--accent-green)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
            {rub(extra)}
          </span>
          <span className="label">80к</span>
        </div>
        <input type="range" min={0} max={80000} step={5000} value={extra}
          onChange={(e) => setExtra(Number(e.target.value))}
          className="w-full" style={{ accentColor: 'var(--accent-green)' }} />
      </div>
    </div>
  )
}
