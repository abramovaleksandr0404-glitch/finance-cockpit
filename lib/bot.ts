/**
 * Finance Cockpit Bot — v8
 * Сценарный анализ покупок + проактивный советник
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { analyzeDecision } from './calc'

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

// ── Сценарный анализ покупки ──────────────────────────────────────────────────

function detectDecisionQuery(text: string): boolean {
  return /стоит ли\b|стоит брать|купить\s.{0,30}в кредит|брать.{0,20}кредит|рассрочк[ае]|переплат|выгодно ли купить|имеет смысл купить|лучше.{0,20}кредит|лучше.{0,20}наличн/i.test(text)
}

function extractCostFromText(text: string): number | null {
  const m1 = text.match(/(\d[\d\s]*)\s*₽/)
  if (m1) { const n = parseInt(m1[1].replace(/\s/g, '')); if (n >= 1000) return n }

  const m2 = text.match(/(\d+(?:[,.]?\d+)?)\s*(тыс(?:яч)?|к)\b/i)
  if (m2) {
    const n = parseFloat(m2[1].replace(',', '.'))
    return Math.round(n * 1000)
  }

  const m3 = text.match(/(\d+(?:[,.]?\d+)?)\s*млн\b/i)
  if (m3) return Math.round(parseFloat(m3[1].replace(',', '.')) * 1000000)

  const m4 = text.match(/\bза\s+(\d{4,7})\b/)
  if (m4) return parseInt(m4[1])

  const m5 = text.match(/\b(\d{5,7})\b/)
  if (m5) return parseInt(m5[1])

  return null
}

async function getDecisionContext(itemCost: number): Promise<string> {
  const { data: u } = await db().from('users').select('debit_balance,tbank_debit').eq('id', USER_ID).single()
  const liquid = Number(u?.debit_balance ?? 0) + Number(u?.tbank_debit ?? 0)

  const { data: monthRow } = await db().from('months').select('clients,revenue').eq('user_id', USER_ID).eq('month_key', mk()).maybeSingle()
  const { data: userRow } = await db().from('users').select('nominals,threshold,margin_share,moment_share,r1').eq('id', USER_ID).single()
  const clients = (monthRow?.clients as Record<string,number>) ?? {}
  const nominals = (userRow?.nominals as Record<string,number>) ?? {}
  const revenue = Number(monthRow?.revenue ?? 41666)
  const marginShare = Number(userRow?.margin_share ?? 0.20)
  const momentShare = Number(userRow?.moment_share ?? 0.80)
  const threshold = Number(userRow?.threshold ?? 56000)
  const r1 = Number(userRow?.r1 ?? 0.13)
  const clientPot = Object.entries(clients).reduce((s,[g,n])=>s+(nominals[g]??0)*Number(n),0)
  const pot = clientPot + revenue * marginShare
  const excess = Math.max(0, pot - threshold)
  const bonusNet = Math.round(excess * momentShare * (1 - r1))

  const now = new Date()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate()
  const daysLeft = daysInMonth - now.getDate()
  const weeksUntilBonus = Math.round(daysLeft / 7)

  const dec = analyzeDecision({
    itemCost,
    loanRate: 0.33,
    loanMonths: 12,
    currentLiquid: liquid,
    expectedBonus: bonusNet > 0 ? bonusNet : undefined,
    weeksUntilBonus: bonusNet > 0 ? Math.max(1, weeksUntilBonus) : undefined,
    minSafeLiquid: 30000,
  })

  return `
=== СЦЕНАРНЫЙ АНАЛИЗ ПОКУПКИ (${rub(itemCost)}) — ИСПОЛЬЗУЙ ЭТИ ЦИФРЫ ===
ТЕКУЩАЯ ЛИКВИДНОСТЬ: ${rub(liquid)}
БЕЗОПАСНАЯ ПОДУШКА: 30 000 ₽

ВАРИАНТ 1 — КРЕДИТ (33% годовых, 12 мес.):
  Ежемесячный платёж: ${rub(dec.creditScenario.monthlyPayment)}
  Всего выплат: ${rub(dec.creditScenario.totalPaid)}
  ПЕРЕПЛАТА: ${rub(dec.creditScenario.overpayment)}

ВАРИАНТ 2 — НАЛИЧНЫЕ:
  Ликвидность после покупки: ${rub(dec.cashScenario.liquidAfter)}
  Безопасно: ${dec.cashScenario.safe ? 'ДА (≥ 30 000 ₽)' : 'НЕТ (ниже порога безопасности)'}

${dec.waitScenario ? `ВАРИАНТ 3 — ПОДОЖДАТЬ БОНУСА (~${dec.waitScenario.weeks} нед.):
  Ожидаемый бонус на руки: ${rub(bonusNet)}
  Бонус покроет покупку: ${dec.waitScenario.canCoverWithBonus ? 'ДА' : 'НЕТ'}` : ''}

✅ РЕКОМЕНДАЦИЯ: ${dec.recommendation}
=== КОНЕЦ АНАЛИЗА ===`
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

  const [{data:user},{data:loans},{data:expenses},{data:month},{data:goals},{data:recentExp},{data:quarterMonths},{data:cards},{data:incomeEvents}] = await Promise.all([
    supabase.from('users').select('*').eq('id',USER_ID).single(),
    supabase.from('loans').select('id,name,principal,accrued_int,min_payment,end_date,rate,paid_month,due_day').eq('user_id',USER_ID).order('sort_order'),
    supabase.from('expenses').select('id,amount,category,description,expense_date').eq('user_id',USER_ID).eq('month_key',monthKey),
    supabase.from('months').select('*').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle(),
    supabase.from('goals').select('id,name,amount,month_key,purchased').eq('user_id',USER_ID).eq('purchased',false).limit(6),
    supabase.from('expenses').select('id,category,amount,description,expense_date').eq('user_id',USER_ID).eq('month_key',monthKey).order('created_at',{ascending:false}).limit(5),
    supabase.from('months').select('month_key,clients,revenue').eq('user_id',USER_ID).gte('month_key',qStartKey).lte('month_key',qEndKey),
    supabase.from('cards').select('name,card_limit,current_debt').eq('user_id',USER_ID).order('sort_order'),
    supabase.from('income_events').select('event_date,description,amount').eq('user_id',USER_ID).eq('month_key',monthKey),
  ])
  if (!user) return 'Данные не загружены'

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
  const today = now.getDate()
  const pendingRecurring = recurringIncomes.filter(r => r.day >= today)
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

  const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate()
  const daysLeft = daysInMonth - today + 1
  const dailyBudget = Math.round(varLeft / Math.max(1, daysLeft))

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
  const projEnd = liquid + incomingTotal - pendingLoanPayments - fixedUnpaid - varLeft
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

  const recentLines = (recentExp ?? []).map(e => `  • ${e.expense_date} ${e.category}: ${rub(Number(e.amount))}${e.description?' — '+e.description:''}`).join('\n') || '  (нет)'
  const fixedLines = fixedCosts.map((f,i) => `  • ${f.name}${f.day?` (${f.day} числа)`:''}: ${rub(f.amount)} ${fixedPaid[String(i)] ? '✅ оплачено' : '⏳'}`).join('\n')
  const goalLines = (goals ?? []).map(g => `  • ${g.name}: ${rub(Number(g.amount))} ${g.month_key ? '('+g.month_key+')' : '(накопление)'}`).join('\n') || '  (нет)'
  const loanLines = (loans ?? []).map(l => {
    const total = Number(l.principal) + Number(l.accrued_int)
    const paid = l.paid_month === monthKey ? '✅' : '⏳'
    return `  • ${l.name}: ${rub(total)} @ ${(Number(l.rate)*100).toFixed(2)}% — ${rub(Number(l.min_payment))}/мес ${paid}`
  }).join('\n')
  const cardLines = (cards ?? []).map(c => `  • ${c.name}: лимит ${rub(Number(c.card_limit))}, долг ${rub(Number(c.current_debt))}, доступно ${rub(Number(c.card_limit) - Number(c.current_debt))}`).join('\n') || '  (нет)'
  const recurringLines = recurringIncomes.map(r => `  • ${r.name}: ${rub(r.amount)} (${r.day} числа каждого месяца)`).join('\n') || '  (нет)'
  const incomeEventLines = (incomeEvents ?? []).map(e => `  • ${e.event_date}: ${e.description}: ${rub(Number(e.amount))}`).join('\n') || '  (нет в этом месяце)'

  return `=== ФИНАНСОВЫЙ КОНТЕКСТ ===
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

=== КЕШФЛОУ ИЮНЯ ===
ВХОДЫ (всего ожидается ${rub(incomingTotal)}):
  Стипендия ${recurringIncomes.find(r=>r.name==='Стипендия') && today<=11 ? `⏳ ${rub(5900)} (11-го)` : '✅/нет'}
  Аванс ${advReceived?'✅ получен':`⏳ ${rub(advAmount)} (${advDay}-го)`}
  ЗП ${eomReceived?'✅':`⏳ ${rub(eomAmount)}`} + Бонус ${eomReceived?'✅':`⏳ ${rub(bonusAmount)}`} (${eomDay}-го, посл. раб. день месяца)

ВЫХОДЫ:
  Кредиты неоплаченные: ${rub(pendingLoanPayments)} [платёж 4 кредитов]
  Постоянные неоплаченные: ${rub(fixedUnpaid)} из ${rub(fixedTotal)}
  Переменные ещё доступно до лимита: ${rub(varLeft)}
  ИТОГО к списанию: ${rub(pendingLoanPayments + fixedUnpaid + varLeft)}

ПЛАНОВЫЕ ПОКУПКИ ИЮНЯ (цели на месяц, ещё не куплены):
${plannedPurchases.length ? plannedPurchases.map(g=>`  • ${g.name}: ${rub(Number(g.amount))}`).join('\n')+`\n  ИТОГО плановых: ${rub(plannedTotal)}` : '  (нет запланированных покупок)'}

ПРОГНОЗ ОСТАТКА К 30-го ИЮНЯ: ${rub(projEnd)}
  [формула: ликвидность ${rub(liquid)} + входы ${rub(incomingTotal)} − кредиты ${rub(pendingLoanPayments)} − постоянные ${rub(fixedUnpaid)} − переменные до лимита ${rub(varLeft)}]
ПОСЛЕ ПЛАНОВЫХ ПОКУПОК (−${rub(plannedTotal)}): ${rub(projEndAfterPlanned)}

=== КРЕДИТЫ (всего ${rub(totalDebt)}, платёж ${rub(totalMonthlyPayment)}/мес) ===
${loanLines}

=== ПОСТОЯННЫЕ (всего ${rub(fixedTotal)}, оплачено ${rub(fixedPaidSum)}) ===
${fixedLines}

=== РЕГУЛЯРНЫЕ ДОХОДЫ ===
${recurringLines}

=== ПОСЛЕДНИЕ ПЕРЕМЕННЫЕ ТРАТЫ ===
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
  Оклад net: ${rub(salaryNet)} | gross: ${rub(Number(user.salary_gross))} | YTD gross: ${rub(Number(user.ytd_gross))}
  Порог: ${rub(threshold)} (эквивалент ~${rub(threshold/marginShare)} выручки или клиентов на эту сумму номиналов)
  Момент: ${(momentShare*100).toFixed(0)}% → ежемесячный | Годовой остаток: ${((1-momentShare)*100).toFixed(0)}%
  Марджин выручки: ${(marginShare*100).toFixed(0)}% | НДФЛ: ${(r1*100).toFixed(0)}%
  Квартальные множители: qm2=${qm2} (при 2 кл), qm3=${qm3} (при ≥3 кл)
  Номиналы: г3=${nominals.g3}, г4=${nominals.g4}, г5-6=${nominals.g56}, г7-8=${nominals.g78}, г9=${nominals.g9}, г10=${nominals.g10}
  Лимит переменных: ${rub(varBudget)}`
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
const SYSTEM_PROMPT = `Ты — финансовый ассистент Александра в Telegram. Александр работает в АТОН (продажи инвестиционных продуктов).

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

ДЕЙСТВИЯ — ВАЖНО:
Если нужно выполнить действие, добавь в конец ответа отдельной строкой ровно один формат:
ACTION:{"type":"add_expense","amount":800,"category":"Транспорт","description":"такси"}

Поддерживаемые типы (ВСЕГДА с подчёркиваниями):
- add_expense, delete_expense
- add_client, add_goal, mark_goal_bought
- mark_salary (part: "advance" или "eom")
- mark_single_fixed, mark_fixed_paid, mark_loan_paid, early_repay
- add_income_event, set_balance, close_month
- add_fixed_cost, remove_fixed_cost, edit_fixed_cost
- update_settings (поля: salary_net, salary_gross, ytd_gross, threshold, moment_share, margin_share, var_budget, или nominal с key=g3..g10)
- undo

Категории: Еда и кафе, Транспорт, Здоровье, Развлечения, Одежда, Инвестиции, Обучение и ИИ, Прочее

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
Если пользователь говорит "получил стипендию" → ACTION add_income_event с amount=5900

РЕШЕНИЕ О ПОКУПКЕ (стоит ли купить X в кредит / за наличные):
Когда в контексте есть раздел "СЦЕНАРНЫЙ АНАЛИЗ ПОКУПКИ" — используй ТОЛЬКО эти цифры.
Не придумывай свои расчёты. Структура ответа:
1. 💳 *Кредит (33%, 12 мес.)*: платёж/мес + переплата
2. 💵 *Наличные*: остаток ликвидности, безопасно/нет
3. ⏳ *Ожидание бонуса* (если есть): срок + покрытие
4. ✅ *Рекомендация* (одна строка — из контекста)
Никакого пересчёта! Берёшь готовые цифры из раздела анализа.

ВАЖНО: если задача требует уточнения — НЕ выполняй ACTION, только задай вопрос.`

interface BotAction {
  type: string
  amount?: number; category?: string; description?: string; id?: string
  grade?: string; revenue?: number; name?: string; new_name?: string; month_key?: string|null
  field?: string; key?: string; value?: number|string; account?: string; part?: string
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

// ── Выполнение действий ───────────────────────────────────────────────────
export async function executeAction(action: BotAction): Promise<void> {
  const s = db()
  const monthKey = mk()

  const snapLabel: Record<string,string> = {
    add_expense:'трата',delete_expense:'удаление',add_client:'клиент',add_goal:'цель',
    mark_goal_bought:'покупка',mark_salary:'зарплата',mark_single_fixed:'постоянная',
    mark_fixed_paid:'все постоянные',mark_loan_paid:'кредит',early_repay:'досрочное',
    add_income_event:'доход',set_balance:'баланс',close_month:'закрытие',
    update_settings:'настройки',add_fixed_cost:'+постоянная',
    remove_fixed_cost:'-постоянная',edit_fixed_cost:'правка',undo:'отмена',
  }
  if (snapLabel[action.type]) await snap(snapLabel[action.type])

  if (action.type === 'add_expense' && action.amount) {
    await s.from('expenses').insert({user_id:USER_ID,month_key:monthKey,expense_date:new Date().toISOString().split('T')[0],category:action.category??'Прочее',amount:Math.round(action.amount),description:action.description??null,source_type:'debit'})
    const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
    await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)-action.amount)*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
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
      await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)+Number(exp.amount))*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
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
      await s.from('months').update({salary_adv_received:true,salary_adv_amount:advAmt}).eq('user_id',USER_ID).eq('month_key',monthKey)
      await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)+advAmt)*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
    }
    if (action.part === 'eom') {
      const advAmt = Number(month?.salary_adv_amount??Math.round(net/2))
      const eomSalary = Number(month?.salary_eom_amount??net-advAmt)
      const bonusAmt = Number(month?.bonus_amount??0)
      const total = eomSalary + bonusAmt
      await s.from('months').update({salary_eom_received:true,salary_eom_amount:eomSalary}).eq('user_id',USER_ID).eq('month_key',monthKey)
      await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)+total)*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
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
        await s.from('months').update({fixed_paid:{...fp,[String(idx)]:amount}}).eq('user_id',USER_ID).eq('month_key',monthKey)
        await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)-amount)*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
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
      await s.from('months').update({fixed_paid:{...fp,...newFp}}).eq('user_id',USER_ID).eq('month_key',monthKey)
      await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)-total)*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
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
      await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)-pay)*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
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
      await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)-action.amount)*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
    }
  }

  if (action.type === 'add_income_event' && action.amount) {
    await s.from('income_events').insert({user_id:USER_ID,month_key:monthKey,event_date:new Date().toISOString().split('T')[0],event_type:'other',description:action.description??'Доход',amount:Math.round(action.amount),to_debit:true})
    const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
    await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)+action.amount)*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
  }

  if (action.type === 'set_balance' && action.account && action.amount != null) {
    const field = action.account === 'sber' ? 'debit_balance' : 'tbank_debit'
    await s.from('users').update({[field]:action.amount,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
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
}

async function processWithModel(text: string, chatId: number, model: 'haiku'|'sonnet'): Promise<string> {
  const needAnalysis = /проанализир|анализ трат|паттерн|на что трачу|куда уход|структур.*трат/i.test(text)
  const isDecision = detectDecisionQuery(text)
  const itemCost = isDecision ? extractCostFromText(text) : null

  const [context, history, analysis, decisionCtx] = await Promise.all([
    getContext(),
    getHistory(chatId),
    needAnalysis ? getSpendingAnalysis() : Promise.resolve(''),
    itemCost ? getDecisionContext(itemCost) : Promise.resolve(''),
  ])
  const fullContext = context + (analysis ? '\n\n' + analysis : '') + (decisionCtx ? '\n\n' + decisionCtx : '')
  const modelId = model === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001'
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY!,'anthropic-version':'2023-06-01'},
    body: JSON.stringify({
      model: modelId,
      max_tokens: 1500,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: '\n\nКОНТЕКСТ:\n' + fullContext },
      ],
      messages: [
        ...history.map(h => ({ role: h.role as 'user'|'assistant', content: h.content })),
        { role: 'user', content: text }
      ]
    })
  })
  const data = await res.json()
  const raw: string = data.content?.[0]?.text ?? '❌ Ошибка API'
  const { actions, cleanText } = extractActions(raw)
  for (const action of actions) {
    try { await executeAction(action) } catch(e) { console.error('[action exec]',e) }
  }
  Promise.all([
    saveHistory(chatId,'user',text),
    saveHistory(chatId,'assistant',cleanText)
  ]).catch(()=>{})
  return cleanText
}

function routeModel(text: string): 'haiku' | 'sonnet' {
  const sonnetTriggers = [
    /что если|сколько бонус|посчитай|гипотет|сценари|прогноз/i,
    /повышен|изменил|поменял|пересмотр|формул|порог|номинал/i,
    /полный|весь бюджет|все цифры|подробно|анализ|почему|объясни/i,
    /кварталь|квартал/i,
    /стоит ли|в кредит|рассрочк|переплат|выгодно ли купить/i,
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
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY!,'anthropic-version':'2023-06-01'},
      body: JSON.stringify({
        model:'claude-sonnet-4-6', max_tokens:1500,
        system:[
          { type:'text', text:SYSTEM_PROMPT, cache_control:{type:'ephemeral'} },
          { type:'text', text:'\n\nКОНТЕКСТ:\n'+context }
        ],
        messages:[
          ...history.map(h=>({role:h.role as 'user'|'assistant',content:h.content})),
          {role:'user',content:[{type:'image',source:{type:'base64',media_type:mime,data:base64}},{type:'text',text:userText}]}
        ]
      })
    })
    const data = await res.json()
    const raw: string = data.content?.[0]?.text ?? '❌ Не смог прочитать'
    const { actions, cleanText } = extractActions(raw)
    for (const action of actions) { try { await executeAction(action) } catch(e) { console.error('[action]',e) } }
    Promise.all([saveHistory(chatId,'user',`[фото: ${userText}]`), saveHistory(chatId,'assistant',cleanText)]).catch(()=>{})
    return cleanText
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
