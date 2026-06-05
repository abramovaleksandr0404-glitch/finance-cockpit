/**
 * evals/run.ts — тесты чистых функций + инварианты промпта.
 * Запуск: npm run eval
 * Все тесты проходят перед каждым коммитом.
 */
import {
  computeMonthlyBonus, computeQuarterlyBonus, computeProjectedEnd,
  computeDailyBudget, advanceDay, lastWorkingDayOfMonth, analyzeDecision,
  suggestEarlyRepayment, computeWorkingDays, computeCreditBurden,
  computeOptimalRepayment, computeVacationAdjustment, type BonusConfig,
} from '../lib/calc'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
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

console.log('\n=== ПРОМПТ: ПРАВИЛО №7 (ПРОЗРАЧНОСТЬ ОГРАНИЧЕНИЙ) ===')
{
  check('ПРАВИЛО №7 ПРОЗРАЧНОСТЬ присутствует', SYSTEM_PROMPT.includes('ПРОЗРАЧНОСТЬ'), true)
  check('промпт содержит "⚙️"', SYSTEM_PROMPT.includes('⚙️'), true)
  check('промпт содержит "бэклог"', SYSTEM_PROMPT.includes('бэклог'), true)
}

console.log('\n=== CHANGELOG.md ===')
{
  const p = join(process.cwd(), 'CHANGELOG.md')
  check('CHANGELOG.md существует', existsSync(p), true)
  if (existsSync(p)) {
    const content = readFileSync(p, 'utf-8')
    check('CHANGELOG.md содержит ## блок', content.includes('## '), true)
    check('CHANGELOG.md содержит Sprint', content.includes('Sprint'), true)
  }
}

console.log('\n=== РАСЧЁТ РАБОЧИХ ДНЕЙ ===')
{
  check('июнь 2026 = 22 рабочих дня', computeWorkingDays(2026, 6), 22)
  check('февраль 2024 (високосный) = 21 рабочий день', computeWorkingDays(2024, 2), 21)
  check('декабрь 2025 = 23 рабочих дня', computeWorkingDays(2025, 12), 23)
  check('январь 2026 = 22 рабочих дня', computeWorkingDays(2026, 1), 22)
  check('июль 2026 = 23 рабочих дня', computeWorkingDays(2026, 7), 23)
}

console.log('\n=== РАСЧЁТ КОРРЕКТИРОВКИ ОТПУСКА ===')
{
  // 121600/22 = 5527.27 → dailyRate=5527, deductFromSalary=5527
  const adj1 = computeVacationAdjustment(1, 3000, 121600, 22)
  approx('дневная ставка (121600/22)', adj1.dailyRate, 5527, 1)
  approx('вычет за 1 день', adj1.deductFromSalary, 5527, 1)
  approx('реальная потеря (5527-3000)', adj1.actualLoss, 2527, 1)
  check('1 день → из аванса', adj1.deductFrom, 'advance')

  // Больничный 5 дней, 0₽ → deductFromSalary = 5×5527 = 27635
  const adj2 = computeVacationAdjustment(5, 0, 121600, 22)
  approx('5 дней больничный: вычет', adj2.deductFromSalary, 5527*5, 5)
  approx('5 дней больничный: потеря = вычет', adj2.actualLoss, adj2.deductFromSalary, 1)
  check('5 дней → из аванса', adj2.deductFrom, 'advance')

  // 10 дней → из eom
  const adj3 = computeVacationAdjustment(10, 50000, 121600, 22)
  check('10 дней → из eom', adj3.deductFrom, 'eom')

  // 0 рабочих дней — не делится на 0
  const adj4 = computeVacationAdjustment(5, 0, 121600, 0)
  check('0 рабочих дней → dailyRate=0', adj4.dailyRate, 0)
}

console.log('\n=== ПРОМПТ: SPRINT 4 ===')
{
  check('record_vacation_pay зарегистрирован', TOOLS.some(t => t.name === 'record_vacation_pay'), true)
  check('create_custom_category зарегистрирован', TOOLS.some(t => t.name === 'create_custom_category'), true)
  check('learn_mapping зарегистрирован', TOOLS.some(t => t.name === 'learn_mapping'), true)
  check('save_correction зарегистрирован', TOOLS.some(t => t.name === 'save_correction'), true)
  check('ПРАВИЛО №8 присутствует', SYSTEM_PROMPT.includes('ПРАВИЛО №8'), true)
  check('ПОДТВЕРЖДЕНИЕ ДЕЙСТВИЯ присутствует', SYSTEM_PROMPT.includes('ПОДТВЕРЖДЕНИЕ ДЕЙСТВИЯ'), true)
  check('ОТПУСКНЫЕ в промпте', SYSTEM_PROMPT.includes('ОТПУСКНЫЕ'), true)
  check('ОБУЧЕНИЕ НА ОШИБКАХ в промпте', SYSTEM_PROMPT.includes('ОБУЧЕНИЕ НА ОШИБКАХ'), true)
  check('КАСТОМНЫЕ КАТЕГОРИИ в промпте', SYSTEM_PROMPT.includes('КАСТОМНЫЕ КАТЕГОРИИ'), true)
}

console.log('\n=== computeWorkingDays с праздниками ===')
{
  // Базовые случаи
  check('июнь 2026 без праздников = 22', computeWorkingDays(2026, 6), 22)
  check('июнь 2026 с праздником 12-го = 21', computeWorkingDays(2026, 6, ['2026-06-12']), 21)
  // 2026-06-13 — суббота, праздник на субботу не уменьшает рабочие дни
  check('июнь 2026 с праздниками 12 и 11 = 20', computeWorkingDays(2026, 6, ['2026-06-12', '2026-06-11']), 20)
  check('пустой массив = то же что без праздников', computeWorkingDays(2026, 6, []), 22)
  // 2026-06-07 — воскресенье, праздник на воскресенье не уменьшает счёт
  check('праздник на выходной не уменьшает счёт', computeWorkingDays(2026, 6, ['2026-06-07']), 22)
}

console.log('\n=== computeCreditBurden ===')
{
  const loans = [
    { name: 'Кредит А', min_payment: 10000, principal: 100000, rate: 0.25 },
    { name: 'Кредит Б', min_payment: 5000, principal: 50000, rate: 0.30 },
  ]
  const result = computeCreditBurden(loans, 100000, 22)
  check('totalMonthlyPayment', result.totalMonthlyPayment, 15000)
  approx('dailyRate (100000/22)', result.dailyRate, 4545, 1)
  check('workingDaysForLoans (ceil(15000/dailyRate))', result.workingDaysForLoans, Math.ceil(15000 / Math.round(100000/22)))
  check('percentOfIncome (15%)', result.percentOfIncome, 15)
  check('freedomWorkingDay = workingDaysForLoans + 1', result.freedomWorkingDay, result.workingDaysForLoans + 1)
  check('loanDetails length', result.loanDetails.length, 2)
  check('нет кредитов → 0 дней', computeCreditBurden([], 100000, 22).workingDaysForLoans, 0)
}

console.log('\n=== computeOptimalRepayment ===')
{
  const loans = [
    { name: 'Малый', principal: 30000, rate: 0.25, min_payment: 3000 },
    { name: 'Дорогой', principal: 200000, rate: 0.35, min_payment: 15000 },
  ]
  // Бонус 50000, расходы 0, подушка 10000 → доступно 40000
  const r1 = computeOptimalRepayment(loans, 50000, 0, 10000)
  check('availableForRepayment = 40000', r1.availableForRepayment, 40000)
  check('может закрыть Малый (30000 <= 40000)', r1.strategies.some(s => s.type === 'close_fully' && s.loanName === 'Малый'), true)
  check('есть стратегия partial_highest_rate для Дорогой', r1.strategies.some(s => s.type === 'partial_highest_rate' && s.loanName === 'Дорогой'), true)
  check('стратегии отсортированы по ROI desc', r1.strategies[0].annualROI >= r1.strategies[r1.strategies.length-1].annualROI, true)

  // Мало денег: бонус 5000, подушка 10000 → доступно 0 (отрицательно → 0)
  const r2 = computeOptimalRepayment(loans, 5000, 0, 10000)
  check('мало денег → availableForRepayment = 0', r2.availableForRepayment, 0)
  check('мало денег → пустые стратегии', r2.strategies.length, 0)

  // Достаточно для частичного но не полного закрытия
  const r3 = computeOptimalRepayment(loans, 20000, 0, 5000) // доступно 15000, Малый стоит 30000 → только partial
  check('недостаточно для close_fully', r3.strategies.every(s => s.type !== 'close_fully'), true)
}

console.log('\n=== ПРОМПТ: SPRINT 5 ===')
{
  check('show_balance_history зарегистрирован', TOOLS.some(t => t.name === 'show_balance_history'), true)
  check('analyze_credit_burden зарегистрирован', TOOLS.some(t => t.name === 'analyze_credit_burden'), true)
  check('calculate_optimal_repayment зарегистрирован', TOOLS.some(t => t.name === 'calculate_optimal_repayment'), true)
  check('АВТОТРИГГЕР в промпте', SYSTEM_PROMPT.includes('АВТОТРИГГЕР'), true)
  check('КРЕДИТНАЯ НАГРУЗКА в промпте', SYSTEM_PROMPT.includes('КРЕДИТНАЯ НАГРУЗКА'), true)
}

console.log('\n=== ПРОМПТ: SPRINT 6 ===')
{
  check('reclassify_expense зарегистрирован', TOOLS.some(t => t.name === 'reclassify_expense'), true)
  check('update_cashflow зарегистрирован', TOOLS.some(t => t.name === 'update_cashflow'), true)
  check('add_backlog_item зарегистрирован', TOOLS.some(t => t.name === 'add_backlog_item'), true)
  check('add_multiday_expense зарегистрирован', TOOLS.some(t => t.name === 'add_multiday_expense'), true)
  check('АВТОТРИГГЕР в промпте', SYSTEM_PROMPT.includes('АВТОТРИГГЕР'), true)
  check('БЭКЛОГ РАЗРАБОТКИ в промпте', SYSTEM_PROMPT.includes('БЭКЛОГ РАЗРАБОТКИ'), true)
  check('ОБНОВЛЕНИЕ КЕШФЛОУ в промпте', SYSTEM_PROMPT.includes('ОБНОВЛЕНИЕ КЕШФЛОУ'), true)
  check('СТАВКИ в промпте', SYSTEM_PROMPT.includes('СТАВКИ'), true)
  check('formula категория в промпте', SYSTEM_PROMPT.includes('formula'), true)
  check('галлюцинируешь в промпте', SYSTEM_PROMPT.includes('галлюцинируешь'), true)
}

// computeWorkingDays с праздниками (Sprint 6)
console.log('\n=== computeWorkingDays с праздниками (Sprint 6) ===')
{
  // Проверяем что 2026-06-07 воскресенье — праздник не уменьшает
  const sun = new Date(2026, 5, 7).getDay() // должно быть 0 (вс)
  check('2026-06-07 воскресенье', sun, 0)
  check('праздник на выходной не уменьшает', computeWorkingDays(2026, 6, ['2026-06-07']), 22)
  // Рабочий день 12 июня = пятница
  const fri = new Date(2026, 5, 12).getDay()
  check('2026-06-12 пятница', fri, 5)
  check('июнь 2026 с 12 июня праздником = 21', computeWorkingDays(2026, 6, ['2026-06-12']), 21)
}

console.log('\n=== ПРОМПТ: SPRINT 7 ===')
{
  check('compare_months зарегистрирован', TOOLS.some(t => t.name === 'compare_months'), true)
  check('СТАВКИ в промпте', SYSTEM_PROMPT.includes('СТАВКИ'), true)
  check('БЭКЛОГ РАЗРАБОТКИ в промпте', SYSTEM_PROMPT.includes('БЭКЛОГ РАЗРАБОТКИ'), true)
  // ChartsWidget существует
  const chartsExists = existsSync(join(process.cwd(), 'components/dashboard/ChartsWidget.tsx'))
  check('ChartsWidget.tsx создан', chartsExists, true)
  // BalanceHistoryChart существует
  const balanceHistExists = existsSync(join(process.cwd(), 'components/dashboard/BalanceHistoryChart.tsx'))
  check('BalanceHistoryChart.tsx создан', balanceHistExists, true)
  // sendTelegramWithButtons экспортируется
  const botContent = readFileSync(join(process.cwd(), 'lib/bot.ts'), 'utf-8')
  check('sendTelegramWithButtons в bot.ts', botContent.includes('sendTelegramWithButtons'), true)
  check('answerCallbackQuery в route.ts', readFileSync(join(process.cwd(), 'app/api/telegram/route.ts'), 'utf-8').includes('answerCallbackQuery'), true)
  check('smart alert дебет < 5000', readFileSync(join(process.cwd(), 'app/api/cron/evening/route.ts'), 'utf-8').includes('5000'), true)
}

console.log('\n=== БЕЗОПАСНОСТЬ: SPRINT 8 ===')
{
  const exportContent = readFileSync(join(process.cwd(), 'app/api/bot/export/route.ts'), 'utf-8')
  const vercelContent = readFileSync(join(process.cwd(), 'vercel.json'), 'utf-8')
  const botContent = readFileSync(join(process.cwd(), 'lib/bot.ts'), 'utf-8')
  const claudeContent = readFileSync(join(process.cwd(), 'CLAUDE.md'), 'utf-8')
  check('export route требует auth', exportContent.includes('Unauthorized'), true)
  check('export route проверяет Bearer', exportContent.includes('Bearer'), true)
  check('vercel.json содержит X-Frame-Options', vercelContent.includes('X-Frame-Options'), true)
  check('vercel.json содержит X-Content-Type-Options', vercelContent.includes('X-Content-Type-Options'), true)
  check('vercel.json содержит Referrer-Policy', vercelContent.includes('Referrer-Policy'), true)
  check('input validation VALID_GRADES в bot.ts', botContent.includes('VALID_GRADES'), true)
  check('sanitizeStr в bot.ts', botContent.includes('sanitizeStr'), true)
  check('amount > 10_000_000 блокируется', botContent.includes('10_000_000'), true)
  check('АВТОЗАПУСК в CLAUDE.md', claudeContent.includes('АВТОЗАПУСК'), true)
  check('sprint_queue в CLAUDE.md', claudeContent.includes('sprint_queue'), true)
}

console.log('\n=== ЯКОРЯ: SPRINT 9 ===')
{
  const bot = readFileSync(join(process.cwd(), 'lib/bot.ts'), 'utf-8')
  // Задача 1: bot_anchors читается в getContext
  check('bot_anchors запрос в getContext', bot.includes("from('bot_anchors')"), true)
  check('anchorSection формируется', bot.includes('buildAnchorSection'), true)
  check('anchorSection включён в return', bot.includes('${anchorSection}'), true)
  // Задача 2: update_anchor инструмент
  check('update_anchor в TOOLS', TOOLS.some(t => t.name === 'update_anchor'), true)
  const ua = TOOLS.find(t => t.name === 'update_anchor')
  check('update_anchor требует month_key', ua?.input_schema?.required?.includes('month_key'), true)
  check('update_anchor требует key', ua?.input_schema?.required?.includes('key'), true)
  check('update_anchor требует value', ua?.input_schema?.required?.includes('value'), true)
  // Задача 3: ПРАВИЛО №0 в промпте
  check('ПРАВИЛО №0 в SYSTEM_PROMPT', SYSTEM_PROMPT.includes('ПРАВИЛО №0'), true)
  check('АБСОЛЮТНЫЙ ПРИОРИТЕТ в промпте', SYSTEM_PROMPT.includes('АБСОЛЮТНЫЙ ПРИОРИТЕТ'), true)
  check('ЯКОРЯ в промпте', SYSTEM_PROMPT.includes('ЯКОРЯ'), true)
  // Задача 4: Sprint 6 инструменты
  check('reclassify_expense в TOOLS', TOOLS.some(t => t.name === 'reclassify_expense'), true)
  check('update_cashflow в TOOLS', TOOLS.some(t => t.name === 'update_cashflow'), true)
  check('add_backlog_item в TOOLS', TOOLS.some(t => t.name === 'add_backlog_item'), true)
  check('add_multiday_expense в TOOLS', TOOLS.some(t => t.name === 'add_multiday_expense'), true)
  // Задача 6: forecast якорь используется
  check('anchorForecast используется для projEnd', bot.includes('anchorForecast'), true)
  check('ANCHOR MISMATCH лог', bot.includes('ANCHOR MISMATCH'), true)
}

console.log('\n=== КОНТЕКСТ + ИНСТРУМЕНТЫ: SPRINT 10 ===')
{
  const bot = readFileSync(join(process.cwd(), 'lib/bot.ts'), 'utf-8')
  // Задача 1: Node.js 24
  const runner = readFileSync(join(process.cwd(), '.github/workflows/autonomous-runner.yml'), 'utf-8')
  check('Node.js 24 в runner', runner.includes("node-version: '24'"), true)
  // Задача 2: Календарь
  check('calendarSection в getContext', bot.includes('calendarSection'), true)
  check('upcomingLoans в getContext', bot.includes('upcomingLoans'), true)
  // Задача 3: Все траты
  check('allExpensesSection в getContext', bot.includes('allExpensesSection'), true)
  check('expensesByCategory в getContext', bot.includes('expensesByCategory'), true)
  // Задача 4: Test endpoint
  check('/api/bot/test существует', existsSync(join(process.cwd(), 'app/api/bot/test/route.ts')), true)
  // Задача 5: list_backlog
  check('list_backlog в TOOLS', TOOLS.some(t => t.name === 'list_backlog'), true)
  check('list_backlog в handleTool', bot.includes("name === 'list_backlog'"), true)
  // Задача 7: add_idea
  check('add_idea в TOOLS', TOOLS.some(t => t.name === 'add_idea'), true)
  check('add_idea в executeAction', bot.includes("action.type === 'add_idea'"), true)
  check('ИДЕИ ПОЛЬЗОВАТЕЛЯ в промпте', SYSTEM_PROMPT.includes('ИДЕИ ПОЛЬЗОВАТЕЛЯ'), true)
}

console.log(`\n${'='.repeat(40)}`)
console.log(`ИТОГО: ${passed} прошло, ${failed} провалено`)
console.log('='.repeat(40))
process.exit(failed > 0 ? 1 : 0)
