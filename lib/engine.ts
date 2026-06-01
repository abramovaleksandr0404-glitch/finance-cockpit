/**
 * ФИНАНСОВЫЙ ДВИЖОК — порт из HTML кокпита v6
 * Формула бонуса исправлена: окупаемость вычитается из КОТЛА (не из выручки).
 * Validated against bank schedule to kopeck.
 */

import type { UserProfile, Month, Loan } from './types'

// ── Calendar helpers ─────────────────────────────────────────────────────────

/** Last calendar day of month (m = 1..12) */
export function lastDayOf(y: number, m: number): number {
  return new Date(y, m, 0).getDate()
}

/** Count workdays (Mon–Fri) in [from..to] of month m (1..12). Holidays not auto-excluded. */
export function workdays(y: number, m: number, from: number, to: number): number {
  let c = 0
  for (let d = from; d <= to; d++) {
    const w = new Date(y, m - 1, d).getDay()
    if (w !== 0 && w !== 6) c++
  }
  return c
}

/** Advance pay day: 15th, shifted back if weekend (Sat→14, Sun→13). */
export function advanceDay(y: number, m: number): number {
  let d = 15
  while (true) {
    const w = new Date(y, m - 1, d).getDay()
    if (w !== 0 && w !== 6) return d
    d--
  }
}

/** End-of-month pay day: last day, shifted back if weekend. */
export function eomDay(y: number, m: number): number {
  let d = lastDayOf(y, m)
  while (true) {
    const w = new Date(y, m - 1, d).getDay()
    if (w !== 0 && w !== 6) return d
    d--
  }
}

// ── Month key helpers (format YYYY-MM) ────────────────────────────────────────

export function parseMonthKey(key: string): { y: number; m: number } {
  const [y, m] = key.split('-').map(Number)
  return { y, m }
}

export function prevMonthKey(key: string): string {
  const { y, m } = parseMonthKey(key)
  const d = new Date(y, m - 2, 1) // m-1 is current (0-idx), m-2 is prev
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Which quarter (1..4) a month belongs to. */
export function quarterOf(m: number): number {
  return Math.ceil(m / 3)
}

// ── Salary split (by real workdays) ───────────────────────────────────────────

export interface SalarySplit {
  advance: number // paid ~15th (workdays 1–15)
  second: number // paid end of month (workdays 16–end)
  advDay: number
  eomDay: number
  totalDays: number
  firstDays: number
  secondDays: number
}

export function salarySplit(year: number, month: number, salaryNet: number): SalarySplit {
  const ld = lastDayOf(year, month)
  const total = workdays(year, month, 1, ld) || 1
  const first = workdays(year, month, 1, 15)
  const daily = salaryNet / total
  return {
    advance: Math.round(daily * first),
    second: Math.round(daily * (total - first)),
    advDay: advanceDay(year, month),
    eomDay: eomDay(year, month),
    totalDays: total,
    firstDays: first,
    secondDays: total - first,
  }
}

// ── Progressive income tax (НДФЛ 13% / 15%) ───────────────────────────────────

/** Tax on the slice [from..to] of cumulative gross income, given the 13%/15% threshold. */
function taxChunk(from: number, to: number, threshold: number, r1: number, r2: number): number {
  return (
    Math.max(0, Math.min(to, threshold) - Math.min(from, threshold)) * r1 +
    Math.max(0, Math.max(0, to - threshold) - Math.max(0, from - threshold)) * r2
  )
}

function clientNominal(
  clients: Record<string, number>,
  nominals: Record<string, number>
): number {
  return Object.entries(clients).reduce((s, [g, n]) => s + (n || 0) * (nominals[g] || 0), 0)
}

// ── Monthly bonus (CORRECTED: threshold subtracted from the pot) ───────────────

export interface BonusBreakdown {
  pot: number // gross pot = clients×nominal + margin_share × revenue
  excess: number // max(0, pot − threshold)
  momentGross: number // excess × moment_share (paid next month)
  annualGross: number // excess × (1 − moment_share) → annual pot
  tax: number
  net: number // what actually lands next month, after НДФЛ
}

/**
 * Bonus earned in a given month (paid out the NEXT month).
 * If month has bonus_override, that net value is used directly.
 */
export function computeMonthlyBonus(
  clients: Record<string, number>,
  revenue: number,
  cfg: UserProfile,
  override?: number | null
): BonusBreakdown {
  if (override != null) {
    return { pot: 0, excess: 0, momentGross: override, annualGross: 0, tax: 0, net: override }
  }
  const pot = clientNominal(clients, cfg.nominals) + cfg.margin_share * (revenue || 0)
  const excess = Math.max(0, pot - cfg.threshold)
  const momentGross = excess * cfg.moment_share
  const annualGross = excess * (1 - cfg.moment_share)
  // Tax stacked on top of YTD gross + this year's salary gross accumulated
  const cumulativeBase = cfg.ytd_gross + cfg.salary_gross
  const tax = taxChunk(cumulativeBase, cumulativeBase + momentGross, cfg.tax_threshold, cfg.r1, cfg.r2)
  return { pot, excess, momentGross, annualGross, tax, net: Math.round(momentGross - tax) }
}

/**
 * Quarterly bonus: sum of clients across the quarter × nominal × multiplier.
 * mult = qm3 if ≥3 clients, qm2 if =2, else 0. Paid end of first month of next quarter.
 */
export function computeQuarterlyBonus(
  quarterClients: Record<string, number>,
  cfg: UserProfile
): { gross: number; net: number; clientCount: number; mult: number } {
  const clientCount = Object.values(quarterClients).reduce((s, v) => s + (v || 0), 0)
  const mult = clientCount >= 3 ? cfg.qm3 : clientCount === 2 ? cfg.qm2 : 0
  const gross = clientNominal(quarterClients, cfg.nominals) * mult
  const net = Math.round(gross * (1 - cfg.r1)) // approx flat 13%
  return { gross, net, clientCount, mult }
}

/** Sum client counts across an array of months (for quarterly calc). */
export function sumQuarterClients(months: Month[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const mo of months) {
    for (const [g, n] of Object.entries(mo.clients || {})) {
      out[g] = (out[g] || 0) + (Number(n) || 0)
    }
  }
  return out
}

// ── Loans ──────────────────────────────────────────────────────────────────

export function loanDailyInterest(loan: Loan): number {
  return Number(loan.principal) * Number(loan.rate) / 365
}

/** Day of month the loan's min payment is due. */
export function loanDueDay(loan: Loan, year: number, month: number): number {
  const ld = lastDayOf(year, month)
  return loan.due_day === 'last' ? ld : Math.min(Number(loan.due_day), ld)
}

/** Months remaining until the loan's end date (from a given month key). */
export function loanMonthsRemaining(loan: Loan, fromKey: string): number {
  if (!loan.end_date) return loan.term_months ?? 60
  const { y, m } = parseMonthKey(fromKey)
  const end = new Date(loan.end_date)
  return Math.max(1, (end.getFullYear() - y) * 12 + (end.getMonth() + 1 - m))
}

/**
 * New monthly payment after an early repayment, keeping the SAME term.
 * For a fixed term and rate, the annuity payment is proportional to principal,
 * so newPayment = oldPayment × newPrincipal / oldPrincipal. Exact for "keep term".
 */
export function annuityPaymentAfterRepay(
  oldPrincipal: number,
  oldPayment: number,
  repayAmount: number
): { newPrincipal: number; newPayment: number } {
  const newPrincipal = Math.max(0, oldPrincipal - repayAmount)
  const ratio = oldPrincipal > 0 ? newPrincipal / oldPrincipal : 0
  return { newPrincipal, newPayment: Math.round(oldPayment * ratio * 100) / 100 }
}

/** Monthly interest for projection — rate/365×30 (matches bank to kopeck). */
export function monthlyInterestApprox(principal: number, rate: number): number {
  return principal * rate / 365 * 30
}

export function applyPayment(principal: number, accruedInt: number, payment: number) {
  const toInt = Math.min(payment, accruedInt)
  const toPrincipal = payment - toInt
  return {
    principal: Math.max(0, principal - toPrincipal),
    accruedInt: accruedInt - toInt,
    toInt,
    toPrincipal,
  }
}

/**
 * Project total debt over N months.
 * Avalanche: extra payments → highest-rate loan first.
 * Returns array of total-debt points [now, +1mo, +2mo, ...].
 */
export function projectDebt(loans: Loan[], extraMonthly = 0, months = 72): number[] {
  const ls = loans.map((l) => ({
    P: Number(l.principal),
    I: Number(l.accrued_int),
    rate: Number(l.rate),
    min: Number(l.min_payment),
  }))
  const pts = [ls.reduce((s, l) => s + l.P + l.I, 0)]

  for (let i = 0; i < months; i++) {
    ls.forEach((l) => {
      l.I += monthlyInterestApprox(l.P, l.rate)
      const pay = Math.min(l.min, l.P + l.I)
      const ti = Math.min(pay, l.I)
      l.I -= ti
      l.P = Math.max(0, l.P - (pay - ti))
    })
    if (extraMonthly > 0) {
      let ex = extraMonthly
      ls.filter((l) => l.P > 0)
        .sort((a, b) => b.rate - a.rate)
        .forEach((l) => {
          if (ex <= 0) return
          const ap = Math.min(ex, l.P + l.I)
          const ti = Math.min(ap, l.I)
          l.I -= ti
          l.P = Math.max(0, l.P - (ap - ti))
          ex -= ap
        })
    }
    pts.push(ls.reduce((s, l) => s + l.P + l.I, 0))
    if (ls.every((l) => l.P <= 0)) break
  }
  return pts
}

/** Months until debt is cleared at given extra monthly payment. */
export function monthsToZero(loans: Loan[], extraMonthly = 0): number {
  const pts = projectDebt(loans, extraMonthly, 600)
  return pts.length - 1
}

/**
 * Total interest (переплата) remaining on all loans at a given extra monthly payment.
 * totalInterest = totalPaid − startingDebt.
 */
export function totalInterestRemaining(loans: Loan[], extraMonthly = 0): number {
  const ls = loans.map((l) => ({
    P: Number(l.principal),
    I: Number(l.accrued_int),
    rate: Number(l.rate),
    min: Number(l.min_payment),
  }))
  const startDebt = ls.reduce((s, l) => s + l.P + l.I, 0)
  let totalPaid = 0

  for (let i = 0; i < 600; i++) {
    ls.forEach((l) => {
      l.I += monthlyInterestApprox(l.P, l.rate)
      const pay = Math.min(l.min, l.P + l.I)
      const ti = Math.min(pay, l.I); l.I -= ti; l.P = Math.max(0, l.P - (pay - ti))
      totalPaid += pay
    })
    if (extraMonthly > 0) {
      let ex = extraMonthly
      ls.filter((l) => l.P > 0).sort((a, b) => b.rate - a.rate).forEach((l) => {
        if (ex <= 0) return
        const ap = Math.min(ex, l.P + l.I)
        const ti = Math.min(ap, l.I); l.I -= ti; l.P = Math.max(0, l.P - (ap - ti)); ex -= ap
        totalPaid += ap
      })
    }
    if (ls.every((l) => l.P <= 0)) break
  }
  return Math.max(0, Math.round(totalPaid - startDebt))
}
