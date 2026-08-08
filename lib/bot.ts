/**
 * Finance Cockpit Bot — v8
 * Детерминированный расчёт через get_financial_summary. LLM не считает цифры.
 */
import { db, mk, rub, pct, quarterOf, advanceDay, lastWorkingDayOfMonth,
  annuityPaymentFor, annuityMonthsFor, isGoalThisMonth, monthsUntil, addMonths,
  stripLoneSurrogates, deepCleanSurrogates, withPrefixCache, USER_ID, TG } from './bot/shared'
import { getHistory, saveHistory, logMessage, checkDeployNotification, storeChatId,
  transcribeVoice, sendTelegramWithButtons, sendTelegram } from './bot/telegram'
export { getHistory, saveHistory, logMessage, checkDeployNotification, storeChatId,
  transcribeVoice, sendTelegramWithButtons, sendTelegram }
import { runInRequest, runAsSystem, textIsHypothetical, textHasAmount, getLastUserMessage, isHypothetical, userMessageHasAmount,
  setWriteBlocked, takeWriteBlocked, setCorrectionRejected, getCorrectionRejected,
  setMemoryOutcome, takeMemoryOutcome, setActionUnrecognized, takeActionUnrecognized,
  resetActionFlags, recordUsage, getReqUsage, cached, invalidateCache } from './bot/state'
export { runAsSystem }
import { computeFinancialState, getContext, getLoansSummaryJson, getFinancialSummaryJson,
  updateAnchors, accrueLoansCore, type FinancialState } from './bot/core'
export { computeFinancialState, getContext, type FinancialState }
import { executeAction, type BotAction } from './bot/actions'
export { executeAction, type BotAction }


import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { analyzeDecision, suggestEarlyRepayment, computeWorkingDays, computeVacationAdjustment, computeCreditBurden, computeOptimalRepayment } from './calc'
import { handlePlannerTool, PLANNER_TOOL_NAMES } from './planner'


// ── Request-level cache (TTL 60s) — один раз за запрос, не 8 ──────────────

// USER_ID и TG теперь в shared.ts — импортируются ниже, не дублируются


// День аванса: 15-е если рабочий, иначе последний рабочий день перед 15-м
// Последний рабочий день месяца (для зп+бонуса)


// Публичная функция для логирования из route.ts
// Отбивка о деплое без внешних вебхуков и CI.
// Vercel прокидывает SHA коммита в окружение. Сравниваем с последним известным
// в bot_anchors: разошлись — значит выкатилась новая версия, шлём уведомление.






// ════════════════════════════════════════════════════════════════════════════
// ЕДИНОЕ ФИНАНСОВОЕ ЯДРО — единственный источник истины для всех расчётов.
// Граф зависимостей: слой 0 (сырьё из БД) → слой 1 (агрегаты) → слой 2
// (производные) → слой 3 (прогнозы) → слой 4 (сценарии). Каждая величина
// считается РОВНО ОДИН РАЗ. getContext, getFinancialSummaryJson, сайт и
// дайджесты читают готовые поля и НИКОГДА не пересчитывают сами.
// ════════════════════════════════════════════════════════════════════════════

// Ежедневное начисление процентов по кредитам (идемпотентно, как на сайте lib/accrue.ts).
// Вызывается из ядра → проценты капают при ЛЮБОМ обращении бота, не только при загрузке сайта.

// Аннуитет в обе стороны — раньше early_repay пропорционально масштабировал
// платёж, что не совпадает НИ С ОДНИМ реальным сценарием банка (ни с
// «уменьшить платёж», ни с «сократить срок»). Отсюда расхождения с выпиской.
// Остаточный срок ДО пересчёта: приоритет — сохранённая end_date, не формула.
// Формула требует чтобы principal/payment были математически согласованы
// (платёж покрывал бы проценты); если старые данные в БД чуть разошлись
// (бывает после ручных правок), annuityMonthsFor может улететь в 999
// месяцев или дать абсурдный результат. end_date — прямое число из
// прошлого шага, не пересчитывается заново, поэтому надёжнее по построению.
// ЕДИНЫЙ критерий «цель этого месяца» — раньше core, список в контексте и
// группировка по горизонтам считали это тремя разными фильтрами (только
// month_key в двух местах, month_key ИЛИ target_date в третьем). Одна и та
// же цель могла попасть в прогноз, но пропасть из списка на экране, или
// наоборот. Теперь все три места вызывают эту функцию.
// Журнал событий по кредиту — платежи и досрочные погашения в хронологии.
// Хранится в bot_anchors (своей таблицы под это нет): ключ loan_log:<имя>,
// значение — JSON-массив. Без него бот не может ответить «что произошло
// с кредитом в этом месяце» иначе как гадая по текущим цифрам.




// ── Полный контекст с квартальной аналитикой ─────────────────────────────


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
import { SYSTEM_PROMPT } from './bot/prompt'
export { SYSTEM_PROMPT }



// ── Выполнение действий ───────────────────────────────────────────────────
// userText — текст сообщения пользователя. undefined = СИСТЕМНЫЙ вызов (cron),
// защиты по тексту неприменимы. Передаётся явно, а не через неявный контекст:
// потеря контекста молча отключала все защиты.

// ── ИНСТРУМЕНТЫ (tool calling) — надёжная замена парсингу ACTION ──────────
import { TOOLS } from './bot/tools'
export { TOOLS }

interface ContentBlock { type:string; text?:string; id?:string; name?:string; input?:Record<string,unknown> }

// Один раунд вызова Claude с инструментами

// Ставит cache_control на последний system-блок.
// Эффект: внутри одного tool-loop раунды 2..6 читают ВЕСЬ префикс
// (промпт + контекст + forced-данные) из кэша по ~10% цены вместо 100%.

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
  if (j.usage) {
    recordUsage(j.usage)
  }
  return j
}

// Удаляет непарные суррогаты (битые эмодзи) из готового JSON — иначе Anthropic
// отклоняет весь запрос с "invalid high surrogate". Страховка на любой источник.

// Рекурсивно чистит непарные суррогаты во ВСЕХ строках ДО JSON.stringify.
// Важно: stringify экранирует суррогаты в \udXXX-текст, поэтому чистить ПОСЛЕ бесполезно —
// Anthropic парсит \udXXX обратно в суррогат и отвергает запрос.

// Обработка одного инструмента — возвращает строку-результат для tool_result

// ═══════════════════════════════════════════════════════════════
// ДЕТЕРМИНИРОВАННЫЙ РАСЧЁТ — единственный источник финансовых цифр
// ═══════════════════════════════════════════════════════════════

// ── ДЕТЕРМИНИРОВАННАЯ СВОДКА КРЕДИТОВ ──


async function handleTool(name: string, input: Record<string,unknown>, userText?: string): Promise<string> {
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
  if (name === 'list_corrections') {
    const { data } = await db().from('bot_corrections')
      .select('correction,category,created_at')
      .eq('user_id', USER_ID)
      .order('created_at', { ascending: false })
      .limit(20)
    return JSON.stringify({ count: data?.length ?? 0, rules: data ?? [] })
  }
  if (name === 'delete_correction') {
    const fragment = String(input.fragment ?? '').slice(0, 100)
    if (fragment) await db().from('bot_corrections').delete().eq('user_id', USER_ID).ilike('correction', `%${fragment}%`)
    return JSON.stringify({ deleted: true })
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
  if (name === 'delete_memory') {
    const fragment = String(input.content_fragment ?? '').slice(0, 100)
    if (fragment) await db().from('bot_memories').delete().eq('user_id', USER_ID).ilike('content', `%${fragment}%`)
    return JSON.stringify({ deleted: true })
  }
  if (name === 'loan_forecast') {
    // Прогноз графика вперёд — та же математика что в early_repay, но без
    // записи в БД. Данные всегда живые (principal/rate/payment из таблицы),
    // не переспрашивает пользователя банковскую выписку каждый раз.
    const months = Math.min(24, Math.max(1, Math.round(Number(input.months ?? 6))))
    const nameFilter = String(input.name ?? '')
    const { data: loans } = await db().from('loans').select('name,principal,rate,min_payment')
      .eq('user_id', USER_ID).gt('principal', 0)
    const filtered = nameFilter
      ? (loans ?? []).filter(l => l.name.toLowerCase().includes(nameFilter.toLowerCase()))
      : (loans ?? [])
    const result = filtered.map(l => {
      let balance = Number(l.principal)
      const monthlyRate = Number(l.rate) / 12
      const payment = Number(l.min_payment)
      const rows: { month: number; interest: number; principal_paid: number; balance_after: number }[] = []
      for (let m = 1; m <= months && balance > 0; m++) {
        const interest = Math.round(balance * monthlyRate * 100) / 100
        const principalPaid = Math.min(balance, Math.round((payment - interest) * 100) / 100)
        balance = Math.round((balance - principalPaid) * 100) / 100
        rows.push({ month: m, interest, principal_paid: principalPaid, balance_after: balance })
      }
      return { name: l.name, starting_balance: Number(l.principal), monthly_payment: payment, schedule: rows }
    })
    return JSON.stringify({ source: 'LIVE_DB_COMPUTED', months_requested: months, loans: result })
  }
  if (name === 'semantic_search') {
    // Ranked поиск по основам слов. ilike по всей фразе не работал никогда:
    // «какие были договорённости по брокеру» целиком в тексте записи не встречается.
    // Основа 4 буквы решает русскую морфологию («займом»→«займ»), ё→е — разнописание.
    const norm = (t: string) => t.toLowerCase().replace(/ё/g, 'е')
    const STOP = new Set(['что','как','где','когда','какие','какой','какая','мои','моя','мне','меня',
      'был','было','были','там','это','для','про','его','она','они','тебе','ты','вот','или','нет'])
    const stems = norm(String(input.query ?? ''))
      .split(/[^a-zа-я0-9]+/)
      .filter(w => w.length > 2 && !STOP.has(w))
      .map(w => w.length > 4 ? w.slice(0, 4) : w)
    const { data: all } = await db().from('bot_memories')
      .select('content,category,importance')
      .eq('user_id', USER_ID)
      .order('importance', { ascending: false })
      .limit(50)
    const ranked = (all ?? [])
      .map(m => {
        const c = norm(String(m.content))
        return { ...m, score: stems.filter(st => c.includes(st)).length }
      })
      .filter(m => m.score > 0)
      .sort((a, b) => b.score - a.score || b.importance - a.importance)
      .slice(0, 5)
    return JSON.stringify({
      found: ranked.length,
      memories: ranked.map(m => ({ content: m.content, category: m.category, importance: m.importance })),
    })
  }
  // DB-writing tools
  resetActionFlags()
  // Централизованная защита: на сослагательный вопрос НИ ОДИН инструмент,
  // меняющий деньги, не должен сработать. Точечных проверок недостаточно —
  // модель обходила их, вызывая соседний инструмент (early_repay → update_loan).
  const MONEY_WRITES = new Set([
    'add_expense', 'add_multiday_expense', 'delete_expense', 'mark_card_payment',
    'early_repay', 'mark_loan_paid', 'update_loan', 'set_month_payment', 'mark_goal_bought', 'pay_card_debt', 'update_cash', 'manage_recurring_income', 'manage_debt_owed_to_me',
    'mark_fixed_paid', 'mark_fixed_paid_with_amount', 'mark_single_fixed',
    'set_balance', 'update_salary', 'mark_salary', 'mark_recurring_received',
    'record_vacation_pay', 'close_month', 'update_cashflow', 'add_income_event',
    'add_fixed_cost', 'remove_fixed_cost', 'edit_fixed_cost', 'update_revenue',
  ])
  if (MONEY_WRITES.has(name) && userText !== undefined && textIsHypothetical(userText)) {
    console.log(`[guard] ${name} заблокирован: сослагательный вопрос`)
    return JSON.stringify({
      saved: false,
      reason: `Операция «${name}» НЕ выполнена: вопрос сослагательный («если», «предположим», «стоит ли», «хватит ли»).`,
      what_to_do: 'Это запрос на РАСЧЁТ. Посчитай сценарий и покажи результат, прямо указав что данные НЕ изменены. Для применения пользователь скажет утвердительно («погаси», «запиши», «отметь»).',
    })
  }
  await executeAction({ type: name, ...input } as BotAction, userText)
  const unknownType = takeActionUnrecognized()
  if (unknownType) {
    return JSON.stringify({
      saved: false,
      reason: `«${unknownType}» НЕ реализован — такого действия не существует в системе. Ничего не произошло.`,
      what_to_do: 'НЕ говори пользователю что что-то удалено/изменено/выполнено. Скажи прямо: "у меня нет инструмента для этого", как учит правило честности.',
    })
  }
  const blocked = takeWriteBlocked()
  if (blocked) {
    if (blocked === 'early_repay:no_explicit_command') {
      return JSON.stringify({
        saved: false,
        reason: 'Досрочное погашение НЕ выполнено: в сообщении нет явной команды («погаси», «внеси», «оплати»).',
        what_to_do: 'Это был запрос на РАСЧЁТ. Покажи сценарий и явно скажи, что данные НЕ изменены. Если пользователь захочет применить — он напишет «погаси X».',
      })
    }
    if (blocked.endsWith(':no_amount_in_message')) {
      const toolName = blocked.split(':')[0]
      return JSON.stringify({
        saved: false,
        reason: `${toolName} НЕ выполнен: в сообщении пользователя нет суммы. Read-only вопросы ("покажи", "график", "прогноз") не повод менять хранимые данные.`,
        what_to_do: 'Если это был просто вопрос на чтение — ответь на него, ничего не нужно "чинить" или "синхронизировать" в БД. Данные уже верны, пока пользователь явно не прислал новую цифру.',
      })
    }
    return JSON.stringify({
      saved: false,
      reason: `Операция «${blocked}» НЕ выполнена: вопрос задан в сослагательном наклонении («если», «предположим», «стоит ли»).`,
      what_to_do: 'Это запрос на РАСЧЁТ, а не на изменение данных. Посчитай сценарий и покажи результат, явно указав что это прогноз и данные не изменены. Если пользователь захочет применить — он скажет утвердительно.',
    })
  }
  if (name === 'save_correction' && getCorrectionRejected()) {
    return JSON.stringify({
      saved: false,
      reason: 'Коррекция содержит конкретные суммы и НЕ сохранена. Числа хранятся только в БД.',
      what_to_do: 'Если цифра в БД неверна — исправь её инструментом (update_card_debt / update_loan / add_expense и т.п.). Если это правило поведения — переформулируй БЕЗ цифр и вызови save_correction ещё раз.',
    })
  }
  if (name === 'save_memory') {
    const outcome = takeMemoryOutcome()
    if (outcome === 'saved_money') {
      return JSON.stringify({
        saved: true,
        warning: 'Сохранено ТОЛЬКО как заметка в долгосрочной памяти. НЕ входит в баланс, ликвидность или прогноз — это не отслеживаемые данные. Явно скажи пользователю про это ограничение в ответе, а не просто "запомнил".',
      })
    }
    if (outcome === 'duplicate') {
      return JSON.stringify({ saved: false, reason: 'Очень похожая запись уже есть в памяти — новую не создал.' })
    }
    return JSON.stringify({ saved: outcome === 'saved' })
  }
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
async function runToolLoop(modelId: string, systemBlocks: unknown[], initialMessages: unknown[], userText?: string): Promise<{ text:string; actionsRun:string[] }> {
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
            const result = await handleTool(block.name, (block.input ?? {}) as Record<string,unknown>, userText)
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

function processWithModel(text: string, chatId: number, model: 'haiku'|'sonnet'): Promise<string> {
  // Изолируем состояние запроса: без этого параллельный запрос перезаписывал
  // userMessage и защиты читали чужой текст.
  return runInRequest(text, () => _processWithModel(text, chatId, model))
}
async function _processWithModel(text: string, chatId: number, model: 'haiku'|'sonnet'): Promise<string> {
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
  const modelId = model === 'sonnet' ? 'claude-sonnet-5' : 'claude-haiku-4-5-20251001'
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
  const { text: reply } = await runToolLoop(modelId, withPrefixCache(systemBlocks), messages, text)
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


// Версия processWithModel для тестов: НЕ сохраняет историю, НЕ загрязняет bot_messages
export function processWithModelForTest(text: string, _chatId: number): Promise<{ text: string; usage: Record<string, number> }> {
  return runInRequest(text, async () => {
    const reply = await _processWithModelForTest(text, _chatId)
    return { text: reply, usage: getReqUsage() }
  })
}
async function _processWithModelForTest(text: string, _chatId: number): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) return '⚠️ Добавь ANTHROPIC_API_KEY в Vercel.'
  const model = routeModel(text)
  const needAnalysis = /проанализир|анализ трат|паттерн/i.test(text)
  const isFinancial = /дебет|бюджет|бонус|баланс|трат|потрач|осталось|доход|аванс|зп|зарплат|кредит|карт|финан/i.test(text)
  const isLoans = /кредит|долг|погаш|рефинанс|займ/i.test(text)
  const [context, analysis, forcedFinData, forcedLoans] = await Promise.all([
    getContext(),
    needAnalysis ? getSpendingAnalysis() : Promise.resolve(''),
    isFinancial ? getFinancialSummaryJson().catch(() => '') : Promise.resolve(''),
    isLoans ? getLoansSummaryJson().catch(() => '') : Promise.resolve(''),
  ])
  const fullContext = context + (analysis ? '\n\n' + analysis : '')
  const modelId = model === 'sonnet' ? 'claude-sonnet-5' : 'claude-haiku-4-5-20251001'
  const systemBlocks: unknown[] = [
    { type:'text', text:SYSTEM_PROMPT, cache_control:{type:'ephemeral'} },
    { type:'text', text:'\n\nКОНТЕКСТ:\n'+fullContext },
  ]
  if (forcedLoans) systemBlocks.push({ type:'text', text:'\n\n╔══ КРЕДИТЫ ИЗ БД ══╗\n'+forcedLoans })
  if (forcedFinData) systemBlocks.push({ type:'text', text:'\n\n╔══ ДАННЫЕ ИЗ БД ══╗\n'+forcedFinData })
  const messages = [{ role:'user' as const, content:text }]  // БЕЗ истории
  const { text: reply } = await runToolLoop(modelId, withPrefixCache(systemBlocks), messages, text)
  // НЕ сохраняем историю — тест изолирован
  return reply
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
    const { text: reply } = await runToolLoop('claude-sonnet-5', withPrefixCache(systemBlocks), messages, userText)
    Promise.all([saveHistory(chatId,'user',`[фото: ${userText}]`), saveHistory(chatId,'assistant',reply)]).catch(()=>{})
    return reply
  } catch(err) { console.error('[vision]',err); return '❌ Ошибка чтения.' }
}

// Возвращает null если дайджест собрать не удалось (нет ключа / нет кредитов / ошибка API).
// null = НЕ отправлять ничего. Пустое «Доброе утро!» без данных — мусор в Telegram.
export async function generateMorningBriefing(isWeekly = false): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null
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
      model: isWeekly ? 'claude-sonnet-5' : 'claude-haiku-4-5-20251001',
      max_tokens:800,
      system:[
        {type:'text',text:SYSTEM_PROMPT,cache_control:{type:'ephemeral'}},
        {type:'text',text:'\n\nКОНТЕКСТ:\n'+context}
      ],
      messages:[{role:'user',content:prompt}]
    }))
  })
  const data = await res.json()
  if (data.error) {
    console.error('[morning] Anthropic API error:', data.error?.type, data.error?.message)
    return null
  }
  const text = data.content?.[0]?.text
  return (typeof text === 'string' && text.trim().length > 0) ? text : null
}




