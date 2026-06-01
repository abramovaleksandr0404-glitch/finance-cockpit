import type { DashboardData, Expense, Month } from './types'
import {
  salarySplit,
  computeMonthlyBonus,
  computeQuarterlyBonus,
  sumQuarterClients,
  parseMonthKey,
  prevMonthKey,
  quarterOf,
  loanDueDay,
} from './engine'

// ── Formatting ───────────────────────────────────────────────────────────────

export function rub(n: number, opts?: { compact?: boolean; sign?: boolean }): string {
  const prefix = opts?.sign && n > 0 ? '+' : ''
  if (opts?.compact && Math.abs(n) >= 1_000_000) {
    return prefix + (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'М ₽'
  }
  if (opts?.compact && Math.abs(n) >= 10_000) {
    return prefix + Math.round(n / 1_000) + 'к ₽'
  }
  // Exact: show kopecks only when the amount has a fractional part
  const hasFraction = Math.abs(n - Math.round(n)) > 0.001
  return (
    prefix +
    new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency: 'RUB',
      minimumFractionDigits: hasFraction ? 2 : 0,
      maximumFractionDigits: hasFraction ? 2 : 0,
    }).format(n)
  )
}

export function pct(value: number, total: number): number {
  if (total === 0) return 0
  return Math.round((value / total) * 100)
}

export function currentMonthKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function monthLabel(key: string): string {
  const { y, m } = parseMonthKey(key)
  return new Date(y, m - 1, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
}

function findMonth(allMonths: Month[], key: string): Month | null {
  return allMonths.find((m) => m.month_key === key) ?? null
}

// ── Income model (real take-home pay) ─────────────────────────────────────────

export interface IncomeBreakdown {
  advance: number
  second: number
  salaryTotal: number
  bonusReceived: number
  quarterlyReceived: number
  totalIncome: number
  bonusEarnedThisMonth: number
  advDay: number
  eomDay: number
  totalWorkdays: number
  advWorkdays: number
  secondWorkdays: number
}

export function calcIncome(data: DashboardData, key: string): IncomeBreakdown {
  const { user, allMonths } = data
  const { y, m } = parseMonthKey(key)
  const split = salarySplit(y, m, user.salary_net)
  const thisMonth = findMonth(allMonths, key)

  // Use stored/edited amounts if present, else computed defaults
  const advance = thisMonth?.salary_adv_amount != null ? Number(thisMonth.salary_adv_amount) : split.advance
  const second = thisMonth?.salary_eom_amount != null ? Number(thisMonth.salary_eom_amount) : split.second

  // Bonus received this month = stored bonus_amount, else computed from PREVIOUS month
  const prevKey = prevMonthKey(key)
  const prevMonth = findMonth(allMonths, prevKey)
  const computedBonus = prevMonth
    ? computeMonthlyBonus(prevMonth.clients || {}, prevMonth.revenue, user, prevMonth.bonus_override).net
    : 0
  const bonusReceived = thisMonth?.bonus_amount != null ? Number(thisMonth.bonus_amount) : computedBonus

  // Bonus earned this month (paid next month) — always computed from this month's revenue
  const bonusEarnedThisMonth = thisMonth
    ? computeMonthlyBonus(thisMonth.clients || {}, thisMonth.revenue, user, thisMonth.bonus_override).net
    : 0

  // Quarterly bonus: paid first month of a quarter, for the PREVIOUS quarter
  let quarterlyReceived = 0
  const isFirstMonthOfQuarter = (m - 1) % 3 === 0
  if (isFirstMonthOfQuarter) {
    const prevQ = quarterOf(m) === 1 ? 4 : quarterOf(m) - 1
    const prevQYear = quarterOf(m) === 1 ? y - 1 : y
    const qMonths = allMonths.filter((mo) => {
      const p = parseMonthKey(mo.month_key)
      return p.y === prevQYear && quarterOf(p.m) === prevQ
    })
    if (qMonths.length) {
      quarterlyReceived = computeQuarterlyBonus(sumQuarterClients(qMonths), user).net
    }
  }

  const salaryTotal = advance + second
  const totalIncome = salaryTotal + bonusReceived + quarterlyReceived

  return {
    advance,
    second,
    salaryTotal,
    bonusReceived,
    quarterlyReceived,
    totalIncome,
    bonusEarnedThisMonth,
    advDay: split.advDay,
    eomDay: split.eomDay,
    totalWorkdays: split.totalDays,
    advWorkdays: split.firstDays,
    secondWorkdays: split.secondDays,
  }
}

const FIXED_CATEGORIES = new Set([
  'Аренда', 'Ипотека', 'Кредит', 'Страховка', 'Интернет',
  'Телефон', 'Подписки', 'ЖКХ', 'ЖКХ/связь', 'Обязательные',
])

export function isFixedCategory(cat: string): boolean {
  return FIXED_CATEGORIES.has(cat)
}

// ── Month summary ─────────────────────────────────────────────────────────────

export interface MonthSummary {
  revenue: number
  income: IncomeBreakdown
  variableSpent: number // logged discretionary expenses
  fixedSpent: number // fixed costs paid this month
  totalSpent: number
  varLimit: number // discretionary budget cap
  varUsedPct: number
  varLeft: number
}

export function calcMonthSummary(data: DashboardData, key?: string): MonthSummary {
  const mk = key ?? currentMonthKey()
  const { user } = data
  const month = findMonth(data.allMonths, mk) ?? data.currentMonth
  const revenue = month?.revenue ?? user.margin_floor
  const income = calcIncome(data, mk)

  const varSpent = variableSpent(data)
  const fixSpent = fixedSpent(data, mk)

  return {
    revenue,
    income,
    variableSpent: varSpent,
    fixedSpent: fixSpent,
    totalSpent: varSpent + fixSpent,
    varLimit: user.var_budget,
    varUsedPct: pct(varSpent, user.var_budget),
    varLeft: Math.max(0, user.var_budget - varSpent),
  }
}

// ── Loans ────────────────────────────────────────────────────────────────────

export interface LoansSummary {
  totalDebt: number
  totalMinPayment: number
  monthlyBurden: number
  dailyInterest: number
}

export function calcLoansSummary(data: DashboardData): LoansSummary {
  const { loans, user } = data
  const totalDebt = loans.reduce((s, l) => s + Number(l.principal) + Number(l.accrued_int), 0)
  const totalMinPayment = loans.reduce((s, l) => s + Number(l.min_payment), 0)
  const dailyInterest = loans.reduce((s, l) => s + Number(l.principal) * Number(l.rate) / 365, 0)
  return {
    totalDebt,
    totalMinPayment,
    monthlyBurden: pct(totalMinPayment, user.salary_net),
    dailyInterest: Math.round(dailyInterest),
  }
}

// ── Cards ────────────────────────────────────────────────────────────────────

export interface CardsSummary {
  totalDebt: number
  totalLimit: number
  utilizationPct: number
}

export function calcCardsSummary(data: DashboardData): CardsSummary {
  const { cards } = data
  const totalDebt = cards.reduce((s, c) => s + c.current_debt, 0)
  const totalLimit = cards.reduce((s, c) => s + c.card_limit, 0)
  return { totalDebt, totalLimit, utilizationPct: pct(totalDebt, totalLimit) }
}

// ── Expense breakdown ──────────────────────────────────────────────────────────

export interface CategoryRow {
  category: string
  amount: number
  pct: number
  isFixed: boolean
}

export function calcExpensesByCategory(expenses: Expense[]): CategoryRow[] {
  const total = expenses.reduce((s, e) => s + e.amount, 0)
  const map = new Map<string, number>()
  for (const e of expenses) {
    map.set(e.category, (map.get(e.category) ?? 0) + e.amount)
  }
  return Array.from(map.entries())
    .map(([category, amount]) => ({
      category,
      amount,
      pct: pct(amount, total),
      isFixed: isFixedCategory(category),
    }))
    .sort((a, b) => b.amount - a.amount)
}

// ── Cashflow waterfall + projected end-of-month balance ───────────────────────

/** Sum of fixed costs NOT yet marked as paid this month. */
export function fixedRemainingSum(data: DashboardData, key: string): number {
  const { user } = data
  const month = data.allMonths.find((m) => m.month_key === key)
  const paid = month?.fixed_paid ?? {}
  return user.fixed_costs.reduce((s, f, i) => {
    const v = paid[i]
    return v == null || v === false ? s + (f.amount || 0) : s
  }, 0)
}

/** Total fixed costs (full template). */
export function fixedTotal(data: DashboardData): number {
  return data.user.fixed_costs.reduce((s, f) => s + (f.amount || 0), 0)
}

/** Sum reserved for this month's goals. */
export function monthGoalsTotal(data: DashboardData, key: string): number {
  return data.goals.filter((g) => g.month_key === key).reduce((s, g) => s + g.amount, 0)
}

/**
 * Start balance for a month.
 * Current/past month → current debit (the real "now").
 * Future month → projected end of the previous month (chained).
 */
export function getMonthStartBalance(data: DashboardData, key: string, depth = 0): number {
  const cur = currentMonthKey()
  const totalLiquid = data.user.debit_balance + (data.user.tbank_debit ?? 0)
  if (key <= cur || depth > 24) return totalLiquid
  return projectedEndInternal(data, prevMonthKey(key), depth + 1)
}

function projectedEndInternal(data: DashboardData, key: string, depth = 0): number {
  const { allMonths, loans } = data
  const month = allMonths.find((m) => m.month_key === key)
  const inc = calcIncome(data, key)

  let p = getMonthStartBalance(data, key, depth)
  const advReceived = month?.salary_adv_received ?? false
  const eomReceived = month?.salary_eom_received ?? false

  // Pending income (not yet received → still to come)
  if (!advReceived) p += inc.advance
  if (!eomReceived) p += inc.second + inc.bonusReceived + inc.quarterlyReceived

  // Pending loan payments this month
  loans
    .filter((l) => Number(l.principal) > 0 && l.paid_month !== key)
    .forEach((l) => {
      p -= Math.min(Number(l.min_payment), Number(l.principal) + Number(l.accrued_int))
    })

  // Unpaid fixed costs
  p -= fixedRemainingSum(data, key)

  // Credit-card debt (conservative: free money after clearing cards).
  // Logged variable expenses are NOT subtracted again — debit-paid ones already
  // reduced the debit balance, card-paid ones are inside card debt above.
  p -= cardDebtTotal(data)

  return Math.round(p)
}

/**
 * "Остаток к концу месяца" — money in the account at month end.
 * Does NOT subtract planned purchases (shown separately).
 */
export function getProjectedEnd(data: DashboardData, key: string): number {
  return projectedEndInternal(data, key, 0)
}

/** "Планируемый остаток" — projected end minus this month's planned purchases. */
export function getPlannedRemainder(data: DashboardData, key: string): number {
  return getProjectedEnd(data, key) - monthGoalsTotal(data, key)
}

/** Variable expenses logged this month. */
export function variableSpent(data: DashboardData): number {
  return data.expenses.reduce((s, e) => s + e.amount, 0)
}

/** Fixed costs actually paid this month. */
export function fixedSpent(data: DashboardData, key: string): number {
  const month = data.allMonths.find((m) => m.month_key === key)
  const paid = month?.fixed_paid ?? {}
  return data.user.fixed_costs.reduce((s, f, i) => {
    const v = paid[String(i)]
    return v != null && v !== false ? s + (typeof v === 'number' ? v : f.amount) : s
  }, 0)
}

/** Total current credit-card debt. */
export function cardDebtTotal(data: DashboardData): number {
  return data.cards.reduce((s, c) => s + c.current_debt, 0)
}

export interface CashflowEvent {
  day: number
  desc: string
  sub: string
  amount: number // +income / −outflow
  type: 'income' | 'loan' | 'fixed' | 'expense' | 'goal'
  done: boolean
  // Action reference for realizing the event:
  ref:
    | { kind: 'advance' }
    | { kind: 'eom'; salaryAmt: number; bonusAmt: number }
    | { kind: 'loan'; loanId: string; payment: number }
    | null
}

/** Ordered cashflow events for the month (the waterfall). */
export function getCashflowEvents(data: DashboardData, key: string): CashflowEvent[] {
  const { allMonths, loans } = data
  const { y, m } = parseMonthKey(key)
  const month = allMonths.find((mo) => mo.month_key === key)
  const inc = calcIncome(data, key)
  const advReceived = month?.salary_adv_received ?? false
  const eomReceived = month?.salary_eom_received ?? false

  const evts: CashflowEvent[] = []

  // 1. Advance
  evts.push({
    day: inc.advDay,
    desc: 'Аванс',
    sub: 'первая часть оклада',
    amount: inc.advance,
    type: 'income',
    done: advReceived,
    ref: { kind: 'advance' },
  })

  // 2. Loans (by due day)
  loans
    .filter((l) => Number(l.principal) > 0)
    .forEach((l) => {
      const payment = Math.min(Number(l.min_payment), Number(l.principal) + Number(l.accrued_int))
      evts.push({
        day: loanDueDay(l, y, m),
        desc: l.name,
        sub: `${(Number(l.rate) * 100).toFixed(2)}% · автосписание`,
        amount: -payment,
        type: 'loan',
        done: l.paid_month === key,
        ref: { kind: 'loan', loanId: l.id, payment },
      })
    })

  // 3. Salary + bonuses (end of month)
  const eomAmt = inc.second + inc.bonusReceived + inc.quarterlyReceived
  let eomSub = `оклад ${rub(inc.second, { compact: true })}`
  if (inc.bonusReceived > 0) eomSub += ` + бонус ${rub(inc.bonusReceived, { compact: true })}`
  if (inc.quarterlyReceived > 0) eomSub += ` + кв. ${rub(inc.quarterlyReceived, { compact: true })}`
  evts.push({
    day: inc.eomDay,
    desc: 'ЗП + бонусы',
    sub: eomSub,
    amount: eomAmt,
    type: 'income',
    done: eomReceived,
    ref: { kind: 'eom', salaryAmt: inc.second, bonusAmt: inc.bonusReceived + inc.quarterlyReceived },
  })

  // 4. Fixed costs remaining (paid early in month, days 1–15)
  const fixRem = fixedRemainingSum(data, key)
  if (fixRem > 0) {
    evts.push({
      day: 5,
      desc: 'Постоянные траты',
      sub: 'отметь оплату в блоке ниже',
      amount: -fixRem,
      type: 'fixed',
      done: false,
      ref: null,
    })
  }

  return evts.sort((a, b) => a.day - b.day)
}

// ── Financial health metrics ──────────────────────────────────────────────

/** Days remaining in the selected month (from today, inclusive). */
export function daysRemainingInMonth(key: string): number {
  const { y, m } = parseMonthKey(key)
  const today = new Date()
  const isCurrentMonth = today.getFullYear() === y && today.getMonth() + 1 === m
  const daysInMonth = new Date(y, m, 0).getDate()
  if (!isCurrentMonth) return daysInMonth
  // Count today + all remaining days (inclusive of today)
  return Math.max(1, daysInMonth - today.getDate() + 1)
}

/** Days until next salary event (advance or EOM). Returns null if both received. */
export function daysUntilPayday(data: DashboardData, key: string): { label: string; days: number } | null {
  const { allMonths } = data
  const month = allMonths.find((m) => m.month_key === key)
  const inc = calcIncome(data, key)
  const today = new Date()
  const { y, m } = parseMonthKey(key)

  if (!month?.salary_adv_received) {
    const advDate = new Date(y, m - 1, inc.advDay)
    const days = Math.max(0, Math.ceil((advDate.getTime() - today.getTime()) / 86_400_000))
    if (days >= 0) return { label: `аванс ${inc.advDay} числа`, days }
  }
  if (!month?.salary_eom_received) {
    const eomDate = new Date(y, m - 1, inc.eomDay)
    const days = Math.max(0, Math.ceil((eomDate.getTime() - today.getTime()) / 86_400_000))
    return { label: `зарплата ${inc.eomDay} числа`, days }
  }
  return null
}

/** Daily budget allowance = varLeft / daysRemaining. */
export function dailyBudgetAllowance(data: DashboardData, key: string): number {
  const s = calcMonthSummary(data, key)
  const daysLeft = daysRemainingInMonth(key)
  return Math.round(s.varLeft / daysLeft)
}

/**
 * Savings rate: what % of income will remain as a net increase in liquid balance.
 * = (projected_end - start_balance) / income × 100
 */
export function savingsRate(data: DashboardData, key: string): number {
  const start = getMonthStartBalance(data, key)
  const projEnd = getProjectedEnd(data, key)
  const inc = calcIncome(data, key)
  if (inc.totalIncome <= 0) return 0
  return Math.round((projEnd - start) / inc.totalIncome * 100)
}
