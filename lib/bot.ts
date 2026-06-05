/**
 * Finance Cockpit Bot — v7
 * Жёсткий мобильный формат + надёжный парсер ACTION + квартальный бонус
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { analyzeDecision, suggestEarlyRepayment, computeWorkingDays, computeVacationAdjustment, computeCreditBurden, computeOptimalRepayment } from './calc'

const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'
const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}
function mk(): string { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}` }
function rub(n: number): string { return Math.round(n).toLocaleString('ru-RU')+' ₽' }
function pct(a: number, b: number): number { return b>0 ? Math.round(a/b*100) : 0 }
function quarterOf(m: number): number { return Math.ceil(m/3) }

// День аванса: 15-е если рабочий, иначе последний рабочий день перед 15-м
function advanceDay(y: number, m: number): number {
  const d = new Date(y, m-1, 15)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate()-1)
  return d.getDate()
}
// Последний рабочий день месяца (для зп+бонуса)
function lastWorkingDayOfMonth(y: number, m: number): number {
  const d = new Date(y, m, 0)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate()-1)
  return d.getDate()
}

export async function getHistory(chatId: number) {
  const { data } = await db().from('bot_messages').select('role,content').eq('chat_id', chatId).order('created_at', { ascending: false }).limit(8)
  return (data ?? []).reverse()
}
export async function saveHistory(chatId: number, role: 'user'|'assistant', content: string) {
  await db().from('bot_messages').insert({ chat_id: chatId, user_id: USER_ID, role, content }).then(()=>{})
}
export async function storeChatId(chatId: number) {
  await db().from('users').update({ telegram_chat_id: chatId }).eq('id', USER_ID)
}

async function snap(label: string) {
  const s = db()
  const [us,mo,lo,ca,go,ex,ie] = await Promise.all([
    s.from('users').select('*').eq('id',USER_ID).single(),
    s.from('months').select('*').eq('user_id',USER_ID),
    s.from('loans').select('*').eq('user_id',USER_ID),
    s.from('cards').select('*').eq('user_id',USER_ID),
    s.from('goals').select('*').eq('user_id',USER_ID),
    s.from('expenses').select('*').eq('user_id',USER_ID),
    s.from('income_events').select('*').eq('user_id',USER_ID),
  ])
  const state = {users:us.data,months:mo.data??[],loans:lo.data??[],cards:ca.data??[],goals:go.data??[],expenses:ex.data??[],income_events:ie.data??[]}
  await s.from('undo_snapshots').insert({user_id:USER_ID,description:`[бот] ${label}`,snapshot:state})
  const { data:all } = await s.from('undo_snapshots').select('id').eq('user_id',USER_ID).order('created_at',{ascending:false})
  if (all && all.length>15) await s.from('undo_snapshots').delete().in('id',all.slice(15).map((r:{id:string})=>r.id))
}

// ── Полный контекст с квартальной аналитикой ─────────────────────────────
export async function getContext(): Promise<string> {
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
    supabase.from('goals').select('id,name,amount,month_key,purchased').eq('user_id',USER_ID).eq('purchased',false).limit(6),
    supabase.from('expenses').select('id,category,amount,description,expense_date').eq('user_id',USER_ID).eq('month_key',monthKey).order('created_at',{ascending:false}).limit(5),
    supabase.from('months').select('month_key,clients,revenue').eq('user_id',USER_ID).gte('month_key',qStartKey).lte('month_key',qEndKey),
    supabase.from('cards').select('name,card_limit,current_debt').eq('user_id',USER_ID).order('sort_order'),
    supabase.from('income_events').select('event_date,description,amount').eq('user_id',USER_ID).eq('month_key',monthKey),
    supabase.from('custom_categories').select('id,name,monthly_limit,alert_at_percent').eq('user_id',USER_ID),
    supabase.from('bot_corrections').select('correction,category,created_at').eq('user_id',USER_ID).order('created_at',{ascending:false}).limit(10),
    supabase.from('ru_holidays').select('holiday_date').gte('holiday_date',`${now.getFullYear()}-${String(curMonth).padStart(2,'0')}-01`).lte('holiday_date',`${now.getFullYear()}-${String(curMonth).padStart(2,'0')}-31`),
    supabase.from('expenses').select('amount,category').eq('user_id', USER_ID).eq('month_key', prevMK),
    supabase.from('bot_anchors').select('month_key,key,value,formula').eq('user_id',USER_ID).in('month_key',[monthKey,nextMonthKey,'global']).order('month_key'),
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
      for (const r of rows) {
        lines.push(`  ${r.key}: ${r.value}${r.formula ? ` (${r.formula})` : ''}`)
      }
    }
    return lines.join('\n') + '\n'
  }
  const anchorSection = buildAnchorSection()

  // Брокерский портфель из якорей (broker_* ключи глобальные)
  const brokerAnchorRows = Object.values(anchorMap['global'] ?? {}).filter(a => a.key.startsWith('broker_'))
  const brokerSection = brokerAnchorRows.length
    ? `\n📈 БРОКЕРСКИЙ ПОРТФЕЛЬ:\n${brokerAnchorRows.map(a => `  ${a.key}: ${a.value}${a.formula ? ` (${a.formula})` : ''}`).join('\n')}\n`
    : ''

  const debitSber = Number(user.debit_balance ?? 0)
  const debitTbank = Number(user.tbank_debit ?? 0)
  const liquid = debitSber + debitTbank

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
  const varSpent = (expenses ?? []).reduce((s,e) => s+Number(e.amount), 0)
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
  const projEndComputed = liquid + incomingTotal - pendingLoanPayments - fixedUnpaid - varLeft
  const anchorForecast = getAnchor(monthKey, 'forecast_end')
  if (anchorForecast && Math.abs(projEndComputed - Number(anchorForecast)) > 100) {
    console.error('[ANCHOR MISMATCH] forecast computed:', projEndComputed, 'anchor:', anchorForecast)
  }
  const projEnd = anchorForecast ? Number(anchorForecast) : projEndComputed
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
  const fixedLines = fixedCosts.map((f,i) => `  • ${f.name}${f.day?` (${f.day} числа)`:''}: ${rub(f.amount)} ${fixedPaid[String(i)] ? '✅ оплачено' : '⏳'}`).join('\n')
  const goalLines = (goals ?? []).map(g => `  • ${g.name}: ${rub(Number(g.amount))} ${g.month_key ? '('+g.month_key+')' : '(накопление)'}`).join('\n') || '  (нет)'
  const loanLines = (loans ?? []).map(l => {
    const total = Number(l.principal) + Number(l.accrued_int)
    const paid = l.paid_month === monthKey ? '✅' : `⏳ (посл. платёж: ${l.paid_month ?? 'нет'})`
    let suffix = ''
    if (l.end_date) {
      const endD = new Date(l.end_date)
      const mLeft = Math.max(0, (endD.getFullYear() - now.getFullYear()) * 12 + (endD.getMonth() - now.getMonth()))
      suffix = ` / осталось ${mLeft} мес. до ${l.end_date}`
    }
    return `  • ${l.name} [аннуитет]: ${rub(total)} @ ${(Number(l.rate)*100).toFixed(2)}% — ${rub(Number(l.min_payment))}/мес ${paid}${suffix}`
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
  const expensesByCategory: Record<string, number> = {}
  for (const e of expenses ?? []) {
    const cat = e.category ?? 'Прочее'
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

  return `${anchorSection}${brokerSection}${calendarSection}
=== ФИНАНСОВЫЙ КОНТЕКСТ ===
ДАТА: ${now.toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}
МЕСЯЦ: ${monthKey} (день ${today} из ${daysInMonth}, осталось ${daysLeft} дней)
КВАРТАЛ: Q${curQuarter} (${qStartKey}…${qEndKey})

=== ГОТОВЫЕ ЦИФРЫ — НЕ ПЕРЕСЧИТЫВАЙ САМ ===

БАЛАНС:
  Дебет Сбер: ${rub(debitSber)}
  Т-Банк дебет: ${rub(debitTbank)}
  ЛИКВИДНОСТЬ ИТОГО: ${rub(liquid)}

КРЕДИТНЫЕ КАРТЫ:
${cardLines}

ПЕРЕМЕННЫЕ ТРАТЫ:
  Лимит: ${rub(varBudget)} (выставлен пользователем вручную)
  Потрачено: ${rub(varSpent)} (${pct(varSpent,varBudget)}%)
  Осталось: ${rub(varLeft)}
  Дневной бюджет: ${rub(dailyBudget)}/день  [формула: осталось ÷ дней до конца месяца]
${varComparison ? `  Vs прошлый месяц: ${varComparison}\n` : ''}${multidayReserved > 0 ? `  Зарезервировано под мультидневные: ${rub(multidayReserved)} (ещё не "сожжено")\n  Свободно на сегодня: ${rub(Math.max(0, varLeft - multidayReserved))}\n` : ''}

=== КЕШФЛОУ ИЮНЯ ===
ВХОДЫ (всего ожидается ${rub(incomingTotal)}):
  Стипендия ${recurringIncomes.find(r=>r.name==='Стипендия') && today<=11 ? `⏳ ${rub(5900)} (11-го)` : '✅/нет'}
  Аванс ${advReceived?'✅ получен':`⏳ ${rub(advAmount)} (${advDay}-го)`}
  ЗП ${eomReceived?'✅':`⏳ ${rub(eomAmount)}`} + Бонус ${eomReceived?'✅':`⏳ ${rub(bonusAmount)}`} (${eomDay}-го, посл. раб. день месяца)

${salaryAdjustments.length > 0 ? `\nКОРРЕКТИРОВКИ ЗП:\n${salaryAdjustments.map((a: SalaryAdjustment) => {
  const adj = computeVacationAdjustment(a.days, a.paid_amount, salaryNet, workingDaysInMonth)
  return `  • ${a.type==='sick'?'больничный':'отпуск'} ${a.days}д: получено ${rub(a.paid_amount)}, вычтено из ${a.deduct_from==='advance'?'аванса':'зп'}: ${rub(a.deduct)}, потеря: ${rub(adj.actualLoss)}`
}).join('\n')}\n` : ''}ВЫХОДЫ:
  Кредиты неоплаченные: ${rub(pendingLoanPayments)} [платёж 4 кредитов]
  Постоянные неоплаченные: ${rub(fixedUnpaid)} из ${rub(fixedTotal)}
  Переменные ещё доступно до лимита: ${rub(varLeft)}
  ИТОГО к списанию: ${rub(pendingLoanPayments + fixedUnpaid + varLeft)}

ПЛАНОВЫЕ ПОКУПКИ ИЮНЯ (цели на месяц, ещё не куплены):
${plannedPurchases.length ? plannedPurchases.map(g=>`  • ${g.name}: ${rub(Number(g.amount))}`).join('\n')+`\n  ИТОГО плановых: ${rub(plannedTotal)}` : '  (нет запланированных покупок)'}

ПРОГНОЗ ОСТАТКА К 30-го ИЮНЯ: ${rub(projEnd)}
  [формула: ликвидность ${rub(liquid)} + входы ${rub(incomingTotal)} − кредиты ${rub(pendingLoanPayments)} − постоянные ${rub(fixedUnpaid)} − переменные до лимита ${rub(varLeft)}]
ПОСЛЕ ПЛАНОВЫХ ПОКУПОК (−${rub(plannedTotal)}): ${rub(projEndAfterPlanned)}

=== ПРОГНОЗ СЛЕДУЮЩЕГО МЕСЯЦА (${nextMK}) ===
  Стартовая ликвидность: ${rub(projEnd)} (= прогноз конца ${monthKey})
  Входы: Аванс ⏳ ${rub(advAmount)} (${nextAdvDay}-го) + ЗП ⏳ ${rub(eomAmount)} (${nextEomDay}-го) + Бонус за ${monthKey}: ${rub(bonusJulNet)} + Повтор. ${rub(nextRecurringTotal)}${nextQBonus > 0 ? ` + Квартальный Q: ${rub(nextQBonus)}` : ''}
  Выходы: Кредиты ${rub(totalMonthlyPayment)} + Постоянные ${rub(fixedTotal)} + Переменные до лимита ${rub(varBudget)}
  Прогноз остатка к концу ${nextMK}: ${rub(nextProjEnd)}
  [формула: ${rub(projEnd)} + ${rub(nextIncoming)} − ${rub(totalMonthlyPayment)} − ${rub(fixedTotal)} − ${rub(varBudget)}]

=== КРЕДИТЫ (всего ${rub(totalDebt)}, платёж ${rub(totalMonthlyPayment)}/мес) ===
${loanLines}

=== ПОСТОЯННЫЕ (всего ${rub(fixedTotal)}, оплачено ${rub(fixedPaidSum)}) ===
${fixedLines}

=== РЕГУЛЯРНЫЕ ДОХОДЫ ===
${recurringLines}

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
export const SYSTEM_PROMPT = `╔═══════════════════════════════════════╗
║  ПРАВИЛО №0 — АБСОЛЮТНЫЙ ПРИОРИТЕТ  ║
╚═══════════════════════════════════════╝

Всё что находится в секции ЯКОРЯ контекста — ЕСТЬ ФИНАЛЬНАЯ ИСТИНА.
КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО:
  ✗ Пересчитывать значения из секции ЯКОРЯ
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

Ты — финансовый ассистент Александра в Telegram. Александр работает в АТОН (продажи инвестиционных продуктов).

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

ОТВЕТ НА "ПОЛНЫЙ БЮДЖЕТ" — ОБЯЗАТЕЛЬНАЯ СТРУКТУРА:
Когда спрашивают полный бюджет/все цифры — ВСЕГДА включай ВСЕ разделы:
1. 💰 Ликвидность (дебет Сбер + Т-Банк)
2. 💳 Кредитные карты (лимиты и долги) — НЕ ЗАБЫВАЙ
3. 📥 Входы с точными датами (стипендия 11-го, аванс, зп+бонус)
4. 📤 Выходы (кредиты, постоянные, переменные)
5. 🎯 Плановые покупки месяца — НЕ ЗАБЫВАЙ (из раздела ПЛАНОВЫЕ ПОКУПКИ)
6. 🏁 Прогноз остатка + остаток ПОСЛЕ плановых покупок
7. Формула расчёта одной строкой
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
Если пользователь говорит "неверно", "ты ошибся", "не так", "это неправильно", "ошибка", "галлюцинируешь", "неправильно"
И объясняет что именно не так → вызови save_correction немедленно, ДО ответа на поправку.
Поле bot_answered = твой предыдущий ответ (первые 400 символов).
Поле correction = суть поправки пользователя.
Поле category: 'math' если ошибка в цифрах, 'context' если перепутал факты, 'logic' если логическая ошибка, 'tool' если не вызвал нужный инструмент, 'formula' если неверная формула расчёта.
Без сохранения ошибки — она повторится.

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
При вопросах о портфеле — берёт данные из якорей broker_* дословно.`

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
}

// ── НАДЁЖНЫЙ ПАРСЕР ACTION ─────────────────────────────────────────────────
function extractActions(text: string): { actions: BotAction[], cleanText: string } {
  const actions: BotAction[] = []
  let cleanText = text
  // Ищем все ACTION:{...} где угодно в тексте
  const regex = /ACTION\s*:\s*(\{[^\n]*?\})/g
  const matches = Array.from(text.matchAll(regex))
  
  for (const m of matches) {
    try {
      // Чиним частые ошибки: addexpense → add_expense, removefixedcost → remove_fixed_cost
      const fixed = m[1]
        .replace(/"addexpense"/g,'"add_expense"').replace(/"deleteexpense"/g,'"delete_expense"')
        .replace(/"addclient"/g,'"add_client"').replace(/"addgoal"/g,'"add_goal"')
        .replace(/"markgoalbought"/g,'"mark_goal_bought"').replace(/"marksalary"/g,'"mark_salary"')
        .replace(/"marksinglefixed"/g,'"mark_single_fixed"').replace(/"markfixedpaid"/g,'"mark_fixed_paid"')
        .replace(/"markloanpaid"/g,'"mark_loan_paid"').replace(/"earlyrepay"/g,'"early_repay"')
        .replace(/"addincomeevent"/g,'"add_income_event"').replace(/"setbalance"/g,'"set_balance"')
        .replace(/"closemonth"/g,'"close_month"').replace(/"updatesettings"/g,'"update_settings"')
        .replace(/"addfixedcost"/g,'"add_fixed_cost"').replace(/"removefixedcost"/g,'"remove_fixed_cost"')
        .replace(/"editfixedcost"/g,'"edit_fixed_cost"')
      actions.push(JSON.parse(fixed))
      cleanText = cleanText.replace(m[0], '')
    } catch (e) {
      console.error('[Action parse]', m[1], e)
      cleanText = cleanText.replace(m[0], '') // убрать всё равно, чтобы пользователь не видел мусор
    }
  }
  return { actions, cleanText: cleanText.replace(/\n{3,}/g, '\n\n').trim() }
}

// ── Запись истории изменений дебетового баланса ────────────────────────────
async function recordDebitChange(
  s: SupabaseClient,
  prevBalance: number,
  newBalance: number,
  description: string,
  sourceType: string
): Promise<void> {
  await s.from('debit_history').insert({
    user_id: USER_ID,
    amount: Math.round((newBalance - prevBalance) * 100) / 100,
    balance_after: Math.round(newBalance * 100) / 100,
    description,
    source_type: sourceType,
  }).then(() => {})
}

// ── Выполнение действий ───────────────────────────────────────────────────
export async function executeAction(action: BotAction): Promise<void> {
  const s = db()
  const monthKey = mk()

  const snapLabel: Record<string,string> = {
    add_expense:'трата',delete_expense:'удаление',add_client:'клиент',add_goal:'цель',
    mark_goal_bought:'покупка',mark_salary:'зарплата',mark_single_fixed:'постоянная',
    mark_fixed_paid:'все постоянные',mark_loan_paid:'кредит',early_repay:'досрочное',
    add_income_event:'доход',set_balance:'баланс',close_month:'закрытие',
    mark_recurring_received:'регулярный доход',
    update_settings:'настройки',add_fixed_cost:'+постоянная',
    remove_fixed_cost:'-постоянная',edit_fixed_cost:'правка',update_loan:'обновление кредита',undo:'отмена',
    record_vacation_pay:'отпускные', create_custom_category:'новая категория',
    add_keyword:'ключевое слово', remove_custom_category:'удал. категории',
    learn_mapping:'обучение', save_correction:'коррекция',
    reclassify_expense:'переклассификация', update_cashflow:'кешфлоу',
    add_backlog_item:'бэклог', add_multiday_expense:'мультидневная трата',
  }
  if (snapLabel[action.type]) await snap(snapLabel[action.type])

  // Input validation — защита от некорректных данных
  const VALID_GRADES = ['g3','g4','g56','g78','g9','g10']
  const VALID_CATEGORIES = ['Еда и кафе','Транспорт','Здоровье','Развлечения','Одежда','Инвестиции','Обучение и ИИ','Прочее']
  const VALID_SETTINGS = ['salary_net','salary_gross','ytd_gross','threshold','moment_share','margin_share','var_budget']
  function sanitizeStr(s: string | undefined, maxLen = 500): string | undefined {
    return s ? s.replace(/[<>'"]/g, '').substring(0, maxLen) : s
  }
  if (action.amount != null && (isNaN(action.amount) || action.amount < 0 || action.amount > 10_000_000)) return
  if (action.type === 'add_expense') {
    action.description = sanitizeStr(action.description)
    if (action.category && !VALID_CATEGORIES.includes(action.category)) action.category = 'Прочее'
  }
  if (action.type === 'add_client' && action.grade && !VALID_GRADES.includes(action.grade)) return
  if (action.type === 'update_settings') {
    if (action.field && !VALID_SETTINGS.includes(action.field) && action.field !== 'nominal') return
    if (action.value != null && (isNaN(Number(action.value)) || !isFinite(Number(action.value)))) return
  }
  action.name = sanitizeStr(action.name) as string | undefined
  action.description = sanitizeStr(action.description)

  if (action.type === 'add_expense' && action.amount) {
    await s.from('expenses').insert({user_id:USER_ID,month_key:monthKey,expense_date:new Date().toISOString().split('T')[0],category:action.category??'Прочее',amount:Math.round(action.amount),description:action.description??null,source_type:'debit'})
    const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
    const prevBal = Number(u?.debit_balance ?? 0)
    const newBal = Math.round((prevBal - action.amount) * 100) / 100
    await s.from('users').update({debit_balance:newBal,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
    await recordDebitChange(s, prevBal, newBal, `Трата: ${action.description ?? action.category}`, 'expense')
  }

  if (action.type === 'delete_expense') {
    let exp
    if (!action.id || action.id === 'last') {
      const { data } = await s.from('expenses').select('id,amount').eq('user_id',USER_ID).eq('month_key',monthKey).order('created_at',{ascending:false}).limit(1).maybeSingle()
      exp = data
    } else {
      const { data } = await s.from('expenses').select('id,amount').eq('user_id',USER_ID).ilike('id',`%${action.id}%`).maybeSingle()
      exp = data
    }
    if (exp) {
      await s.from('expenses').delete().eq('id',exp.id)
      const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
      const prevBal = Number(u?.debit_balance ?? 0)
      const newBal = Math.round((prevBal + Number(exp.amount)) * 100) / 100
      await s.from('users').update({debit_balance:newBal,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
      await recordDebitChange(s, prevBal, newBal, `Удаление траты`, 'expense_delete')
    }
  }

  if (action.type === 'add_client' && action.grade) {
    const { data:month } = await s.from('months').select('clients,revenue').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
    const cur = (month?.clients as Record<string,number>) ?? {}
    const clients = {...cur, [action.grade]:(cur[action.grade]??0)+1}
    const newRev = Number(month?.revenue??41666) + (action.revenue??0)
    month ? await s.from('months').update({clients,revenue:newRev}).eq('user_id',USER_ID).eq('month_key',monthKey)
         : await s.from('months').insert({user_id:USER_ID,month_key:monthKey,clients,revenue:newRev})
  }

  if (action.type === 'add_goal' && action.name && action.amount) {
    await s.from('goals').insert({user_id:USER_ID,name:action.name,amount:Math.round(action.amount),month_key:action.month_key??null,sort_order:99})
  }

  if (action.type === 'mark_goal_bought' && action.name) {
    const { data:goal } = await s.from('goals').select('id,amount').eq('user_id',USER_ID).ilike('name',`%${action.name}%`).maybeSingle()
    if (goal) {
      await s.from('goals').update({purchased:true,purchased_at:new Date().toISOString().split('T')[0]}).eq('id',goal.id)
      const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
      await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)-Number(goal.amount))*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
    }
  }

  if (action.type === 'mark_salary') {
    const { data:u } = await s.from('users').select('debit_balance,salary_net').eq('id',USER_ID).single()
    const { data:month } = await s.from('months').select('*').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
    const net = Number(u?.salary_net??121600)
    if (action.part === 'advance') {
      const advAmt = Number(month?.salary_adv_amount??Math.round(net/2))
      const prevBal = Number(u?.debit_balance??0)
      const newBal = Math.round((prevBal+advAmt)*100)/100
      await s.from('months').update({salary_adv_received:true,salary_adv_amount:advAmt}).eq('user_id',USER_ID).eq('month_key',monthKey)
      await s.from('users').update({debit_balance:newBal,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
      await recordDebitChange(s, prevBal, newBal, `Аванс`, 'salary')
    }
    if (action.part === 'eom') {
      const advAmt = Number(month?.salary_adv_amount??Math.round(net/2))
      const eomSalary = Number(month?.salary_eom_amount??net-advAmt)
      const bonusAmt = Number(month?.bonus_amount??0)
      const total = eomSalary + bonusAmt
      const prevBal = Number(u?.debit_balance??0)
      const newBal = Math.round((prevBal+total)*100)/100
      await s.from('months').update({salary_eom_received:true,salary_eom_amount:eomSalary}).eq('user_id',USER_ID).eq('month_key',monthKey)
      await s.from('users').update({debit_balance:newBal,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
      await recordDebitChange(s, prevBal, newBal, `ЗП + бонус`, 'salary')
      // Update YTD gross
      const { data: u3 } = await s.from('users').select('salary_gross,ytd_gross').eq('id', USER_ID).single()
      const newYtd = Number(u3?.ytd_gross ?? 0) + Number(u3?.salary_gross ?? 0)
      await s.from('users').update({ ytd_gross: newYtd }).eq('id', USER_ID)
    }
  }

  if (action.type === 'mark_single_fixed' && action.name) {
    const { data:u } = await s.from('users').select('debit_balance,fixed_costs').eq('id',USER_ID).single()
    const { data:month } = await s.from('months').select('fixed_paid').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
    const fc = (u?.fixed_costs as {name:string;amount:number}[]) ?? []
    const idx = fc.findIndex(f => f.name.toLowerCase().includes((action.name??'').toLowerCase()))
    if (idx >= 0) {
      const fp = (month?.fixed_paid as Record<string,number|boolean>) ?? {}
      if (!fp[String(idx)]) {
        const amount = action.amount ?? fc[idx].amount
        const prevBal = Number(u?.debit_balance??0)
        const newBal = Math.round((prevBal - amount)*100)/100
        await s.from('months').update({fixed_paid:{...fp,[String(idx)]:amount}}).eq('user_id',USER_ID).eq('month_key',monthKey)
        await s.from('users').update({debit_balance:newBal,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
        await recordDebitChange(s, prevBal, newBal, `Постоянная: ${fc[idx].name}`, 'fixed')
      }
    }
  }

  if (action.type === 'mark_fixed_paid') {
    const { data:u } = await s.from('users').select('debit_balance,fixed_costs').eq('id',USER_ID).single()
    const { data:month } = await s.from('months').select('fixed_paid').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
    const fc = (u?.fixed_costs as {name:string;amount:number}[]) ?? []
    const fp = (month?.fixed_paid as Record<string,number|boolean>) ?? {}
    const newFp: Record<string,number> = {}
    let total = 0
    fc.forEach((f,i) => { if (!fp[String(i)]) { newFp[String(i)]=f.amount; total+=f.amount } })
    if (total > 0) {
      const prevBal = Number(u?.debit_balance??0)
      const newBal = Math.round((prevBal-total)*100)/100
      await s.from('months').update({fixed_paid:{...fp,...newFp}}).eq('user_id',USER_ID).eq('month_key',monthKey)
      await s.from('users').update({debit_balance:newBal,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
      await recordDebitChange(s, prevBal, newBal, `Все постоянные`, 'fixed')
    }
  }

  if (action.type === 'mark_loan_paid' && action.name) {
    const { data:loan } = await s.from('loans').select('*').eq('user_id',USER_ID).ilike('name',`%${action.name}%`).maybeSingle()
    if (loan && loan.paid_month !== monthKey) {
      const pay = Number(loan.min_payment)
      const toInt = Math.min(pay, Number(loan.accrued_int))
      const toPrincipal = pay - toInt
      await s.from('loans').update({accrued_int:Number(loan.accrued_int)-toInt,principal:Math.max(0,Number(loan.principal)-toPrincipal),paid_month:monthKey,last_pay_principal:toPrincipal,last_pay_interest:toInt}).eq('id',loan.id)
      const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
      const prevBal = Number(u?.debit_balance??0)
      const newBal = Math.round((prevBal-pay)*100)/100
      await s.from('users').update({debit_balance:newBal,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
      await recordDebitChange(s, prevBal, newBal, `Кредит: ${loan.name}`, 'loan')
    }
  }

  if (action.type === 'early_repay' && action.name && action.amount) {
    const { data:loan } = await s.from('loans').select('*').eq('user_id',USER_ID).ilike('name',`%${action.name}%`).maybeSingle()
    if (loan) {
      const newPrincipal = Math.max(0, Number(loan.principal) - action.amount)
      const ratio = Number(loan.principal)>0 ? newPrincipal/Number(loan.principal) : 0
      const newPayment = Math.round(Number(loan.min_payment)*ratio*100)/100
      await s.from('loans').update({principal:newPrincipal,min_payment:newPayment}).eq('id',loan.id)
      const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
      const prevBal = Number(u?.debit_balance??0)
      const newBal = Math.round((prevBal-action.amount)*100)/100
      await s.from('users').update({debit_balance:newBal,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
      await recordDebitChange(s, prevBal, newBal, `Досрочное: ${loan.name}`, 'loan')
    }
  }

  if (action.type === 'add_income_event' && action.amount) {
    await s.from('income_events').insert({user_id:USER_ID,month_key:monthKey,event_date:new Date().toISOString().split('T')[0],event_type:'other',description:action.description??'Доход',amount:Math.round(action.amount),to_debit:true})
    const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
    const prevBal = Number(u?.debit_balance??0)
    const newBal = Math.round((prevBal+action.amount)*100)/100
    await s.from('users').update({debit_balance:newBal,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
    await recordDebitChange(s, prevBal, newBal, action.description ?? 'Доход', 'income')
  }

  // Получена регулярная выплата (стипендия и т.п.): зачислить + пометить чтобы не дублировать в прогнозе
  if (action.type === 'mark_recurring_received' && action.name) {
    const { data:u } = await s.from('users').select('debit_balance,recurring_incomes').eq('id',USER_ID).single()
    const recurring = (u?.recurring_incomes as {name:string;amount:number;day:number}[]) ?? []
    const item = recurring.find(r => r.name.toLowerCase().includes((action.name??'').toLowerCase()))
    const amount = action.amount ?? item?.amount ?? 0
    if (amount > 0) {
      // income_event для истории
      await s.from('income_events').insert({user_id:USER_ID,month_key:monthKey,event_date:new Date().toISOString().split('T')[0],event_type:'recurring',description:item?.name??action.name,amount:Math.round(amount),to_debit:true})
      // зачисление на дебет
      const prevBalR = Number(u?.debit_balance??0)
      const newBalR = Math.round((prevBalR+amount)*100)/100
      await s.from('users').update({debit_balance:newBalR,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
      await recordDebitChange(s, prevBalR, newBalR, action.name ?? item?.name ?? 'Регулярный доход', 'income')
      // пометка received (чтобы forecast не считал ещё раз)
      const { data:month } = await s.from('months').select('recurring_received').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
      const received = (month?.recurring_received as string[]) ?? []
      if (!received.includes(item?.name??action.name)) {
        received.push(item?.name??action.name)
        const { data:exists } = await s.from('months').select('month_key').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
        exists ? await s.from('months').update({recurring_received:received}).eq('user_id',USER_ID).eq('month_key',monthKey)
               : await s.from('months').insert({user_id:USER_ID,month_key:monthKey,recurring_received:received})
      }
    }
  }

  if (action.type === 'set_balance' && action.account && action.amount != null) {
    const field = action.account === 'sber' ? 'debit_balance' : 'tbank_debit'
    const { data:uBal } = await s.from('users').select('debit_balance,tbank_debit').eq('id',USER_ID).single()
    const prevBal = Number(action.account === 'sber' ? uBal?.debit_balance : uBal?.tbank_debit ?? 0)
    await s.from('users').update({[field]:action.amount,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
    await recordDebitChange(s, prevBal, Number(action.amount), `Установка баланса (${action.account})`, 'manual')
  }

  if (action.type === 'close_month') {
    await s.from('months').update({closed:true}).eq('user_id',USER_ID).eq('month_key',monthKey)
  }

  if (action.type === 'add_fixed_cost' && action.name && action.amount) {
    const { data:u } = await s.from('users').select('fixed_costs').eq('id',USER_ID).single()
    const fc = (u?.fixed_costs as {name:string;amount:number}[]) ?? []
    fc.push({name:action.name, amount:Math.round(action.amount)})
    await s.from('users').update({fixed_costs:fc}).eq('id',USER_ID)
  }

  if (action.type === 'remove_fixed_cost' && action.name) {
    const { data:u } = await s.from('users').select('fixed_costs').eq('id',USER_ID).single()
    const fc = (u?.fixed_costs as {name:string;amount:number}[]) ?? []
    const filtered = fc.filter(f => !f.name.toLowerCase().includes((action.name??'').toLowerCase()))
    await s.from('users').update({fixed_costs:filtered}).eq('id',USER_ID)
  }

  if (action.type === 'edit_fixed_cost' && action.name) {
    const { data:u } = await s.from('users').select('fixed_costs').eq('id',USER_ID).single()
    const fc = (u?.fixed_costs as {name:string;amount:number}[]) ?? []
    const idx = fc.findIndex(f => f.name.toLowerCase().includes((action.name??'').toLowerCase()))
    if (idx >= 0) {
      if (action.new_name) fc[idx].name = action.new_name
      if (action.amount) fc[idx].amount = Math.round(action.amount)
      await s.from('users').update({fixed_costs:fc}).eq('id',USER_ID)
    }
  }

  if (action.type === 'update_loan' && action.name) {
    const { data:loan } = await s.from('loans').select('id').eq('user_id',USER_ID).ilike('name',`%${action.name}%`).maybeSingle()
    if (loan) {
      const upd: Record<string,unknown> = {}
      if (action.principal != null) upd.principal = Math.round(action.principal)
      if (action.rate != null) upd.rate = action.rate
      if (action.min_payment != null) upd.min_payment = Math.round(action.min_payment)
      if (action.end_date) upd.end_date = action.end_date
      if (Object.keys(upd).length) await s.from('loans').update(upd).eq('id', loan.id)
    }
  }

  if (action.type === 'update_settings' && action.field) {
    const ALLOWED = ['salary_net','salary_gross','ytd_gross','threshold','moment_share','margin_share','var_budget']
    if (action.field === 'nominal' && action.key) {
      const { data:u } = await s.from('users').select('nominals').eq('id',USER_ID).single()
      const nominals = {...((u?.nominals as Record<string,number>)??{}), [action.key]:Number(action.value)}
      await s.from('users').update({nominals}).eq('id',USER_ID)
    } else if (ALLOWED.includes(action.field)) {
      await s.from('users').update({[action.field]:Number(action.value)}).eq('id',USER_ID)
    }
  }

  if (action.type === 'undo') {
    const { data:sn } = await s.from('undo_snapshots').select('*').eq('user_id',USER_ID).order('created_at',{ascending:false}).limit(1).maybeSingle()
    if (sn) {
      const st = sn.snapshot as Record<string,unknown>
      if (st.users) { const u={...st.users as Record<string,unknown>}; delete u.id; await s.from('users').update(u).eq('id',USER_ID) }
      await s.from('expenses').delete().eq('user_id',USER_ID)
      await s.from('income_events').delete().eq('user_id',USER_ID)
      await s.from('goals').delete().eq('user_id',USER_ID)
      await s.from('loans').delete().eq('user_id',USER_ID)
      await s.from('months').delete().eq('user_id',USER_ID)
      await s.from('cards').delete().eq('user_id',USER_ID)
      for (const t of ['cards','months','loans','goals','expenses','income_events']) {
        const rows = st[t] as Record<string,unknown>[]|undefined
        if (rows?.length) await s.from(t).insert(rows)
      }
      await s.from('undo_snapshots').delete().eq('id',sn.id)
    }
  }

  if (action.type === 'record_vacation_pay' && action.days && action.paid_amount) {
    const now = new Date()
    const { data:u } = await s.from('users').select('debit_balance,salary_net').eq('id',USER_ID).single()
    const salaryNet = Number(u?.salary_net ?? 121600)
    const wdays = computeWorkingDays(now.getFullYear(), now.getMonth()+1)
    const adj = computeVacationAdjustment(action.days, action.paid_amount, salaryNet, wdays)
    // Зачислить на дебет
    const prevBalV = Number(u?.debit_balance??0)
    const newBalV = Math.round((prevBalV+action.paid_amount)*100)/100
    await s.from('users').update({debit_balance:newBalV,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
    await recordDebitChange(s, prevBalV, newBalV, 'Отпускные/больничный', 'income')
    // income_event — vacation_type поле (sick/vacation) передаётся в input инструмента
    const vacationType = action.vacation_type ?? 'vacation'
    await s.from('income_events').insert({user_id:USER_ID,month_key:monthKey,event_date:new Date().toISOString().split('T')[0],event_type:'vacation',description:`${vacationType==='sick'?'Больничный':'Отпускные'} ${action.days}д`,amount:Math.round(action.paid_amount),to_debit:true})
    // Запись корректировки в months
    const { data:month } = await s.from('months').select('salary_adjustments,salary_adv_amount,salary_eom_amount').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
    const adjustments = (month?.salary_adjustments as unknown[]) ?? []
    const newAdj = {type:vacationType,days:action.days!,paid_amount:action.paid_amount!,deduct:adj.deductFromSalary,date:action.start_date??new Date().toISOString().split('T')[0],deduct_from:adj.deductFrom}
    adjustments.push(newAdj)
    const salaryNet2 = Number(u?.salary_net??121600)
    const advAmt = Number(month?.salary_adv_amount ?? Math.round(salaryNet2/2))
    const eomAmt = Number(month?.salary_eom_amount ?? salaryNet2 - advAmt)
    const updateData: Record<string,unknown> = { salary_adjustments: adjustments }
    if (adj.deductFrom === 'advance') updateData.salary_adv_amount = Math.max(0, advAmt - adj.deductFromSalary)
    else updateData.salary_eom_amount = Math.max(0, eomAmt - adj.deductFromSalary)
    month ? await s.from('months').update(updateData).eq('user_id',USER_ID).eq('month_key',monthKey)
          : await s.from('months').insert({user_id:USER_ID,month_key:monthKey,...updateData})
  }

  if (action.type === 'create_custom_category' && action.name) {
    const { data:existing } = await s.from('custom_categories').select('id').eq('user_id',USER_ID).ilike('name',action.name).maybeSingle()
    if (!existing) {
      const ins: Record<string,unknown> = {user_id:USER_ID,name:action.name}
      if (action.monthly_limit != null) ins.monthly_limit = action.monthly_limit
      if (action.keywords) ins.keywords = action.keywords
      await s.from('custom_categories').insert(ins)
    }
  }

  if (action.type === 'add_keyword' && action.name && action.keyword) {
    const { data:cat } = await s.from('custom_categories').select('id,keywords').eq('user_id',USER_ID).ilike('name',`%${action.name}%`).maybeSingle()
    if (cat) {
      const kws = (cat.keywords as string[]) ?? []
      if (!kws.includes(action.keyword)) {
        await s.from('custom_categories').update({keywords:[...kws,action.keyword]}).eq('id',cat.id)
      }
    }
  }

  if (action.type === 'remove_custom_category' && action.name) {
    await s.from('custom_categories').delete().eq('user_id',USER_ID).ilike('name',`%${action.name}%`)
  }

  if (action.type === 'learn_mapping' && action.trigger) {
    const upsertData: Record<string,unknown> = {user_id:USER_ID,trigger:action.trigger.toLowerCase()}
    if (action.category) upsertData.category = action.category
    if (action.custom_category_name) {
      const { data:cat } = await s.from('custom_categories').select('id').eq('user_id',USER_ID).ilike('name',`%${action.custom_category_name}%`).maybeSingle()
      if (cat) upsertData.custom_category_id = cat.id
    }
    await s.from('bot_learnings').upsert(upsertData,{onConflict:'user_id,trigger',ignoreDuplicates:false})
  }

  if (action.type === 'save_correction' && action.correction) {
    // Читаем последние сообщения из истории чата для контекста
    const { data: recentMsgs } = await s.from('bot_messages').select('role,content,created_at').eq('user_id', USER_ID).order('created_at', {ascending: false}).limit(4)
    const msgs = (recentMsgs ?? []).reverse()
    const lastUser = msgs.filter(m => m.role === 'user').pop()
    const lastBot = msgs.filter(m => m.role === 'assistant').pop()
    const userSaid = lastUser?.content ?? '[нет сообщения]'
    const botAnswered = action.bot_answered ?? (lastBot?.content?.slice(0, 400) ?? '[нет ответа]')
    await s.from('bot_corrections').insert({user_id:USER_ID,user_said:userSaid,bot_answered:botAnswered,correction:action.correction,category:action.category??'logic'})
  }

  if (action.type === 'reclassify_expense') {
    const monthKey2 = mk()
    let customCatId: string | null = null
    if (action.custom_category_name) {
      const { data: cat } = await s.from('custom_categories').select('id').eq('user_id', USER_ID).ilike('name', `%${action.custom_category_name}%`).maybeSingle()
      customCatId = cat?.id ?? null
    }
    if (action.keyword) {
      const { data: exps } = await s.from('expenses').select('id').eq('user_id', USER_ID).eq('month_key', monthKey2).ilike('description', `%${action.keyword}%`)
      if (exps?.length) {
        const upd: Record<string, unknown> = {}
        if (action.new_category) upd.category = action.new_category
        if (customCatId) upd.custom_category_id = customCatId
        if (Object.keys(upd).length) await s.from('expenses').update(upd).in('id', exps.map(e => e.id))
      }
      // Запомнить маппинг
      await executeAction({ type: 'learn_mapping', trigger: action.keyword.toLowerCase(), category: action.new_category, custom_category_name: action.custom_category_name })
    }
  }

  if (action.type === 'update_cashflow') {
    const monthKey3 = mk()
    const upd: Record<string, unknown> = {}
    if (action.adv_amount   != null) upd.salary_adv_amount = action.adv_amount
    if (action.eom_amount   != null) upd.salary_eom_amount = action.eom_amount
    if (action.bonus_amount != null) upd.bonus_amount      = action.bonus_amount
    if (Object.keys(upd).length) {
      const { data: exists } = await s.from('months').select('month_key').eq('user_id', USER_ID).eq('month_key', monthKey3).maybeSingle()
      exists ? await s.from('months').update(upd).eq('user_id', USER_ID).eq('month_key', monthKey3)
             : await s.from('months').insert({ user_id: USER_ID, month_key: monthKey3, ...upd })
    }
  }

  if (action.type === 'add_backlog_item' && action.title) {
    await s.from('bot_backlog').insert({
      user_id: USER_ID,
      title: action.title,
      description: action.description ?? null,
      priority: action.priority ?? 2,
      category: action.category ?? 'feature',
    })
  }

  if (action.type === 'add_idea' && action.description) {
    await s.from('bot_ideas').insert({
      user_id: USER_ID,
      idea: action.description,
      context: action.name ?? null,
      category: action.category ?? 'feature',
      priority: action.priority ?? 2,
    }).select()
  }

  if (action.type === 'add_multiday_expense' && action.amount) {
    await s.from('expenses').insert({
      user_id: USER_ID, month_key: mk(),
      expense_date: new Date().toISOString().split('T')[0],
      category: action.category ?? 'Еда и кафе',
      amount: Math.round(action.amount),
      description: action.description ?? null,
      source_type: 'debit',
      covers_days: action.covers_days ?? 1,
    })
    const { data: u } = await s.from('users').select('debit_balance').eq('id', USER_ID).single()
    const newBal = Math.round((Number(u?.debit_balance ?? 0) - action.amount) * 100) / 100
    await s.from('users').update({ debit_balance: newBal, debit_updated_at: new Date().toISOString() }).eq('id', USER_ID)
    await recordDebitChange(s, Number(u?.debit_balance ?? 0), newBal, `Мультидневная: ${action.description ?? action.category} (${action.covers_days}д)`, 'expense')
  }

  if (action.type === 'update_anchor' && action.month_key && action.key && action.value != null) {
    await s.from('bot_anchors').upsert({
      user_id: USER_ID,
      month_key: action.month_key,
      key: action.key,
      value: String(action.value),
      formula: action.formula ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,month_key,key' })
  }
}

// ── ИНСТРУМЕНТЫ (tool calling) — надёжная замена парсингу ACTION ──────────
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
      vacation_type:{type:'string',enum:['vacation','sick'],description:'Тип: отпуск или больничный'}
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
    description: 'Изменить категорию или привязать к кастомной категории существующие траты текущего месяца. Вызывай когда пользователь говорит "перенеси снюс в Вредные", "это вредная трата", "переквалифицируй трату", "отнеси X к категории Y". Также вызывай learn_mapping для будущего.',
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
]

interface ContentBlock { type:string; text?:string; id?:string; name?:string; input?:Record<string,unknown> }

// Один раунд вызова Claude с инструментами
async function callClaude(modelId: string, systemBlocks: unknown[], messages: unknown[]) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY!,'anthropic-version':'2023-06-01'},
    body: JSON.stringify({ model:modelId, max_tokens:1500, system:systemBlocks, tools:TOOLS, messages })
  })
  return res.json()
}

// Обработка одного инструмента — возвращает строку-результат для tool_result
async function handleTool(name: string, input: Record<string,unknown>): Promise<string> {
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
    const workingDays = computeWorkingDays(now.getFullYear(), now.getMonth() + 1)
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
    const status = String(input.status ?? 'pending')
    let q = db().from('bot_backlog').select('title,description,priority,status,created_at').eq('user_id', USER_ID).order('priority', { ascending: true }).limit(20)
    if (status !== 'all') q = q.eq('status', status)
    const { data: items } = await q
    return JSON.stringify(items ?? [])
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
  // DB-writing tools
  await executeAction({ type: name, ...input } as BotAction)
  return 'Выполнено успешно.'
}

// Цикл tool calling: модель вызывает инструменты → выполняем → возвращаем результат → финальный текст
async function runToolLoop(modelId: string, systemBlocks: unknown[], initialMessages: unknown[]): Promise<{ text:string; actionsRun:string[] }> {
  const messages = [...initialMessages]
  const actionsRun: string[] = []
  for (let round = 0; round < 5; round++) {
    const data = await callClaude(modelId, systemBlocks, messages)
    const content: ContentBlock[] = data.content ?? []
    if (data.stop_reason === 'tool_use') {
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
      return { text: text || '✅ Готово', actionsRun }
    }
  }
  return { text: '⚠️ Слишком много шагов, останавливаюсь. Проверь результат на сайте.', actionsRun }
}

async function processWithModel(text: string, chatId: number, model: 'haiku'|'sonnet'): Promise<string> {
  const needAnalysis = /проанализир|анализ трат|паттерн|на что трачу|куда уход|структур.*трат/i.test(text)
  const [context, history, analysis] = await Promise.all([
    getContext(),
    getHistory(chatId),
    needAnalysis ? getSpendingAnalysis() : Promise.resolve(''),
  ])
  const fullContext = context + (analysis ? '\n\n' + analysis : '')
  const modelId = model === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001'
  const systemBlocks = [
    { type:'text', text:SYSTEM_PROMPT, cache_control:{type:'ephemeral'} },
    { type:'text', text:'\n\nКОНТЕКСТ:\n'+fullContext },
  ]
  const messages = [
    ...history.map(h => ({ role:h.role as 'user'|'assistant', content:h.content })),
    { role:'user', content:text }
  ]
  const { text: reply } = await runToolLoop(modelId, systemBlocks, messages)
  Promise.all([
    saveHistory(chatId,'user',text),
    saveHistory(chatId,'assistant',reply)
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
    ? `Еженедельный отчёт (воскресенье, ${dateFmt}). Структура: итоги недели, баланс + дневной бюджет, ближайшие платежи следующей недели, прогноз бонуса, что улучшить. КРАТКО, не более 1500 символов, вертикальные списки.`
    : `Утренний дайджест (${dateFmt}). Баланс, дневной бюджет, ближайшие платежи, прогресс переменных. 8-10 строк, без таблиц.`
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY!,'anthropic-version':'2023-06-01'},
    body:JSON.stringify({
      model: isWeekly ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001',
      max_tokens:800,
      system:[
        {type:'text',text:SYSTEM_PROMPT,cache_control:{type:'ephemeral'}},
        {type:'text',text:'\n\nКОНТЕКСТ:\n'+context}
      ],
      messages:[{role:'user',content:prompt}]
    })
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
