/**
 * Finance Cockpit Telegram Bot — v2
 * Smart NL parsing via Claude Haiku + Whisper voice + full action set
 */
import { createClient } from '@supabase/supabase-js'

const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'
const TG_URL = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`

// ── Supabase admin (bypasses RLS) ─────────────────────────────────────────
function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function currentMK(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function rub(n: number): string {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽'
}

// ── Intent types ──────────────────────────────────────────────────────────
interface Intent {
  action: 'add_expense'|'add_client'|'get_status'|'get_loans'|'get_cashflow'
        |'get_daily'|'get_goals'|'add_goal'|'help'|'get_analytics'
  amount?: number
  category?: string
  description?: string
  grade?: string
  revenue?: number
  goal_name?: string
  goal_month?: string
}

// ── Claude API intent parsing ─────────────────────────────────────────────
const PARSE_PROMPT = `Ты парсер финансовых сообщений на русском. Возвращай ТОЛЬКО JSON.

Действия:
- add_expense: трата/покупка/расход (amount, category, description)
- add_client: закрыл клиента, сделка (grade: g3/g4/g56/g78/g9/g10, revenue)
- get_status: баланс, деньги, статус
- get_loans: кредиты, долги, займы
- get_cashflow: план месяца, кешфлоу, прогноз
- get_daily: дневной бюджет, сколько тратить
- get_goals: цели, покупки, планы
- add_goal: хочу купить что-то (goal_name, amount, goal_month: YYYY-MM или null)
- get_analytics: аналитика, сравнение месяцев
- help: помощь, не знаю

Категории трат: Еда и кафе, Транспорт, Здоровье, Развлечения, Одежда, Прочее

Примеры:
"потратил 800 на такси" → {"action":"add_expense","amount":800,"category":"Транспорт","description":"такси"}
"закрыл клиента г10 выручка 80000" → {"action":"add_client","grade":"g10","revenue":80000}
"сколько денег" → {"action":"get_status"}
"хочу купить телефон 50000 в июле" → {"action":"add_goal","goal_name":"Телефон","amount":50000,"goal_month":"2026-07"}`

async function parseWithClaude(text: string): Promise<Intent | null> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 200,
        system: PARSE_PROMPT,
        messages: [{ role: 'user', content: text }]
      })
    })
    const data = await res.json()
    const raw = data.content?.[0]?.text ?? ''
    const json = raw.match(/\{[\s\S]*\}/)?.[0]
    return json ? JSON.parse(json) : null
  } catch { return null }
}

// ── Regex fallback parser ─────────────────────────────────────────────────
const GRADE_MAP: Record<string, string> = {
  'г3':'g3','гр3':'g3','g3':'g3',
  'г4':'g4','гр4':'g4','g4':'g4',
  'г5':'g56','г6':'g56','гр5':'g56','гр6':'g56','g5':'g56','g6':'g56',
  'г7':'g78','г8':'g78','гр7':'g78','гр8':'g78','g7':'g78','g8':'g78',
  'г9':'g9','гр9':'g9','g9':'g9',
  'г10':'g10','гр10':'g10','g10':'g10',
}

function guessCategory(desc: string): string {
  const d = desc.toLowerCase()
  if (/кофе|кафе|ресторан|еда|обед|ужин|завтрак|продукт|магазин|перекус|пицца|суши/.test(d)) return 'Еда и кафе'
  if (/такси|убер|uber|яндекс.го|метро|автобус|маршрут|транспорт|электричка|каршер/.test(d)) return 'Транспорт'
  if (/аптека|лекарств|здоровь|врач|стоматолог|клиник/.test(d)) return 'Здоровье'
  if (/кино|театр|развлеч|игр|спорт|концерт|бар/.test(d)) return 'Развлечения'
  if (/одежда|обувь|шопинг/.test(d)) return 'Одежда'
  return 'Прочее'
}

function parseRegex(text: string): Intent {
  const t = text.toLowerCase().trim()
  if (['/start','/help','помощь','команды'].includes(t)) return { action: 'help' }
  if (['/status','/stat','баланс','деньги','сколько денег','статус'].some(k => t.includes(k))) return { action: 'get_status' }
  if (['/loans','/debt','кредит','долг','займ'].some(k => t.includes(k))) return { action: 'get_loans' }
  if (['/cashflow','/plan','план','прогноз','кешфлоу','водопад'].some(k => t.includes(k))) return { action: 'get_cashflow' }
  if (['/budget','/день','бюджет','дневной'].some(k => t.includes(k))) return { action: 'get_daily' }
  if (['/goals','/цели','цел','покупк'].some(k => t.includes(k))) return { action: 'get_goals' }
  if (['/analytics','аналитик','сравнен'].some(k => t.includes(k))) return { action: 'get_analytics' }

  // Client: "закрыл г10", "клиент г3 выручка 7200"
  const clientRe = /(?:закрыл|клиент|сделка|добавил)\s+(?:клиента?\s+)?([а-яёg\d]+)(?:.*?(?:выручк[аи]|revenue|выр)[\s:]*(\d+))?/i
  const cm = t.match(clientRe)
  if (cm) {
    const gradeKey = cm[1].toLowerCase().replace(/\s/g,'')
    const grade = GRADE_MAP[gradeKey]
    if (grade) return { action: 'add_client', grade, revenue: cm[2] ? parseInt(cm[2]) : undefined }
  }

  // Expense: "списал 800 на кофе", "потратил 1200", "-500 такси"
  const expRe = /(?:списал|потратил|трата|расход|купил|заплатил|-)\s*(\d[\d\s]*)\s*(?:р(?:уб)?\.?|₽)?(?:\s+(?:на|за|в)?\s*(.+))?/i
  const em = t.match(expRe)
  if (em) {
    const amount = parseInt(em[1].replace(/\s/g,''))
    const raw = (em[2] ?? '').replace(/\s*р\.?\s*$/,'').trim()
    if (amount > 0) return { action: 'add_expense', amount, description: raw, category: guessCategory(raw) }
  }

  // "хочу купить X за N"
  const goalRe = /(?:хочу|хочется|планирую)\s+(?:купить\s+)?(.+?)\s+(?:за|на)\s+(\d[\d\s]*)/i
  const gm = t.match(goalRe)
  if (gm) return { action: 'add_goal', goal_name: gm[1].trim(), amount: parseInt(gm[2].replace(/\s/g,'')) }

  return { action: 'help' }
}

export async function parseIntent(text: string): Promise<Intent> {
  // Try Claude first
  const claude = await parseWithClaude(text)
  if (claude?.action) return claude
  // Fallback to regex
  return parseRegex(text)
}

// ── Voice transcription (Whisper) ─────────────────────────────────────────
export async function transcribeVoice(fileId: string): Promise<string | null> {
  const openaiKey = process.env.OPENAI_API_KEY
  if (!openaiKey) return null
  try {
    // Get Telegram file path
    const fileRes = await fetch(`${TG_URL}/getFile?file_id=${fileId}`)
    const { result } = await fileRes.json()
    if (!result?.file_path) return null

    // Download audio
    const audioRes = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${result.file_path}`)
    const audioBuffer = await audioRes.arrayBuffer()

    // Send to Whisper
    const form = new FormData()
    form.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg')
    form.append('model', 'whisper-1')
    form.append('language', 'ru')
    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { 'Authorization': `Bearer ${openaiKey}` }, body: form
    })
    const { text } = await whisperRes.json()
    return text ?? null
  } catch { return null }
}

// ── Handlers ──────────────────────────────────────────────────────────────

export async function handleGetStatus(): Promise<string> {
  const db = sb()
  const mk = currentMK()
  const [{ data: user }, { data: loans }, { data: expenses }, { data: month }] = await Promise.all([
    db.from('users').select('debit_balance,tbank_debit,var_budget,fixed_costs').eq('id', USER_ID).single(),
    db.from('loans').select('principal,accrued_int,min_payment').eq('user_id', USER_ID),
    db.from('expenses').select('amount').eq('user_id', USER_ID).eq('month_key', mk),
    db.from('months').select('salary_adv_received,salary_eom_received,salary_adv_amount').eq('user_id', USER_ID).eq('month_key', mk).maybeSingle(),
  ])
  if (!user) return '❌ Данные не найдены'

  const liquid = Number(user.debit_balance ?? 0) + Number(user.tbank_debit ?? 0)
  const totalDebt = (loans ?? []).reduce((s,l) => s + Number(l.principal) + Number(l.accrued_int), 0)
  const totalPay = (loans ?? []).reduce((s,l) => s + Number(l.min_payment), 0)
  const varSpent = (expenses ?? []).reduce((s,e) => s + Number(e.amount), 0)
  const varBudget = Number(user.var_budget ?? 40000)
  const varLeft = Math.max(0, varBudget - varSpent)
  const today = new Date().getDate()
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth()+1, 0).getDate()
  const daysLeft = daysInMonth - today + 1
  const daily = Math.round(varLeft / Math.max(1, daysLeft))
  const pct = Math.min(100, Math.round(varSpent / varBudget * 100))
  const progressBar = '█'.repeat(Math.round(pct/10)) + '░'.repeat(10 - Math.round(pct/10))

  const lines = [
    `💰 *Статус · ${today} июня*`,
    ``,
    `🏦 Ликвидность: *${rub(liquid)}*`,
  ]
  if ((user.tbank_debit ?? 0) > 0) lines.push(`   Сбер ${rub(user.debit_balance)} · Т-Банк ${rub(user.tbank_debit ?? 0)}`)
  lines.push(
    ``,
    `📊 Переменные: ${progressBar} ${pct}%`,
    `   ${rub(varSpent)} из ${rub(varBudget)}`,
    `⚡ Дневной бюджет: *${rub(daily)}*  (${daysLeft} дн.)`,
    ``,
    `💳 Долг: *${rub(totalDebt)}*  ·  плат. ${rub(totalPay)}/мес`,
  )
  if (!month?.salary_adv_received) lines.push(``, `⏰ Аванс ещё не получен`)
  return lines.join('\n')
}

export async function handleAddExpense(amount: number, category: string, desc: string): Promise<string> {
  if (!amount || amount <= 0) return '❌ Не понял сумму. Пример: *«потратил 800 на кофе»*'
  const db = sb()
  const mk = currentMK()
  const today = new Date().toISOString().split('T')[0]

  await db.from('expenses').insert({
    user_id: USER_ID, month_key: mk, expense_date: today,
    category: category || 'Прочее', amount: Math.round(amount),
    description: desc || null, source_type: 'debit',
  })

  const { data: u } = await db.from('users').select('debit_balance,var_budget').eq('id', USER_ID).single()
  const newDebit = Math.round((Number(u?.debit_balance ?? 0) - amount) * 100) / 100
  await db.from('users').update({ debit_balance: newDebit, debit_updated_at: new Date().toISOString() }).eq('id', USER_ID)

  const { data: all } = await db.from('expenses').select('amount').eq('user_id', USER_ID).eq('month_key', mk)
  const varSpent = (all ?? []).reduce((s,e) => s + Number(e.amount), 0)
  const varLeft = Math.max(0, (u?.var_budget ?? 40000) - varSpent)
  const daysLeft = new Date(new Date().getFullYear(), new Date().getMonth()+1, 0).getDate() - new Date().getDate() + 1
  const daily = Math.round(varLeft / Math.max(1, daysLeft))
  const label = category !== 'Прочее' ? category : (desc || 'Прочее')

  return [
    `✅ *${label} · ${rub(amount)}*`,
    ``,
    `Дебет: ${rub(newDebit)}`,
    `Осталось на переменные: ${rub(varLeft)}`,
    `Дневной бюджет: *${rub(daily)}* / день`,
  ].join('\n')
}

export async function handleAddClient(grade: string, revenue?: number): Promise<string> {
  if (!grade) return '❌ Не понял грейд. Пример: *«закрыл клиента г10»*'
  const db = sb()
  const mk = currentMK()

  const { data: month } = await db.from('months').select('clients,revenue').eq('user_id', USER_ID).eq('month_key', mk).maybeSingle()
  const clients = { ...(month?.clients as Record<string, number> ?? {}), [grade]: ((month?.clients as Record<string, number> ?? {})[grade] ?? 0) + 1 }
  const { data: user } = await db.from('users').select('nominals,threshold,margin_share,moment_share,ytd_gross,salary_gross').eq('id', USER_ID).single()

  let newRevenue = Number(month?.revenue ?? 41666)
  if (revenue) newRevenue += revenue

  if (month) {
    await db.from('months').update({ clients, revenue: newRevenue }).eq('user_id', USER_ID).eq('month_key', mk)
  } else {
    await db.from('months').insert({ user_id: USER_ID, month_key: mk, clients, revenue: newRevenue })
  }

  // Compute bonus projection
  const nominals = user?.nominals as Record<string, number> ?? {}
  const clientPot = Object.entries(clients).reduce((s, [g, n]) => s + (nominals[g] ?? 0) * n, 0)
  const revenuePot = newRevenue * Number(user?.margin_share ?? 0.20)
  const pot = clientPot + revenuePot
  const threshold = Number(user?.threshold ?? 56000)
  const excess = Math.max(0, pot - threshold)
  const momentShare = Number(user?.moment_share ?? 0.80)
  const moment = excess * momentShare
  // Simplified net (rough NDFL 13%)
  const netBonus = Math.round(moment * 0.87)

  const gradeLabel = grade.replace('g', 'Г').replace('56', '5-6').replace('78', '7-8')
  const clientList = Object.entries(clients).map(([g, n]) => `${g.replace('g','Г')}×${n}`).join(', ')

  return [
    `🎯 *Клиент ${gradeLabel} добавлен${revenue ? ` · +${rub(revenue)} выручка` : ''}*`,
    ``,
    `Клиентов в ${mk}: ${clientList}`,
    `Выручка месяца: ${rub(newRevenue)}`,
    ``,
    `📈 Прогноз бонуса (после ЗП):`,
    `   Котёл: ${rub(pot)} · порог ${rub(threshold)}`,
    `   Сверхпорог: ${rub(excess)}`,
    `   Бонус на руки: *~${rub(netBonus)}*`,
  ].join('\n')
}

export async function handleGetLoans(): Promise<string> {
  const db = sb()
  const { data: loans } = await db.from('loans').select('*').eq('user_id', USER_ID).order('sort_order')
  if (!loans?.length) return '🎉 Кредитов нет!'

  const now = new Date()
  const totalDebt = loans.reduce((s,l) => s + Number(l.principal) + Number(l.accrued_int), 0)
  const totalPay = loans.reduce((s,l) => s + Number(l.min_payment), 0)

  const lines: string[] = [`🏦 *Кредиты*`, ``]
  for (const l of loans) {
    const total = Number(l.principal) + Number(l.accrued_int)
    const pctPaid = Math.round((Number(l.original_amt) - Number(l.principal)) / Number(l.original_amt) * 100)
    let months = ''
    if (l.end_date) {
      const end = new Date(l.end_date)
      const m = (end.getFullYear() - now.getFullYear()) * 12 + end.getMonth() - now.getMonth()
      months = ` · ${m} мес`
    }
    const due = l.due_day === 'last' ? 'конец мес.' : `${l.due_day} числа`
    lines.push(`*${l.name}*: ${rub(total)}`)
    lines.push(`   ${(Number(l.rate)*100).toFixed(2)}% · платёж ${rub(Number(l.min_payment))} (${due})${months} · погашено ${pctPaid}%`)
    lines.push(``)
  }
  lines.push(`Итого: *${rub(totalDebt)}*  ·  платёж/мес *${rub(totalPay)}*`)

  return lines.join('\n')
}

export async function handleGetCashflow(): Promise<string> {
  const db = sb()
  const mk = currentMK()
  const [{ data: user }, { data: loans }, { data: expenses }, { data: month }] = await Promise.all([
    db.from('users').select('*').eq('id', USER_ID).single(),
    db.from('loans').select('*').eq('user_id', USER_ID).order('sort_order'),
    db.from('expenses').select('amount').eq('user_id', USER_ID).eq('month_key', mk),
    db.from('months').select('*').eq('user_id', USER_ID).eq('month_key', mk).maybeSingle(),
  ])
  if (!user) return '❌ Ошибка'

  const start = Number(user.debit_balance ?? 0) + Number(user.tbank_debit ?? 0)
  const adv = Number(month?.salary_adv_amount ?? 60800)
  const eom = Number(month?.salary_eom_amount ?? 60800)
  // Bonus from prev month clients (simplified)
  const bonus = 25010 // last computed
  const totalLoans = (loans ?? []).reduce((s,l) => s + Number(l.min_payment), 0)
  const fixedCosts = (user.fixed_costs as {amount:number}[] ?? []).reduce((s,f) => s + f.amount, 0)
  const varSpent = (expenses ?? []).reduce((s,e) => s + Number(e.amount), 0)
  const projEnd = start + adv + eom + bonus - totalLoans - fixedCosts - varSpent

  return [
    `📊 *Кешфлоу июня*`,
    ``,
    `Старт: ${rub(start)}`,
    `+ Аванс: ${rub(adv)}${month?.salary_adv_received ? ' ✅' : ' ⏳'}`,
    `+ Зарплата: ${rub(eom)}${month?.salary_eom_received ? ' ✅' : ' ⏳'}`,
    `+ Бонус: ${rub(bonus)}`,
    `− Кредиты: ${rub(totalLoans)}`,
    `− Постоянные: ${rub(fixedCosts)}`,
    `− Переменные: ${rub(varSpent)}`,
    ``,
    `═══════════════`,
    `*Остаток к концу: ${rub(projEnd)}*`,
  ].join('\n')
}

export async function handleGetDaily(): Promise<string> {
  const db = sb()
  const mk = currentMK()
  const [{ data: u }, { data: expenses }] = await Promise.all([
    db.from('users').select('var_budget').eq('id', USER_ID).single(),
    db.from('expenses').select('amount').eq('user_id', USER_ID).eq('month_key', mk),
  ])
  const varBudget = Number(u?.var_budget ?? 40000)
  const varSpent = (expenses ?? []).reduce((s,e) => s + Number(e.amount), 0)
  const varLeft = Math.max(0, varBudget - varSpent)
  const today = new Date().getDate()
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth()+1, 0).getDate()
  const daysLeft = daysInMonth - today + 1
  const daily = Math.round(varLeft / Math.max(1, daysLeft))
  const pct = Math.round(varSpent/varBudget*100)

  return [
    `⚡ *Дневной бюджет: ${rub(daily)}*`,
    ``,
    `Лимит: ${rub(varBudget)}`,
    `Потрачено: ${rub(varSpent)} (${pct}%)`,
    `Осталось: ${rub(varLeft)} на ${daysLeft} дней`,
  ].join('\n')
}

export async function handleGetGoals(): Promise<string> {
  const db = sb()
  const mk = currentMK()
  const { data: goals } = await db.from('goals').select('*').eq('user_id', USER_ID).order('sort_order')
  if (!goals?.length) return '🎯 Целей пока нет\n\nДобавь: *«хочу купить телефон за 50000»*'

  const planned = goals.filter(g => g.month_key === mk && !g.purchased)
  const savings = goals.filter(g => !g.month_key)
  const bought = goals.filter(g => g.purchased)

  const lines: string[] = [`🎯 *Цели*`, ``]
  if (planned.length) {
    lines.push(`*Плановые (${mk.split('-')[1]}):*`)
    planned.forEach(g => lines.push(`• ${g.name}: ${rub(g.amount)}`))
    lines.push(``)
  }
  if (savings.length) {
    lines.push(`*Накопления:*`)
    savings.forEach(g => lines.push(`• ${g.name}: ${rub(g.amount)}`))
    lines.push(``)
  }
  if (bought.length) {
    lines.push(`*Куплено ✅:*`)
    bought.slice(-3).forEach(g => lines.push(`• ~~${g.name}~~: ${rub(g.amount)}`))
  }
  return lines.join('\n')
}

export async function handleAddGoal(name: string, amount: number, goalMonth?: string): Promise<string> {
  if (!name || !amount) return '❌ Не понял. Пример: *«хочу купить телефон за 50000 в июле»*'
  const db = sb()
  const mk = goalMonth ?? null
  await db.from('goals').insert({ user_id: USER_ID, name, amount: Math.round(amount), month_key: mk, sort_order: 99 })
  const where = mk ? `в плановые ${mk}` : 'в накопления'
  return [`✅ *${name} · ${rub(amount)}*`, ``, `Добавлено ${where}`, `Управление: Finance Cockpit → Цели`].join('\n')
}

export async function handleGetAnalytics(): Promise<string> {
  const db = sb()
  const { data: months } = await db.from('months').select('month_key,revenue,clients,bonus_amount').eq('user_id', USER_ID).order('month_key', { ascending: false }).limit(3)
  if (!months?.length) return '📊 Пока недостаточно данных для аналитики'

  const lines = [`📊 *Аналитика*`, ``]
  for (const m of months) {
    const clients = Object.values(m.clients as Record<string,number> ?? {}).reduce((s,n)=>s+n,0)
    const bonus = m.bonus_amount ? rub(m.bonus_amount) : '—'
    lines.push(`*${m.month_key}*: выручка ${rub(m.revenue)} · ${clients} кл. · бонус ${bonus}`)
  }
  return lines.join('\n')
}

export function handleHelp(): string {
  const hasVoice = !!process.env.OPENAI_API_KEY
  const hasClaude = !!process.env.ANTHROPIC_API_KEY
  return [
    `🤖 *Finance Cockpit Bot*`,
    hasClaude ? `✨ _Умный режим: понимаю любые фразы_` : `_Режим: команды и шаблоны_`,
    hasVoice ? `🎙 _Голосовые сообщения поддерживаются_` : '',
    ``,
    `📊 *Информация:*`,
    `/status — баланс и сводка`,
    `/loans — кредиты`,
    `/budget — дневной бюджет`,
    `/cashflow — план месяца`,
    `/goals — цели и покупки`,
    `/analytics — аналитика`,
    ``,
    `💸 *Записать трату:*`,
    `_«потратил 800 на кофе»_`,
    `_«списал 1200 такси»_`,
    ``,
    `🎯 *Сделки:*`,
    `_«закрыл клиента г10»_`,
    `_«закрыл г3 выручка 7200»_`,
    ``,
    `🛍 *Цель:*`,
    `_«хочу купить телефон за 50000»_`,
  ].filter(Boolean).join('\n')
}

// ── Telegram send ─────────────────────────────────────────────────────────
export async function sendTelegram(chatId: number, text: string): Promise<void> {
  await fetch(`${TG_URL}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId, text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  })
}
