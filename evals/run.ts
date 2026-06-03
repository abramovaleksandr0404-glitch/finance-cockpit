/**
 * evals/run.ts — тесты чистых функций + инварианты промпта.
 * Запуск: npm run eval
 * Все тесты проходят перед каждым коммитом.
 */
import {
  computeMonthlyBonus, computeQuarterlyBonus, computeProjectedEnd,
  computeDailyBudget, advanceDay, lastWorkingDayOfMonth, analyzeDecision,
  suggestEarlyRepayment, type BonusConfig,
} from '../lib/calc'
import { SYSTEM_PROMPT, TOOLS } from '../lib/bot'

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
  const b = computeMonthlyBonus({ g10: 3 }, 41666, cfg)
  approx('котёл (3×г10 + 20%×41666)', b.pot, 240000 + 8333.2, 1)
  approx('сверхпорог', b.excess, 248333.2 - 56000, 1)
  approx('момент (80%)', b.moment, (248333.2 - 56000) * 0.8, 1)
  approx('на руки (НДФЛ 13%)', b.net, Math.round((248333.2 - 56000) * 0.8 * 0.87), 1)
  // 0 клиентов, нет сверхпорога
  const b0 = computeMonthlyBonus({ g3: 1 }, 0, cfg)
  check('г3 без выручки: котёл < порога → 0', b0.net, 0)
}

console.log('\n=== БОНУС: квартальный ===')
{
  const q = computeQuarterlyBonus({ g3: 3, g10: 5 }, cfg)
  check('кол-во клиентов', q.clientCount, 8)
  check('множитель (≥3 → qm3)', q.mult, 3)
  approx('gross = (3×7200 + 5×80000)×3', q.gross, (21600 + 400000) * 3, 1)
  approx('net', q.net, Math.round((21600 + 400000) * 3 * 0.87), 1)
  const q2 = computeQuarterlyBonus({ g10: 2 }, cfg)
  check('2 клиента → множитель qm2', q2.mult, 2)
  const q1 = computeQuarterlyBonus({ g10: 1 }, cfg)
  check('1 клиент → множитель 0', q1.mult, 0)
  check('1 клиент → gross 0', q1.gross, 0)
  const q0 = computeQuarterlyBonus({}, cfg)
  check('0 клиентов → gross 0', q0.gross, 0)
  const q3exact = computeQuarterlyBonus({ g3: 1, g4: 1, g56: 1 }, cfg)
  check('ровно 3 клиента → mult qm3=3', q3exact.mult, 3)
  const q10 = computeQuarterlyBonus({ g10: 10 }, cfg)
  check('10 клиентов → mult qm3=3', q10.mult, 3)
}

console.log('\n=== ПРОГНОЗ ОСТАТКА ===')
{
  const p = computeProjectedEnd({
    liquid: 8667, incoming: 152510, pendingLoans: 44144, fixedUnpaid: 18872, varLeft: 39770, plannedPurchases: 30000,
  })
  approx('прогноз остатка', p.projEnd, 8667 + 152510 - 44144 - 18872 - 39770, 1)
  approx('после плановых', p.projEndAfterPlanned, 8667 + 152510 - 44144 - 18872 - 39770 - 30000, 1)
  // Нулевой входящий
  const p0 = computeProjectedEnd({ liquid: 5000, incoming: 0, pendingLoans: 0, fixedUnpaid: 0, varLeft: 0 })
  check('нет входящих: остаток = liquid', p0.projEnd, 5000)
}

console.log('\n=== ДНЕВНОЙ БЮДЖЕТ ===')
{
  check('40000 лимит, 230 потрачено, 30 дней', computeDailyBudget(40000, 230, 30), Math.round(39770 / 30))
  check('лимит исчерпан', computeDailyBudget(40000, 40000, 10), 0)
  check('1 день остался', computeDailyBudget(40000, 0, 1), 40000)
  check('переполнен лимит → 0', computeDailyBudget(40000, 50000, 10), 0)
}

console.log('\n=== ДАТЫ ВЫПЛАТ ===')
{
  check('аванс июнь 2026 (15 пн)', advanceDay(2026, 6), 15)
  check('посл. раб. день июня 2026', lastWorkingDayOfMonth(2026, 6), 30)
  // Декабрь 2024: 31-е вторник
  check('посл. раб. день декабрь 2024', lastWorkingDayOfMonth(2024, 12), 31)
  // Июль 2026: 15-е среда
  check('аванс июль 2026 (15 ср)', advanceDay(2026, 7), 15)
}

console.log('\n=== СЦЕНАРНЫЙ АНАЛИЗ ===')
{
  // Ждать бонуса 6 недель выгоднее
  const d1 = analyzeDecision({ itemCost:200000,loanRate:0.33,loanMonths:12,currentLiquid:50000,expectedBonus:470000,weeksUntilBonus:6,minSafeLiquid:10000 })
  check('переплата положительна', d1.creditScenario.overpayment > 0, true)
  check('наличные unsafe (50к-200к<10к)', d1.cashScenario.safe, false)
  check('бонус покроет покупку', d1.waitScenario?.canCoverWithBonus, true)
  check('рекомендация содержит "нед"', d1.recommendation.includes('нед'), true)
  // За наличные безопасно
  const d2 = analyzeDecision({ itemCost:50000,loanRate:0.33,loanMonths:12,currentLiquid:200000,minSafeLiquid:10000 })
  check('наличные safe', d2.cashScenario.safe, true)
  check('нет wait-сценария без бонуса', d2.waitScenario, null)
  // Небезопасно и дорогой кредит
  const d3 = analyzeDecision({ itemCost:150000,loanRate:0.33,loanMonths:12,currentLiquid:14000,minSafeLiquid:10000 })
  check('unsafe при малой ликвидности', d3.cashScenario.safe, false)
  check('переплата > 15% суммы', d3.creditScenario.overpayment > d3.creditScenario.totalPaid * 0.15, true)
  // Нулевая ставка
  const d4 = analyzeDecision({ itemCost:10000,loanRate:0,loanMonths:12,currentLiquid:5000,minSafeLiquid:1000 })
  check('нулевая ставка → нет переплаты', d4.creditScenario.overpayment, 0)
}

console.log('\n=== ДОСРОЧНОЕ ПОГАШЕНИЕ ===')
{
  const loans = [
    { name:'Рефинанс', principal:358101, accrued_int:0, rate:0.3398, min_payment:12642 },
    { name:'Кредит В',  principal:119154, accrued_int:0, rate:0.329,  min_payment:4494  },
    { name:'Кредит А',  principal:351481, accrued_int:0, rate:0.329,  min_payment:12092 },
    { name:'Кредит Б',  principal:436714, accrued_int:0, rate:0.329,  min_payment:14917 },
  ]
  const s = suggestEarlyRepayment(loans, 70000, 10000)
  check('есть рекомендация при 70к liquid', s !== null, true)
  check('самый дорогой кредит (Рефинанс)', s?.loanName, 'Рефинанс')
  check('сумма = 60к (70к − 10к подушка)', s?.suggestedAmount, 60000)
  check('экономия > 0', (s?.monthlySaving ?? 0) > 0, true)
  check('окупаемость < 48 мес', (s?.breakEvenMonths ?? 99) < 48, true)
  check('roiDescription содержит %', s?.roiDescription?.includes('%'), true)
  // Мало денег
  const none = suggestEarlyRepayment(loans, 12000, 10000)
  check('нет рекомендации при доступном < 5к', none, null)
  // Нет кредитов
  const empty = suggestEarlyRepayment([], 100000, 10000)
  check('нет рекомендации без кредитов', empty, null)
  // Один кредит с нулевым телом
  const paid = [{ name:'Погашен', principal:0, accrued_int:0, rate:0.33, min_payment:5000 }]
  const noPrincipal = suggestEarlyRepayment(paid, 50000, 10000)
  check('кредит с principal=0 пропускается', noPrincipal, null)
}

console.log('\n=== ПРОМПТ: принцип честности (ПРАВИЛО №4) ===')
{
  check('промпт содержит "в базе"', SYSTEM_PROMPT.includes('в базе'), true)
  check('промпт содержит "не знаю"', SYSTEM_PROMPT.includes('не знаю'), true)
  check('промпт содержит "уточни"', SYSTEM_PROMPT.includes('уточни'), true)
  check('промпт содержит "КОНФЛИКТ"', SYSTEM_PROMPT.includes('КОНФЛИКТ'), true)
  check('промпт содержит "СЛОЖНАЯ ЗАДАЧА"', SYSTEM_PROMPT.includes('СЛОЖНАЯ ЗАДАЧА'), true)
}

console.log('\n=== ИНСТРУМЕНТЫ: update_loan ===')
{
  check('инструмент update_loan зарегистрирован', TOOLS.some(t => t.name === 'update_loan'), true)
  const ul = TOOLS.find(t => t.name === 'update_loan')
  const props = ul?.input_schema?.properties ?? {}
  check('update_loan требует name', ul?.input_schema?.required?.includes('name'), true)
  check('update_loan имеет поле principal', 'principal' in props, true)
  check('update_loan имеет поле rate', 'rate' in props, true)
  check('update_loan имеет поле min_payment', 'min_payment' in props, true)
  check('update_loan имеет поле end_date', 'end_date' in props, true)
  // scenario_analysis, suggest_early_repayment, early_repay также присутствуют
  check('scenario_analysis зарегистрирован', TOOLS.some(t => t.name === 'scenario_analysis'), true)
  check('suggest_early_repayment зарегистрирован', TOOLS.some(t => t.name === 'suggest_early_repayment'), true)
  check('early_repay зарегистрирован', TOOLS.some(t => t.name === 'early_repay'), true)
}

console.log('\n=== ПРОМПТ: надёжный рассуждальщик (SPRINT 3) ===')
{
  check('ПРАВИЛО ЦИТАТЫ присутствует', SYSTEM_PROMPT.includes('ЦИТАТЫ'), true)
  check('промпт содержит "доверяй контексту"', SYSTEM_PROMPT.includes('доверяй контексту'), true)
  check('ПРОГНОЗ vs ФАКТ присутствует', SYSTEM_PROMPT.includes('ПРОГНОЗ vs ФАКТ'), true)
  check('ПРАВИЛО ДЕЙСТВИЯ ВМЕСТО ВОПРОСА присутствует', SYSTEM_PROMPT.includes('ВМЕСТО ВОПРОСА'), true)
  check('промпт содержит "очевиден"', SYSTEM_PROMPT.includes('очевиден'), true)
  check('ОБЪЯСНИТЕЛЬНЫЙ РЕЖИМ присутствует', SYSTEM_PROMPT.includes('ОБЪЯСНИТЕЛЬНЫЙ'), true)
  check('промпт содержит "не говори"', SYSTEM_PROMPT.includes('не говори'), true)
}

console.log('\n=== ДАТЫ СЛЕДУЮЩЕГО МЕСЯЦА ===')
{
  // Июль 2026: 15-е среда — рабочий
  check('аванс июль 2026 (15 ср)', advanceDay(2026, 7), 15)
  // Июль 2026: 31-е пятница — рабочий
  check('посл. раб. день июля 2026 (31 пт)', lastWorkingDayOfMonth(2026, 7), 31)
  // Август 2026: 15-е суббота → сдвиг на 14 пт
  check('аванс август 2026 (15 сб → 14 пт)', advanceDay(2026, 8), 14)
  // Декабрь 2026: 31-е четверг — рабочий
  check('посл. раб. день декабрь 2026 (31 чт)', lastWorkingDayOfMonth(2026, 12), 31)
  // Январь 2027: 15-е пятница — рабочий
  check('аванс январь 2027 (15 пт)', advanceDay(2027, 1), 15)
}

console.log(`\n${'='.repeat(40)}`)
console.log(`ИТОГО: ${passed} прошло, ${failed} провалено`)
console.log('='.repeat(40))
process.exit(failed > 0 ? 1 : 0)
