/**
 * Finance Cockpit Bot — Smart Agent v3
 * Claude Haiku отвечает с полным финансовым контекстом + памятью разговора
 * Groq Whisper для голосовых (бесплатно)
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'
const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`

function db(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function mk(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
}

function rub(n: number): string {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽'
}

// ── История разговора ─────────────────────────────────────────────────────
async function getHistory(chatId: number): Promise<{role: string; content: string}[]> {
  const { data } = await db()
    .from('bot_messages')
    .select('role,content')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: false })
    .limit(10)
  return (data ?? []).reverse()
}

async function saveHistory(chatId: number, role: 'user'|'assistant', content: string) {
  await db().from('bot_messages').insert({ chat_id: chatId, user_id: USER_ID, role, content })
}

// ── Текущий финансовый контекст ───────────────────────────────────────────
async function getContext(): Promise<string> {
  const supabase = db()
  const monthKey = mk()
  const [
    { data: user }, { data: loans }, { data: expenses },
    { data: month }, { data: goals }, { data: recentExp }
  ] = await Promise.all([
    supabase.from('users').select('*').eq('id', USER_ID).single(),
    supabase.from('loans').select('name,principal,accrued_int,min_payment,end_date,rate').eq('user_id', USER_ID).order('sort_order'),
    supabase.from('expenses').select('amount').eq('user_id', USER_ID).eq('month_key', monthKey),
    supabase.from('months').select('*').eq('user_id', USER_ID).eq('month_key', monthKey).maybeSingle(),
    supabase.from('goals').select('name,amount,month_key,purchased').eq('user_id', USER_ID).eq('purchased', false).limit(5),
    supabase.from('expenses').select('category,amount,description,expense_date').eq('user_id', USER_ID).eq('month_key', monthKey).order('expense_date', { ascending: false }).limit(5),
  ])

  if (!user) return 'Данные не загружены'

  const liquid = Number(user.debit_balance ?? 0) + Number(user.tbank_debit ?? 0)
  const varBudget = Number(user.var_budget ?? 40000)
  const varSpent = (expenses ?? []).reduce((s,e) => s+Number(e.amount), 0)
  const varLeft = Math.max(0, varBudget - varSpent)
  const today = new Date().getDate()
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth()+1, 0).getDate()
  const daysLeft = daysInMonth - today + 1
  const daily = Math.round(varLeft / Math.max(1, daysLeft))
  const totalDebt = (loans ?? []).reduce((s,l) => s+Number(l.principal)+Number(l.accrued_int), 0)
  const totalPay = (loans ?? []).reduce((s,l) => s+Number(l.min_payment), 0)
  const adv = Number(month?.salary_adv_amount ?? 60800)
  const eom = Number(month?.salary_eom_amount ?? 60800)
  const bonus = 25010 // from May

  const loanLines = (loans ?? []).map(l => {
    const total = Number(l.principal) + Number(l.accrued_int)
    let months = ''
    if (l.end_date) {
      const end = new Date(l.end_date)
      const now = new Date()
      const m = (end.getFullYear()-now.getFullYear())*12 + end.getMonth()-now.getMonth()
      months = ` (${m} мес)`
    }
    return `  - ${l.name}: ${rub(total)} @ ${(Number(l.rate)*100).toFixed(2)}%${months}, платёж ${rub(Number(l.min_payment))}/мес`
  }).join('\n')

  const expLines = (recentExp ?? []).length
    ? (recentExp ?? []).map(e => `  - ${e.category}: ${rub(e.amount)}${e.description ? ' ('+e.description+')' : ''}`).join('\n')
    : '  (трат пока нет)'

  const goalLines = (goals ?? []).length
    ? (goals ?? []).filter(g => !g.purchased).slice(0,3).map(g => `  - ${g.name}: ${rub(g.amount)}${g.month_key ? ' ('+g.month_key+')' : ''}`).join('\n')
    : '  нет активных целей'

  const clients = month?.clients ? JSON.stringify(month.clients) : '{}'
  const revenue = Number(month?.revenue ?? 41666)
  const nominals = user.nominals as Record<string,number> ?? {}
  const clientsObj = month?.clients as Record<string,number> ?? {}
  const pot = Object.entries(clientsObj).reduce((s,[g,n])=>s+(nominals[g]??0)*n,0) + revenue*(Number(user.margin_share)??0.20)
  const bonusNet = Math.round(Math.max(0,(pot-(Number(user.threshold)??56000)))*(Number(user.moment_share)??0.80)*0.87)

  return `ДАТА: ${new Date().toLocaleDateString('ru-RU', {day:'numeric',month:'long',year:'numeric'})}
МОИ ФИНАНСЫ:
- Ликвидность: ${rub(liquid)} (Сбер: ${rub(user.debit_balance)}, Т-Банк: ${rub(user.tbank_debit??0)})
- Переменные: потрачено ${rub(varSpent)} из ${rub(varBudget)} (осталось ${rub(varLeft)})
- Дневной бюджет: ${rub(daily)}/день (${daysLeft} дней до конца месяца)

ИЮНЬ — ПЛАН:
- Аванс ${rub(adv)} (15-е)${month?.salary_adv_received ? ' ✅' : ' ⏳'}
- ЗП ${rub(eom)} + бонус ${rub(bonus)} (30-е)${month?.salary_eom_received ? ' ✅' : ' ⏳'}
- Клиенты этого месяца: ${clients}, выручка: ${rub(revenue)}
- Прогноз бонуса: ~${rub(bonusNet)}

КРЕДИТЫ (итого: ${rub(totalDebt)}, платёж: ${rub(totalPay)}/мес):
${loanLines}

ПОСЛЕДНИЕ ТРАТЫ:
${expLines}

АКТИВНЫЕ ЦЕЛИ:
${goalLines}`
}

// ── Умный агент — главная функция ─────────────────────────────────────────
const SYSTEM = `Ты — Финансовый ИИ-ассистент Александра. Говоришь по-русски, кратко (2-4 предложения), с эмодзи. Александр работает в инвестиционном доме АТОН, продажи.

ПРАВИЛА:
1. Отвечай ТОЛЬКО на то о чём спросили. Кратко.
2. Если "подробнее", "расскажи больше", "?" — УТОЧНИ о чём или расскажи подробнее о последней теме из истории диалога
3. Трату записывай ТОЛЬКО если явно сказано: потратил/купил/заплатил/списал/трата. НЕ записывай при "подробнее", "расскажи", общих вопросах
4. При записи действий — считай результат математически и скажи итог пользователю
5. "Отмени", "отменить", "undo" — команда отмены последнего действия

ДОСТУПНЫЕ ДЕЙСТВИЯ — включай в ответ если нужно:
Если нужно записать действие, добавь В САМЫЙ КОНЕЦ ответа ровно одну строку (пользователь не видит):
ACTION:{"type":"add_expense","amount":800,"category":"Транспорт","description":"такси"}
ACTION:{"type":"add_client","grade":"g10","revenue":80000}
ACTION:{"type":"add_goal","name":"Телефон","amount":50000,"month_key":null}
ACTION:{"type":"undo"}

Категории трат: Еда и кафе, Транспорт, Здоровье, Развлечения, Одежда, Прочее
Грейды клиентов: g3(7200₽), g4, g56, g78, g9, g10(80000₽)
`

interface BotAction {
  type: 'add_expense'|'add_client'|'add_goal'|'undo'
  amount?: number; category?: string; description?: string
  grade?: string; revenue?: number
  name?: string; month_key?: string|null
}

export async function processMessage(text: string, chatId: number): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return fallbackProcess(text, chatId)

  // Fetch context + history in parallel
  const [context, history] = await Promise.all([getContext(), getHistory(chatId)])

  const messages = [
    ...history.map(h => ({ role: h.role as 'user'|'assistant', content: h.content })),
    { role: 'user' as const, content: text }
  ]

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: SYSTEM + '\n\nКОНТЕКСТ (актуально сейчас):\n' + context,
      messages,
    })
  })

  const data = await res.json()
  const fullReply: string = data.content?.[0]?.text ?? '❌ Ошибка ответа'

  // Extract and execute action if present
  const actionMatch = fullReply.match(/^ACTION:(\{.+\})$/m)
  const reply = fullReply.replace(/^ACTION:\{.+\}$/m, '').trim()
  
  if (actionMatch) {
    try {
      const action: BotAction = JSON.parse(actionMatch[1])
      await executeAction(action)
    } catch (e) {
      console.error('[Bot action parse error]', e)
    }
  }

  // Save to history
  await Promise.all([
    saveHistory(chatId, 'user', text),
    saveHistory(chatId, 'assistant', reply),
  ])

  return reply
}

async function executeAction(action: BotAction): Promise<void> {
  const supabase = db()
  const monthKey = mk()
  const today = new Date().toISOString().split('T')[0]

  if (action.type === 'add_expense' && action.amount) {
    await supabase.from('expenses').insert({
      user_id: USER_ID, month_key: monthKey, expense_date: today,
      category: action.category ?? 'Прочее', amount: Math.round(action.amount),
      description: action.description ?? null, source_type: 'debit',
    })
    const { data: u } = await supabase.from('users').select('debit_balance').eq('id', USER_ID).single()
    const newDebit = Math.round((Number(u?.debit_balance ?? 0) - action.amount) * 100) / 100
    await supabase.from('users').update({ debit_balance: newDebit, debit_updated_at: new Date().toISOString() }).eq('id', USER_ID)
  }

  if (action.type === 'add_client' && action.grade) {
    const { data: month } = await supabase.from('months').select('clients,revenue').eq('user_id', USER_ID).eq('month_key', monthKey).maybeSingle()
    const clients = { ...(month?.clients as Record<string,number> ?? {}), [action.grade]: ((month?.clients as Record<string,number> ?? {})[action.grade] ?? 0) + 1 }
    const newRevenue = Number(month?.revenue ?? 41666) + (action.revenue ?? 0)
    if (month) {
      await supabase.from('months').update({ clients, revenue: newRevenue }).eq('user_id', USER_ID).eq('month_key', monthKey)
    } else {
      await supabase.from('months').insert({ user_id: USER_ID, month_key: monthKey, clients, revenue: newRevenue })
    }
  }

  if (action.type === 'add_goal' && action.name && action.amount) {
    await supabase.from('goals').insert({ user_id: USER_ID, name: action.name, amount: Math.round(action.amount), month_key: action.month_key ?? null, sort_order: 99 })
  }

  if (action.type === 'undo') {
    const { data: snap } = await supabase.from('undo_snapshots').select('*').eq('user_id', USER_ID).order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (snap) {
      const s = snap.snapshot as Record<string, unknown>
      if (s.users) { const u = {...(s.users as Record<string,unknown>)}; delete u.id; await supabase.from('users').update(u).eq('id', USER_ID) }
      await supabase.from('expenses').delete().eq('user_id', USER_ID)
      await supabase.from('income_events').delete().eq('user_id', USER_ID)
      await supabase.from('goals').delete().eq('user_id', USER_ID)
      await supabase.from('loans').delete().eq('user_id', USER_ID)
      await supabase.from('months').delete().eq('user_id', USER_ID)
      await supabase.from('cards').delete().eq('user_id', USER_ID)
      for (const table of ['cards','months','loans','goals','expenses','income_events']) {
        const rows = s[table] as Record<string,unknown>[]|undefined
        if (rows?.length) await supabase.from(table).insert(rows)
      }
      await supabase.from('undo_snapshots').delete().eq('id', snap.id)
    }
  }
}

// ── Fallback без API ключа (regex) ────────────────────────────────────────
async function fallbackProcess(text: string, chatId: number): Promise<string> {
  const t = text.toLowerCase().trim()
  if (['/start','/help'].includes(t) || t.includes('помощ')) return `🤖 Добавь ANTHROPIC_API_KEY в Vercel для умного режима.\n\nПока работаю в режиме команд:\n/status — баланс\n/loans — кредиты\n/budget — бюджет\n\nТрата: «потратил 800 кофе»`
  return `⚠️ Умный режим выключен. Добавь ANTHROPIC_API_KEY в Vercel Settings.\n\nИспользуй команды: /status /loans /budget`
}

// ── Голос: Groq Whisper (бесплатно) или OpenAI ───────────────────────────
export async function transcribeVoice(fileId: string): Promise<string | null> {
  const groqKey = process.env.GROQ_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY
  if (!groqKey && !openaiKey) return null

  try {
    const fileRes = await fetch(`${TG}/getFile?file_id=${fileId}`)
    const { result } = await fileRes.json()
    if (!result?.file_path) return null

    const audioRes = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${result.file_path}`)
    const audioBuffer = await audioRes.arrayBuffer()

    const form = new FormData()
    form.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg')
    form.append('model', groqKey ? 'whisper-large-v3-turbo' : 'whisper-1')
    form.append('language', 'ru')

    const whisperRes = await fetch(
      groqKey ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions',
      { method: 'POST', headers: { 'Authorization': `Bearer ${groqKey ?? openaiKey}` }, body: form }
    )
    const { text } = await whisperRes.json()
    return text ?? null
  } catch { return null }
}

// ── Telegram отправка ─────────────────────────────────────────────────────
export async function sendTelegram(chatId: number, text: string): Promise<void> {
  const clean = text.replace(/```[\s\S]*?```/g, '') // убрать code blocks из Telegram
  await fetch(`${TG}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId, text: clean.trim(),
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  })
}
