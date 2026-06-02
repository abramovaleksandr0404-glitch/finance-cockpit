/**
 * evals/run.ts — Тесты чистых функций.
 * Запуск: npx tsx evals/run.ts
 * Должны пройти все перед каждым коммитом.
 */
import {
  computeMonthlyBonus, computeQuarterlyBonus, computeProjectedEnd,
  computeDailyBudget, advanceDay, lastWorkingDayOfMonth, analyzeDecision,
  suggestEarlyRepayment,
  type BonusConfig,
} from '../lib/calc'

let passed = 0, failed = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { passed++; console.log(`  ✅ ${name}`) }
  else { failed++; console.log(`  ❌ ${name}\n     ожидалось: ${JSON.stringify(expected)}\n     получено:  ${JSON.stringify(actual)}`) }
}
function approx(name: string, actual: number, expected: number, tol = 1) {
  const ok = Math.abs(actual - expected) <= tol
  if (ok) { passed++; console.log(`  ✅ ${name}`) }
  else { failed++; console.log(`  ❌ ${name}\n     ожидалось ~${expected}, получено ${actual}`) }
}

const cfg: BonusConfig = {
  nominals: { g3: 7200, g4: 14400, g56: 21600, g78: 43200, g9: 64000, g10: 80000 },
  threshold: 56000, marginShare: 0.20, momentShare: 0.80, r1: 0.13, qm2: 2, qm3: 3,
}

console.log('\n=== БОНУС: ежемесячный ===')
{
  // 3 клиента g10, выручка 41666
  const b = computeMonthlyBonus({ g10: 3 }, 41666, cfg)
  approx('котёл (3×г10 + 20%×41666)', b.pot, 240000 + 8333.2, 1)
  approx('сверхпорог', b.excess, 248333.2 - 56000, 1)
  approx('момент (80%)', b.moment, (248333.2 - 56000) * 0.8, 1)
  approx('на руки (НДФЛ 13%)', b.net, Math.round((248333.2 - 56000) * 0.8 * 0.87), 1)
}

console.log('\n=== БОНУС: 0 клиентов ===')
{
  const b0 = computeMonthlyBonus({}, 0, cfg)
  check('без клиентов — котёл 0', b0.pot, 0)
  check('без клиентов — excess 0', b0.excess, 0)
  check('без клиентов — net 0', b0.net, 0)

  // Выручка не дотягивает до порога
  const bLow = computeMonthlyBonus({}, 200000, cfg)
  approx('только выручка 200к — котёл', bLow.pot, 200000 * 0.2, 1)
  check('котёл ниже порога → excess 0', bLow.excess, 0)
}

console.log('\n=== БОНУС: один клиент разных грейдов ===')
{
  const bg3 = computeMonthlyBonus({ g3: 1 }, 0, cfg)
  check('г3 котёл = 7200', bg3.clientPot, 7200)
  check('г3 excess 0 (ниже порога)', bg3.excess, 0)

  const bg10 = computeMonthlyBonus({ g10: 1 }, 0, cfg)
  check('г10 котёл = 80000', bg10.clientPot, 80000)
  approx('г10 excess = 80000-56000', bg10.excess, 24000, 1)
  approx('г10 net', bg10.net, Math.round(24000 * 0.8 * 0.87), 1)
}

console.log('\n=== БОНУС: квартальный ===')
{
  // Q2: 3 г3 + 5 г10 = 8 клиентов, множитель 3
  const q = computeQuarterlyBonus({ g3: 3, g10: 5 }, cfg)
  check('кол-во клиентов', q.clientCount, 8)
  check('множитель (≥3 → qm3)', q.mult, 3)
  approx('gross = (3×7200 + 5×80000)×3', q.gross, (21600 + 400000) * 3, 1)
  approx('net', q.net, Math.round((21600 + 400000) * 3 * 0.87), 1)

  // 2 клиента → множитель 2
  const q2 = computeQuarterlyBonus({ g10: 2 }, cfg)
  check('2 клиента → множитель qm2', q2.mult, 2)

  // 1 клиент → множитель 0
  const q1 = computeQuarterlyBonus({ g10: 1 }, cfg)
  check('1 клиент → множитель 0', q1.mult, 0)
  check('1 клиент → gross 0', q1.gross, 0)

  // 0 клиентов
  const q0 = computeQuarterlyBonus({}, cfg)
  check('0 клиентов → mult 0', q0.mult, 0)
  check('0 клиентов → gross 0', q0.gross, 0)
}

console.log('\n=== ПРОГНОЗ ОСТАТКА ===')
{
  const p = computeProjectedEnd({
    liquid: 8667, incoming: 152510, pendingLoans: 44144, fixedUnpaid: 18872, varLeft: 39770, plannedPurchases: 30000,
  })
  approx('прогноз остатка', p.projEnd, 8667 + 152510 - 44144 - 18872 - 39770, 1)
  approx('после плановых', p.projEndAfterPlanned, 8667 + 152510 - 44144 - 18872 - 39770 - 30000, 1)

  // Нет плановых покупок
  const p2 = computeProjectedEnd({ liquid: 10000, incoming: 50000, pendingLoans: 5000, fixedUnpaid: 3000, varLeft: 10000 })
  check('без плановых: projEnd = projEndAfterPlanned', p2.projEnd, p2.projEndAfterPlanned)
}

console.log('\n=== ДНЕВНОЙ БЮДЖЕТ ===')
{
  check('40000 лимит, 230 потрачено, 30 дней', computeDailyBudget(40000, 230, 30), Math.round(39770 / 30))
  check('лимит исчерпан', computeDailyBudget(40000, 40000, 10), 0)
  check('перерасход → 0', computeDailyBudget(40000, 45000, 10), 0)
  check('0 дней → ∞ не делится, вернуть всё', computeDailyBudget(40000, 0, 0), 40000)
}

console.log('\n=== ДАТЫ ВЫПЛАТ ===')
{
  // Июнь 2026: 15-е понедельник → аванс 15
  check('аванс июнь 2026 (15 пн)', advanceDay(2026, 6), 15)
  // Последний рабочий день июня 2026 — 30-е (вторник)
  check('посл. раб. день июня 2026', lastWorkingDayOfMonth(2026, 6), 30)
  // Январь 2026: 15 — четверг → аванс 15
  check('аванс январь 2026 (15 чт)', advanceDay(2026, 1), 15)
  // Последний раб. день января 2026: 31 — суббота → 30 (пятница)
  check('посл. раб. день января 2026 (31 сб → 30 пт)', lastWorkingDayOfMonth(2026, 1), 30)
}

console.log('\n=== СЦЕНАРНЫЙ АНАЛИЗ: макбук в кредит ===')
{
  const d = analyzeDecision({
    itemCost: 200000, loanRate: 0.33, loanMonths: 12,
    currentLiquid: 50000, expectedBonus: 470000, weeksUntilBonus: 6, minSafeLiquid: 10000,
  })
  console.log(`     платёж/мес: ${d.creditScenario.monthlyPayment}, переплата: ${d.creditScenario.overpayment}`)
  console.log(`     рекомендация: ${d.recommendation}`)
  check('переплата положительна', d.creditScenario.overpayment > 0, true)
  check('наличные просадят ликвидность (50к-200к<10к)', d.cashScenario.safe, false)
  check('бонус покроет покупку', d.waitScenario?.canCoverWithBonus, true)
  check('рекомендация — подождать бонуса', d.recommendation.includes('бонус') || d.recommendation.includes('Подожди'), true)
}

console.log('\n=== СЦЕНАРНЫЙ АНАЛИЗ: безопасная покупка наличными ===')
{
  const d2 = analyzeDecision({
    itemCost: 30000, loanRate: 0.33, loanMonths: 12,
    currentLiquid: 150000, minSafeLiquid: 30000,
  })
  check('наличные безопасны (150к-30к≥30к)', d2.cashScenario.safe, true)
  check('нет сценария ожидания (бонус не задан)', d2.waitScenario, null)
  check('рекомендация — наличные', d2.recommendation.includes('наличные') || d2.recommendation.includes('Купи'), true)
}

console.log('\n=== СЦЕНАРНЫЙ АНАЛИЗ: высокая переплата, низкая ликвидность ===')
{
  const d3 = analyzeDecision({
    itemCost: 500000, loanRate: 0.33, loanMonths: 12,
    currentLiquid: 25000, minSafeLiquid: 30000,
  })
  check('наличные небезопасны', d3.cashScenario.safe, false)
  check('переплата больше 0', d3.creditScenario.overpayment > 0, true)
  approx('переплата > 10% от стоимости', d3.creditScenario.overpayment / 500000, 0.18, 0.05)
}

console.log('\n=== СЦЕНАРНЫЙ АНАЛИЗ: кредит приемлем (маленькая ставка) ===')
{
  const d4 = analyzeDecision({
    itemCost: 100000, loanRate: 0.03, loanMonths: 12,
    currentLiquid: 15000, minSafeLiquid: 30000,
  })
  check('маленькая переплата → кредит приемлем', d4.creditScenario.overpayment / 100000 < 0.05, true)
}

console.log('\n=== ДОСРОЧНОЕ ПОГАШЕНИЕ ===')
{
  const loans = [
    { name: 'Кредит А', principal: 200000, rate: 0.33, minPayment: 20000 },
    { name: 'Кредит Б', principal: 100000, rate: 0.25, minPayment: 10000 },
  ]

  // 80к ликвидности, буфер 30к — свободных 50к
  const s1 = suggestEarlyRepayment(80000, loans, 30000)
  check('выбирает самый дорогой кредит (33%)', s1?.loanName, 'Кредит А')
  check('сумма = свободных средств', s1?.repayAmount, 50000)
  approx('годовая экономия ~50к×0.33', s1?.annualSavings ?? 0, 50000 * 0.33, 100)

  // Недостаточно средств (буфер > ликвидности)
  const s2 = suggestEarlyRepayment(25000, loans, 30000)
  check('нет рекомендации — свободных < 10к', s2, null)

  // Очень большая ликвидность → ограничивается основным долгом
  const s3 = suggestEarlyRepayment(500000, [{ name: 'Кредит', principal: 50000, rate: 0.30, minPayment: 5000 }], 30000)
  check('сумма не превышает остаток долга', s3?.repayAmount, 50000)

  // Нет кредитов
  const s4 = suggestEarlyRepayment(100000, [], 30000)
  check('нет кредитов → null', s4, null)
}

console.log(`\n${'='.repeat(40)}`)
console.log(`ИТОГО: ${passed} прошло, ${failed} провалено`)
console.log('='.repeat(40))
process.exit(failed > 0 ? 1 : 0)
