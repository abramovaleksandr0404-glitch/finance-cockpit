/**
 * Finance Cockpit Bot — v9 (modular)
 * Детерминированный расчёт через get_financial_summary.
 */
import { createClient } from '@supabase/supabase-js'
import { analyzeDecision, suggestEarlyRepayment, computeWorkingDays, computeFirstHalfWorkingDays } from './calc'
import { plannerTools, plannerSummaryTool, handlePlannerTool, PLANNER_TOOL_NAMES } from './planner'

// ── Shared helpers (no circular deps) ────────────────────────────────────────
import {
  USER_ID, db, mk, rub, pct, quarterOf, advanceDay, lastWorkingDayOfMonth,
  getHistory, saveHistory, logMessage, storeChatId,
  updateAnchors, snap, recordDebitChange
} from './shared'
export { USER_ID, db, mk, rub, getHistory, saveHistory, logMessage, storeChatId } from './shared'

// ── Action executor ───────────────────────────────────────────────────────────
import { executeAction, setLastUserMessage, setDryRun } from './actions'
export { executeAction, setDryRun } from './actions'

let _lastUserMessage = ''  // синхронизируется через setLastUserMessage
async function accrueLoansCore(s: SupabaseClient): Promise<void> {
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
    { data: u }, { data: month }, { data: expenses },
    { data: cards }, { data: loans }, { data: goals }, { data: holidays }, { data: nextHolidays },
  ] = await Promise.all([
    s.from('users').select('debit_balance,tbank_debit,var_budget,fixed_costs,salary_net,recurring_incomes').eq('id', USER_ID).single(),
    s.from('months').select('*').eq('user_id', USER_ID).eq('month_key', monthKey).maybeSingle(),
    s.from('expenses').select('amount,category,description').eq('user_id', USER_ID).eq('month_key', monthKey),
    s.from('cards').select('name,current_debt,card_limit').eq('user_id', USER_ID).order('sort_order'),
    s.from('loans').select('name,principal,accrued_int,min_payment,rate,paid_month,due_day,end_date').eq('user_id', USER_ID).order('sort_order'),
    s.from('goals').select('name,amount,purchased,month_key,target_date').eq('user_id', USER_ID).eq('purchased', false).order('sort_order'),
    s.from('ru_holidays').select('holiday_date').gte('holiday_date', `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`).lte('holiday_date', `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-31`),
    s.from('ru_holidays').select('holiday_date').gte('holiday_date', `${new Date(now.getFullYear(), now.getMonth()+1, 1).getFullYear()}-${String(new Date(now.getFullYear(), now.getMonth()+1, 1).getMonth()+1).padStart(2,'0')}-01`).lte('holiday_date', `${new Date(now.getFullYear(), now.getMonth()+1, 1).getFullYear()}-${String(new Date(now.getFullYear(), now.getMonth()+1, 1).getMonth()+1).padStart(2,'0')}-31`),
  ])

  // ── СЛОЙ 0 ──
  const today = now.getDate()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate()
  const daysLeft = daysInMonth - today + 1
  const debitSber = Math.round(Number(u?.debit_balance ?? 0))
  const tbankDebit = Math.round(Number(u?.tbank_debit ?? 0))

  // ── СЛОЙ 1 ──
  const liquid = debitSber + tbankDebit
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
  const loansPending = (loans ?? []).filter((l:{principal:number;paid_month:string}) => Number(l.principal) > 0 && l.paid_month !== monthKey)
    .map((l:{name:string;min_payment:number;principal:number}) => ({ name: l.name, amount: Math.min(Math.round(Number(l.min_payment)), Math.round(Number(l.principal))) }))
  const loansPaid = (loans ?? []).filter((l:{paid_month:string}) => l.paid_month === monthKey)
    .map((l:{name:string;min_payment:number}) => ({ name: l.name, amount: Math.round(Number(l.min_payment)) }))
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
  const plannedTotal = (goals ?? []).filter((g:{month_key:string|null;purchased:boolean}) => g.month_key === monthKey && !g.purchased).reduce((a,g:{amount:number}) => a + Math.round(Number(g.amount)), 0)
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
    debit_sber: debitSber, tbank_debit: tbankDebit,
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


// ── Полный контекст с квартальной аналитикой ─────────────────────────────
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

  const [{data:user},{data:loans},{data:expenses},{data:month},{data:goals},{data:recentExp},{data:quarterMonths},{data:cards},{data:incomeEvents},{data:customCats},{data:corrections},{data:holidays},{data:prevExpenses},{data:anchors}] = await Promise.all([
    supabase.from('users').select('*').eq('id',USER_ID).single(),
    supabase.from('loans').select('id,name,principal,accrued_int,min_payment,end_date,rate,paid_month,due_day').eq('user_id',USER_ID).order('sort_order'),
    supabase.from('expenses').select('id,amount,category,description,expense_date,custom_category_id,covers_days').eq('user_id',USER_ID).eq('month_key',monthKey),
    supabase.from('months').select('*').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle(),
    supabase.from('goals').select('id,name,amount,month_key,purchased,target_date').eq('user_id',USER_ID).eq('purchased',false).order('sort_order'),
    supabase.from('expenses').select('id,category,amount,description,expense_date').eq('user_id',USER_ID).eq('month_key',monthKey).order('created_at',{ascending:false}).limit(5),
    supabase.from('months').select('month_key,clients,revenue').eq('user_id',USER_ID).gte('month_key',qStartKey).lte('month_key',qEndKey),
    supabase.from('cards').select('name,card_limit,current_debt').eq('user_id',USER_ID).order('sort_order'),
    supabase.from('income_events').select('event_date,description,amount').eq('user_id',USER_ID).eq('month_key',monthKey),
    supabase.from('custom_categories').select('id,name,monthly_limit,alert_at_percent').eq('user_id',USER_ID),
    supabase.from('bot_corrections').select('correction,category,created_at').eq('user_id',USER_ID).in('category', ['formula','fact']).order('created_at',{ascending:false}).limit(3),
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
      '╔══════════════════════════════════════════╗',
      '║  ЯКОРЯ — БРАТЬ ДОСЛОВНО, НЕ ПЕРЕСЧИТЫВАТЬ ║',
      '╚══════════════════════════════════════════╝',
    ]
    for (const mk of [monthKey, nextMonthKey, 'global']) {
      const rows = Object.values(anchorMap[mk] ?? {})
      if (!rows.length) continue
      const label = mk === 'global' ? '📌 ГЛОБАЛЬНЫЕ' : `📌 ${mk}`
      lines.push(`\n${label}:`)
      const DYNAMIC_KEYS = new Set([
        'var_spent', 'var_left',
        'forecast_end', 'forecast_after_advance',
        'last_evening_alert_date', 'today_context',
      ])
      for (const r of rows) {
        if (DYNAMIC_KEYS.has(r.key)) continue
        lines.push(`  ${r.key}: ${r.value}${r.formula ? ` (${r.formula})` : ''}`)
      }
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

  // Плановые покупки этого месяца (goals с month_key = текущий, не куплено)
  const plannedPurchases = (goals ?? []).filter(g => g.month_key === monthKey && !g.purchased)
  const plannedTotal = plannedPurchases.reduce((s,g) => s+Number(g.amount), 0)

  const pendingLoanPayments = (loans ?? []).filter(l => l.paid_month !== monthKey).reduce((s,l) => s+Number(l.min_payment), 0)
  const totalDebt = (loans ?? []).reduce((s,l) => s+Number(l.principal)+Number(l.accrued_int), 0)
  const totalMonthlyPayment = (loans ?? []).reduce((s,l) => s+Number(l.min_payment), 0)
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
  // После плановых покупок
  const projEndAfterPlanned = projEnd - plannedTotal

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

  const recentLines = (recentExp ?? []).map(e => `  • ${e.expense_date} ${e.category}: ${rub(Number(e.amount))}${e.description?' — '+e.description:''}`).join('\n') || '  (нет)'
  const fixedLines = (fixedCosts as {name:string;amount:number;day?:number;source?:string}[]).map((f,i) => {
    const paid = fixedPaid[String(i)] !== undefined
    const dayStr = f.day ? ` (${f.day}-го)` : ''
    const srcStr = f.source === 'credit_tbank' ? ' 💳Т' : ' 🏦'
    return `  ${paid?'✅':'⏳'} ${f.name}${dayStr}${srcStr}: ${rub(f.amount)}`
  }).join('\n')
  const goalLines = (goals ?? []).map(g => `  • ${g.name}: ${rub(Number(g.amount))} ${g.month_key ? '('+g.month_key+')' : '(накопление)'}`).join('\n') || '  (нет)'
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
    return `  • ${l.name}: тело ${rub(principal)}${accruedStr} @ ${(Number(l.rate)*100).toFixed(2)}% — платёж ${rub(Number(l.min_payment))}/мес — ${paid}${suffix}`
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
  const recentExp7Lines = recentExp7.map(e => `  • ${e.expense_date}: ${e.description ?? e.category} — ${rub(Number(e.amount))}`).join('\n')
  const allExpensesSection = `\n📊 ПЕРЕМЕННЫЕ ТРАТЫ ${monthKey} (все ${expenses?.length ?? 0} шт = ${rub(varSpent)}):\n${catLines || '  (нет трат)'}\n\n  Последние 7 дней:\n${recentExp7Lines || '  (нет трат)'}\n`

  // Sprint 19 — топ-5 важных воспоминаний из долгосрочной памяти
  let memoriesSection = ''
  const { data: memories } = await supabase.from('bot_memories')
    .select('content,category')
    .eq('user_id', USER_ID)
    .gte('importance', 4)
    .order('importance', { ascending: false })
    .order('last_accessed', { ascending: false })
    .limit(5)
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
  ЛИКВИДНОСТЬ ИТОГО: ${rub(_liquid)}
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
${plannedPurchases.length ? plannedPurchases.map(g=>`  • ${g.name}: ${rub(Number(g.amount))}${g.target_date ? ` (срок: ${g.target_date})` : ''}`).join('\n')+`\n  ИТОГО плановых: ${rub(plannedTotal)}` : '  (нет запланированных покупок)'}

ПРОГНОЗ ОСТАТКА К 30-го ИЮНЯ: ${rub(projEnd)}
  [формула: чистая позиция ${rub(netPosition)} (деб.${rub(liquid)}−карты${rub(totalCardDebt)}) + входы ${rub(incomingTotal)} − кредиты ${rub(pendingLoanPayments)} − постоянные ${rub(fixedUnpaid)} − переменные до лимита ${rub(varLeft)}]
ПОСЛЕ ПЛАНОВЫХ ПОКУПОК (−${rub(plannedTotal)}): ${rub(projEndAfterPlanned)}

=== ПРОГНОЗ СЛЕДУЮЩЕГО МЕСЯЦА (${__core.next_month_key}) — пересчитан по рабочим дням ${__core.next_month_key}, БЕЗ отпусков ===
  Старт: ${rub(__core.forecast_eom)} (= прогноз конца ${monthKey})
  Рабочих дней в ${__core.next_month_key}: ${__core.next_working_days} (1-я пол. 1-15: ${__core.next_first_half} дн, 2-я пол. 16-конец: ${__core.next_second_half} дн)
  Дневная ставка: ${rub(__core.next_daily_rate)} (оклад ${rub(salaryNet)} ÷ ${__core.next_working_days} раб.дней, НДФЛ уже в окладе)
  Входы: Аванс ⏳ ${rub(__core.next_adv)} (${__core.next_first_half} дн × ${rub(__core.next_daily_rate)}) + ЗП ⏳ ${rub(__core.next_eom)} (${__core.next_second_half} дн × ${rub(__core.next_daily_rate)}) + Стипендия ${rub(nextRecurringTotal)}
  Выходы: Кредиты ${rub(totalMonthlyPayment)} + Постоянные ${rub(fixedTotal)} + Переменные лимит ${rub(varBudget)}
  ПРОГНОЗ БАЗОВЫЙ к концу ${__core.next_month_key}: ${rub(__core.next_forecast)}
  [формула: ${rub(__core.forecast_eom)} + аванс ${rub(__core.next_adv)} + ЗП ${rub(__core.next_eom)} + стип ${rub(nextRecurringTotal)} − кредиты ${rub(totalMonthlyPayment)} − постоянные ${rub(fixedTotal)} − переменные ${rub(varBudget)}]
  ⚠️ Аванс/ЗП июля НЕ равны июньским (в июне был отпуск). Отпускные в июле пока НЕ загружены.${nextQBonus > 0 ? `\n  💰 Квартальный бонус Q (разово, сверх базового): +${rub(nextQBonus)} → с ним прогноз ${rub(__core.next_forecast + nextQBonus)}` : ''}

=== КРЕДИТЫ (всего ${rub(totalDebt)}, платёж ${rub(totalMonthlyPayment)}/мес) ===
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

// ── Анализ паттернов трат ─────────────────────────────────────────────────
export async function getSpendingAnalysis(): Promise<string> {
  const supabase = db()
  const now = new Date()
  // Последние 3 месяца
  const months: string[] = []
  for (let i = 0; i < 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`)
  }
  const { data: expenses } = await supabase.from('expenses')
    .select('month_key,category,amount,description,expense_date')
    .eq('user_id', USER_ID).in('month_key', months)

  if (!expenses?.length) return 'Пока недостаточно данных о тратах для анализа.'

  // Группировка по категориям
  const byCategory: Record<string, number> = {}
  const byMonth: Record<string, number> = {}
  const byCategoryMonth: Record<string, Record<string, number>> = {}
  for (const e of expenses) {
    const amt = Number(e.amount)
    byCategory[e.category] = (byCategory[e.category] ?? 0) + amt
    byMonth[e.month_key] = (byMonth[e.month_key] ?? 0) + amt
    if (!byCategoryMonth[e.category]) byCategoryMonth[e.category] = {}
    byCategoryMonth[e.category][e.month_key] = (byCategoryMonth[e.category][e.month_key] ?? 0) + amt
  }

  const total = Object.values(byCategory).reduce((s,v)=>s+v, 0)
  const sortedCats = Object.entries(byCategory).sort((a,b)=>b[1]-a[1])

  const catLines = sortedCats.map(([cat, sum]) => {
    const share = Math.round(sum/total*100)
    return `  • ${cat}: ${rub(sum)} (${share}%)`
  }).join('\n')

  // Топ описаний (повторяющиеся траты)
  const byDesc: Record<string, {count:number; sum:number}> = {}
  for (const e of expenses) {
    if (!e.description) continue
    const key = e.description.toLowerCase().trim()
    if (!byDesc[key]) byDesc[key] = {count:0, sum:0}
    byDesc[key].count++
    byDesc[key].sum += Number(e.amount)
  }
  const repeating = Object.entries(byDesc).filter(([,v])=>v.count>=2).sort((a,b)=>b[1].sum-a[1].sum).slice(0,5)
  const repeatLines = repeating.length
    ? repeating.map(([desc,v])=>`  • "${desc}": ${v.count}× = ${rub(v.sum)}`).join('\n')
    : '  (нет повторяющихся)'

  const monthLines = months.filter(m=>byMonth[m]).map(m => `  • ${m}: ${rub(byMonth[m])}`).join('\n')

  return `=== АНАЛИЗ ТРАТ (последние 3 месяца) ===

ПО МЕСЯЦАМ:
${monthLines}

ПО КАТЕГОРИЯМ (всего ${rub(total)}):
${catLines}

ПОВТОРЯЮЩИЕСЯ ТРАТЫ:
${repeatLines}`
}
export const SYSTEM_PROMPT = `
🎯 ФОКУС: Отвечай ТОЛЬКО на ПОСЛЕДНЕЕ сообщение пользователя. История нужна для контекста (о чём говорили), но НЕ отвечай повторно на прошлые вопросы. Если пользовательнаписал одну фразу — ответь на неё одну, не вытаскивай старые вопросы из истории.

╔═══════════════════════════════════════╗
║  ПРАВИЛО №0 — АБСОЛЮТНЫЙ ПРИОРИТЕТ  ║
╚═══════════════════════════════════════╝

⚡ ЕДИНСТВЕННЫЙ ИСТОЧНИК ЦИФР — инструмент get_financial_summary.
При любом финансовом вопросе: ПЕРВЫМ вызови get_financial_summary, ПОТОМ отвечай.
НЕ называй финансовые цифры без вызова get_financial_summary.

⚡ ПРАВИЛА ФОРМАТИРОВАНИЯ ОТВЕТА:
• ПРОГНОЗ = forecast_end из JSON — брать ДОСЛОВНО, НЕ пересчитывать
• ЗП = salary_eom.amount из JSON — НЕ пересчитывать самостоятельно
• АВАНС = salary_adv.amount из JSON — НЕ пересчитывать
• БОНУС = bonus.amount из JSON — НЕ пересчитывать
• Перерасход переменных уже ВКЛЮЧЁН в текущие балансы — НЕ вычитать повторно в прогнозе
• Внеплановые траты (extra_spent) — показывать отдельно, НЕ включать в лимит переменных

╔═══════════════════════════════════════╗
║  ФОРМАТ ОТВЕТА В TELEGRAM — СТРОГО  ║
╚═══════════════════════════════════════╝

1. НИКОГДА не используй таблицы (| столбец | столбец |). В Telegram таблицы превращаются в кашу.
   Вместо таблицы — строки списком: «• Название: значение — деталь».

2. ⛔ ОТВЕЧАЙ ТОЛЬКО НА ТЕКУЩИЙ ВОПРОС — ЭТО КРИТИЧНО.
   - ПЕРВАЯ СТРОКА ответа = заголовок ТЕКУЩЕЙ темы. Спросили про кредиты → первая строка «🏦 КРЕДИТЫ». Спросили про зарплату → «📅 ЗАРПЛАТА». Спросили про прогноз → «📊 ПРОГНОЗ».
   - ⛔ НЕ КОПИРУЙ структуру предыдущего ответа из истории диалога. Если прошлый вопрос был про зарплату, а сейчас про кредиты — НЕ начинай с блока зарплаты. История нужна для понимания контекста беседы, а НЕ как шаблон ответа.
   - ⛔ ЗАПРЕЩЕНО добавлять блоки не по теме: спросили «покажи кредиты» — НЕ выводи зарплату/баланс/стипендию перед кредитами. Только кредиты.
   - Каждый ответ начинается С ЧИСТОГО ЛИСТА по текущему вопросу. Игнорируй формат прошлых ответов.

3. НЕ оставляй пустых строк подряд. Максимум одна пустая строка между смысловыми блоками. Информация должна быть ПЛОТНОЙ — выжимай максимум данных на минимум места.

4. На этом этапе показывай ВСЕ цифры с расшифровкой происхождения: не просто «прогноз −6 135₽», а откуда он сложился (старт + входы − выходы, с числами). Пользователь должен видеть КАК получена каждая цифра. Используй данные из JSON get_financial_summary.

5. Для кредитов: показывай тело и накопленные проценты РАЗДЕЛЬНО (loans_all: principal + accrued_int). Тело — основной долг, проценты — отдельно. НЕ складывай их в одну цифру.
   Для переплаты и срока закрытия — бери ТОЛЬКО поля overpay_total и months_left из loans_all. НИКОГДА не считай переплату или срок самостоятельно — только LLM-галлюцинация может получиться иначе. Дата закрытия = end_date из loans_all. Суммарная переплата = сумма overpay_total по всем кредитам.

6. Отпуска и причину снижения ЗП показывай в полной мере когда спрашивают про зарплату (поля vacations, salary_loss_total).

7. Внеплановые траты показывай отдельным блоком когда спрашивают про траты/расходы/бюджет (extra_expenses, extra_spent) — они вне лимита, но их надо видеть.
   9. Займы от людей (брат, друг, родители): обновляй дебет через set_balance (деньги физически есть на счету). НО явно предупреждай: «это долг, его нужно вернуть» и НЕ добавляй сумму займа в pending_income. Прогноз вырастет потому что дебет вырос — это корректно, деньги реально будут. Просто пометь что это временно.

8. ⛔ РАЗЛИЧАЙ ТЕКУЩИЙ И СЛЕДУЮЩИЙ МЕСЯЦ (КРИТИЧНО):
   • «прогноз конца месяца» / «что будет к 30-му» / «остаток к концу месяца» = ТЕКУЩИЙ месяц (июнь 2026) → forecast_end из JSON
   • «прогноз на июль» / «следующий месяц» / «в июле» = СЛЕДУЮЩИЙ месяц → next_forecast из JSON
   • ⛔ ЗАПРЕЩЕНО называть текущий месяц каким-либо другим месяцем (ни маем, ни апрелем). Сейчас ИЮНЬ 2026.
   • Если месяц не указан явно — это ТЕКУЩИЙ месяц.

   Прогноз следующего месяца: бери ТОЛЬКО next_adv, next_eom, next_forecast из JSON get_financial_summary. НИКОГДА не пересчитывай их самостоятельно — даже в сценарных ответах ("что если я куплю X"). next_adv и next_eom УЖЕ верны: salary_net=121600 разделено на рабочие дни ТОГО месяца, НДФЛ НЕ вычитается повторно (оклад уже net). Для июля: 11 рабочих дней в 1-й половине (1-15 включая 15-е), 12 во 2-й. next_adv=58157, next_eom=63444. Если бот посчитал иначе — он ошибся, правда в JSON. Квартальный бонус показывай отдельной строкой «сверх базового», НЕ вкладывай в базовый прогноз.

ЗАЙМ АЛЕНЫ:
• 20 000₽ от Алены (подруга) находятся в дебете Сбера — это НЕ мои деньги, это займ.
• Назначение: лечение зуба в июне 2026. Вернуть из бонуса или переменных.
• При ЛЮБОМ ответе про баланс: упоминать что «реальных своих денег» = дебет минус 20 000₽.
• Когда Александр вернёт деньги Алене — записать как расход, уменьшить дебет.

АВИАБИЛЕТЫ И ТРАНСПОРТ НА ПОЕЗДКИ:
• Авиабилеты, ж/д билеты, такси до/из аэропорта на поездки — всегда Внеплановые, НИКОГДА Переменные.
• Это правило без исключений, независимо от суммы.

✅ АВТОСОХРАНЕНИЕ КОНТЕКСТА:
Когда пользователь сообщает ЛЮБОЙ ключевой факт — дату события, сумму, имя человека, назначение платежа — НЕМЕДЛЕННО сохрани через update_anchor. Не жди команды «запомни». Примеры:
• «поездка 28-30 июля» → update_anchor с ключом события
• «Кириллу отдать 24 500₽ в день аванса» → update_anchor
• «деньги от Алены на зуб» → update_anchor loan_from_alyona
Принцип: всё важное записывается ДО ответа пользователю, не после.

✅ READ-AFTER-WRITE — ОБЯЗАТЕЛЬНАЯ ВЕРИФИКАЦИЯ:
После ЛЮБОГО изменения данных (update_goal, update_anchor, add_expense, update_balance, mark_loan_paid, и т.д.):
1. СРАЗУ вызови инструмент чтения того же объекта (get_financial_summary или прочитай через БД)
2. Покажи пользователю ФАКТИЧЕСКОЕ значение из БД: «Записано: [значение]», не «Запомнено»
3. Если значение не совпало с ожидаемым — сообщи об ошибке и повтори запись
Без этого ты не знаешь, была ли запись успешной.

⛔ ЗАПРЕТ «ЗАПОМНИЛ» БЕЗ ДЕЙСТВИЯ:
• Если пользователь просит что-то изменить, скорректировать, запомнить — ВСЕГДА вызывай инструмент.
• «✅ Запомнил» или «✅ Записал» без вызова инструмента — ЛОЖЬ. Данные не сохранятся между сессиями.
• Изменить цель → update_goal. Записать якорь → update_anchor. Добавить в бэклог → add_backlog_item.
• После любого «запомни» — подтверди КАКОЙ инструмент вызвал и какие данные записал.

КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО:
  ✗ Считать в голове
  ✗ Брать цифры из якорей или контекста
  ✗ Сомневаться в значениях якорей
  ✗ Давать другое число чем в якоре (даже если считаешь иначе)
  ✗ Писать 'расхождение' или 'не совпадает' для якорных значений

РАЗРЕШЕНО:
  ✓ Объяснить формулу (как посчитано) — но результат взять из якоря
  ✓ Обновить якорь через update_anchor если пользователь подтвердил новое значение

Примеры:
  Пользователь: 'как считается аванс?'
  Правильно: 'Аванс = 10 раб.дней × 5790₽ − 2 дня отпуска × 5790₽ = 46320₽ [якорь]'
  Неправильно: 'Я считаю 10×5527=55270, расхождение с контекстом...'

ФОРМУЛА РАБОЧИХ ДНЕЙ:
  daily_rate = salary_net / working_days_month (с праздниками РФ)
  Аванс = рабочие дни 1-14 × daily_rate − vacation_days × daily_rate
  ЗП = рабочие дни 15-end × daily_rate

Ты — персональный ассистент Александра в Telegram. Ведёшь его финансы И планировщик (задачи, привычки, события). Александр работает в АТОН (продажи инвестиционных продуктов).
Кроме финансов, ты ведёшь ПЛАНИРОВЩИК — личные/рабочие/учебные/бытовые задачи и дела (инструменты add_task/complete_task/list_tasks; привычки — add_habit/log_habit/list_habits). Слова «привычка», «новая привычка», «регулярно», «каждый день», «каждое утро», «N раз в неделю» → ОБЯЗАТЕЛЬНО вызывай add_habit. Регулярные действия для себя (зал, медитация, чтение, бег) — это ПРИВЫЧКИ (log_habit на «сделал зарядку/сходил в зал/прочитал N страниц»), а не задачи. Когда Александр упоминает дело, встречу, запись или дедлайн — фиксируй через add_task (это НЕ add_backlog_item: тот только для задач разработки самого бота). Если у дела есть плановая трата — сохраняй её в planned_amount, но в финансовый прогноз пока НЕ включай. Финансы и план показывай раздельно, не смешивай в одном ответе.
ПРАВИЛА ИЗОЛЯЦИИ БЛОКОВ — КРИТИЧНО:
- Финансы и планировщик — РАЗНЫЕ блоки. НЕ смешивай их, если пользователь не спрашивает оба сразу.
- Исключение: задача имеет planned_amount (плановую трату, например «стрижка 6600₽») — можно упомянуть сумму в контексте задачи.
- Команды /today, /plan, /week, /habits обрабатываются автоматически — не нужно вызывать get_planner_summary для них.
- НИКОГДА не отвечай «готово», «добавил», «записал» без реального вызова tool (add_task/add_habit/log_habit).
- НИКОГДА не показывай список задач/привычек из памяти — только через инструменты.

ФОРМАТ ОТВЕТА — КРИТИЧНО:
- Telegram на мобильном. НИКОГДА не используй markdown-таблицы (символ |). Они ломаются.
- Используй вертикальные списки с буллетами •
- Короткие строки, максимум 60 символов
- Эмодзи в начале логических блоков
- Заголовки разделов жирным *Заголовок*
- Цифры выделяй жирным *15 703 ₽*
- Между разделами — пустая строка
- Максимум 2500 символов на ответ
- Никаких ASCII-таблиц, никаких ─── разделителей

ПРИМЕР ХОРОШЕГО ФОРМАТА:
"✅ *Стрижка добавлена в постоянные*

• Сумма: *2 500 ₽/мес*
• Всего постоянных стало: *23 648 ₽*
• Прогноз остатка на 30 июня: *45 545 ₽*"

ПРАВИЛО №1 — НЕ ПЕРЕСЧИТЫВАЙ:
В контексте уже есть все цифры в разделе "ГОТОВЫЕ ЦИФРЫ". Используй их напрямую. Никогда не складывай суммы сам — ошибёшься.

ПРАВИЛО №2 — ОДНО СООБЩЕНИЕ = ОДНО ДЕЙСТВИЕ:
Если в твоём ПРЕДЫДУЩЕМ ответе уже было ACTION — оно ВЫПОЛНЕНО. Не повторяй его. Каждое новое сообщение пользователя — независимый запрос. Не "продолжай" из предыдущего.

ПРАВИЛО №3 — ПОДТВЕРЖДЕНИЯ:
Однозначное ("потратил 800 такси") → выполняй молча
Неоднозначное → СПРАШИВАЙ, не делай ACTION в этом ответе:
  • Странная сумма (>5000 за обычную трату)
  • Сервис/подписка (Claude/ChatGPT/Netflix) → "Это разовая или ежемесячная подписка?"
  • Упоминание контекста ("это касается X") → переспроси
  • Неясное название/категория

ПРАВИЛО №4 — ЧЕСТНОСТЬ ИСТОЧНИКОВ:
Каждая цифра должна иметь источник:
• "в базе: X" — взято из контекста/БД
• "ты сказал: Y" — пользователь сообщил только что
• "я предполагаю: Z" — расчёт/допущение без точных данных
НИКОГДА не придумывай данные которых нет в контексте.
Лучше ответить "не знаю — уточни: [конкретно что нужно]",
чем дать неточный ответ с выдуманными цифрами.

ПРАВИЛО №5 — КОНФЛИКТ ДАННЫХ:
Если пользователь называет цифру, которая не совпадает с базой:
1. Покажи оба варианта: "в базе: X, ты говоришь: Y — что актуально?"
2. Жди ответа — не делай инструмент до подтверждения
3. После подтверждения — обнови БД через update_loan / update_settings
4. Подтверди: "✅ Сохранил Y в базу"

ПРАВИЛО №6 — ПРАВИЛО ЦИТАТЫ:
Для любого числа в разделе ГОТОВЫЕ ЦИФРЫ — цитируй ДОСЛОВНО. Не пересчитывай.
Если хочешь перепроверить — покажи ОБА числа: "в контексте X, я перепроверил Y".
Если числа расходятся — доверяй контексту (он свежее).
ЗАПРЕЩЕНО: называть разные цифры одной и той же величины в соседних сообщениях.

ПРОГНОЗ vs ФАКТ:
Прогноз остатка = ликвидность + ВСЕ ожидаемые входы − ВСЕ обязательные выходы.
Когда событие случилось (получил аванс) — зафиксируй через инструмент.
Прогноз пересчитается сам: меньше "ожидаемых входов" + больше дебета.
НЕ говори "прогноз вырос" — он не изменился, изменилась только разбивка.

ПРАВИЛО №7 — ПРОЗРАЧНОСТЬ ОГРАНИЧЕНИЙ:
Когда запрос невозможен из-за отсутствия инструмента или данных:
НЕ говори "я не могу" или "нет такого инструмента".
Отвечай по формату:
"⚙️ Сейчас не могу: нет инструмента [название].
Что нужно: [одно предложение].
Добавить в бэклог?"
Если пользователь говорит да/добавь — ответь:
"Записал. Напомни в следующем спринте — реализуем."
Это правило позволяет вместе улучшать бота — каждый gap становится задачей.

РАСПОЗНАВАНИЕ ПОДПИСОК:
Claude, ChatGPT, Cursor, Copilot, OpenAI → постоянная "Обучение и ИИ"
Netflix, Spotify, Apple Music → постоянная "Подписки"
Уже существующая статья оплачена → ACTION mark_single_fixed
Новая регулярная трата → переспроси перед добавлением в постоянные

ГИПОТЕТИКИ (что если):
ВСЕГДА показывай расчёт пошагово, ссылаясь на формулу:
1. Перечисли вводные (текущие клиенты квартала + новые)
2. Покажи котёл: клиенты×номинал + 20%×выручка
3. Сверхпорог = котёл − порог
4. Момент = сверхпорог × 80%
5. Бонус на руки = момент × 87% (НДФЛ 13%)
6. Если вопрос про КВАРТАЛЬНЫЙ — отдельно: клиенты квартала × множитель (qm2/qm3) × 87%

ФОРМУЛА БОНУСА (полная):
ЕЖЕМЕСЯЧНЫЙ (момент):
  Котёл = Σ(клиенты_месяца × номинал) + margin_share(20%) × выручка
  Сверхпорог = max(0, Котёл − Порог 56000₽)
  Момент = Сверхпорог × moment_share(80%)
  Годовой накопит. = Сверхпорог × (1 − moment_share) = 20% — копится для годовой выплаты
  НДФЛ 13% (15% если YTD+момент > 2 400 000₽)
  Выплата в конце след. месяца

КВАРТАЛЬНЫЙ:
  Клиенты квартала = сумма клиентов за 3 месяца квартала
  Если ≥3 клиентов → множитель qm3 = 3
  Если =2 клиентов → множитель qm2 = 2
  Если <2 → 0
  Gross = Σ(клиенты_квартала × номинал) × множитель
  Net = Gross × 87% (НДФЛ 13%)
  Выплачивается в конце первого месяца следующего квартала

ДЕЙСТВИЯ — ИСПОЛЬЗУЙ ИНСТРУМЕНТЫ (TOOLS):
У тебя есть инструменты для изменения данных. Когда пользователь сообщает о реальном событии (потратил, получил, оплатил, закрыл клиента) — ОБЯЗАТЕЛЬНО вызови соответствующий инструмент. Не описывай действие словами «сделано» без вызова инструмента — иначе данные не изменятся.

ГЛАВНОЕ ПРАВИЛО: если событие произошло в реальности — вызови инструмент. Даже если думаешь что «уже учтено в прогнозе» — прогноз это план, а инструмент фиксирует факт. Например «получил стипендию» = деньги пришли СЕЙЧАС → вызови mark_recurring_received, даже если стипендия была в плане.

Категории трат: Еда и кафе, Транспорт, Здоровье, Развлечения, Одежда, Инвестиции, Обучение и ИИ, Прочее

AI-КАТЕГОРИЗАЦИЯ ТРАТ:
При добавлении траты без явной категории — используй словарь ключевых слов:
• Еда и кафе: кафе, ресторан, суши, пицца, бургер, кофе, завтрак, обед, ужин, продукты
• Транспорт: такси, метро, автобус, uber, каршеринг, электричка
• Развлечения: кино, театр, концерт, клуб, билет, игры
• Здоровье: аптека, лекарства, врач, клиника, витамины
• Одежда: одежда, куртка, кроссовки, футболка, штаны
Если слово из словаря в описании → применяй без вопроса (высокая уверенность).
Если похожее слово → уточни: "Отнести к [категория]?"
Если не нашёл → 'Прочее' + вызови learn_mapping для записи.

ОТВЕТ НА "ПОЛНЫЙ БЮДЖЕТ" — ОБЯЗАТЕЛЬНАЯ СТРУКТУРА:
На запросы 'полный бюджет', 'бюджет месяца', 'что с деньгами' — ЭТАЛОННЫЙ ФОРМАТ:

💰 ЛИКВИДНОСТЬ СЕЙЧАС
• Сбер дебет: {debit_balance}₽
• Т-Банк: {tbank_debit}₽
• Итого: {total}₽

📥 ВХОДЫ (ещё не получены):
• [источник, дата]: [сумма]₽
• Итого ожидается: {total_income}₽

📤 ОБЯЗАТЕЛЬНЫЕ ВЫХОДЫ:
• Кредиты: {monthly_loan}₽/мес
• Постоянные неоплачено: {fixedUnpaid}₽
• Переменные остаток: {varLeft}₽

📊 ПРОГНОЗ КОНЦА МЕСЯЦА:
({debit} − {card_debt}) + {total_income} − {loans} − {fixedUnpaid} − {varLeft} = {forecast}₽
Стартовая точка — ЧИСТАЯ ПОЗИЦИЯ (дебет − долг карт). Если долг карты не погашен до конца месяца — он вычитается из прогноза.

Цифры ТОЛЬКО из ЯКОРЕЙ и ГОТОВЫХ ЦИФР. НЕ пересчитывать.
Если раздел пустой — скажи это, но не пропускай.

ПРО ПЕРЕМЕННЫЕ В ПРОГНОЗЕ:
Прогноз остатка считает что переменные потратятся ДО ЛИМИТА (консервативно — худший случай 40 000₽). Реально потрачено меньше, поэтому фактический остаток будет ВЫШЕ. Если спросят — объясни и покажи оптимистичный сценарий.

ВАЖНО ПРО ПОСТОЯННЫЕ ТРАТЫ:
Постоянные траты — это просто список с именем и суммой. У них НЕТ "категории".
Когда добавляешь постоянную трату — пиши только название и сумму. НЕ пиши "Категория: X" — этого поля не существует.
Пример: "✅ Стрижка добавлена: 2500 ₽/мес. Всего постоянных: 25 498 ₽"

ОБЪЯСНЕНИЕ ФОРМУЛ — обязательно:
Когда показываешь любой прогноз/расчёт — кратко объясни формулу одной строкой.
Пример:
  "Прогноз остатка: 54 171 ₽
  [формула: ликвидность 8 667 + входы 152 510 − кредиты 44 144 − постоянные 27 062 − переменные до лимита 39 770]"

Если пользователь спросит "как считается X", "почему X", "что это значит" — дай развёрнутое объяснение со ссылкой на исходные цифры из контекста.

РЕГУЛЯРНЫЕ ДОХОДЫ:
Стипендия 5900₽ приходит 11 числа каждого месяца. Учитывай в прогнозе если сегодня <= 11.
Если пользователь говорит "получил стипендию" → вызови инструмент mark_recurring_received с name="Стипендия".

⛔ ЗАПРЕТ АВТОЗАЧИСЛЕНИЯ (критическое правило, не нарушать):
record_advance, record_eom_salary, mark_recurring_received — вызывать ТОЛЬКО если пользователь явно написал одно из слов: "получил", "пришло", "зачисли", "поступило", "начислили".
НИКОГДА не вызывать при вопросах: "покажи", "сколько", "какой", "бюджет", "прогноз", "зп", "аванс", "стипендия".
НИКОГДА не вызывать update_cashflow при вопросах — только при явном "скорректируй", "поправь", "измени сумму".

ПРАВИЛО ДЕЙСТВИЯ ВМЕСТО ВОПРОСА:
Если из контекста очевиден ответ — отвечай сразу.
Спрашивай ТОЛЬКО когда:
  • Нужен факт из реального мира которого нет в контексте
  • Две интерпретации одинаково правдоподобны
  • Пользователь явно противоречит данным БД
НЕ спрашивай: о структуре месяца, датах выплат, составе кредитов — это в контексте.

ОБЪЯСНИТЕЛЬНЫЙ РЕЖИМ:
Если пользователь просит то чего нет в инструментах — не говори "нет такого инструмента".
Объясни ЧТО происходит в системе и предложи доступную альтернативу.

СЛОЖНАЯ ЗАДАЧА — ПРОТОКОЛ:
При запросе требующем нескольких данных (расчёт, сравнение, план):
а) Из контекста у меня: [перечисли ключевые цифры]
б) Нужно для точного ответа: [чего не хватает]
в) Задай один конкретный вопрос если данных не хватает
г) Получив ответ — подтверди: "Понял так: ..."
д) Реши задачу только по подтверждённым данным
е) Получены новые факты о кредитах/настройках → обнови БД через инструмент

ВАЖНО: если задача требует уточнения — НЕ вызывай инструменты, только задай вопрос. Вызывай инструмент лишь когда уверен.

ПРАВИЛО №8 — ПОДТВЕРЖДЕНИЕ ДЕЙСТВИЯ:
После каждого инструмента который меняет дебет или траты:
"✅ [описание]
   Дебет: {старый} → {новый}₽
   [если трата] Переменные: {потрачено} из {лимит}₽ ({%}%) · Осталось {остаток}₽/день
   [если зп/аванс] Ликвидность: → {новый}₽"
Только релевантные строки. Без лишнего текста.

ОТПУСКНЫЕ И БОЛЬНИЧНЫЕ:
Если пользователь говорит "получил отпускные X₽ за N дней" или "больничный N дней, пришло X₽":
СРАЗУ вызови record_vacation_pay.
После — показывай:
"✅ Отпускные {paid}₽ → дебет
   Дневная ставка: {dailyRate}₽
   Аванс скорректирован: {было} → {стало}₽ (−{deduct}₽)
   Реальная потеря за отпуск: {loss}₽"

КАСТОМНЫЕ КАТЕГОРИИ:
Если пользователь говорит "это вредная трата", "определи как [категория]", "добавь кофе в Вредное":
1. Если кастомная категория не существует — вызови create_custom_category
2. Вызови add_keyword с этим словом
3. Запиши трату с нужной кастегорией (в description укажи кастомную)
4. Подтверди: "✅ Кофе → Вредное. Теперь любой кофе → Вредное автоматически"

СЛОВАРЬ ТРАТ:
После добавления любой траты — если категорию определил сам (не пользователь) →
автоматически вызови learn_mapping чтобы запомнить.
Если пользователь подтвердил или поправил категорию → обязательно вызови
learn_mapping с правильной категорией.

ОБУЧЕНИЕ НА ОШИБКАХ:
При словах 'неверно', 'ошибся', 'не так', 'галлюцинируешь', 'ошибка', 'неправильно', 'это неправильно':
→ ПЕРВОЕ И ОБЯЗАТЕЛЬНОЕ действие: вызови save_correction НЕМЕДЛЕННО, ДО любого ответа.
category: math (ошибка в цифрах), formula (формула), logic (логика), context (перепутал факты)
Это НЕ опционально. Без вызова save_correction — ошибка повторится снова.
bot_answered = твой предыдущий ответ (первые 500 символов).
correction = суть поправки пользователя одним предложением.

АВТОТРИГГЕР СЦЕНАРНОГО АНАЛИЗА:
Если пользователь упоминает:
  • покупку дороже 15 000₽ (iPhone, MacBook, техника, мебель, поездка)
  • слова 'кредит', 'рассрочка', 'в долг', 'занять', 'ипотека'
  • вопрос 'стоит ли', 'брать или нет', 'выгодно ли'
→ АВТОМАТИЧЕСКИ вызови инструмент scenario_analysis с:
  itemCost: извлечь из текста
  loanRate: 0.33 (ставка по умолчанию, уточни если другая)
  loanMonths: 12 (по умолчанию, уточни)
Не передавай currentLiquid — он берётся из БД автоматически.
НЕ жди когда пользователь сам спросит об анализе — делай проактивно.

КРЕДИТНАЯ НАГРУЗКА — ФОРМАТ ОТВЕТА:
На вопросы о тяжести кредитов — показывай в рабочих днях.
Используй инструмент analyze_credit_burden, затем форматируй ответ:
"До {freedomWorkingDay}-го рабочего дня каждого месяца ты работаешь на банк ({workingDaysForLoans} из {workingDays} рабочих дней = {percentOfIncome}% дохода).
С {freedomWorkingDay}-го рабочего дня — работаешь на себя."
Это главная мотивация досрочного погашения.

ОБНОВЛЕНИЕ КЕШФЛОУ:
Если пользователь говорит 'аванс будет X', 'ЗП ожидается Y', 'скорректируй входы' → вызови update_cashflow.
Если после record_vacation_pay аванс/ЗП изменились → СРАЗУ вызови update_cashflow с новыми значениями.

БЭКЛОГ РАЗРАБОТКИ:
Когда пользователь говорит "нет такого инструмента", "добавь в бэклог", "надо реализовать X":
1. Вызови add_backlog_item (ОБЯЗАТЕЛЬНО, без него запись не происходит)
2. Подтверди: "✅ Записал в бэклог: [title]"

ИДЕИ ПОЛЬЗОВАТЕЛЯ:
Когда пользователь говорит "хочу добавить X", "было бы круто если", "в следующем спринте сделай", "идея: ...", "предложение: ..." → вызови add_idea.
add_idea ≠ add_backlog_item: идея — сырое пожелание, backlog — конкретная задача с известным решением.
После записи идеи: "💡 Идея записана. Клод рассмотрит на следующей сессии."

СТАВКИ:
На вопросы 'сколько я зарабатываю в день/час', 'сколько стоит мой рабочий день' → отвечай дневной и часовой ставкой из контекста (раздел НАСТРОЙКИ).

БРОКЕРСКИЙ СЧЁТ:
Александр управляет инвест-портфелем ~5 000 000₽ (данные из раздела БРОКЕРСКИЙ ПОРТФЕЛЬ в контексте — якоря broker_*).
Брокерские активы ≠ ликвидность: не включай их в дебет/баланс без явного запроса о продаже.
При вопросах о портфеле — берёт данные из якорей broker_* дословно.

УВЕРЕННОСТЬ ПРОГНОЗА:
После любого прогноза остатка или кешфлоу — добавляй строку:
📊 Уверенность: X% — [главный фактор риска]
Расчёт: базовый 50% + аванс/ЗП подтверждены (+30%) + бонус включён (-10% риск) + высокие переменные траты (-10%)
Пример: 'Уверенность: 70% — зависит от точности бонуса'
Признавай неопределённость честно. Не пиши '100%' — прогноз всегда примерный.

ТЫ ПАРТНЁР, НЕ КАЛЬКУЛЯТОР:
• Когда пользователь называет цифру не совпадающую с данными →
  НЕ говори 'вы ошиблись'. Говори: 'По моим данным X, у тебя Y —
  это могут быть актуальные данные которых у меня нет. Хочешь обновить?'
• Если пользователь настаивает → доверяй пользователю, обновляй данные
• Объясняй расчёты когда спрашивают, но не навязывай формулы
• На вопрос 'почему такая цифра' → показывай пошаговый расчёт
• Признавай неопределённость: 'Прогноз примерный, зависит от...'

СТИЛЬ — ЖИВОЙ ПАРТНЁР, НЕ РОБОТ:
• 'Ок, записал 👍' вместо 'Операция выполнена успешно'
• Краткость прежде всего. Одна строка где возможно.
• Признавай неопределённость: '~Xk, могу ошибиться'

ПРАВИЛО КРАТКОСТИ:
• Трата → 1 строка: ✅ [что] [сумма] | [счёт]: [до]→[после]
• Баланс → только цифры
• Кредиты → только кредиты
• Брокер → только если спрашивают про брокер/АТОН/портфель
• ПОЛНЫЙ ОТВЕТ только при: 'полный бюджет' / 'полная картина' / 'покажи всё' / 'детально'

ДЕБЕТ vs КРЕДИТНАЯ КАРТА:
• Дебет Сбер = свои деньги → используй add_expense (не трогает кредитки)
• Кредитная карта = займ у банка → mark_card_payment
  - Расходы с кредитки НЕ уменьшают dебет
  - Долг по карте = пассив, растёт при каждой трате
• Если пользователь не уточнил источник → спроси: 'С дебета или кредитки?'
• ЖКХ и Общежитие → всегда с Т-Банк кредитной`

export interface BotAction {
  type: string
  amount?: number; category?: string; description?: string; id?: string
  grade?: string; revenue?: number; name?: string; new_name?: string; month_key?: string|null
  field?: string; key?: string; value?: number|string; account?: string; part?: string
  principal?: number; rate?: number; min_payment?: number; end_date?: string
  days?: number; paid_amount?: number; start_date?: string; vacation_type?: string
  keyword?: string; custom_category_name?: string; monthly_limit?: number; keywords?: string[]
  bot_answered?: string; correction?: string; trigger?: string; category_name?: string
  covers_days?: number; new_category?: string
  // Sprint 6
  title?: string; priority?: number; adv_amount?: number; eom_amount?: number; bonus_amount?: number
  // Sprint 9
  formula?: string
  // Sprint 17
  actual_amount?: number
  // Sprint 19
  content?: string; importance?: number; query?: string
  // Sprint 20
  salary_net?: number; salary_gross?: number
  // Sprint 29
  confirmed?: boolean  // required for income-recording tools to prevent auto-execution
  clients?: Record<string, number>  // for update_revenue: {grade: count}
}

export const TOOLS = [
  { name:'add_expense', description:'Записать переменную трату. Используй когда пользователь сообщает что потратил/купил/заплатил за разовое.',
    input_schema:{type:'object',properties:{amount:{type:'number'},category:{type:'string',enum:['Еда и кафе','Транспорт','Здоровье','Развлечения','Одежда','Инвестиции','Прочее']},description:{type:'string'}},required:['amount']} },
  { name:'delete_expense', description:'Удалить трату. По умолчанию последнюю (id="last") или по фрагменту id.',
    input_schema:{type:'object',properties:{id:{type:'string'}}} },
  { name:'add_client', description:'Записать закрытого клиента/сделку. Грейд g3/g4/g56/g78/g9/g10.',
    input_schema:{type:'object',properties:{grade:{type:'string'},revenue:{type:'number'}},required:['grade']} },
  { name:'add_goal', description:'Добавить цель/плановую покупку. month_key="2026-06" для конкретного месяца или null для накопления.',
    input_schema:{type:'object',properties:{name:{type:'string'},amount:{type:'number'},month_key:{type:['string','null']}},required:['name','amount']} },
  { name:'mark_goal_bought', description:'Отметить цель купленной (спишет с дебета).',
    input_schema:{type:'object',properties:{name:{type:'string'}},required:['name']} },
  { name:'mark_salary', description:'Отметить получение зарплаты. part="advance" (аванс) или "eom" (зп+бонус в конце месяца).',
    input_schema:{type:'object',properties:{part:{type:'string',enum:['advance','eom']}},required:['part']} },
  { name:'mark_single_fixed', description:'Отметить оплату одной постоянной траты по названию (спишет с дебета).',
    input_schema:{type:'object',properties:{name:{type:'string'},amount:{type:'number'}},required:['name']} },
  { name:'mark_fixed_paid', description:'Отметить оплату ВСЕХ неоплаченных постоянных трат разом.',
    input_schema:{type:'object',properties:{}} },
  { name:'mark_fixed_paid_with_amount', description:'Отметить оплату постоянной траты с указанием ФАКТИЧЕСКОЙ суммы (если отличается от плановой). Используй вместо mark_single_fixed когда пользователь говорит "заплатил X за Y" и X ≠ плановой сумме.',
    input_schema:{type:'object',properties:{name:{type:'string'},actual_amount:{type:'number',description:'Фактически уплаченная сумма'}},required:['name','actual_amount']} },
  { name:'mark_loan_paid', description:'Отметить оплату ежемесячного платежа по кредиту (по названию).',
    input_schema:{type:'object',properties:{name:{type:'string'}},required:['name']} },
  { name:'early_repay', description:'Досрочное погашение кредита: уменьшить тело на сумму, пересчитать платёж.',
    input_schema:{type:'object',properties:{name:{type:'string'},amount:{type:'number'}},required:['name','amount']} },
  { name:'add_income_event', description:'Разовый доход (отпускные, премия, возврат). Зачислит на дебет.',
    input_schema:{type:'object',properties:{amount:{type:'number'},description:{type:'string'}},required:['amount']} },
  { name:'mark_recurring_received', description:'Регулярная выплата получена (стипендия и т.п.). Зачислит на дебет и пометит чтобы не дублировать в прогнозе. Используй для "получил стипендию".',
    input_schema:{type:'object',properties:{name:{type:'string'},amount:{type:'number'}},required:['name']} },
  { name:'set_balance', description:'Установить баланс счёта вручную. account="sber" или "tbank".',
    input_schema:{type:'object',properties:{account:{type:'string',enum:['sber','tbank']},amount:{type:'number'}},required:['account','amount']} },
  { name:'close_month', description:'Закрыть текущий месяц.',
    input_schema:{type:'object',properties:{}} },
  { name:'add_fixed_cost', description:'Добавить новую постоянную трату (только имя и сумма, без категории).',
    input_schema:{type:'object',properties:{name:{type:'string'},amount:{type:'number'}},required:['name','amount']} },
  { name:'remove_fixed_cost', description:'Удалить постоянную трату по названию.',
    input_schema:{type:'object',properties:{name:{type:'string'}},required:['name']} },
  { name:'edit_fixed_cost', description:'Изменить постоянную трату: новое имя и/или сумму.',
    input_schema:{type:'object',properties:{name:{type:'string'},new_name:{type:'string'},amount:{type:'number'}},required:['name']} },
  { name:'update_loan', description:'Обновить параметры кредита (тело долга, ставку, платёж, дату окончания). Используй когда пользователь сообщает актуальные данные из банка или исправляет информацию.',
    input_schema:{type:'object',properties:{name:{type:'string',description:'Название кредита (фрагмент для поиска)'},principal:{type:'number',description:'Новое тело долга'},rate:{type:'number',description:'Новая ставка (например 0.34)'},min_payment:{type:'number',description:'Новый ежемесячный платёж'},end_date:{type:'string',description:'Дата окончания YYYY-MM-DD'}},required:['name']} },
  { name:'update_settings', description:'Изменить настройку. field: salary_net/salary_gross/ytd_gross/threshold/moment_share/margin_share/var_budget, или nominal с key=g3..g10.',
    input_schema:{type:'object',properties:{field:{type:'string'},value:{type:'number'},key:{type:'string'}},required:['field','value']} },
  { name:'update_salary', description:'Обновить оклад если изменился. Вызывай при: "зарплата теперь X", "оклад повысили до X". Пересчитывает дневную ставку и якоря.',
    input_schema:{type:'object',properties:{salary_net:{type:'number',description:'Чистый оклад (net) в рублях'},salary_gross:{type:'number',description:'Грязный оклад (gross), опционально'}},required:['salary_net']} },
  { name:'scenario_analysis', description:'Рассчитать экономику решения о покупке. Используй когда спрашивают "стоит ли купить X в кредит/рассрочку", "выгодно ли брать кредит", "лучше ли подождать бонуса". Возвращает сравнение: кредит vs наличные vs ожидание, с переплатой и рекомендацией.',
    input_schema:{type:'object',properties:{itemCost:{type:'number',description:'Стоимость покупки в рублях'},loanRate:{type:'number',description:'Годовая ставка кредита (например 0.33 для 33%)'},loanMonths:{type:'number',description:'Срок в месяцах'},expectedBonus:{type:'number',description:'Ожидаемый бонус (если есть)'},weeksUntilBonus:{type:'number',description:'Через сколько недель бонус'}},required:['itemCost','loanRate','loanMonths']} },
  { name:'suggest_early_repayment', description:'Рассчитать выгоду от досрочного погашения кредита при текущей ликвидности. Используй когда спрашивают "куда вложить свободные деньги" или проактивно.',
    input_schema:{type:'object',properties:{}} },
  { name:'record_vacation_pay',
    description:'Записать отпускные или больничные. Зачисляет на дебет СРАЗУ. Из ближайшего аванса/зп вычитается дневная ставка×кол-во дней. Вызывай когда "получил отпускные X₽ за N дней" или "больничный N дней, пришло X₽".',
    input_schema:{type:'object',properties:{
      days:{type:'number',description:'Количество дней'},
      paid_amount:{type:'number',description:'Сумма отпускных/больничных'},
      start_date:{type:'string',description:'Дата начала YYYY-MM-DD'},
      vacation_type:{type:'string',enum:['vacation','sick'],description:'Тип: отпуск или больничный'},
      part:{type:'string',enum:['advance','eom'],description:'Откуда вычитать дни: advance (аванс) или eom (ЗП конца месяца). Указывай если пользователь сказал явно.'}
    },required:['days','paid_amount']} },
  { name:'create_custom_category',
    description:'Создать кастомную категорию трат с опциональным лимитом и ключевыми словами.',
    input_schema:{type:'object',properties:{
      name:{type:'string'},
      monthly_limit:{type:'number'},
      keywords:{type:'array',items:{type:'string'}}
    },required:['name']} },
  { name:'add_keyword',
    description:'Добавить ключевое слово в кастомную категорию для автоматического распознавания.',
    input_schema:{type:'object',properties:{
      category_name:{type:'string'},
      keyword:{type:'string'}
    },required:['category_name','keyword']} },
  { name:'remove_custom_category',
    description:'Удалить кастомную категорию.',
    input_schema:{type:'object',properties:{name:{type:'string'}},required:['name']} },
  { name:'learn_mapping',
    description:'Запомнить соответствие trigger→категория. Вызывай после любой траты где определил категорию сам или пользователь подтвердил/поправил.',
    input_schema:{type:'object',properties:{
      trigger:{type:'string',description:'Слово/фраза из описания траты'},
      category:{type:'string'},
      custom_category_name:{type:'string'}
    },required:['trigger']} },
  { name:'save_correction',
    description:'Сохранить ошибку бота для обучения. Вызывай когда пользователь говорит "неверно", "ты ошибся", "не так".',
    input_schema:{type:'object',properties:{
      bot_answered:{type:'string',description:'Что ответил бот (неверно) — первые 500 символов'},
      correction:{type:'string',description:'Правильный ответ/объяснение пользователя'},
      category:{type:'string',enum:['math','context','logic','tool','formula']}
    },required:['bot_answered','correction']} },
  { name:'undo', description:'Отменить последнее изменение (откат к снапшоту).',
    input_schema:{type:'object',properties:{}} },
  { name: 'reclassify_expense',
    description: 'Изменить категорию существующих трат текущего месяца. Вызывай когда пользователь говорит "перенеси снюс в Вредные", "это вредная трата", "перенеси авиабилет во Внеплановые", "отнеси X к категории Y". ВАЖНО: категория "Внеплановые" выносит трату ЗА лимит переменных (для крупных разовых: авиабилеты, техника). Категория "Вредные расходы" для снюса/вейпа/алкоголя. Указывай keyword (слово из описания траты) и new_category.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'ключевое слово в description траты' },
        new_category: { type: 'string' },
        custom_category_name: { type: 'string' },
      },
    } },
  { name: 'update_cashflow',
    description: 'Обновить плановые суммы аванса, ЗП или бонуса в текущем месяце. Вызывай когда: пользователь поправляет цифры входов, после расчёта отпускных/больничных, при несовпадении с контекстом.',
    input_schema: {
      type: 'object',
      properties: {
        adv_amount:   { type: 'number', description: 'новая сумма аванса' },
        eom_amount:   { type: 'number', description: 'новая сумма ЗП' },
        bonus_amount: { type: 'number', description: 'новая сумма бонуса' },
      },
    } },
  { name: 'update_revenue',
    description: 'Обновить выручку и/или клиентов за прошлый или текущий месяц. Вызывай когда пользователь говорит "выручка за май была X", "скорректируй выручку", "добавь клиента за прошлый месяц". После обновления бонус следующего месяца пересчитается автоматически.',
    input_schema: { type: 'object', properties: {
      month_key: { type: 'string', description: 'YYYY-MM (необязательно, по умолчанию предыдущий месяц)' },
      revenue: { type: 'number', description: 'новая выручка за месяц' },
      clients: { type: 'object', description: 'новые клиенты {grade: count}' },
    } } },
  { name: 'add_backlog_item',
    description: 'Записать задачу/идею/баг в бэклог разработки бота. ОБЯЗАТЕЛЬНО вызывай когда пользователь говорит: "запиши в бэклог", "добавь задачу", "надо сделать", "реализуй в следующем спринте", "не хватает инструмента [X]". НИКОГДА не пиши "Записал" без реального вызова этого инструмента.',
    input_schema: {
      type: 'object',
      properties: {
        title:       { type: 'string' },
        description: { type: 'string' },
        priority:    { type: 'number', description: '1=критично 2=важно 3=улучшение' },
        category:    { type: 'string', enum: ['tool', 'bug', 'feature', 'data', 'prompt'] },
      },
      required: ['title'],
    } },
  { name: 'add_multiday_expense',
    description: 'Записать трату рассчитанную на несколько дней (продукты, товары длительного пользования). Вызывай когда пользователь говорит "купил продукты на 5 дней", "взял запас на неделю", "это на N дней".',
    input_schema: {
      type: 'object',
      properties: {
        amount:      { type: 'number' },
        category:    { type: 'string' },
        description: { type: 'string' },
        covers_days: { type: 'number', description: 'на сколько дней рассчитана трата' },
      },
      required: ['amount', 'covers_days'],
    } },
  { name:'show_balance_history',
    description:'История изменений дебетового баланса. Вызывай на: "история баланса", "как менялся дебет", "откуда деньги", "почему баланс изменился".',
    input_schema:{type:'object',properties:{limit:{type:'number',description:'Кол-во записей, по умолчанию 15'}}} },
  { name:'analyze_credit_burden',
    description:'Кредитная нагрузка в единицах рабочего дня. Вызывай на: "сколько дней работаю на банк", "кредитная нагрузка", "когда начну работать на себя", "насколько тяжелы кредиты".',
    input_schema:{type:'object',properties:{}} },
  { name:'calculate_optimal_repayment',
    description:'Оптимальная стратегия досрочного погашения из бонуса/накоплений. Вызывай на: "сколько погасить из бонуса", "куда направить квартальный бонус", "как быстрее закрыть кредиты", "стратегия погашения".',
    input_schema:{type:'object',properties:{
      available_bonus:{type:'number',description:'Сумма доступная для погашения'},
      mandatory_expenses:{type:'number',description:'Обязательные расходы периода (по умолчанию 0)'},
      safe_liquid:{type:'number',description:'Минимальная подушка (по умолчанию 50000)'},
    },required:['available_bonus']} },
  { name: 'compare_months',
    description: 'Сравнить траты текущего и прошлого месяца по категориям. Вызывай на: "как я трачу по сравнению с прошлым месяцем", "стал ли я тратить больше/меньше", "сравни месяцы".',
    input_schema: { type: 'object', properties: {} } },
  { name: 'list_backlog',
    description: 'Показать задачи бэклога разработки. Вызывай при: "что в бэклоге", "какие задачи накопились", "что планируется", "бэклог".',
    input_schema: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'done', 'all'], description: 'По умолчанию pending' } } } },
  { name: 'add_idea',
    description: 'Записать идею или пожелание в пайплайн разработки. Вызывай когда пользователь говорит: "хочу добавить X", "было бы круто если", "в следующем спринте сделай", "идея: ...", "предложение: ...". Отличие от add_backlog_item: идея — сырое пожелание, backlog — конкретная задача.',
    input_schema: { type: 'object',
      properties: {
        description: { type: 'string', description: 'Текст идеи' },
        name: { type: 'string', description: 'Краткое объяснение от бота почему важно (1 предложение)' },
        category: { type: 'string', enum: ['feature', 'bug', 'optimization', 'sprint'] },
        priority: { type: 'number', description: '1=критично, 2=нормально, 3=когда-нибудь' },
      },
      required: ['description'] } },
  { name: 'update_anchor',
    description: 'Обновить якорное значение когда пользователь подтверждает новую верную цифру. Вызывай когда пользователь говорит: "аванс теперь X", "запомни что в июле Y дней", "исправь: ЗП = Z".',
    input_schema: { type: 'object',
      properties: {
        month_key: { type: 'string', description: '2026-06, 2026-07, или global' },
        key: { type: 'string', description: 'working_days, daily_rate, advance_actual, eom_salary, forecast_end и т.п.' },
        value: { type: 'string', description: 'Новое значение' },
        formula: { type: 'string', description: 'Как посчитано (необязательно)' },
      },
      required: ['month_key', 'key', 'value'] } },
  { name: 'days_until_advance',
    description: 'Рассчитать сколько дней осталось до ближайшего аванса (15 числа). Вызывай на: "когда аванс", "сколько дней до аванса", "дней до 15", "когда придут деньги", "успею до аванса".',
    input_schema: { type: 'object', properties: {} } },
  { name: 'check_salary_pattern',
    description: 'Показать историю реальных выплат (аванс/ЗП) и средние суммы. Вызывай на: "когда обычно приходит ЗП", "сколько в среднем аванс", "история выплат", "паттерн зарплаты".',
    input_schema: { type: 'object', properties: {} } },
  { name: 'mark_card_payment',
    description: 'Записать оплату с кредитной карты (Т-Банк кредитная, Сбер кредитка, Яндекс Сплит). Вызывай когда пользователь говорит "оплатил с кредитки", "с карты Т-Банк", "Яндекс Сплитом". НЕ уменьшает debit_balance.',
    input_schema: { type: 'object', properties: {
      name: { type: 'string', description: 'Т-Банк кредитная | Сбер кредитка | Яндекс Сплит' },
      amount: { type: 'number' },
      category: { type: 'string' },
      description: { type: 'string' },
    }, required: ['name', 'amount'] } },
  { name: 'validate_context',
    description: 'Проверить актуальность данных. Вызывай при: "всё верно?", "проверь данные", "расхождение в цифрах".',
    input_schema: { type: 'object', properties: {} } },
  { name: 'forecast_after_advance',
    description: 'Прогноз после получения аванса 15-го и оплаты всех постоянных. Вызывай при: "сколько останется после аванса", "что будет с деньгами после 15-го", "прогноз до зарплаты".',
    input_schema: { type: 'object', properties: {} } },
  { name: 'semantic_search',
    description: 'Поиск похожих фактов и паттернов из памяти. Вызывай когда пользователь спрашивает что-то похожее на прошлые ошибки или паттерны.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'save_memory',
    description: 'Сохранить важный факт или паттерн в долгосрочную память. Вызывай когда пользователь говорит "запомни", "это важно", или когда выявлен устойчивый паттерн.',
    input_schema: { type: 'object', properties: {
      content: { type: 'string' },
      category: { type: 'string' },
      importance: { type: 'number', description: '1-5, где 5 критично' },
    }, required: ['content'] } },
  // ── БЛОК ПЛАНИРОВЩИК (P-1 + P-2 + P-3 habits) ──
  ...plannerTools,
  plannerSummaryTool,
]

interface ContentBlock { type:string; text?:string; id?:string; name?:string; input?:Record<string,unknown> }

// Один раунд вызова Claude с инструментами
export let _lastUsage: Record<string, number> = {}

async function callClaude(modelId: string, systemBlocks: unknown[], messages: unknown[], noTools = false) {
  // Prompt Caching: кешируем TOOLS (самый большой статичный блок)
  const toolsWithCache = [
    ...TOOLS.slice(0, -1),
    { ...TOOLS[TOOLS.length - 1], cache_control: { type: 'ephemeral' } }
  ]
  const bodyObj: Record<string, unknown> = { model:modelId, max_tokens:1500, system:systemBlocks, messages }
  // noTools=true в финализирующем запросе — модель ОБЯЗАНА дать текст, не может звать инструменты
  if (!noTools) bodyObj.tools = toolsWithCache
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'x-api-key':process.env.ANTHROPIC_API_KEY!,
      'anthropic-version':'2023-06-01',
      'anthropic-beta':'prompt-caching-2024-07-31'
    },
    body: JSON.stringify(deepCleanSurrogates(bodyObj))
  })
  const j = await res.json()
  if (j.usage) _lastUsage = j.usage
  return j
}

// Удаляет непарные суррогаты (битые эмодзи) из готового JSON — иначе Anthropic
// отклоняет весь запрос с "invalid high surrogate". Страховка на любой источник.
function stripLoneSurrogates(s: string): string {
  // Посимвольно убираем непарные суррогаты (битые эмодзи). Работает на ЛЮБОМ Node
  // (toWellFormed есть только в Node 20+; regex с суррогатами хрупок к экранированию).
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xD800 && c <= 0xDBFF) {
      const n = s.charCodeAt(i + 1)
      if (n >= 0xDC00 && n <= 0xDFFF) { out += s[i] + s[i + 1]; i++ }
      // иначе: непарный high surrogate — выбрасываем
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      // непарный low surrogate — выбрасываем
    } else {
      out += s[i]
    }
  }
  return out
}

// Рекурсивно чистит непарные суррогаты во ВСЕХ строках ДО JSON.stringify.
// Важно: stringify экранирует суррогаты в \udXXX-текст, поэтому чистить ПОСЛЕ бесполезно —
// Anthropic парсит \udXXX обратно в суррогат и отвергает запрос.
function deepCleanSurrogates(obj: unknown): unknown {
  if (typeof obj === 'string') return stripLoneSurrogates(obj)
  if (Array.isArray(obj)) return obj.map(deepCleanSurrogates)
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj as Record<string, unknown>)) {
      out[k] = deepCleanSurrogates((obj as Record<string, unknown>)[k])
    }
    return out
  }
  return obj
}

// Обработка одного инструмента — возвращает строку-результат для tool_result

// ═══════════════════════════════════════════════════════════════
// ДЕТЕРМИНИРОВАННЫЙ РАСЧЁТ — единственный источник финансовых цифр
// ═══════════════════════════════════════════════════════════════

// ── ДЕТЕРМИНИРОВАННАЯ СВОДКА КРЕДИТОВ ──
async function getLoansSummaryJson(): Promise<string> {
  return cached('loans_summary', _getLoansRaw)
}
async function _getLoansRaw(): Promise<string> {
  const s = db()
  const { data: loans } = await s.from('loans').select('name,principal,rate,min_payment,end_date,paid_month').eq('user_id', USER_ID).order('rate', { ascending: false })
  const mk2 = mk()
  const list = (loans ?? []).map((l: {name:string,principal:number,rate:number,min_payment:number,end_date:string,paid_month:string}) => {
    const principal = Math.round(Number(l.principal))
    const rate = Number(l.rate)
    const minPay = Math.round(Number(l.min_payment))
    const monthlyRate = rate / 12
    let monthsLeft = 0
    if (minPay > principal * monthlyRate) {
      monthsLeft = Math.ceil(-Math.log(1 - (principal * monthlyRate) / minPay) / Math.log(1 + monthlyRate))
    }
    const overpay = Math.max(0, minPay * monthsLeft - principal)
    return { name:l.name, principal, rate_percent:Math.round(rate*10000)/100, min_payment:minPay, end_date:l.end_date, paid_this_month:l.paid_month===mk2, months_left:monthsLeft, overpay_estimate:overpay }
  })
  return JSON.stringify({
    source:'LIVE_DB',
    loans:list,
    total_principal:list.reduce((s,l)=>s+l.principal,0),
    total_min_payment_monthly:list.reduce((s,l)=>s+l.min_payment,0),
    total_overpay_estimate:list.reduce((s,l)=>s+l.overpay_estimate,0),
  }, null, 2)
}

async function getFinancialSummaryJson(): Promise<string> {
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
    debit_sber: st.debit_sber, tbank_debit: st.tbank_debit, total_liquid: st.liquid,
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

async function handleTool(name: string, input: Record<string,unknown>): Promise<string> {
  // ── ПЛАНИРОВЩИК: перехватываем до финансового fallthrough ──
  if (PLANNER_TOOL_NAMES.has(name)) return await handlePlannerTool(name, input)
  if (name === 'get_financial_summary') return await getFinancialSummaryJson()
  // Computation tools (read-only, не пишут в БД)
  if (name === 'scenario_analysis') {
    let liqCurrent = Number(input.currentLiquid ?? 0)
    if (!liqCurrent) {
      const { data: u } = await db().from('users').select('debit_balance,tbank_debit').eq('id', USER_ID).single()
      liqCurrent = Number(u?.debit_balance ?? 0) + Number(u?.tbank_debit ?? 0)
    }
    const result = analyzeDecision({
      itemCost: Number(input.itemCost ?? 0),
      loanRate: Number(input.loanRate ?? 0.33),
      loanMonths: Number(input.loanMonths ?? 12),
      currentLiquid: liqCurrent,
      expectedBonus: input.expectedBonus != null ? Number(input.expectedBonus) : undefined,
      weeksUntilBonus: input.weeksUntilBonus != null ? Number(input.weeksUntilBonus) : undefined,
      minSafeLiquid: 10000,
    })
    return JSON.stringify({
      credit: result.creditScenario,
      cash: result.cashScenario,
      wait: result.waitScenario,
      recommendation: result.recommendation,
    })
  }
  if (name === 'suggest_early_repayment') {
    const s = db()
    const [{ data:u },{ data:loans }] = await Promise.all([
      s.from('users').select('debit_balance,tbank_debit').eq('id',USER_ID).single(),
      s.from('loans').select('name,principal,accrued_int,rate,min_payment').eq('user_id',USER_ID),
    ])
    const liquid = Number(u?.debit_balance??0) + Number(u?.tbank_debit??0)
    const suggestion = suggestEarlyRepayment(loans??[], liquid, 10000)
    if (!suggestion) return JSON.stringify({suggestion:null,reason:'Недостаточно свободных средств (< 5000₽ после подушки в 10000₽)'})
    return JSON.stringify(suggestion)
  }
  if (name === 'show_balance_history') {
    const limit = Number(input.limit ?? 15)
    const { data: hist } = await db().from('debit_history')
      .select('amount,balance_after,description,source_type,created_at')
      .eq('user_id', USER_ID)
      .order('created_at', { ascending: false })
      .limit(limit)
    return JSON.stringify(hist ?? [])
  }
  if (name === 'analyze_credit_burden') {
    const s = db()
    const [{ data: u }, { data: loans }] = await Promise.all([
      s.from('users').select('salary_net').eq('id', USER_ID).single(),
      s.from('loans').select('name,principal,rate,min_payment').eq('user_id', USER_ID),
    ])
    const salaryNet = Number(u?.salary_net ?? 121600)
    const now = new Date()
    const cbMonthStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`
    const { data: cbHols } = await s.from('ru_holidays').select('holiday_date')
      .gte('holiday_date', `${cbMonthStr}-01`).lte('holiday_date', `${cbMonthStr}-31`)
    const workingDays = computeWorkingDays(now.getFullYear(), now.getMonth() + 1,
      (cbHols ?? []).map((h: {holiday_date: string}) => String(h.holiday_date).slice(0,10)))
    const result = computeCreditBurden(
      (loans ?? []).map(l => ({ name: l.name, min_payment: Number(l.min_payment), principal: Number(l.principal), rate: Number(l.rate) })),
      salaryNet,
      workingDays
    )
    return JSON.stringify(result)
  }
  if (name === 'calculate_optimal_repayment') {
    const { data: loans } = await db().from('loans').select('name,principal,rate,min_payment').eq('user_id', USER_ID)
    const result = computeOptimalRepayment(
      (loans ?? []).map(l => ({ name: l.name, principal: Number(l.principal), rate: Number(l.rate), min_payment: Number(l.min_payment) })),
      Number(input.available_bonus ?? 0),
      Number(input.mandatory_expenses ?? 0),
      Number(input.safe_liquid ?? 50000),
    )
    return JSON.stringify(result)
  }
  if (name === 'compare_months') {
    const s = db()
    const now = new Date()
    const curMK = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const prevD = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const prevMK = `${prevD.getFullYear()}-${String(prevD.getMonth() + 1).padStart(2, '0')}`
    const [{ data: cur }, { data: prev }] = await Promise.all([
      s.from('expenses').select('category,amount').eq('user_id', USER_ID).eq('month_key', curMK),
      s.from('expenses').select('category,amount').eq('user_id', USER_ID).eq('month_key', prevMK),
    ])
    const group = (rows: { category: string; amount: number }[] | null) =>
      (rows ?? []).reduce((acc, e) => ({ ...acc, [e.category]: (acc[e.category] ?? 0) + e.amount }), {} as Record<string, number>)
    return JSON.stringify({ current: { monthKey: curMK, byCategory: group(cur) }, previous: { monthKey: prevMK, byCategory: group(prev) } })
  }
  if (name === 'list_backlog') {
    const { data: items } = await db().from('bot_backlog').select('title,description,priority,status,created_at').eq('user_id', USER_ID).eq('status', 'pending').order('priority', { ascending: true }).limit(20)
    return JSON.stringify(items ?? [])
  }
  if (name === 'validate_context') {
    const s = db()
    const mk2 = mk()
    const [{ data: u }, { data: m }, { data: anchors2 }] = await Promise.all([
      s.from('users').select('fixed_costs,salary_net').eq('id', USER_ID).single(),
      s.from('months').select('fixed_paid').eq('user_id', USER_ID).eq('month_key', mk2).maybeSingle(),
      s.from('bot_anchors').select('key,value').eq('user_id', USER_ID).eq('month_key', mk2).in('key', ['fixed_total', 'fixed_unpaid', 'working_days']),
    ])
    const fc = (u?.fixed_costs as {name:string;amount:number}[]) ?? []
    const fp = (m?.fixed_paid as Record<string,number|boolean>) ?? {}
    const realFixedTotal = fc.reduce((s,f) => s+Number(f.amount), 0)
    const realPaid = Object.keys(fp).reduce((s,i) => s+(fc[Number(i)]?Number(fc[Number(i)].amount):0), 0)
    const realUnpaid = realFixedTotal - realPaid
    const anchorMap2 = Object.fromEntries((anchors2 ?? []).map(a => [a.key, a.value]))
    const issues: string[] = []
    if (anchorMap2['fixed_total'] && Math.abs(Number(anchorMap2['fixed_total']) - realFixedTotal) > 10)
      issues.push(`fixed_total: якорь ${anchorMap2['fixed_total']}₽ ≠ факт ${realFixedTotal}₽`)
    if (anchorMap2['fixed_unpaid'] && Math.abs(Number(anchorMap2['fixed_unpaid']) - realUnpaid) > 10)
      issues.push(`fixed_unpaid: якорь ${anchorMap2['fixed_unpaid']}₽ ≠ факт ${realUnpaid}₽`)
    return issues.length ? `⚠️ Расхождения:\n${issues.join('\n')}` : '✅ Все данные актуальны'
  }

  if (name === 'forecast_after_advance') {
    const s = db()
    const mk2 = mk()
    const [{ data: u }, { data: m }, { data: anchors2 }, { data: exps }] = await Promise.all([
      s.from('users').select('debit_balance,tbank_debit,salary_net,var_budget').eq('id', USER_ID).single(),
      s.from('months').select('salary_adv_amount,fixed_paid').eq('user_id', USER_ID).eq('month_key', mk2).maybeSingle(),
      s.from('bot_anchors').select('key,value').eq('user_id', USER_ID).eq('month_key', mk2).eq('key', 'fixed_unpaid'),
      s.from('expenses').select('amount').eq('user_id', USER_ID).eq('month_key', mk2),
    ])
    const debit = Number(u?.debit_balance ?? 0) + Number(u?.tbank_debit ?? 0)
    const net = Number(u?.salary_net ?? 121600)
    const advance = Number(m?.salary_adv_amount ?? Math.round(net / 2))
    const anchorUnpaid = anchors2?.find(a => a.key === 'fixed_unpaid')?.value
    const fc = [] as {amount:number}[]
    const fp = (m?.fixed_paid as Record<string,number|boolean>) ?? {}
    const realUnpaid = anchorUnpaid ? Number(anchorUnpaid) : 0
    const varSpent = (exps ?? []).reduce((s,e) => s+Number(e.amount), 0)
    const varLeft = Math.max(0, Number(u?.var_budget ?? 40000) - varSpent)
    const afterAdvance = debit + advance
    const afterFixed = afterAdvance - realUnpaid
    const rub2 = (n: number) => Math.round(n).toLocaleString('ru-RU') + '₽'
    return `⏳ После аванса ${rub2(advance)} (15-го):\nДебет: ${rub2(debit)} → ${rub2(afterAdvance)}\nМинус постоянные неопл.: −${rub2(realUnpaid)} → ${rub2(afterFixed)}\nПеременные ещё доступно: ${rub2(varLeft)}`
  }

  if (name === 'check_salary_pattern') {
    const { data } = await db().from('salary_actuals')
      .select('payment_type,expected_amount,actual_amount,payment_date,deviation,notes')
      .eq('user_id', USER_ID)
      .order('payment_date', { ascending: false })
      .limit(12)
    if (!data?.length) return JSON.stringify({ message: 'Нет данных об историии выплат' })
    const advances = data.filter(r => r.payment_type === 'advance')
    const eoms = data.filter(r => r.payment_type === 'eom')
    const avgAdv = advances.length ? Math.round(advances.reduce((s,r)=>s+Number(r.actual_amount),0)/advances.length) : null
    const avgEom = eoms.length ? Math.round(eoms.reduce((s,r)=>s+Number(r.actual_amount),0)/eoms.length) : null
    return JSON.stringify({ records: data, avgAdvance: avgAdv, avgEom, count: data.length })
  }

  if (name === 'days_until_advance') {
    const now = new Date()
    const today = now.getDate()
    const y = now.getFullYear()
    const m = now.getMonth() + 1
    const advDay = advanceDay(y, m)
    let daysLeft: number
    let targetAdvDay: number
    let targetMonth: string
    if (today <= advDay) {
      daysLeft = advDay - today
      targetAdvDay = advDay
      targetMonth = `${y}-${String(m).padStart(2, '0')}`
    } else {
      const nextM = m === 12 ? 1 : m + 1
      const nextY = m === 12 ? y + 1 : y
      const nextAdvDay = advanceDay(nextY, nextM)
      const daysInMonth = new Date(y, m, 0).getDate()
      daysLeft = daysInMonth - today + nextAdvDay
      targetAdvDay = nextAdvDay
      targetMonth = `${nextY}-${String(nextM).padStart(2, '0')}`
    }
    const monthKey2 = mk()
    const { data: month } = await db().from('months').select('salary_adv_received,salary_adv_amount').eq('user_id', USER_ID).eq('month_key', monthKey2).maybeSingle()
    const { data: u } = await db().from('users').select('salary_net').eq('id', USER_ID).single()
    const net = Number(u?.salary_net ?? 121600)
    const advAmt = Number(month?.salary_adv_amount ?? Math.round(net / 2))
    const advReceived = !!month?.salary_adv_received
    return JSON.stringify({ daysLeft, advDay: targetAdvDay, targetMonth, advReceived, advAmt })
  }
  if (name === 'list_memories') {
    const { data } = await db().from('bot_memories')
      .select('content,category,importance,created_at')
      .eq('user_id', USER_ID)
      .order('importance', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(20)
    return JSON.stringify({ count: data?.length ?? 0, memories: data ?? [] })
  }
  if (name === 'semantic_search') {
    // Улучшенный поиск: все memories, отфильтрованные по ключевым словам + sort по importance
    const q = String(input.query ?? '').toLowerCase()
    const words = q.split(/\s+/).filter(w => w.length > 2)
    const { data: all } = await db().from('bot_memories')
      .select('content,category,importance,created_at')
      .eq('user_id', USER_ID)
      .order('importance', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(30)
    // Rank: сколько слов запроса содержит запись
    const ranked = (all ?? [])
      .map(m => ({ ...m, score: words.filter(w => m.content.toLowerCase().includes(w)).length }))
      .filter(m => m.score > 0 || words.length === 0)
      .sort((a,b) => b.score - a.score || b.importance - a.importance)
      .slice(0, 5)
    // Обновляем last_accessed для найденных
    if (ranked.length) {
      await db().from('bot_memories')
        .update({ last_accessed: new Date().toISOString() })
        .eq('user_id', USER_ID)
        .in('content', ranked.map(m => m.content))
    }
    return JSON.stringify(ranked.map(m => ({ content: m.content, category: m.category, importance: m.importance })))
  }
  // DB-writing tools
  await executeAction({ type: name, ...input } as BotAction)
  // Инвалидируем кеш после любой записи в БД — следующий getContext прочитает свежие данные
  invalidateCache('core_state', 'context', 'fin_summary', 'loans_summary')
  // Sprint 27: read-after-write — после записи перечитываем ФАКТ из БД.
  // Бот обязан цитировать эти цифры, а не свою арифметику.
  try {
    const sV = db()
    const mkV = mk()
    const [{ data: uV }, { data: cardsV }, { data: expV }] = await Promise.all([
      sV.from('users').select('debit_balance,var_budget').eq('id', USER_ID).single(),
      sV.from('cards').select('name,current_debt').eq('user_id', USER_ID),
      sV.from('expenses').select('amount').eq('user_id', USER_ID).eq('month_key', mkV),
    ])
    const varSpentV = (expV ?? []).reduce((sum: number, e: {amount: number}) => sum + Number(e.amount), 0)
    const varBudgetV = Number(uV?.var_budget ?? 45000)
    const cardsStrV = (cardsV ?? []).map((c: {name: string; current_debt: number}) =>
      `${c.name}=${Math.round(Number(c.current_debt))}₽`).join(', ')
    return `Выполнено. ФАКТ ИЗ БД ПОСЛЕ ЗАПИСИ (цитируй ТОЛЬКО эти цифры): дебет=${Math.round(Number(uV?.debit_balance ?? 0))}₽ | потрачено_за_месяц=${Math.round(varSpentV)}₽ | остаток_переменных=${Math.round(varBudgetV - varSpentV)}₽ | долги_карт: ${cardsStrV}`
  } catch (e) {
    console.error('[read-after-write]', e)
    return 'Выполнено, но верификация из БД не удалась — НЕ называй итоговые цифры, предложи пользователю спросить баланс отдельным сообщением.'
  }
}

// Цикл tool calling: модель вызывает инструменты → выполняем → возвращаем результат → финальный текст
async function runToolLoop(modelId: string, systemBlocks: unknown[], initialMessages: unknown[]): Promise<{ text:string; actionsRun:string[] }> {
  const messages = [...initialMessages]
  const actionsRun: string[] = []
  let anyToolCalled = false
  for (let round = 0; round < 6; round++) {
    const data = await callClaude(modelId, systemBlocks, messages)
    // Честная обработка ошибок API — НЕ маскируем в "Готово" (иначе невозможно понять что сломалось)
    if (data.error || !data.content) {
      console.error('[anthropic error]', JSON.stringify(data).slice(0, 500))
      const errMsg = String(data.error?.message || '')
      if (/credit balance|too low|billing|insufficient/i.test(errMsg))
        return { text: '⚠️ Закончились кредиты Anthropic API. Пополни баланс: console.anthropic.com → Plans & Billing.', actionsRun }
      if (/rate.?limit|overloaded|too many|429|529/i.test(errMsg))
        return { text: '⏳ API перегружен или лимит запросов. Попробуй через минуту.', actionsRun }
      if (/authentication|api.?key|401/i.test(errMsg))
        return { text: '🔑 Проблема с ключом API. Проверь ANTHROPIC_API_KEY в Vercel.', actionsRun }
      return { text: '⚠️ Ошибка API: ' + (errMsg || 'неизвестная ошибка').slice(0, 150), actionsRun }
    }
    const content: ContentBlock[] = data.content ?? []
    if (data.stop_reason === 'tool_use') {
      anyToolCalled = true
      const toolResults: unknown[] = []
      for (const block of content) {
        if (block.type === 'tool_use' && block.name) {
          try {
            const result = await handleTool(block.name, (block.input ?? {}) as Record<string,unknown>)
            const readOnlyTools = ['scenario_analysis','suggest_early_repayment','show_balance_history','analyze_credit_burden','calculate_optimal_repayment','compare_months','list_backlog']
            if (!readOnlyTools.includes(block.name)) {
              actionsRun.push(block.name)
            }
            toolResults.push({ type:'tool_result', tool_use_id:block.id, content: result })
          } catch (e) {
            console.error('[tool exec]', block.name, e)
            toolResults.push({ type:'tool_result', tool_use_id:block.id, content:'Ошибка: '+String(e), is_error:true })
          }
        }
      }
      messages.push({ role:'assistant', content })
      messages.push({ role:'user', content: toolResults })
      // следующий раунд — модель даст финальный текст или вызовет ещё инструменты
    } else {
      const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      if (text) return { text, actionsRun }
      // Модель завершила ход БЕЗ текста. Если инструменты не вызывались — это чистое действие.
      if (!anyToolCalled) return { text: '✅ Готово', actionsRun }
      // Иначе данные собраны, но ответ не сформулирован → выходим в финализацию ниже.
      break
    }
  }
  // ФИНАЛИЗАЦИЯ: модель собрала данные через инструменты, но не дала текст
  // (частая слабость Haiku) ИЛИ исчерпала раунды. Добивающий запрос БЕЗ tools —
  // модель не может звать инструменты, поэтому ОБЯЗАНА сформулировать текст из контекста.
  try {
    const finalData = await callClaude(modelId, systemBlocks, messages, true)
    const finalText = ((finalData.content ?? []) as ContentBlock[])
      .filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
    if (finalText) return { text: finalText, actionsRun }
  } catch (e) {
    console.error('[finalize]', e)
  }
  return { text: actionsRun.length ? '✅ Готово' : '⚠️ Не смог сформулировать ответ. Попробуй переформулировать вопрос.', actionsRun }
}

async function processWithModel(text: string, chatId: number, model: 'haiku'|'sonnet'): Promise<string> {
  _lastUserMessage = text; setLastUserMessage(_lastUserMessage)
  const needAnalysis = /проанализир|анализ трат|паттерн|на что трачу|куда уход|структур.*трат/i.test(text)
  // Принудительный финансовый контекст: данные из БД ВСЕГДА при финансовых вопросах
  const isFinancial = /дебет|бюджет|бонус|баланс|трат|потрач|осталось|доход|аванс|зп|зарплат|кредит|карт|финанс|остат|переменн|лимит|деньг|прогноз|сколько|ликвидност|сальдо|позиц/i.test(text)
  const isLoans = /кредит|долг|погаш|рефинанс|досрочн|переплат|займ|ставк/i.test(text)
  // Батч: все данные параллельно — один круговой запрос вместо трёх последовательных
  const [context, history, analysis, forcedFinData, forcedLoans] = await Promise.all([
    getContext(),
    getHistory(chatId),
    needAnalysis ? getSpendingAnalysis() : Promise.resolve(''),
    isFinancial ? getFinancialSummaryJson().catch(() => '') : Promise.resolve(''),
    isLoans ? getLoansSummaryJson().catch(() => '') : Promise.resolve(''),
  ])
  const fullContext = context + (analysis ? '\n\n' + analysis : '')
  const modelId = model === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001'
  const systemBlocks: unknown[] = [
    { type:'text', text:SYSTEM_PROMPT, cache_control:{type:'ephemeral'} },
    { type:'text', text:'\n\nКОНТЕКСТ:\n'+fullContext },
  ]
  if (forcedLoans) {
    systemBlocks.push({ type:'text', text:
      '\n\n╔══ КРЕДИТЫ ИЗ БД — ТОЛЬКО ЭТИ ЦИФРЫ ══╗\n' +
      '⚠️ Тело, ставку, переплату, остаток месяцев бери ТОЛЬКО отсюда. НЕ пересчитывай переплату сам.\n' +
      '╚═══════════════════════════════════════╝\n' + forcedLoans
    })
  }
  if (forcedFinData) {
    systemBlocks.push({ type:'text', text:
      '\n\n╔══ ДАННЫЕ ИЗ БД — ИСПОЛЬЗОВАТЬ ТОЛЬКО ЭТИ ЦИФРЫ ══╗\n' +
      '⚠️ НЕ считать самостоятельно. НЕ брать из контекста выше.\n' +
      '• БОНУС В ТЕКУЩЕМ МЕСЯЦЕ = рассчитать из prev_month (прошлый месяц) в данных ниже\n' +
      '• ПРОГНОЗ = forecast_end из данных ниже дословно\n' +
      '• ЗП = salary_eom.amount, АВАНС = salary_adv.amount\n' +
      '╚═══════════════════════════════════════════════════════╝\n' +
      forcedFinData
    })
  }
  const messages = [
    ...history.map(h => ({ role:h.role as 'user'|'assistant', content:h.content })),
    { role:'user', content:text }
  ]
  const { text: reply } = await runToolLoop(modelId, systemBlocks, messages)
  Promise.all([
    saveHistory(chatId,'user',text,'text'),
    saveHistory(chatId,'assistant',reply,'text')
  ]).catch(()=>{})
  return reply
}

function routeModel(text: string): 'haiku' | 'sonnet' {
  const sonnetTriggers = [
    /что если|сколько бонус|посчитай|гипотет|сценари|прогноз/i,
    /повышен|изменил|поменял|пересмотр|формул|порог|номинал/i,
    /полный|весь бюджет|все цифры|подробно|анализ|почему|объясни/i,
    /кварталь|квартал/i,
    /\?.*\?.*\?/,
  ]
  if (text.length > 250) return 'sonnet'
  if (sonnetTriggers.some(re => re.test(text))) return 'sonnet'
  return 'haiku'
}

export async function processMessage(text: string, chatId: number): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) return '⚠️ Добавь ANTHROPIC_API_KEY в Vercel.'
  return processWithModel(text, chatId, routeModel(text))
}

export async function processImage(fileId: string, chatId: number, caption?: string): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) return '⚠️ Нужен ANTHROPIC_API_KEY.'
  try {
    const fileRes = await fetch(`${TG}/getFile?file_id=${fileId}`)
    const { result } = await fileRes.json()
    if (!result?.file_path) return '❌ Не удалось получить файл'
    const imgRes = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${result.file_path}`)
    const buf = await imgRes.arrayBuffer()
    const base64 = Buffer.from(buf).toString('base64')
    const mime = result.file_path.endsWith('.png') ? 'image/png' : 'image/jpeg'
    const [context, history] = await Promise.all([getContext(), getHistory(chatId)])
    const userText = caption ?? 'Что на этом скрине? Если чек/трата — помоги записать (помни: подписки на сервисы = постоянные, не переменные!).'
    const systemBlocks = [
      { type:'text', text:SYSTEM_PROMPT, cache_control:{type:'ephemeral'} },
      { type:'text', text:'\n\nКОНТЕКСТ:\n'+context }
    ]
    const messages = [
      ...history.map(h=>({role:h.role as 'user'|'assistant',content:h.content})),
      {role:'user',content:[{type:'image',source:{type:'base64',media_type:mime,data:base64}},{type:'text',text:userText}]}
    ]
    const { text: reply } = await runToolLoop('claude-sonnet-4-6', systemBlocks, messages)
    Promise.all([saveHistory(chatId,'user',`[фото: ${userText}]`), saveHistory(chatId,'assistant',reply)]).catch(()=>{})
    return reply
  } catch(err) { console.error('[vision]',err); return '❌ Ошибка чтения.' }
}

export async function generateMorningBriefing(isWeekly = false): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) return '🌅 Доброе утро, Александр!'
  const context = await getContext()
  const today = new Date()
  const dateFmt = today.toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long'})
  const prompt = isWeekly
    ? `Воскресный недельный дайджест (${dateFmt}). Составь отчёт из СТРОГО 5 секций:\n1. НЕДЕЛЯ — сколько потрачено за последние 7 дней (возьми из трат), топ-1 самая крупная трата\n2. БЮДЖЕТ — сколько осталось от переменных, дневной лимит до конца месяца\n3. ВРЕДНЫЕ — сумма по вредным категориям с % от лимита (только если есть)\n4. ПЛАТЕЖИ — ближайшие кредиты/постоянные на следующей неделе\n5. 💡 СОВЕТ — одна конкретная рекомендация и мотивационная строка\nОТВЕЧАЙ кратко, вертикальными списками, без таблиц, не более 1200 символов.`
    : `Утренний дайджест (${dateFmt}). Баланс, дневной бюджет, ближайшие платежи, прогресс переменных. 8-10 строк, без таблиц.`
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY!,'anthropic-version':'2023-06-01'},
    body:JSON.stringify(deepCleanSurrogates({
      model: isWeekly ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001',
      max_tokens:800,
      system:[
        {type:'text',text:SYSTEM_PROMPT,cache_control:{type:'ephemeral'}},
        {type:'text',text:'\n\nКОНТЕКСТ:\n'+context}
      ],
      messages:[{role:'user',content:prompt}]
    }))
  })
  const data = await res.json()
  return data.content?.[0]?.text ?? '🌅 Доброе утро!'
}

export async function transcribeVoice(fileId: string): Promise<string|null> {
  const groqKey = process.env.GROQ_API_KEY, openaiKey = process.env.OPENAI_API_KEY
  if (!groqKey && !openaiKey) return null
  try {
    const fileRes = await fetch(`${TG}/getFile?file_id=${fileId}`)
    const { result } = await fileRes.json()
    if (!result?.file_path) return null
    const audioRes = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${result.file_path}`)
    const buf = await audioRes.arrayBuffer()
    const form = new FormData()
    form.append('file', new Blob([buf],{type:'audio/ogg'}),'voice.ogg')
    form.append('model', groqKey ? 'whisper-large-v3-turbo' : 'whisper-1')
    form.append('language','ru')
    const whisperRes = await fetch(
      groqKey ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions',
      {method:'POST',headers:{'Authorization':`Bearer ${groqKey??openaiKey}`},body:form}
    )
    const { text } = await whisperRes.json()
    return text ?? null
  } catch { return null }
}

export async function sendTelegramWithButtons(
  chatId: number,
  text: string,
  inlineKeyboard: Array<Array<{ text: string; callback_data: string }>>
): Promise<void> {
  const clean = text.replace(/```[\s\S]*?```/g, '').trim()
  await fetch(`${TG}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: clean,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: inlineKeyboard },
    }),
  })
}

export async function sendTelegram(chatId: number, text: string): Promise<void> {
  // Убираем code blocks и таблицы
  const clean = text.replace(/```[\s\S]*?```/g,'').replace(/\|/g, '').trim()
  const chunks = splitMsg(clean, 3800)
  for (const chunk of chunks) {
    const res = await fetch(`${TG}/sendMessage`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:chatId,text:chunk,parse_mode:'Markdown',disable_web_page_preview:true})
    })
    const json = await res.json()
    if (!json.ok) {
      await fetch(`${TG}/sendMessage`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({chat_id:chatId,text:chunk.replace(/[*_`]/g,''),disable_web_page_preview:true})
      })
    }
  }
}

function splitMsg(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const parts: string[] = []
  let i = 0
  while (i < text.length) { parts.push(text.slice(i, i+limit)); i += limit }
  return parts
}
