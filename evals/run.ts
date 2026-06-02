/**
 * evals/run.ts — Тесты чистых функций.
 * Запуск: npx tsx evals/run.ts
 * Должны пройти все перед каждым коммитом.
 */
import {
  computeMonthlyBonus, computeQuarterlyBonus, computeProjectedEnd,
  computeDailyBudget, advanceDay, lastWorkingDayOfMonth, analyzeDecision,
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
}

console.log('\n=== ПРОГНОЗ ОСТАТКА ===')
{
  const p = computeProjectedEnd({
    liquid: 8667, incoming: 152510, pendingLoans: 44144, fixedUnpaid: 18872, varLeft: 39770, plannedPurchases: 30000,
  })
  approx('прогноз остатка', p.projEnd, 8667 + 152510 - 44144 - 18872 - 39770, 1)
  approx('после плановых', p.projEndAfterPlanned, 8667 + 152510 - 44144 - 18872 - 39770 - 30000, 1)
}

console.log('\n=== ДНЕВНОЙ БЮДЖЕТ ===')
{
  check('40000 лимит, 230 потрачено, 30 дней', computeDailyBudget(40000, 230, 30), Math.round(39770 / 30))
  check('лимит исчерпан', computeDailyBudget(40000, 40000, 10), 0)
}

console.log('\n=== ДАТЫ ВЫПЛАТ ===')
{
  // Июнь 2026: 15-е понедельник → аванс 15
  check('аванс июнь 2026 (15 пн)', advanceDay(2026, 6), 15)
  // Последний рабочий день июня 2026 — 30-е (вторник)
  check('посл. раб. день июня 2026', lastWorkingDayOfMonth(2026, 6), 30)
}

console.log('\n=== СЦЕНАРНЫЙ АНАЛИЗ (макбук-кейс) ===')
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
}

console.log(`\n${'='.repeat(40)}`)
console.log(`ИТОГО: ${passed} прошло, ${failed} провалено`)
console.log('='.repeat(40))
process.exit(failed > 0 ? 1 : 0)
