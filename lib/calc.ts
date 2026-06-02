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

/** Аннуитетный платёж */
function annuityPayment(principal: number, monthlyRate: number, months: number): number {
  if (monthlyRate === 0) return principal / months
  const k = Math.pow(1 + monthlyRate, months)
  return (principal * monthlyRate * k) / (k - 1)
}

// ── Досрочное погашение ──────────────────────────────────────────────────────

export interface RepaymentSuggestion {
  loanName: string
  repayAmount: number
  annualSavings: number
  newPayment: number
  paymentReduction: number
}

/**
 * Находит оптимальное досрочное погашение.
 * Возвращает null если свободных средств недостаточно.
 */
export function suggestEarlyRepayment(
  liquidBalance: number,
  loans: Array<{ name: string; principal: number; rate: number; minPayment: number }>,
  safeBuffer = 30000,
): RepaymentSuggestion | null {
  const freeCash = liquidBalance - safeBuffer
  if (freeCash < 10000) return null

  const activeLoan = [...loans]
    .filter(l => l.principal > 0)
    .sort((a, b) => b.rate - a.rate)[0]

  if (!activeLoan) return null

  const repayAmount = Math.min(freeCash, activeLoan.principal)
  if (repayAmount < 5000) return null

  const annualSavings = Math.round(repayAmount * activeLoan.rate)
  const ratio = Math.max(0, (activeLoan.principal - repayAmount) / activeLoan.principal)
  const newPayment = Math.round(activeLoan.minPayment * ratio)

  return {
    loanName: activeLoan.name,
    repayAmount: Math.round(repayAmount),
    annualSavings,
    newPayment,
    paymentReduction: Math.round(activeLoan.minPayment * (1 - ratio)),
  }
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
