/**
 * lib/calc.ts — чистые расчётные функции (без БД, тестируемые)
 * Используются и ботом, и eval-тестами.
 */

export interface BonusConfig {
  nominals: Record<string, number>
  threshold: number
  marginShare: number
  momentShare: number
  r1: number // НДФЛ ставка
  qm2: number
  qm3: number
}

/** Ежемесячный бонус (момент) */
export function computeMonthlyBonus(
  clients: Record<string, number>,
  revenue: number,
  cfg: BonusConfig
): { clientPot: number; pot: number; excess: number; moment: number; annual: number; net: number } {
  const clientPot = Object.entries(clients).reduce((s, [g, n]) => s + (cfg.nominals[g] ?? 0) * n, 0)
  const pot = clientPot + revenue * cfg.marginShare
  const excess = Math.max(0, pot - cfg.threshold)
  const moment = excess * cfg.momentShare
  const annual = excess * (1 - cfg.momentShare)
  const net = Math.round(moment * (1 - cfg.r1))
  return { clientPot, pot, excess, moment, annual, net }
}

/** Квартальный бонус */
export function computeQuarterlyBonus(
  quarterClients: Record<string, number>,
  cfg: BonusConfig
): { clientCount: number; mult: number; gross: number; net: number } {
  const clientCount = Object.values(quarterClients).reduce((s, n) => s + (n || 0), 0)
  const mult = clientCount >= 3 ? cfg.qm3 : clientCount === 2 ? cfg.qm2 : 0
  const nominalSum = Object.entries(quarterClients).reduce((s, [g, n]) => s + (cfg.nominals[g] ?? 0) * n, 0)
  const gross = nominalSum * mult
  const net = Math.round(gross * (1 - cfg.r1))
  return { clientCount, mult, gross, net }
}

/** Прогноз остатка к концу месяца */
export function computeProjectedEnd(p: {
  liquid: number
  incoming: number
  pendingLoans: number
  fixedUnpaid: number
  varLeft: number
  plannedPurchases?: number
}): { projEnd: number; projEndAfterPlanned: number } {
  const projEnd = p.liquid + p.incoming - p.pendingLoans - p.fixedUnpaid - p.varLeft
  const projEndAfterPlanned = projEnd - (p.plannedPurchases ?? 0)
  return { projEnd, projEndAfterPlanned }
}

/** Дневной бюджет переменных трат */
export function computeDailyBudget(varBudget: number, varSpent: number, daysLeft: number): number {
  const varLeft = Math.max(0, varBudget - varSpent)
  return Math.round(varLeft / Math.max(1, daysLeft))
}

/** День аванса: 15-е если рабочий, иначе последний рабочий день перед 15-м */
export function advanceDay(y: number, m: number): number {
  const d = new Date(y, m - 1, 15)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1)
  return d.getDate()
}

/** Последний рабочий день месяца */
export function lastWorkingDayOfMonth(y: number, m: number): number {
  const d = new Date(y, m, 0)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1)
  return d.getDate()
}

/**
 * Сценарный анализ решения о покупке.
 * Сравнивает: купить в кредит vs за наличные vs подождать (бонус/накопление).
 */
export interface DecisionInput {
  itemCost: number           // стоимость покупки
  loanRate: number           // годовая ставка кредита (например 0.33)
  loanMonths: number         // срок кредита в месяцах
  currentLiquid: number      // текущая ликвидность
  expectedBonus?: number     // ожидаемый бонус (для сценария ожидания)
  weeksUntilBonus?: number   // через сколько недель бонус
  minSafeLiquid?: number     // минимальная безопасная ликвидность (подушка)
}

export interface DecisionResult {
  creditScenario: { monthlyPayment: number; totalPaid: number; overpayment: number }
  cashScenario: { liquidAfter: number; safe: boolean }
  waitScenario: { weeks: number; canCoverWithBonus: boolean } | null
  recommendation: string
}

/** Поиск оптимального досрочного погашения: самый дорогой кредит, который осилим */
export interface RepaymentSuggestion {
  loanName: string
  rate: number
  principal: number
  suggestedAmount: number
  monthlySaving: number
  breakEvenMonths: number
  roiDescription: string
}

export function suggestEarlyRepayment(
  loans: Array<{name:string; principal:number; accrued_int:number; rate:number; min_payment:number}>,
  liquidCash: number,
  minSafeLiquid = 10000
): RepaymentSuggestion | null {
  const usable = liquidCash - minSafeLiquid
  if (usable < 5000) return null
  // Берём самый дорогой кредит с остатком
  const sorted = loans.filter(l => l.principal > 0).sort((a,b) => b.rate - a.rate)
  const best = sorted[0]
  if (!best) return null
  const amount = Math.min(usable, best.principal)
  const monthlyRate = best.rate / 12
  const newPrincipal = Math.max(0, best.principal - amount)
  const ratio = best.principal > 0 ? newPrincipal / best.principal : 0
  const newPayment = Math.round(best.min_payment * ratio)
  const saving = best.min_payment - newPayment
  const breakEven = saving > 0 ? Math.ceil(amount / saving) : 0
  const annualGain = saving * 12
  const roi = amount > 0 ? Math.round(annualGain / amount * 100) : 0
  return {
    loanName: best.name,
    rate: best.rate,
    principal: best.principal,
    suggestedAmount: Math.round(amount),
    monthlySaving: saving,
    breakEvenMonths: breakEven,
    roiDescription: `ROI ${roi}%/год (как вклад под ${roi}% без риска)`,
  }
}

/** Кол-во рабочих дней (пн-пт) в месяце с учётом праздников */
export function computeWorkingDays(year: number, month: number, holidays?: string[]): number {
  const holidaySet = new Set(holidays ?? [])
  const daysInMonth = new Date(year, month, 0).getDate()
  let count = 0
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    const day = new Date(year, month - 1, d).getDay()
    if (day !== 0 && day !== 6 && !holidaySet.has(dateStr)) count++
  }
  return count
}

export interface CreditBurdenResult {
  dailyRate: number
  totalMonthlyPayment: number
  workingDaysForLoans: number
  percentOfIncome: number
  freedomWorkingDay: number
  totalRemainingInterest: number
  loanDetails: Array<{ name: string; payment: number; daysEquivalent: number }>
}

export function computeCreditBurden(
  loans: Array<{ name: string; min_payment: number; principal: number; rate: number }>,
  salaryNet: number,
  workingDays: number
): CreditBurdenResult {
  const dailyRate = workingDays > 0 ? Math.round(salaryNet / workingDays) : 0
  const totalMonthlyPayment = Math.round(loans.reduce((s, l) => s + l.min_payment, 0))
  const workingDaysForLoans = dailyRate > 0 ? Math.ceil(totalMonthlyPayment / dailyRate) : 0
  const percentOfIncome = salaryNet > 0 ? Math.round(totalMonthlyPayment / salaryNet * 100) : 0
  const freedomWorkingDay = workingDaysForLoans + 1
  const totalRemainingInterest = Math.round(
    loans.reduce((s, l) => {
      const monthlyRate = l.rate / 12
      const months = l.principal > 0 && l.min_payment > 0
        ? Math.ceil(l.principal / Math.max(1, l.min_payment - l.principal * monthlyRate))
        : 0
      return s + Math.max(0, l.min_payment * months - l.principal)
    }, 0)
  )
  const loanDetails = loans.map(l => ({
    name: l.name,
    payment: Math.round(l.min_payment),
    daysEquivalent: dailyRate > 0 ? Math.round(l.min_payment / dailyRate * 10) / 10 : 0,
  }))
  return { dailyRate, totalMonthlyPayment, workingDaysForLoans, percentOfIncome, freedomWorkingDay, totalRemainingInterest, loanDetails }
}

export interface RepaymentStrategy {
  type: 'close_fully' | 'partial_highest_rate' | 'partial_smallest'
  loanName: string
  amount: number
  monthlySaving: number
  annualROI: number
  paybackMonths: number
  explanation: string
}

export interface OptimalRepaymentResult {
  availableForRepayment: number
  strategies: RepaymentStrategy[]
  topRecommendation: string
}

export function computeOptimalRepayment(
  loans: Array<{ name: string; principal: number; rate: number; min_payment: number }>,
  availableBonus: number,
  mandatoryExpenses: number,
  safeLiquid: number
): OptimalRepaymentResult {
  const available = Math.max(0, availableBonus - mandatoryExpenses - safeLiquid)
  const activeLoan = loans.filter(l => l.principal > 0)
  const strategies: RepaymentStrategy[] = []

  // Strategy A: close smallest loan fully (psychological effect)
  const bySmallest = [...activeLoan].sort((a, b) => a.principal - b.principal)
  const smallest = bySmallest[0]
  if (smallest && Math.round(smallest.principal) <= available) {
    const saving = Math.round(smallest.min_payment)
    const roi = smallest.principal > 0 ? Math.round(saving * 12 / smallest.principal * 100) : 0
    const payback = saving > 0 ? Math.ceil(smallest.principal / saving) : 0
    strategies.push({
      type: 'close_fully',
      loanName: smallest.name,
      amount: Math.round(smallest.principal),
      monthlySaving: saving,
      annualROI: roi,
      paybackMonths: payback,
      explanation: `Закрыть ${smallest.name} полностью — психологический эффект + свободные ${saving.toLocaleString('ru-RU')}₽/мес навсегда`,
    })
  }

  // Strategy B: partial highest rate (most financially optimal)
  const byRate = [...activeLoan].sort((a, b) => b.rate - a.rate)
  const expensive = byRate[0]
  if (expensive && available >= 5000) {
    const amount = Math.min(available, expensive.principal)
    const newPrincipal = Math.max(0, expensive.principal - amount)
    const ratio = expensive.principal > 0 ? newPrincipal / expensive.principal : 0
    const newPayment = Math.round(expensive.min_payment * ratio)
    const saving = expensive.min_payment - newPayment
    const roi = amount > 0 ? Math.round(saving * 12 / amount * 100) : 0
    const payback = saving > 0 ? Math.ceil(amount / saving) : 0
    // Only add if it's different from strategy A
    if (!strategies.length || expensive.name !== smallest?.name || amount < Math.round(expensive.principal)) {
      strategies.push({
        type: 'partial_highest_rate',
        loanName: expensive.name,
        amount: Math.round(amount),
        monthlySaving: saving,
        annualROI: roi,
        paybackMonths: payback,
        explanation: `Частично погасить ${expensive.name} (${(expensive.rate * 100).toFixed(1)}%): платёж ${expensive.min_payment.toLocaleString('ru-RU')} → ${newPayment.toLocaleString('ru-RU')}₽/мес`,
      })
    }
  }

  // Sort by annualROI desc
  strategies.sort((a, b) => b.annualROI - a.annualROI)

  const top = strategies[0]
  const topRecommendation = top
    ? `Направь ${top.amount.toLocaleString('ru-RU')}₽ на ${top.loanName}: сэкономишь ${top.monthlySaving.toLocaleString('ru-RU')}₽/мес, ROI ${top.annualROI}%/год, окупаемость ${top.paybackMonths} мес`
    : `Доступно для погашения: ${available.toLocaleString('ru-RU')}₽ — недостаточно для значимого эффекта`

  return { availableForRepayment: Math.round(available), strategies, topRecommendation }
}

/** Расчёт корректировки за отпуск/больничный */
export function computeVacationAdjustment(
  vacationDays: number,
  paidAmount: number,
  salaryNet: number,
  workingDays: number
): { dailyRate: number; deductFromSalary: number; actualLoss: number; deductFrom: 'advance' | 'eom' } {
  const dailyRate = workingDays > 0 ? Math.round(salaryNet / workingDays) : 0
  const deductFromSalary = dailyRate * vacationDays
  const actualLoss = deductFromSalary - paidAmount
  // Простое правило: если дней меньше половины месяца — из аванса, иначе из eom
  const deductFrom: 'advance' | 'eom' = vacationDays <= 7 ? 'advance' : 'eom'
  return { dailyRate, deductFromSalary, actualLoss, deductFrom }
}

export function annuityPayment(principal: number, monthlyRate: number, months: number): number {
  if (monthlyRate === 0) return principal / months
  const k = Math.pow(1 + monthlyRate, months)
  return (principal * monthlyRate * k) / (k - 1)
}

export function analyzeDecision(input: DecisionInput): DecisionResult {
  const monthlyRate = input.loanRate / 12
  const monthlyPayment = annuityPayment(input.itemCost, monthlyRate, input.loanMonths)
  const totalPaid = monthlyPayment * input.loanMonths
  const overpayment = totalPaid - input.itemCost

  const liquidAfter = input.currentLiquid - input.itemCost
  const minSafe = input.minSafeLiquid ?? 10000
  const cashSafe = liquidAfter >= minSafe

  const waitScenario = input.expectedBonus != null && input.weeksUntilBonus != null
    ? { weeks: input.weeksUntilBonus, canCoverWithBonus: input.expectedBonus >= input.itemCost }
    : null

  // Логика рекомендации
  let recommendation = ''
  if (waitScenario?.canCoverWithBonus && waitScenario.weeks <= 8) {
    recommendation = `Подожди ${waitScenario.weeks} нед. до бонуса — сэкономишь ${Math.round(overpayment).toLocaleString('ru-RU')} ₽ переплаты по кредиту. Альтернативные издержки ожидания минимальны.`
  } else if (cashSafe) {
    recommendation = `Купи за наличные — переплата по кредиту ${Math.round(overpayment).toLocaleString('ru-RU')} ₽ не оправдана, ликвидность останется безопасной (${Math.round(liquidAfter).toLocaleString('ru-RU')} ₽).`
  } else if (overpayment / input.itemCost < 0.05) {
    recommendation = `Кредит приемлем — переплата ${Math.round(overpayment).toLocaleString('ru-RU')} ₽ (${(overpayment/input.itemCost*100).toFixed(1)}%) невелика, наличные оставят опасно низкую ликвидность.`
  } else {
    recommendation = `Осторожно: кредит даёт переплату ${Math.round(overpayment).toLocaleString('ru-RU')} ₽ (${(overpayment/input.itemCost*100).toFixed(1)}%), а наличные просадят ликвидность до ${Math.round(liquidAfter).toLocaleString('ru-RU')} ₽. Рассмотри рассрочку 0% или отложи покупку.`
  }

  return {
    creditScenario: { monthlyPayment: Math.round(monthlyPayment), totalPaid: Math.round(totalPaid), overpayment: Math.round(overpayment) },
    cashScenario: { liquidAfter: Math.round(liquidAfter), safe: cashSafe },
    waitScenario,
    recommendation,
  }
}
