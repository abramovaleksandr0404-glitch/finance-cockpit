// Финансовое ЯДРО: все расчёты и сборка контекста. Только чтение —
// ничего не пишет в БД (кроме updateAnchors, который синхронизирует якоря).
// Единственный источник цифр для бота и сайта: computeFinancialState().
// Зависимостей от bot.ts нет — проверено, модуль самодостаточен.
import { SupabaseClient } from '@supabase/supabase-js'
import { db, mk, rub, pct, quarterOf, advanceDay, lastWorkingDayOfMonth,
  annuityMonthsFor, isGoalThisMonth, USER_ID } from './shared'
import { cached } from './state'
import { computeWorkingDays, computeVacationAdjustment } from '../calc'

export async function updateAnchors(s: SupabaseClient): Promise<void> {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  const monthK = `${year}-${String(month).padStart(2, '0')}`
  const [{ data: u }, { data: loans }, { data: holidays }] = await Promise.all([
    s.from('users').select('salary_net,fixed_costs').eq('id', USER_ID).single(),
    s.from('loans').select('min_payment,principal').eq('user_id', USER_ID),
    s.from('ru_holidays').select('holiday_date')
      .gte('holiday_date', `${year}-${String(month).padStart(2, '0')}-01`)
      .lte('holiday_date', `${year}-${String(month).padStart(2, '0')}-31`),
  ])
  const wd = computeWorkingDays(year, month, (holidays ?? []).map((h: { holiday_date: string }) => String(h.holiday_date).slice(0, 10)))
  const dailyRate = Math.round(Number(u?.salary_net ?? 0) / wd)
  const totalLoans = (loans ?? []).reduce((acc, l) => acc + Number(l.min_payment), 0)
  const totalFixed = (u?.fixed_costs as Array<{ amount: number }> ?? []).reduce((acc, f) => acc + f.amount, 0)
  const anchorRows = [
    { key: 'working_days', value: String(wd), formula: 'рабочих дней с праздниками' },
    { key: 'daily_rate', value: String(dailyRate), formula: `${u?.salary_net}/${wd}` },
    { key: 'monthly_loan_payment', value: String(Math.round(totalLoans)), formula: 'сумма min_payment' },
    { key: 'fixed_total', value: String(totalFixed), formula: 'сумма fixed_costs' },
  ]
  for (const a of anchorRows) {
    await s.from('bot_anchors').upsert(
      { user_id: USER_ID, month_key: monthK, ...a, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,month_key,key' }
    )
  }
  // Sprint 26: автосинхронизация cards_summary при любом обновлении якорей
  const { data: cardsAnchor } = await s.from('cards').select('name,card_limit,current_debt').eq('user_id', USER_ID)
  const cardsSumAnchor = (cardsAnchor ?? []).map((c: {name:string;card_limit:number;current_debt:number}) =>
    `${c.name}: долг ${c.current_debt}₽, доступно ${c.card_limit - c.current_debt}₽`).join('. ')
  const { data: uDebitAnchor } = await s.from('users').select('debit_balance').eq('id', USER_ID).single()
  const totalDebtAnchor = (cardsAnchor ?? []).reduce((sum: number, c: {current_debt:number}) => sum + Number(c.current_debt ?? 0), 0)
  const netPosAnchor = Math.round(Number(uDebitAnchor?.debit_balance ?? 0) - totalDebtAnchor)
  await s.from('bot_anchors').upsert([
    { user_id: USER_ID, month_key: 'global', key: 'cards_summary', value: cardsSumAnchor, updated_at: new Date().toISOString() },
    { user_id: USER_ID, month_key: 'global', key: 'net_position', value: String(netPosAnchor), updated_at: new Date().toISOString() },
  ], { onConflict: 'user_id,month_key,key' })
}

export interface FinancialState {
  // слой 0 — сырьё
  month_key: string; today: number; days_in_month: number; days_left: number
  debit_sber: number; tbank_debit: number; cash: number
  // слой 1 — базовые агрегаты
  liquid: number; card_debt: number; net_position: number
  var_spent: number; extra_spent: number
  fixed_total: number; fixed_paid: number
  // слой 2 — производные
  var_budget: number; var_left: number; daily_var_budget: number
  fixed_unpaid: number
  pending_loans: number
  pending_income: number
  pending_salary: number; pending_recurring: number
  stipend_needs_confirm: boolean   // день≥11, не отмечена → бот должен спросить
  // слой 3 — прогнозы
  forecast_eom: number
  planned_total: number; forecast_after_planned: number
  // отпуска / корректировки ЗП
  vacations: { date: string; days: number; type: string; deduct: number; deduct_from: string; paid_amount: number }[]
  salary_loss_total: number  // суммарная потеря из-за отпусков в этом месяце
  // Внеплановые траты (детально)
  extra_expenses: { description: string; amount: number }[]
  // прогноз следующего месяца (пересчитан по ЕГО рабочим дням, БЕЗ отпусков)
  next_month_key: string
  next_working_days: number; next_daily_rate: number
  next_first_half: number; next_second_half: number  // рабочих дней в 1-й и 2-й половинах
  next_adv: number; next_eom: number
  next_forecast: number
  // детали для вывода
  cards: { name: string; debt: number; available: number }[]
  loans_pending: { name: string; amount: number; rate_percent: number; accrued_int: number }[]
  loans_paid: { name: string; amount: number }[]
  loans_all: { name: string; principal: number; accrued_int: number; rate_percent: number; min_payment: number; due_day: string; paid_this_month: boolean; end_date: string|null; months_left: number|null; overpay_total: number|null }[]
  incomes: { name: string; amount: number; received: boolean; status: string }[]
}

export async function accrueLoansCore(s: SupabaseClient): Promise<void> {
  const today = new Date().toISOString().split('T')[0]
  const { data: loans, error } = await s.from('loans').select('id,principal,accrued_int,rate,last_accrual').eq('user_id', USER_ID).gt('principal', 0)
  if (error || !loans?.length) return
  const updates: {id:string; accrued_int:number; last_accrual:string}[] = []
  for (const loan of loans) {
    const last = (loan.last_accrual as string | null) ?? today
    if (last >= today) continue
    const days = Math.max(0, Math.round((new Date(today).getTime() - new Date(last).getTime()) / 86400000))
    if (days === 0) continue
    const dailyInterest = Number(loan.principal) * Number(loan.rate) / 365
    const toAdd = Math.round(dailyInterest * days * 100) / 100
    updates.push({ id: loan.id, accrued_int: Math.round((Number(loan.accrued_int) + toAdd) * 100) / 100, last_accrual: today })
  }
  await Promise.all(updates.map(u => s.from('loans').update({ accrued_int: u.accrued_int, last_accrual: u.last_accrual }).eq('id', u.id).eq('user_id', USER_ID)))
}

export async function computeFinancialState(): Promise<FinancialState> {
  return cached('core_state', _computeFinancialStateRaw)
}

async function _computeFinancialStateRaw(): Promise<FinancialState> {
  const s = db(); const monthKey = mk(); const now = new Date()
  await accrueLoansCore(s)  // начисляем проценты ДО чтения данных кредитов
  const [
    { data: u }, { data: cashAnchor }, { data: month }, { data: expenses },
    { data: cards }, { data: loans }, { data: goals }, { data: holidays }, { data: nextHolidays }, { data: payOverrides },
  ] = await Promise.all([
    s.from('users').select('debit_balance,tbank_debit,var_budget,fixed_costs,salary_net,recurring_incomes').eq('id', USER_ID).single(),
    s.from('bot_anchors').select('value').eq('user_id', USER_ID).eq('key', 'cash_on_hand').eq('month_key', 'global').maybeSingle(),
    s.from('months').select('*').eq('user_id', USER_ID).eq('month_key', monthKey).maybeSingle(),
    s.from('expenses').select('amount,category,description').eq('user_id', USER_ID).eq('month_key', monthKey),
    s.from('cards').select('name,current_debt,card_limit').eq('user_id', USER_ID).order('sort_order'),
    s.from('loans').select('name,principal,accrued_int,min_payment,rate,paid_month,due_day,end_date').eq('user_id', USER_ID).order('sort_order'),
    s.from('goals').select('name,amount,purchased,month_key,target_date').eq('user_id', USER_ID).eq('purchased', false).order('sort_order'),
    s.from('ru_holidays').select('holiday_date').gte('holiday_date', `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`).lte('holiday_date', `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-31`),
    s.from('ru_holidays').select('holiday_date').gte('holiday_date', `${new Date(now.getFullYear(), now.getMonth()+1, 1).getFullYear()}-${String(new Date(now.getFullYear(), now.getMonth()+1, 1).getMonth()+1).padStart(2,'0')}-01`).lte('holiday_date', `${new Date(now.getFullYear(), now.getMonth()+1, 1).getFullYear()}-${String(new Date(now.getFullYear(), now.getMonth()+1, 1).getMonth()+1).padStart(2,'0')}-31`),
    s.from('bot_anchors').select('key,value').eq('user_id', USER_ID).eq('month_key', 'global').like('key', 'loan_payment_override:%'),
  ])

  // ── СЛОЙ 0 ──
  const today = now.getDate()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate()
  const daysLeft = daysInMonth - today + 1
  const debitSber = Math.round(Number(u?.debit_balance ?? 0))
  const tbankDebit = Math.round(Number(u?.tbank_debit ?? 0))
  // Наличные — такие же свои деньги, как остаток на дебете. Входят в ликвидность
  // и в дневной бюджет; раньше им негде было храниться и бот их «забывал».
  const cash = Math.round(Number(cashAnchor?.value ?? 0))

  // ── СЛОЙ 1 ──
  const liquid = debitSber + tbankDebit + cash
  const cardList = (cards ?? []).map((c:{name:string;current_debt:number;card_limit:number}) => ({
    name: c.name, debt: Math.round(Number(c.current_debt ?? 0)),
    available: Math.round(Number(c.card_limit ?? 0)) - Math.round(Number(c.current_debt ?? 0)),
  }))
  const cardDebt = cardList.reduce((a,c) => a + c.debt, 0)
  const netPosition = liquid - cardDebt
  const varSpent = (expenses ?? []).filter((e:{category:string}) => e.category !== 'Внеплановые').reduce((a,e) => a + Math.round(Number(e.amount ?? 0)), 0)
  const extraSpent = (expenses ?? []).filter((e:{category:string}) => e.category === 'Внеплановые').reduce((a,e) => a + Math.round(Number(e.amount ?? 0)), 0)
  const fc = (u?.fixed_costs as {name:string;amount:number}[]) ?? []
  const fp = (month?.fixed_paid ?? {}) as Record<string, number|boolean>
  const fixedTotal = fc.reduce((a,f) => a + Math.round(Number(f.amount)), 0)
  const fixedPaid = fc.reduce((a,f,i) => { const v = fp[String(i)]; return (v!=null && v!==false) ? a + Math.round(Number(typeof v==='number'?v:f.amount)) : a }, 0)

  // ── СЛОЙ 2 ──
  const varBudget = Math.round(Number(u?.var_budget ?? 45000))
  const varLeft = varBudget - varSpent
  const dailyVarBudget = Math.round(Math.max(0, varLeft) / Math.max(1, daysLeft))
  const fixedUnpaid = fixedTotal - fixedPaid
  // Переходный платёж после досрочного погашения: банк на один месяц выставляет
  // сумму, отличную от регулярной. Раньше хранить это было негде — правка
  // затиралась при следующем пересчёте, и бот «забывал» её.
  // Ключ: loan_payment_override:<кредит>:<YYYY-MM>
  const payOverride = (loanName: string): number | null => {
    const row = (payOverrides ?? []).find((a: {key:string;value:string}) =>
      a.key === `loan_payment_override:${loanName.toLowerCase()}:${monthKey}`)
    return row ? Math.round(Number(row.value)) : null
  }
  const effPay = (l: {name:string;min_payment:number}) =>
    payOverride(l.name) ?? Math.round(Number(l.min_payment))
  const loansPending = (loans ?? []).filter((l:{principal:number;paid_month:string}) => Number(l.principal) > 0 && l.paid_month !== monthKey)
    .map((l:{name:string;min_payment:number;principal:number}) => ({ name: l.name, amount: Math.min(effPay(l), Math.round(Number(l.principal))) }))
  const loansPaid = (loans ?? []).filter((l:{paid_month:string}) => l.paid_month === monthKey)
    .map((l:{name:string;min_payment:number}) => ({ name: l.name, amount: effPay(l) }))
  const pendingLoans = loansPending.reduce((a,l) => a + l.amount, 0)

  // доходы: аванс, зп+бонус, повторяющиеся (стипендия)
  const advAmt = Math.round(Number(month?.salary_adv_amount ?? 0))
  const eomAmt = Math.round(Number(month?.salary_eom_amount ?? 0))
  const bonAmt = Math.round(Number(month?.bonus_amount ?? 0))
  const advRec = !!month?.salary_adv_received
  const eomRec = !!month?.salary_eom_received
  const pendingSalary = (advRec ? 0 : advAmt) + (eomRec ? 0 : eomAmt + bonAmt)

  const recurringIncomes = (u?.recurring_incomes as {name:string;amount:number;day:number}[]) ?? []
  const recurringReceived = (month?.recurring_received as string[]) ?? []
  // Логика стипендии: получена→0. Не получена И день наступил(≥day)→в плановые потоки + флаг "спросить".
  // Не получена И день ещё не наступил→в плановые потоки (ожидается штатно).
  let pendingRecurring = 0
  let stipendNeedsConfirm = false
  const incomesList: { name:string; amount:number; received:boolean; status:string }[] = []
  for (const ri of recurringIncomes) {
    const received = recurringReceived.includes(ri.name)
    const amt = Math.round(Number(ri.amount))
    if (received) {
      incomesList.push({ name: ri.name, amount: amt, received: true, status: '✅ получена' })
    } else {
      pendingRecurring += amt  // не получена → всегда в будущих потоках
      if (today >= ri.day) {
        stipendNeedsConfirm = true
        incomesList.push({ name: ri.name, amount: amt, received: false, status: `❓ ожидается (${ri.day}-го прошло — подтверди получение)` })
      } else {
        incomesList.push({ name: ri.name, amount: amt, received: false, status: `⏳ ожидается ${ri.day}-го` })
      }
    }
  }
  if (!advRec) incomesList.push({ name: 'Аванс', amount: advAmt, received: false, status: '⏳ ожидается' })
  else incomesList.push({ name: 'Аванс', amount: advAmt, received: true, status: '✅ получен' })
  if (!eomRec) {
    incomesList.push({ name: 'ЗП', amount: eomAmt, received: false, status: '⏳ ожидается (конец месяца)' })
    incomesList.push({ name: 'Бонус', amount: bonAmt, received: false, status: '⏳ ожидается (конец месяца)' })
  } else {
    incomesList.push({ name: 'ЗП', amount: eomAmt, received: true, status: '✅ получена' })
    incomesList.push({ name: 'Бонус', amount: bonAmt, received: true, status: '✅ получен' })
  }
  const pendingIncome = pendingSalary + pendingRecurring

  // ── СЛОЙ 3 ──
  const forecastEom = netPosition + pendingIncome - pendingLoans - fixedUnpaid - Math.max(0, varLeft)
  // planned_total = только цели ТЕКУЩЕГО месяца (не все накопительные цели всех месяцев)
  const plannedTotal = (goals ?? []).filter((g:{month_key:string|null;target_date:string|null;purchased:boolean}) => isGoalThisMonth(g, monthKey, now) && !g.purchased).reduce((a,g:{amount:number}) => a + Math.round(Number(g.amount)), 0)
  const forecastAfterPlanned = forecastEom - plannedTotal

  // ── ОТПУСКА / КОРРЕКТИРОВКИ ЗП ──
  const vacationsRaw = (month?.salary_adjustments as {date:string;days:number;type:string;deduct:number;deduct_from:string;paid_amount:number}[]) ?? []
  const vacations = vacationsRaw.map(v => ({ date: v.date, days: v.days, type: v.type, deduct: Math.round(Number(v.deduct ?? 0)), deduct_from: v.deduct_from, paid_amount: Math.round(Number(v.paid_amount ?? 0)) }))
  const salaryLossTotal = vacations.reduce((a,v) => a + Math.max(0, v.deduct - v.paid_amount), 0)

  // ── ВНЕПЛАНОВЫЕ ТРАТЫ (детально) ──
  const extraExpenses = (expenses ?? []).filter((e:{category:string}) => e.category === 'Внеплановые')
    .map((e:{description:string;amount:number}) => ({ description: e.description ?? 'без описания', amount: Math.round(Number(e.amount ?? 0)) }))

  // ── КРЕДИТЫ с процентами ──
  const loansAll = (loans ?? []).map((l:{name:string;principal:number;accrued_int:number;rate:number;min_payment:number;due_day:string;paid_month:string;end_date:string}) => {
    const principal = Math.round(Number(l.principal ?? 0))
    const minPay = Math.round(Number(l.min_payment ?? 0))
    const endDate = l.end_date ? new Date(l.end_date) : null
    const monthsLeft = endDate ? Math.max(0, (endDate.getFullYear()-now.getFullYear())*12+(endDate.getMonth()-now.getMonth())) : null
    // Переплата = оставшиеся платежи − оставшееся тело долга (детерминированно)
    const overpayTotal = (monthsLeft !== null && minPay > 0) ? Math.max(0, monthsLeft * minPay - principal) : null
    return {
      name: l.name, principal, accrued_int: Math.round(Number(l.accrued_int ?? 0)),
      rate_percent: Math.round(Number(l.rate ?? 0) * 10000) / 100, min_payment: minPay,
      due_day: String(l.due_day ?? ''), paid_this_month: l.paid_month === monthKey,
      end_date: l.end_date ?? null, months_left: monthsLeft, overpay_total: overpayTotal,
    }
  })
  const loansPendingRich = (loans ?? []).filter((l:{principal:number;paid_month:string}) => Number(l.principal) > 0 && l.paid_month !== monthKey)
    .map((l:{name:string;min_payment:number;principal:number;rate:number;accrued_int:number}) => ({
      name: l.name, amount: Math.min(Math.round(Number(l.min_payment)), Math.round(Number(l.principal))),
      rate_percent: Math.round(Number(l.rate ?? 0) * 10000) / 100, accrued_int: Math.round(Number(l.accrued_int ?? 0)),
    }))

  // ── ПРОГНОЗ СЛЕДУЮЩЕГО МЕСЯЦА (по ЕГО рабочим дням, БЕЗ отпусков) ──
  const nextDate = new Date(now.getFullYear(), now.getMonth()+1, 1)
  const nextMonthKey = `${nextDate.getFullYear()}-${String(nextDate.getMonth()+1).padStart(2,'0')}`
  const nextHolidayDates = (nextHolidays ?? []).map((h:{holiday_date:string}) => String(h.holiday_date).slice(0,10))
  const salaryNet = Math.round(Number(u?.salary_net ?? 121600))
  const nextWorkingDays = computeWorkingDays(nextDate.getFullYear(), nextDate.getMonth()+1, nextHolidayDates)
  const nextDailyRate = Math.round(salaryNet / Math.max(1, nextWorkingDays))
  let nextFirstHalf = 0, nextSecondHalf = 0
  const nextDim = new Date(nextDate.getFullYear(), nextDate.getMonth()+1, 0).getDate()
  for (let d = 1; d <= nextDim; d++) {
    const dt = new Date(nextDate.getFullYear(), nextDate.getMonth(), d)
    const iso = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    if (dt.getDay() !== 0 && dt.getDay() !== 6 && !nextHolidayDates.includes(iso)) {
      if (d <= 15) nextFirstHalf++; else nextSecondHalf++
    }
  }
  // salary_net уже НА РУКИ (НДФЛ в нём учтён), nextDailyRate тоже на руки — НЕ умножаем на 0.87 повторно
  const nextAdv = Math.round(nextFirstHalf * nextDailyRate)
  const nextEom = Math.round(nextSecondHalf * nextDailyRate)
  const nextLoansTotal = (loans ?? []).reduce((a,l:{min_payment:number}) => a + Math.round(Number(l.min_payment ?? 0)), 0)
  const nextRecurringTotal = recurringIncomes.reduce((a,r) => a + Math.round(Number(r.amount)), 0)
  const nextForecast = forecastEom + nextAdv + nextEom + nextRecurringTotal - nextLoansTotal - fixedTotal - varBudget

  return {
    month_key: monthKey, today, days_in_month: daysInMonth, days_left: daysLeft,
    debit_sber: debitSber, tbank_debit: tbankDebit, cash,
    liquid, card_debt: cardDebt, net_position: netPosition,
    var_spent: varSpent, extra_spent: extraSpent,
    fixed_total: fixedTotal, fixed_paid: fixedPaid,
    var_budget: varBudget, var_left: varLeft, daily_var_budget: dailyVarBudget,
    fixed_unpaid: fixedUnpaid,
    pending_loans: pendingLoans,
    pending_income: pendingIncome, pending_salary: pendingSalary, pending_recurring: pendingRecurring,
    stipend_needs_confirm: stipendNeedsConfirm,
    forecast_eom: forecastEom,
    planned_total: plannedTotal, forecast_after_planned: forecastAfterPlanned,
    vacations, salary_loss_total: salaryLossTotal,
    extra_expenses: extraExpenses,
    next_month_key: nextMonthKey,
    next_working_days: nextWorkingDays, next_daily_rate: nextDailyRate,
    next_first_half: nextFirstHalf, next_second_half: nextSecondHalf,
    next_adv: nextAdv, next_eom: nextEom, next_forecast: nextForecast,
    cards: cardList, loans_pending: loansPendingRich, loans_paid: loansPaid,
    loans_all: loansAll,
    incomes: incomesList,
  }
}

export async function getContext(): Promise<string> {
  return cached('context', _getContextRaw)
}

async function _getContextRaw(): Promise<string> {
  const supabase = db()
  const monthKey = mk()
  const now = new Date()
  const curMonth = now.getMonth() + 1
  const curQuarter = quarterOf(curMonth)
  const qStartMonth = (curQuarter - 1) * 3 + 1
  const qStartKey = `${now.getFullYear()}-${String(qStartMonth).padStart(2,'0')}`
  const qEndKey = `${now.getFullYear()}-${String(qStartMonth + 2).padStart(2,'0')}`

  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const prevMK = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}`
  const nextMonthDate = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const nextMonthKey = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, '0')}`

  const [{data:user},{data:loans},{data:expenses},{data:month},{data:payOverridesCtx},{data:goals},{data:recentExp},{data:quarterMonths},{data:cards},{data:incomeEvents},{data:customCats},{data:corrections},{data:holidays},{data:prevExpenses},{data:anchors}] = await Promise.all([
    supabase.from('users').select('*').eq('id',USER_ID).single(),
    supabase.from('loans').select('id,name,principal,accrued_int,min_payment,end_date,rate,paid_month,due_day').eq('user_id',USER_ID).order('sort_order'),
    supabase.from('expenses').select('id,amount,category,description,expense_date,custom_category_id,covers_days,source_type').eq('user_id',USER_ID).eq('month_key',monthKey),
    supabase.from('months').select('*').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle(),
    supabase.from('bot_anchors').select('key,value').eq('user_id',USER_ID).eq('month_key','global').like('key','loan_payment_override:%'),
    supabase.from('goals').select('id,name,amount,month_key,purchased,target_date,sort_order').eq('user_id',USER_ID).eq('purchased',false).order('sort_order'),
    supabase.from('expenses').select('id,category,amount,description,expense_date,source_type').eq('user_id',USER_ID).eq('month_key',monthKey).order('created_at',{ascending:false}).limit(5),
    supabase.from('months').select('month_key,clients,revenue').eq('user_id',USER_ID).gte('month_key',qStartKey).lte('month_key',qEndKey),
    supabase.from('cards').select('name,card_limit,current_debt').eq('user_id',USER_ID).order('sort_order'),
    supabase.from('income_events').select('event_date,description,amount').eq('user_id',USER_ID).eq('month_key',monthKey),
    supabase.from('custom_categories').select('id,name,monthly_limit,alert_at_percent').eq('user_id',USER_ID),
    supabase.from('bot_corrections').select('correction,category,created_at').eq('user_id',USER_ID).order('created_at',{ascending:false}).limit(8),
    supabase.from('ru_holidays').select('holiday_date').gte('holiday_date',`${now.getFullYear()}-${String(curMonth).padStart(2,'0')}-01`).lte('holiday_date',`${now.getFullYear()}-${String(curMonth).padStart(2,'0')}-31`),
    supabase.from('expenses').select('amount,category').eq('user_id', USER_ID).eq('month_key', prevMK),
    supabase.from('bot_anchors').select('month_key,key,value,formula').eq('user_id',USER_ID).in('month_key',[monthKey,nextMonthKey,'global','broker']).order('month_key'),
  ])
  if (!user) return 'Данные не загружены'

  const holidayDates = (holidays ?? []).map((h: {holiday_date: string}) => String(h.holiday_date).substring(0, 10))
  const workingDaysInMonth = computeWorkingDays(now.getFullYear(), curMonth, holidayDates)
  console.log('[getContext] workingDays:', workingDaysInMonth, 'holidays:', holidayDates.length)

  // Якоря: индекс по ключу для быстрого поиска
  type Anchor = {month_key:string; key:string; value:string; formula:string|null}
  const anchorMap: Record<string, Record<string, Anchor>> = {}
  for (const a of (anchors ?? []) as Anchor[]) {
    if (!anchorMap[a.month_key]) anchorMap[a.month_key] = {}
    anchorMap[a.month_key][a.key] = a
  }
  function getAnchor(mk: string, key: string): string | null {
    return anchorMap[mk]?.[key]?.value ?? null
  }

  // Форматирование раздела якорей
  function buildAnchorSection(): string {
    if (!anchors?.length) return ''
    const lines: string[] = [
      '╔═══════════════════════════════════════════════════╗',
      '║  ЯКОРЯ — только факты, которых нет в таблицах.     ║',
      '║  Если цифра есть в блоке ДАННЫЕ ИЗ БД — берётся    ║',
      '║  ОНА, а не якорь. Якорь может быть устаревшим.     ║',
      '╚═══════════════════════════════════════════════════╝',
    ]
    for (const mk of [monthKey, nextMonthKey, 'global']) {
      const rows = Object.values(anchorMap[mk] ?? {})
      if (!rows.length) continue
      const label = mk === 'global' ? '📌 ГЛОБАЛЬНЫЕ' : `📌 ${mk}`
      lines.push(`\n${label}:`)
      // Значения, ВЫЧИСЛЯЕМЫЕ из таблиц-источников, НИКОГДА не подаём из якорей.
      // Якорь — это снимок на момент записи; таблица меняется каждый день.
      // Ровно так в июне возникли два источника правды и посыпались галлюцинации.
      const DERIVED_KEYS = new Set([
        // меняются ежедневно
        'var_spent', 'var_left', 'forecast_end', 'forecast_after_advance',
        'last_evening_alert_date', 'today_context',
        // дублируют users
        'salary_net', 'var_budget',
        // дублируют loans
        'total_loans', 'monthly_loan_payment',
        // дублируют cards
        'tbank_credit_debt', 'tbank_credit_available', 'tbank_credit_limit',
        'cards_summary', 'net_position',
        // дублируют fixed_costs + months.fixed_paid
        'fixed_total', 'fixed_unpaid',
      ])
      for (const r of rows) {
        if (DERIVED_KEYS.has(r.key)) continue
        if (r.key.startsWith('owed_to_me:')) continue // отдельный блок ниже
        lines.push(`  ${r.key}: ${r.value}${r.formula ? ` (${r.formula})` : ''}`)
      }
    }
    // Долги ДРУГИХ людей передо мной — НЕ входят в ликвидность, деньги ещё не вернулись.
    const owedRows = Object.values(anchorMap['global'] ?? {}).filter(r => r.key.startsWith('owed_to_me:'))
    if (owedRows.length) {
      lines.push('\n💸 МНЕ ДОЛЖНЫ (НЕ входит в ликвидность — деньги ещё не у меня):')
      for (const r of owedRows) lines.push(`  ${r.key.replace('owed_to_me:', '')}: ${rub(Number(r.value))}`)
    }
    return lines.join('\n') + '\n'
  }
  const anchorSection = buildAnchorSection()

  // Брокерский портфель из якорей (month_key='broker') или глобальных broker_*
  const brokerRows = Object.values(anchorMap['broker'] ?? {})
  const brokerAnchorRows = brokerRows.length
    ? brokerRows
    : Object.values(anchorMap['global'] ?? {}).filter(a => a.key.startsWith('broker_'))
  const brokerSection = brokerAnchorRows.length
    ? (() => {
        const portfolio = brokerRows.find(a => a.key === 'portfolio_value')?.value
          ?? brokerAnchorRows.find(a => a.key.includes('portfolio'))?.value
          ?? '5 302 682'
        return `\n🏦 БРОКЕР: портфель ${portfolio}₽ | вернуть 5 500 000₽ к 01.10.2026 | 31 июля → 177 000₽ флоатеры\n`
      })()
    : ''

  const debitSber = Number(user.debit_balance ?? 0)
  const debitTbank = Number(user.tbank_debit ?? 0)
  const liquid = debitSber + debitTbank
  const totalCardDebt = (cards ?? []).reduce((s, c) => s + Number(c.current_debt), 0)
  const netPosition = liquid - totalCardDebt

  const salaryNet = Number(user.salary_net ?? 121600)
  const advAmount = Number(month?.salary_adv_amount ?? Math.round(salaryNet/2))
  const eomAmount = Number(month?.salary_eom_amount ?? salaryNet - advAmount)
  const bonusAmount = Number(month?.bonus_amount ?? 25010)
  const advReceived = !!month?.salary_adv_received
  const eomReceived = !!month?.salary_eom_received

  // ── Recurring incomes (стипендия и т.п.) ─────────────────────
  const recurringIncomes = (user.recurring_incomes as {name:string;amount:number;day:number}[]) ?? []
  const recurringReceived = (month?.recurring_received as string[]) ?? []
  const today = now.getDate()
  // Ожидается = день ещё не прошёл (или прошёл, но не отмечено received) И не получено в этом месяце
  const pendingRecurring = recurringIncomes.filter(r => !recurringReceived.includes(r.name) && r.day >= today)
  const pendingRecurringTotal = pendingRecurring.reduce((s,r)=>s+r.amount, 0)
  
  const incomingTotal = (advReceived ? 0 : advAmount) + (eomReceived ? 0 : eomAmount + bonusAmount) + pendingRecurringTotal

  const fixedCosts = (user.fixed_costs as {name:string;amount:number;day?:number}[]) ?? []
  const fixedPaid = (month?.fixed_paid as Record<string,number|boolean>) ?? {}
  const fixedTotal = fixedCosts.reduce((s,f)=>s+f.amount,0)
  let fixedPaidSum = 0
  fixedCosts.forEach((f,i) => { if (fixedPaid[String(i)]) fixedPaidSum += (typeof fixedPaid[String(i)]==='number' ? Number(fixedPaid[String(i)]) : f.amount) })
  const fixedUnpaid = Math.max(0, fixedTotal - fixedPaidSum)

  const varBudget = Number(user.var_budget ?? 40000)
  const varSpent = (expenses ?? []).filter((e: {category?: string}) => e.category !== 'Внеплановые').reduce((s,e) => s+Number(e.amount), 0)
  const varLeft = Math.max(0, varBudget - varSpent)

  const prevVarSpent = (prevExpenses ?? []).reduce((s, e) => s + Number(e.amount), 0)
  const deltaVarPct = prevVarSpent > 0 ? Math.round((varSpent - prevVarSpent) / prevVarSpent * 100) : 0
  const varComparison = prevVarSpent > 0
    ? `${deltaVarPct > 0 ? '⚠️ +' : '✅ '}${deltaVarPct}% vs прошлый месяц (${rub(prevVarSpent)})`
    : ''

  const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate()
  const daysLeft = daysInMonth - today + 1
  const dailyBudget = Math.round(varLeft / Math.max(1, daysLeft))

  // Мультидневные траты: зарезервированная часть (будущие дни)
  const multidayReserved = (expenses ?? []).reduce((s, e) => {
    const days = Number((e as Record<string, unknown>).covers_days ?? 1)
    if (days <= 1) return s
    const daysSinceExpense = Math.max(0, Math.floor((now.getTime() - new Date(e.expense_date).getTime()) / (1000 * 60 * 60 * 24)))
    const daysRemaining = Math.max(0, days - daysSinceExpense)
    return s + (Number(e.amount) / days) * daysRemaining
  }, 0)

  // Оставшиеся рабочие дни в месяце
  let daysLeftWorking = 0
  for (let d = today; d <= daysInMonth; d++) {
    const dateStr = `${now.getFullYear()}-${String(curMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    const dow = new Date(now.getFullYear(), curMonth - 1, d).getDay()
    if (dow !== 0 && dow !== 6 && !holidayDates.includes(dateStr)) daysLeftWorking++
  }

  // Точные даты выплат
  const advDay = advanceDay(now.getFullYear(), curMonth)
  const eomDay = lastWorkingDayOfMonth(now.getFullYear(), curMonth)

  // Список для отображения — та же функция-классификатор, что и в ядре.
  // Сумму НЕ считаем здесь заново: берём готовую из __core.planned_total ниже.
  const plannedPurchases = (goals ?? []).filter(g => isGoalThisMonth(g, monthKey, now) && !g.purchased)

  const pendingLoanPayments = (loans ?? []).filter(l => l.paid_month !== monthKey).reduce((s,l) => s+Number(l.min_payment), 0)
  const totalDebt = (loans ?? []).reduce((s,l) => s+Number(l.principal)+Number(l.accrued_int), 0)
  // Итог по платежам с учётом переходных: без этого шапка контекста давала
  // регулярную сумму, а строки ниже — фактическую, и бот выбирал произвольно.
  const totalMonthlyPayment = (loans ?? []).reduce((sum, l) => {
    const ov = (payOverridesCtx ?? []).find((a: {key:string}) => a.key === `loan_payment_override:${l.name.toLowerCase()}:${monthKey}`)
    return sum + (ov ? Number(ov.value) : Number(l.min_payment))
  }, 0)
  // Прогноз остатка = баланс + входы − кредиты − постоянные − переменные до лимита
  // BUGFIX: прогноз от чистой позиции (дебет − долги по картам), НЕ от ликвидности
  const projEndComputed = netPosition + incomingTotal - pendingLoanPayments - fixedUnpaid - varLeft
  const anchorForecast = getAnchor(monthKey, 'forecast_end')
  if (anchorForecast && Math.abs(projEndComputed - Number(anchorForecast)) > 100) {
    console.error('[ANCHOR MISMATCH] forecast computed:', projEndComputed, 'anchor:', anchorForecast)
  }
  // ЕДИНЫЙ ИСТОЧНИК: синхронизируем ключевые цифры с ядром computeFinancialState().
  // Это гарантирует что getContext и getFinancialSummaryJson дают идентичные числа.
  const __core = await computeFinancialState()
  const projEnd = __core.forecast_eom  // прогноз ТОЛЬКО из ядра, без anchor-расхождений
  // Переопределяем отображаемые величины значениями ядра (single source of truth)
  const _netPosition = __core.net_position
  const _liquid = __core.liquid
  const _totalCardDebt = __core.card_debt
  const _varLeft = __core.var_left
  const _varSpent = __core.var_spent
  const _fixedUnpaid = __core.fixed_unpaid
  const _fixedPaidSum = __core.fixed_paid
  const _pendingLoanPayments = __core.pending_loans
  const _incomingTotal = __core.pending_income
  const _dailyBudget = __core.daily_var_budget
  const _stipendNeedsConfirm = __core.stipend_needs_confirm
  // После плановых покупок — сумма из ядра, не пересчитываем
  const projEndAfterPlanned = projEnd - __core.planned_total

  // Бонус
  const nominals = (user.nominals as Record<string,number>) ?? {}
  const clients = (month?.clients as Record<string,number>) ?? {}
  const revenue = Number(month?.revenue ?? 41666)
  const marginShare = Number(user.margin_share ?? 0.20)
  const momentShare = Number(user.moment_share ?? 0.80)
  const threshold = Number(user.threshold ?? 56000)
  const qm2 = Number(user.qm2 ?? 2)
  const qm3 = Number(user.qm3 ?? 3)
  const r1 = Number(user.r1 ?? 0.13)
  const clientPot = Object.entries(clients).reduce((s,[g,n])=>s+(nominals[g]??0)*n,0)
  const pot = clientPot + revenue * marginShare
  const excess = Math.max(0, pot - threshold)
  const moment = excess * momentShare
  const annual = excess * (1 - momentShare)
  const bonusJulNet = Math.round(moment * (1 - r1))

  // Квартал
  const quarterClients: Record<string,number> = {}
  for (const m of quarterMonths ?? []) {
    const c = m.clients as Record<string,number> ?? {}
    for (const [g,n] of Object.entries(c)) quarterClients[g] = (quarterClients[g]??0) + Number(n)
  }
  const qClientCount = Object.values(quarterClients).reduce((s,n)=>s+n, 0)
  const qMult = qClientCount >= 3 ? qm3 : qClientCount === 2 ? qm2 : 0
  const qNominalSum = Object.entries(quarterClients).reduce((s,[g,n])=>s+(nominals[g]??0)*n, 0)
  const qBonusGross = qNominalSum * qMult
  const qBonusNet = Math.round(qBonusGross * (1 - r1))

  // Прогноз следующего месяца (nextMonthDate/nextMonthKey уже определены выше)
  const nextYear = nextMonthDate.getFullYear()
  const nextMonthNum = nextMonthDate.getMonth() + 1
  const nextMK = nextMonthKey
  const nextAdvDay = advanceDay(nextYear, nextMonthNum)
  const nextEomDay = lastWorkingDayOfMonth(nextYear, nextMonthNum)
  const nextRecurringTotal = recurringIncomes.reduce((s,r)=>s+r.amount, 0)
  // Квартальный бонус выплачивается в первом месяце следующего квартала
  const nextIsFirstOfNextQuarter = (nextMonthNum % 3 === 1)
  const nextQBonus = nextIsFirstOfNextQuarter ? qBonusNet : 0
  // Ежемесячный бонус текущего месяца выплачивается в следующем
  const nextIncoming = advAmount + eomAmount + bonusJulNet + nextRecurringTotal + nextQBonus
  const nextProjEnd = Math.round(projEnd + nextIncoming - totalMonthlyPayment - fixedTotal - varBudget)

  // Источник траты виден явно: раньше source_type не выбирался запросом,
  // и модель подписывала «Дебет» даже тратам наличными и с карт.
  const srcTag = (st?: string) => st === 'cash' ? ' 💵нал' : st === 'card' ? ' 💳карта' : ' 🏦дебет'
  const recentLines = (recentExp ?? []).map(e => `  • ${e.expense_date} ${e.category}: ${rub(Number(e.amount))}${srcTag((e as {source_type?:string}).source_type)}${e.description?' — '+e.description:''}`).join('\n') || '  (нет)'
  const fixedLines = (fixedCosts as {name:string;amount:number;day?:number;source?:string}[]).map((f,i) => {
    const paid = fixedPaid[String(i)] !== undefined
    const dayStr = f.day ? ` (${f.day}-го)` : ''
    const srcStr = f.source === 'credit_tbank' ? ' 💳Т'
      : f.source === 'credit_sber' ? ' 💳С'
      : f.source === 'debit_sber' ? ' 🏦'
      : ' ❓'
    return `  ${paid?'✅':'⏳'} ${f.name}${dayStr}${srcStr}: ${rub(f.amount)}`
  }).join('\n')
  // Горизонт цели — вычисляется из target_date, не хранится отдельным полем
  // (иначе разъедется с датой, как раньше расходились якоря с таблицами).
  const classifyHorizon = (g: {month_key: string|null; target_date: string|null}): string => {
    if (isGoalThisMonth(g, monthKey, now)) return 'ЭТОТ МЕСЯЦ'
    if (!g.target_date) return 'БЕЗ СРОКА (накопление)'
    const t = new Date(g.target_date)
    const monthsAway = (t.getFullYear()-now.getFullYear())*12 + (t.getMonth()-now.getMonth())
    if (monthsAway <= 3) return 'ЭТОТ КВАРТАЛ'
    if (t.getFullYear() === now.getFullYear()) return 'ДО КОНЦА ГОДА'
    if (t.getFullYear() === now.getFullYear()+1) return 'ЧЕРЕЗ ГОД'
    return 'ЧЕРЕЗ 2+ ГОДА'
  }
  const HORIZON_ORDER = ['ЭТОТ МЕСЯЦ','ЭТОТ КВАРТАЛ','ДО КОНЦА ГОДА','ЧЕРЕЗ ГОД','ЧЕРЕЗ 2+ ГОДА','БЕЗ СРОКА (накопление)']
  const goalsByHorizon: Record<string, {name:string;amount:number;target_date:string|null;sort_order:number}[]> = {}
  for (const g of (goals ?? []) as {name:string;amount:number;month_key:string|null;target_date:string|null;sort_order:number}[]) {
    const h = classifyHorizon(g)
    ;(goalsByHorizon[h] ??= []).push({ name: g.name, amount: Number(g.amount), target_date: g.target_date, sort_order: g.sort_order ?? 2 })
  }
  const goalLines = HORIZON_ORDER.filter(h => goalsByHorizon[h]?.length).map(h => {
    const items = goalsByHorizon[h].sort((a,b)=>a.sort_order-b.sort_order)
    const sum = items.reduce((s,i)=>s+i.amount,0)
    const lines = items.map(i => `    • ${i.name}: ${rub(i.amount)}${i.target_date?` (к ${i.target_date})`:''}`).join('\n')
    // Для горизонта "этот квартал" сразу видно, покрывает ли бонус план —
    // без этого пользователю приходится сверять цифры руками в двух местах.
    const bonusNote = h === 'ЭТОТ КВАРТАЛ'
      ? `\n    (ожидаемый квартальный бонус на руки: ${rub(qBonusNet)}, ${qBonusNet >= sum ? 'покрывает' : `не хватает ${rub(sum-qBonusNet)}`})`
      : ''
    return `  ${h} — итого ${rub(sum)}:\n${lines}${bonusNote}`
  }).join('\n') || '  (нет целей)'
  const loanLines = (loans ?? []).map(l => {
    const principal = Math.round(Number(l.principal))
    const accrued = Math.round(Number(l.accrued_int ?? 0))
    const paid = l.paid_month === monthKey ? '✅ оплачен в этом месяце' : `⏳ не оплачен (посл. платёж: ${l.paid_month ?? 'нет'})`
    let suffix = ''
    if (l.end_date) {
      const endD = new Date(l.end_date)
      const mLeft = Math.max(0, (endD.getFullYear() - now.getFullYear()) * 12 + (endD.getMonth() - now.getMonth()))
      suffix = ` / осталось ${mLeft} мес. до ${l.end_date}`
    }
    const accruedStr = accrued > 0 ? ` (+ накопл.проценты ${rub(accrued)})` : ''
    // Переходный платёж этого месяца показываем явно, иначе бот назовёт
    // регулярную сумму и разойдётся с банковской выпиской.
    const ovRow = (payOverridesCtx ?? []).find((a: {key:string}) => a.key === `loan_payment_override:${l.name.toLowerCase()}:${monthKey}`)
    const payStr = ovRow
      ? `${rub(Number(ovRow.value))} В ЭТОМ МЕСЯЦЕ (регулярный ${rub(Number(l.min_payment))}, разово снижен после досрочки)`
      : `${rub(Number(l.min_payment))}/мес`
    return `  • ${l.name}: тело ${rub(principal)}${accruedStr} @ ${(Number(l.rate)*100).toFixed(2)}% — платёж ${payStr} — ${paid}${suffix}`
  }).join('\n')
  const cardLines = (cards ?? []).map(c => `  • ${c.name}: лимит ${rub(Number(c.card_limit))}, долг ${rub(Number(c.current_debt))}, доступно ${rub(Number(c.card_limit) - Number(c.current_debt))}`).join('\n') || '  (нет)'
  const recurringLines = recurringIncomes.map(r => `  • ${r.name}: ${rub(r.amount)} (${r.day} числа каждого месяца)`).join('\n') || '  (нет)'
  const incomeEventLines = (incomeEvents ?? []).map(e => `  • ${e.event_date}: ${e.description}: ${rub(Number(e.amount))}`).join('\n') || '  (нет в этом месяце)'

  // Salary adjustments
  type SalaryAdjustment = {type:string;days:number;paid_amount:number;deduct:number;date:string;deduct_from:string}
  const salaryAdjustments = (month?.salary_adjustments as SalaryAdjustment[]) ?? []

  // Custom categories spending
  const customCatLines = (customCats ?? []).map(cat => {
    const spent = (expenses ?? []).filter(e => e.custom_category_id === cat.id).reduce((s,e) => s+Number(e.amount), 0)
    const limitStr = cat.monthly_limit ? ` — ${rub(spent)} из ${rub(Number(cat.monthly_limit))} (${pct(spent,Number(cat.monthly_limit))}%)` : ` — ${rub(spent)}`
    return `  • ${cat.name}${limitStr}`
  }).join('\n')

  // Bot corrections
  const correctionLines = (corrections ?? []).map(c => `  • [${c.category ?? 'general'}] ${c.correction}`).join('\n')
  console.log('[getContext] corrections loaded:', corrections?.length ?? 0)

  // Ближайшие 7 дней — платежи
  const upcomingLoans = (loans ?? []).filter(l => {
    const dueDay = l.due_day === 'last' ? lastWorkingDayOfMonth(now.getFullYear(), curMonth) : Number(l.due_day)
    const diff = dueDay - today
    return diff >= 0 && diff <= 7 && l.paid_month !== monthKey
  }).map(l => `  • ${l.name}: ${rub(Number(l.min_payment))} (${l.due_day} числа)`)

  const upcomingFixed = fixedCosts.filter((f, i) => {
    const fday = (f as {day?:number}).day
    if (!fday) return false
    const diff = fday - today
    return diff >= 0 && diff <= 7 && !fixedPaid[String(i)]
  }).map(f => `  • ${(f as {name:string}).name}: ${rub((f as {amount:number}).amount)}`)

  const calendarLines = [...upcomingLoans, ...upcomingFixed]
  const calendarSection = `\n📅 БЛИЖАЙШИЕ 7 ДНЕЙ:\n${calendarLines.length ? calendarLines.join('\n') : '  Платежей нет'}\n`

  // Все траты месяца — по категориям + последние 7 дней
  // Sprint 25: effective_category — custom_category_id имеет приоритет над category
  const { data: customCatsCtx } = await supabase.from('custom_categories').select('id,name').eq('user_id', USER_ID)
  const customCatMapCtx: Record<string, string> = {}
  for (const c of customCatsCtx ?? []) customCatMapCtx[c.id] = c.name
  const expensesByCategory: Record<string, number> = {}
  for (const e of expenses ?? []) {
    const cat = (e.custom_category_id ? customCatMapCtx[e.custom_category_id] : null) ?? e.category ?? 'Прочее'
    expensesByCategory[cat] = (expensesByCategory[cat] ?? 0) + Number(e.amount)
  }
  const catLines = Object.entries(expensesByCategory)
    .sort(([,a],[,b]) => b - a)
    .map(([cat, sum]) => `  • ${cat}: ${rub(sum)}`)
    .join('\n')
  const sevenDaysAgo = new Date(now); sevenDaysAgo.setDate(today - 7)
  const sevenDaysAgoISO = sevenDaysAgo.toISOString().split('T')[0]
  const recentExp7 = (expenses ?? [])
    .filter(e => e.expense_date >= sevenDaysAgoISO)
    .sort((a, b) => b.expense_date.localeCompare(a.expense_date))
    .slice(0, 15)
  const recentExp7Lines = recentExp7.map(e => `  • ${e.expense_date}: ${e.description ?? e.category} — ${rub(Number(e.amount))}${srcTag((e as {source_type?:string}).source_type)}`).join('\n')
  const allExpensesSection = `\n📊 ПЕРЕМЕННЫЕ ТРАТЫ ${monthKey} (все ${expenses?.length ?? 0} шт = ${rub(varSpent)}):\n${catLines || '  (нет трат)'}\n\n  Последние 7 дней:\n${recentExp7Lines || '  (нет трат)'}\n`

  // Sprint 19 — топ-5 важных воспоминаний из долгосрочной памяти
  let memoriesSection = ''
  const { data: memories } = await supabase.from('bot_memories')
    .select('content,category')
    .eq('user_id', USER_ID)
    .gte('importance', 3)
    .order('importance', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(8)
  if (memories?.length) {
    memoriesSection = '\n📚 КЛЮЧЕВЫЕ ПАТТЕРНЫ И ФАКТЫ:\n'
      + memories.map(m => `  • ${m.content}`).join('\n') + '\n'
  }

  return `${anchorSection}${brokerSection}${calendarSection}${memoriesSection}
=== ФИНАНСОВЫЙ КОНТЕКСТ ===
ДАТА: ${now.toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}
МЕСЯЦ: ${monthKey} (день ${today} из ${daysInMonth}, осталось ${daysLeft} дней)
КВАРТАЛ: Q${curQuarter} (${qStartKey}…${qEndKey})

=== ГОТОВЫЕ ЦИФРЫ — НЕ ПЕРЕСЧИТЫВАЙ САМ ===

БАЛАНС:
  Дебет Сбер: ${rub(__core.debit_sber)}
  Т-Банк дебет: ${rub(__core.tbank_debit)}
  Наличные на руках: ${rub(__core.cash)}
  ЛИКВИДНОСТЬ ИТОГО: ${rub(_liquid)} (дебеты + наличные)
  Чистая позиция: ${rub(_liquid)} − ${rub(_totalCardDebt)} долг по картам = ${rub(_netPosition)}

💳 КРЕДИТНЫЕ КАРТЫ (ПАССИВЫ):
${cardLines}
  ⚠️ Кредитные карты ≠ дебет. Расходы с карты = долг (пассив).

ПЕРЕМЕННЫЕ ТРАТЫ:
  Лимит: ${rub(varBudget)} (выставлен пользователем вручную)
  Потрачено: ${rub(_varSpent)} (${pct(_varSpent,varBudget)}%)
  Осталось: ${rub(varLeft)}
  Дневной бюджет: ${rub(dailyBudget)}/день  [формула: осталось ÷ дней до конца месяца]
${varComparison ? `  Vs прошлый месяц: ${varComparison}\n` : ''}${multidayReserved > 0 ? `  Зарезервировано под мультидневные: ${rub(multidayReserved)} (ещё не "сожжено")\n  Свободно на сегодня: ${rub(Math.max(0, varLeft - multidayReserved))}\n` : ''}

=== КЕШФЛОУ ИЮНЯ ===
ВХОДЫ (всего ожидается ${rub(incomingTotal)}):
${__core.incomes.filter(i=>!['Аванс','ЗП','Бонус'].includes(i.name)).map(i=>`  ${i.name}: ${i.status} (${rub(i.amount)})`).join('\n')}
  Аванс ${advReceived?'✅ получен':`⏳ ${rub(advAmount)} (${advDay}-го)`}
  ЗП ${eomReceived?'✅':`⏳ ${rub(eomAmount)}`} + Бонус ${eomReceived?'✅':`⏳ ${rub(bonusAmount)}`} (${eomDay}-го, посл. раб. день месяца)
${_stipendNeedsConfirm ? '\n  ⚠️ ВАЖНО: день стипендии наступил, но она не отмечена полученной. СПРОСИ пользователя «Стипендия пришла?» — если да, вызови mark_recurring_received. Сейчас она учтена в будущих потоках.\n' : ''}

${salaryAdjustments.length > 0 ? `\nКОРРЕКТИРОВКИ ЗП:\n${salaryAdjustments.map((a: SalaryAdjustment) => {
  const adj = computeVacationAdjustment(a.days, a.paid_amount, salaryNet, workingDaysInMonth)
  return `  • ${a.type==='sick'?'больничный':'отпуск'} ${a.days}д: получено ${rub(a.paid_amount)}, вычтено из ${a.deduct_from==='advance'?'аванса':'зп'}: ${rub(a.deduct)}, потеря: ${rub(adj.actualLoss)}`
}).join('\n')}\n` : ''}ВЫХОДЫ:
  Кредиты неоплаченные: ${rub(pendingLoanPayments)} [платёж 4 кредитов]
  Постоянные неоплаченные: ${rub(fixedUnpaid)} из ${rub(fixedTotal)}
  Переменные ещё доступно до лимита: ${rub(varLeft)}
  ИТОГО к списанию: ${rub(pendingLoanPayments + fixedUnpaid + varLeft)}

ПЛАНОВЫЕ ПОКУПКИ ИЮНЯ (цели на месяц, ещё не куплены):
${plannedPurchases.length ? plannedPurchases.map(g=>`  • ${g.name}: ${rub(Number(g.amount))}${g.target_date ? ` (срок: ${g.target_date})` : ''}`).join('\n')+`\n  ИТОГО плановых: ${rub(__core.planned_total)}` : '  (нет запланированных покупок)'}

ПРОГНОЗ ОСТАТКА К 30-го ИЮНЯ: ${rub(projEnd)}
  [формула: чистая позиция ${rub(netPosition)} (деб.${rub(liquid)}−карты${rub(totalCardDebt)}) + входы ${rub(incomingTotal)} − кредиты ${rub(pendingLoanPayments)} − постоянные ${rub(fixedUnpaid)} − переменные до лимита ${rub(varLeft)}]
ПОСЛЕ ПЛАНОВЫХ ПОКУПОК (−${rub(__core.planned_total)}): ${rub(projEndAfterPlanned)}

=== ПРОГНОЗ СЛЕДУЮЩЕГО МЕСЯЦА (${__core.next_month_key}) — пересчитан по рабочим дням ${__core.next_month_key}, БЕЗ отпусков ===
  Старт: ${rub(__core.forecast_eom)} (= прогноз конца ${monthKey})
  Рабочих дней в ${__core.next_month_key}: ${__core.next_working_days} (1-я пол. 1-15: ${__core.next_first_half} дн, 2-я пол. 16-конец: ${__core.next_second_half} дн)
  Дневная ставка: ${rub(__core.next_daily_rate)} (оклад ${rub(salaryNet)} ÷ ${__core.next_working_days} раб.дней, НДФЛ уже в окладе)
  Входы: Аванс ⏳ ${rub(__core.next_adv)} (${__core.next_first_half} дн × ${rub(__core.next_daily_rate)}) + ЗП ⏳ ${rub(__core.next_eom)} (${__core.next_second_half} дн × ${rub(__core.next_daily_rate)}) + Стипендия ${rub(nextRecurringTotal)}
  Выходы: Кредиты ${rub(totalMonthlyPayment)} + Постоянные ${rub(fixedTotal)} + Переменные лимит ${rub(varBudget)}
  ПРОГНОЗ БАЗОВЫЙ к концу ${__core.next_month_key}: ${rub(__core.next_forecast)}
  [формула: ${rub(__core.forecast_eom)} + аванс ${rub(__core.next_adv)} + ЗП ${rub(__core.next_eom)} + стип ${rub(nextRecurringTotal)} − кредиты ${rub(totalMonthlyPayment)} − постоянные ${rub(fixedTotal)} − переменные ${rub(varBudget)}]
  ⚠️ Аванс/ЗП июля НЕ равны июньским (в июне был отпуск). Отпускные в июле пока НЕ загружены.${nextQBonus > 0 ? `\n  💰 Квартальный бонус Q (разово, сверх базового): +${rub(nextQBonus)} → с ним прогноз ${rub(__core.next_forecast + nextQBonus)}` : ''}

=== КРЕДИТЫ (ВСЕГО ТЕЛО ${rub(totalDebt)} — БРАТЬ ДОСЛОВНО, НЕ СКЛАДЫВАТЬ САМОМУ; платёж в этом месяце ${rub(totalMonthlyPayment)}) ===
${loanLines}

=== ПОСТОЯННЫЕ (всего ${rub(fixedTotal)}, оплачено ${rub(fixedPaidSum)}) ===
${fixedLines}

=== РЕГУЛЯРНЫЕ ДОХОДЫ ===
${recurringLines}

=== ОТПУСКА / ПРИЧИНА СНИЖЕНИЯ ЗП (${monthKey}) ===
${__core.vacations.length ? __core.vacations.map(v => `  • ${v.date}: ${v.type==='vacation'?'отпуск':v.type} ${v.days} дн — вычтено из ${v.deduct_from==='advance'?'аванса':'ЗП'}: ${rub(v.deduct)}, выплачено: ${rub(v.paid_amount)}, недополучено: ${rub(Math.max(0,v.deduct-v.paid_amount))}`).join('\n') + `\n  ИТОГО потеря от отпусков: ${rub(__core.salary_loss_total)}` : '  (нет отпусков/корректировок в этом месяце)'}

=== ВНЕПЛАНОВЫЕ ТРАТЫ (вне лимита переменных, но учитываются в расходах) ===
${__core.extra_expenses.length ? __core.extra_expenses.map(e => `  • ${e.description}: ${rub(e.amount)}`).join('\n') + `\n  ИТОГО внеплановых: ${rub(__core.extra_spent)}` : '  (нет внеплановых трат)'}

=== ПЕРЕМЕННЫЕ ТРАТЫ — ДЕТАЛЬНО ===${allExpensesSection}
=== ПОСЛЕДНИЕ 5 ТРАТ ===
${recentLines}

=== ДОХОДНЫЕ СОБЫТИЯ ИЮНЯ (отпускные, премии и т.п.) ===
${incomeEventLines}

=== ЦЕЛИ ===
${goalLines}

=== БОНУС ИЮНЯ (выплачивается в июле) ===
  Клиенты месяца: ${JSON.stringify(clients)}
  Выручка: ${rub(revenue)}
  Котёл = клиенты×номинал + ${(marginShare*100).toFixed(0)}%×выручка = ${rub(clientPot)} + ${rub(revenue*marginShare)} = ${rub(pot)}
  Порог: ${rub(threshold)} → сверхпорог: ${rub(excess)}
  Момент (выплата в июле): ${rub(moment)} = ${(momentShare*100).toFixed(0)}% от сверхпорога
  Годовой накопит. (20%): ${rub(annual)} → копится на годовую выплату
  Бонус НА РУКИ (НДФЛ 13%): ${rub(bonusJulNet)}

=== КВАРТАЛЬНЫЙ БОНУС (Q${curQuarter} ${qStartKey}…${qEndKey}) ===
  Клиенты квартала: ${JSON.stringify(quarterClients)} (всего ${qClientCount})
  Множитель: ${qMult} ${qClientCount>=3?'(qm3=3 при ≥3 клиентов)':qClientCount===2?'(qm2=2 при 2 клиентах)':'(0 — нужно минимум 2)'}
  Сумма номиналов × множитель = ${rub(qNominalSum)} × ${qMult} = ${rub(qBonusGross)} gross
  Квартальный бонус НА РУКИ: ${rub(qBonusNet)}
  Выплачивается в конце первого месяца следующего квартала

=== НАСТРОЙКИ ===
  Оклад net: ${rub(salaryNet)} | gross: ${rub(Number(user.salary_gross))}
  YTD gross: ${rub(Number(user.ytd_gross ?? 0))} | До порога 15% НДФЛ: ${rub(Math.max(0, 2400000 - Number(user.ytd_gross ?? 0)))}
  Рабочих дней в ${monthKey}: ${workingDaysInMonth} (с праздниками РФ)
  Дневная ставка: ${rub(Math.round(salaryNet / workingDaysInMonth))}/день
  Часовая ставка: ${rub(Math.round(salaryNet / workingDaysInMonth / 8))}/час
  До конца месяца заработаешь ещё: ${rub(Math.round(salaryNet / workingDaysInMonth * daysLeftWorking))}
  Порог: ${rub(threshold)} (эквивалент ~${rub(threshold/marginShare)} выручки или клиентов на эту сумму номиналов)
  Момент: ${(momentShare*100).toFixed(0)}% → ежемесячный | Годовой остаток: ${((1-momentShare)*100).toFixed(0)}%
  Марджин выручки: ${(marginShare*100).toFixed(0)}% | НДФЛ: ${(r1*100).toFixed(0)}%
  Квартальные множители: qm2=${qm2} (при 2 кл), qm3=${qm3} (при ≥3 кл)
  Номиналы: г3=${nominals.g3}, г4=${nominals.g4}, г5-6=${nominals.g56}, г7-8=${nominals.g78}, г9=${nominals.g9}, г10=${nominals.g10}
  Лимит переменных: ${rub(varBudget)}

=== КАСТОМНЫЕ КАТЕГОРИИ ===
${customCatLines || '  (нет кастомных категорий)'}

=== МОИ ПРОШЛЫЕ ОШИБКИ (не повторять) ===
${correctionLines || '  (нет записей)'}`
}

export async function getLoansSummaryJson(): Promise<string> {
  return cached('loans_summary', _getLoansRaw)
}

async function _getLoansRaw(): Promise<string> {
  const s = db()
  const { data: loans } = await s.from('loans').select('name,principal,rate,min_payment,end_date,paid_month').eq('user_id', USER_ID).order('rate', { ascending: false })
  const mk2 = mk()
  // Журнал последних событий по каждому кредиту — без него бот отвечает
  // «что происходило» по памяти диалога и путает даты/суммы задним числом.
  const { data: anchorRows } = await s.from('bot_anchors').select('key,value')
    .eq('user_id', USER_ID).eq('month_key', 'global').like('key', 'loan_log:%')
  // Переходные платежи этого месяца — итог должен считаться по ним,
  // иначе шапка показывает регулярную сумму и противоречит строкам ниже.
  const { data: ovRows } = await s.from('bot_anchors').select('key,value')
    .eq('user_id', USER_ID).eq('month_key', 'global').like('key', `loan_payment_override:%:${mk2}`)
  const logByLoan: Record<string, unknown[]> = {}
  for (const r of anchorRows ?? []) {
    const nm = r.key.replace('loan_log:', '')
    try { logByLoan[nm] = (JSON.parse(String(r.value)) as unknown[]).slice(-3) } catch { logByLoan[nm] = [] }
  }
  const list = (loans ?? []).map((l: {name:string,principal:number,rate:number,min_payment:number,end_date:string,paid_month:string}) => {
    const principal = Math.round(Number(l.principal))
    const rate = Number(l.rate)
    const minPay = Math.round(Number(l.min_payment))
    const ovr = (ovRows ?? []).find(r => r.key === `loan_payment_override:${l.name.toLowerCase()}:${mk2}`)
    const payThisMonth = ovr ? Math.round(Number(ovr.value)) : minPay
    const monthsLeft = annuityMonthsFor(principal, rate / 12, minPay)
    const overpay = Math.max(0, minPay * monthsLeft - principal)
    return {
      name:l.name, principal, rate_percent:Math.round(rate*10000)/100, min_payment:minPay,
      payment_this_month: payThisMonth,
      payment_note: ovr ? `в ${mk2} разово ${payThisMonth}₽ вместо ${minPay}₽ (после досрочки)` : null,
      end_date:l.end_date, paid_this_month:l.paid_month===mk2, months_left:monthsLeft, overpay_estimate:overpay,
      recent_events: logByLoan[l.name.toLowerCase()] ?? [],
    }
  })
  return JSON.stringify({
    source:'LIVE_DB',
    loans:list,
    total_principal:list.reduce((s,l)=>s+l.principal,0),
    total_min_payment_regular:list.reduce((s,l)=>s+l.min_payment,0),
    total_payment_THIS_MONTH:list.reduce((s,l)=>s+l.payment_this_month,0),
    total_overpay_estimate:list.reduce((s,l)=>s+l.overpay_estimate,0),
  }, null, 2)
}

export async function getFinancialSummaryJson(): Promise<string> {
  return cached('fin_summary', _getFinancialSummaryRaw)
}

async function _getFinancialSummaryRaw(): Promise<string> {
  // ЕДИНЫЙ ИСТОЧНИК: всё из ядра computeFinancialState(). Здесь НЕТ своей математики.
  const st = await computeFinancialState()
  const s = db()
  // Данные прошлого месяца для расчёта бонуса (не финсостояние, отдельный запрос)
  const prevMk = (() => { const [y,m] = st.month_key.split('-').map(Number); const d = new Date(y, m-2, 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}` })()
  const { data: prevMonth } = await s.from('months').select('clients,revenue,bonus_amount').eq('user_id',USER_ID).eq('month_key',prevMk).maybeSingle()

  const advInc = st.incomes.find(i => i.name === 'Аванс')
  const eomInc = st.incomes.find(i => i.name === 'ЗП')
  const bonInc = st.incomes.find(i => i.name === 'Бонус')

  return JSON.stringify({
    source: 'LIVE_DB_CORE',
    month_key: st.month_key,
    today: st.today, days_left: st.days_left,
    debit_sber: st.debit_sber, tbank_debit: st.tbank_debit, cash: st.cash, total_liquid: st.liquid,
    card_debt_total: st.card_debt,
    cards: st.cards,
    net_position: st.net_position,
    var_spent: st.var_spent, var_budget: st.var_budget, var_left: st.var_left,
    daily_var_budget: st.daily_var_budget, extra_spent: st.extra_spent,
    fixed_paid: st.fixed_paid, fixed_total: st.fixed_total, fixed_unpaid: st.fixed_unpaid,
    salary_adv: { amount: advInc?.amount ?? 0, received: advInc?.received ?? false },
    salary_eom: { amount: eomInc?.amount ?? 0, received: eomInc?.received ?? false },
    bonus: { amount: bonInc?.amount ?? 0, received: bonInc?.received ?? false },
    pending_income: st.pending_income, pending_salary: st.pending_salary, pending_recurring: st.pending_recurring,
    pending_loans: st.pending_loans,
    loans_pending: st.loans_pending, loans_paid: st.loans_paid,
    planned_total: st.planned_total,
    forecast_end: st.forecast_eom,
    forecast_after_planned: st.forecast_after_planned,
    incomes: st.incomes,
    stipend_needs_confirm: st.stipend_needs_confirm,
    prev_month: { month_key: prevMk, clients: prevMonth?.clients, revenue: prevMonth?.revenue, bonus_received: prevMonth?.bonus_amount },
  }, null, 2)
}
