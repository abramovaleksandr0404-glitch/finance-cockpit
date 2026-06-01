/**
 * Finance Cockpit Bot — v4
 * + Vision (чтение скринов)
 * + Изменение оклада/формулы через бот
 * + Точные гипотетические сценарии
 * + Память разговора + утреннее дежурство
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
export async function getHistory(chatId: number): Promise<{role:string; content:string}[]> {
  const { data } = await db().from('bot_messages').select('role,content').eq('chat_id', chatId).order('created_at', { ascending: false }).limit(12)
  return (data ?? []).reverse()
}

export async function saveHistory(chatId: number, role: 'user'|'assistant', content: string) {
  await db().from('bot_messages').insert({ chat_id: chatId, user_id: USER_ID, role, content })
}

// ── Сохранить chat_id пользователя ───────────────────────────────────────
export async function storeChatId(chatId: number) {
  await db().from('users').update({ telegram_chat_id: chatId }).eq('id', USER_ID)
}

// ── Финансовый контекст ───────────────────────────────────────────────────
export async function getContext(): Promise<string> {
  const supabase = db()
  const monthKey = mk()
  const [
    { data: user }, { data: loans }, { data: expenses },
    { data: month }, { data: goals }, { data: recentExp },
    { data: prevMonth }
  ] = await Promise.all([
    supabase.from('users').select('*').eq('id', USER_ID).single(),
    supabase.from('loans').select('name,principal,accrued_int,min_payment,end_date,rate').eq('user_id', USER_ID).order('sort_order'),
    supabase.from('expenses').select('amount').eq('user_id', USER_ID).eq('month_key', monthKey),
    supabase.from('months').select('*').eq('user_id', USER_ID).eq('month_key', monthKey).maybeSingle(),
    supabase.from('goals').select('name,amount,month_key,purchased').eq('user_id', USER_ID).eq('purchased', false).limit(5),
    supabase.from('expenses').select('category,amount,description,expense_date').eq('user_id', USER_ID).eq('month_key', monthKey).order('expense_date', { ascending: false }).limit(5),
    supabase.from('months').select('clients,revenue,bonus_amount').eq('user_id', USER_ID).order('month_key', { ascending: false }).limit(2),
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

  // Loan details
  const loanLines = (loans ?? []).map(l => {
    const total = Number(l.principal) + Number(l.accrued_int)
    let months = ''
    if (l.end_date) {
      const end = new Date(l.end_date), now = new Date()
      const m = (end.getFullYear()-now.getFullYear())*12 + end.getMonth()-now.getMonth()
      months = ` [${m} мес]`
    }
    return `  ${l.name}: ${rub(total)} @ ${(Number(l.rate)*100).toFixed(2)}%${months}, ${rub(Number(l.min_payment))}/мес`
  }).join('\n')

  // Recent expenses
  const expLines = (recentExp ?? []).length
    ? (recentExp ?? []).map(e => `  ${e.category}: ${rub(e.amount)}${e.description ? ' ('+e.description+')' : ''}`).join('\n')
    : '  нет трат'

  // Current month client data
  const clients = month?.clients as Record<string,number> ?? {}
  const revenue = Number(month?.revenue ?? 41666)
  const nominals = user.nominals as Record<string,number> ?? {}

  // Bonus calc
  const pot = Object.entries(clients).reduce((s,[g,n])=>s+(nominals[g]??0)*n, 0) + revenue * Number(user.margin_share ?? 0.20)
  const excess = Math.max(0, pot - Number(user.threshold ?? 56000))
  const moment = excess * Number(user.moment_share ?? 0.80)
  const ytd = Number(user.ytd_gross ?? 0) + Number(user.salary_gross ?? 140000)
  const taxThreshold = 2400000
  const tax = ytd+moment > taxThreshold
    ? Math.max(0, Math.min(ytd+moment, taxThreshold) - Math.min(ytd, taxThreshold)) * 0.13 + Math.max(0, (ytd+moment) - taxThreshold - Math.max(0, ytd-taxThreshold)) * 0.15
    : moment * 0.13
  const bonusNet = Math.round(moment - tax)

  // Goals
  const goalLines = (goals ?? []).slice(0,4).map(g => `  ${g.name}: ${rub(g.amount)}${g.month_key ? ' ('+g.month_key+')' : ''}`).join('\n') || '  нет'

  return `ДАТА: ${new Date().toLocaleDateString('ru-RU', {day:'numeric',month:'long',year:'numeric',weekday:'long'})}

ФИНАНСЫ:
- Ликвидность: ${rub(liquid)} (Сбер: ${rub(user.debit_balance)}, Т-Банк: ${rub(user.tbank_debit??0)})
- Переменные траты: ${rub(varSpent)} / ${rub(varBudget)} → осталось ${rub(varLeft)}
- Дневной бюджет: ${rub(daily)}/день (${daysLeft} дней)
- Долг: ${rub(totalDebt)}, платёж: ${rub(totalPay)}/мес

КРЕДИТЫ:
${loanLines}

ПЛАН ИЮНЯ:
- Аванс ${rub(Number(month?.salary_adv_amount ?? 60800))} (15-е)${month?.salary_adv_received ? ' ✅' : ' ⏳'}
- ЗП+бонус (30-е)${month?.salary_eom_received ? ' ✅' : ' ⏳'}
- Клиенты: ${JSON.stringify(clients)}, выручка: ${rub(revenue)}
- Прогноз бонуса: котёл ${rub(pot)}, сверхпорог ${rub(excess)}, на руки ~${rub(bonusNet)}

НАСТРОЙКИ (для изменений):
- Оклад gross: ${rub(user.salary_gross)}, net: ${rub(user.salary_net)}
- YTD (накопленный gross): ${rub(user.ytd_gross)}
- Порог бонуса: ${rub(user.threshold)}
- Margin share: ${(Number(user.margin_share)*100).toFixed(0)}%, Moment share: ${(Number(user.moment_share)*100).toFixed(0)}%
- Номиналы: г3=${nominals.g3}, г4=${nominals.g4}, г5-6=${nominals.g56}, г7-8=${nominals.g78}, г9=${nominals.g9}, г10=${nominals.g10}
- Лимит переменных: ${rub(varBudget)}

ПОСЛЕДНИЕ ТРАТЫ:
${expLines}

ЦЕЛИ:
${goalLines}`
}

// ── Системный промпт с полной формулой ───────────────────────────────────
const SYSTEM = `Ты — умный персональный финансовый ИИ-ассистент Александра. Александр — специалист по продажам инвестиционного продукта в АТОН.

СТИЛЬ: по-русски, кратко (2-4 предложения), с эмодзи, как умный друг-финансист.

ФОРМУЛА БОНУСА (для точных расчётов):
  Котёл = Σ(клиенты × номинал) + margin_share × выручка
  Сверхпорог = max(0, Котёл − Порог)
  Момент = Сверхпорог × moment_share
  НДФЛ = если (YTD_gross + Момент) > 2 400 000₽:
             min(2400000, YTD+момент) − min(2400000, YTD)) × 13%
           + max(0, YTD+момент−2400000 − max(0,YTD−2400000)) × 15%
         иначе: Момент × 13%
  Бонус на руки = Момент − НДФЛ
Квартальный: та же формула за 3 месяца кумулятивно, YTD учитывается.

ПРАВИЛА:
1. Трату записывай ТОЛЬКО при явных словах: потратил/купил/заплатил/списал/трата
2. "Подробнее", "расскажи", вопросы — это НЕ траты, просто отвечай
3. Для гипотетических вопросов ("что если...") — считай точно по формуле выше
4. "Отмени"/"отменить"/"undo" → откатить последнее действие
5. Изменения оклада, порогов, формулы → выполни через update_settings
6. При чтении ИЗОБРАЖЕНИЯ: если чек/квитанция/расход → предложи записать

ДЕЙСТВИЯ (добавляй в конец ответа одной строкой, пользователю не видно):
ACTION:{"type":"add_expense","amount":800,"category":"Транспорт","description":"такси"}
ACTION:{"type":"add_client","grade":"g10","revenue":80000}
ACTION:{"type":"add_goal","name":"Телефон","amount":50000,"month_key":null}
ACTION:{"type":"undo"}
ACTION:{"type":"update_settings","field":"salary_net","value":130000}
ACTION:{"type":"update_settings","field":"salary_gross","value":150000}
ACTION:{"type":"update_settings","field":"threshold","value":60000}
ACTION:{"type":"update_settings","field":"moment_share","value":0.75}
ACTION:{"type":"update_settings","field":"margin_share","value":0.25}
ACTION:{"type":"update_settings","field":"var_budget","value":50000}
ACTION:{"type":"update_settings","field":"nominal","key":"g10","value":90000}
ACTION:{"type":"update_settings","field":"ytd_gross","value":950000}

Категории трат: Еда и кафе, Транспорт, Здоровье, Развлечения, Одежда, Инвестиции, Прочее
Грейды: g3=7200₽, g4=14400₽, g56=21600₽, g78=43200₽, g9=64000₽, g10=80000₽`

// ── Тип действия ─────────────────────────────────────────────────────────
interface BotAction {
  type: 'add_expense'|'add_client'|'add_goal'|'undo'|'update_settings'
  amount?: number; category?: string; description?: string
  grade?: string; revenue?: number
  name?: string; month_key?: string|null
  field?: string; key?: string; value?: number | string
}

// ── Выполнить действие ────────────────────────────────────────────────────
export async function executeAction(action: BotAction): Promise<void> {
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
    await supabase.from('users').update({ debit_balance: Math.round((Number(u?.debit_balance??0) - action.amount)*100)/100, debit_updated_at: new Date().toISOString() }).eq('id', USER_ID)
  }

  if (action.type === 'add_client' && action.grade) {
    const { data: month } = await supabase.from('months').select('clients,revenue').eq('user_id', USER_ID).eq('month_key', monthKey).maybeSingle()
    const cur = month?.clients as Record<string,number> ?? {}
    const clients = { ...cur, [action.grade]: (cur[action.grade] ?? 0) + 1 }
    const newRevenue = Number(month?.revenue ?? 41666) + (action.revenue ?? 0)
    month
      ? await supabase.from('months').update({ clients, revenue: newRevenue }).eq('user_id', USER_ID).eq('month_key', monthKey)
      : await supabase.from('months').insert({ user_id: USER_ID, month_key: monthKey, clients, revenue: newRevenue })
  }

  if (action.type === 'add_goal' && action.name && action.amount) {
    await supabase.from('goals').insert({ user_id: USER_ID, name: action.name, amount: Math.round(action.amount), month_key: action.month_key ?? null, sort_order: 99 })
  }

  if (action.type === 'update_settings' && action.field) {
    const ALLOWED_FIELDS = ['salary_net','salary_gross','ytd_gross','threshold','moment_share','margin_share','var_budget']
    if (action.field === 'nominal' && action.key) {
      const { data: u } = await supabase.from('users').select('nominals').eq('id', USER_ID).single()
      const nominals = { ...(u?.nominals as Record<string,number> ?? {}), [action.key]: Number(action.value) }
      await supabase.from('users').update({ nominals }).eq('id', USER_ID)
    } else if (ALLOWED_FIELDS.includes(action.field)) {
      await supabase.from('users').update({ [action.field]: Number(action.value) }).eq('id', USER_ID)
    }
  }

  if (action.type === 'undo') {
    const { data: snap } = await supabase.from('undo_snapshots').select('*').eq('user_id', USER_ID).order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (snap) {
      const s = snap.snapshot as Record<string, unknown>
      if (s.users) { const u = {...s.users as Record<string,unknown>}; delete u.id; await supabase.from('users').update(u).eq('id', USER_ID) }
      await supabase.from('expenses').delete().eq('user_id', USER_ID)
      await supabase.from('income_events').delete().eq('user_id', USER_ID)
      await supabase.from('goals').delete().eq('user_id', USER_ID)
      await supabase.from('loans').delete().eq('user_id', USER_ID)
      await supabase.from('months').delete().eq('user_id', USER_ID)
      await supabase.from('cards').delete().eq('user_id', USER_ID)
      for (const t of ['cards','months','loans','goals','expenses','income_events']) {
        const rows = s[t] as Record<string,unknown>[]|undefined
        if (rows?.length) await supabase.from(t).insert(rows)
      }
      await supabase.from('undo_snapshots').delete().eq('id', snap.id)
    }
  }
}

// ── Основная обработка текста ─────────────────────────────────────────────
export async function processMessage(text: string, chatId: number): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return '⚠️ Добавь ANTHROPIC_API_KEY в Vercel Settings для умного режима.'

  const [context, history] = await Promise.all([getContext(), getHistory(chatId)])
  return callClaude(text, null, context, history, chatId)
}

// ── Обработка изображения ─────────────────────────────────────────────────
export async function processImage(fileId: string, chatId: number, caption?: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return '⚠️ Для чтения скринов нужен ANTHROPIC_API_KEY.'

  try {
    // Download image from Telegram
    const fileRes = await fetch(`${TG}/getFile?file_id=${fileId}`)
    const { result } = await fileRes.json()
    if (!result?.file_path) return '❌ Не удалось получить изображение'

    const imgRes = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${result.file_path}`)
    const buf = await imgRes.arrayBuffer()
    const base64 = Buffer.from(buf).toString('base64')
    const mime = result.file_path.endsWith('.png') ? 'image/png' : 'image/jpeg'

    const [context, history] = await Promise.all([getContext(), getHistory(chatId)])
    const userText = caption || 'Что на этом скрине? Если это чек/квитанция/расход — предложи записать.'

    return callClaudeVision(base64, mime, userText, context, history, chatId)
  } catch (err) {
    console.error('[Bot vision]', err)
    return '❌ Не смог прочитать изображение. Попробуй ещё раз.'
  }
}

// ── Claude API — текст ────────────────────────────────────────────────────
async function callClaude(text: string, _imageData: null, context: string, history: {role:string;content:string}[], chatId: number): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      system: SYSTEM + '\n\nКОНТЕКСТ (актуальные данные):\n' + context,
      messages: [
        ...history.map(h => ({ role: h.role as 'user'|'assistant', content: h.content })),
        { role: 'user', content: text }
      ],
    })
  })
  const data = await res.json()
  return parseAndExecute(data.content?.[0]?.text ?? '❌ Ошибка', text, chatId)
}

// ── Claude API — vision ───────────────────────────────────────────────────
async function callClaudeVision(base64: string, mime: string, userText: string, context: string, history: {role:string;content:string}[], chatId: number): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      system: SYSTEM + '\n\nКОНТЕКСТ:\n' + context,
      messages: [
        ...history.map(h => ({ role: h.role as 'user'|'assistant', content: h.content })),
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
            { type: 'text', text: userText }
          ]
        }
      ],
    })
  })
  const data = await res.json()
  const userDesc = `[изображение: ${userText}]`
  return parseAndExecute(data.content?.[0]?.text ?? '❌ Не смог прочитать', userDesc, chatId)
}

// ── Парсинг ответа + выполнение ACTION ───────────────────────────────────
async function parseAndExecute(fullReply: string, userText: string, chatId: number): Promise<string> {
  const actionMatch = fullReply.match(/^ACTION:(\{.+\})$/m)
  const reply = fullReply.replace(/^ACTION:\{.+\}$/m, '').trim()

  if (actionMatch) {
    try { await executeAction(JSON.parse(actionMatch[1])) } catch (e) { console.error('[action]', e) }
  }

  await Promise.all([
    saveHistory(chatId, 'user', userText),
    saveHistory(chatId, 'assistant', reply),
  ])

  return reply
}

// ── Утренний дайджест (для cron) ──────────────────────────────────────────
export async function generateMorningBriefing(): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  const context = await getContext()
  if (!apiKey) return '🌅 Доброе утро, Александр!'

  const today = new Date()
  const dayName = today.toLocaleDateString('ru-RU', { weekday: 'long' })
  const dateStr = today.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: SYSTEM + '\n\nКОНТЕКСТ:\n' + context,
      messages: [{
        role: 'user',
        content: `Составь краткий утренний финансовый дайджест на ${dayName}, ${dateStr}. 
Включи: 1) текущий баланс и дневной бюджет, 2) ближайшие платежи по кредитам, 3) прогресс по переменным тратам, 4) мотивирующий факт о прогрессе к финансовым целям. Без лишних слов, по делу.`
      }]
    })
  })
  const data = await res.json()
  return data.content?.[0]?.text ?? '🌅 Доброе утро, Александр!'
}

// ── Голос: Groq (бесплатно) или OpenAI ───────────────────────────────────
export async function transcribeVoice(fileId: string): Promise<string | null> {
  const groqKey = process.env.GROQ_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY
  if (!groqKey && !openaiKey) return null
  try {
    const fileRes = await fetch(`${TG}/getFile?file_id=${fileId}`)
    const { result } = await fileRes.json()
    if (!result?.file_path) return null
    const audioRes = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${result.file_path}`)
    const buf = await audioRes.arrayBuffer()
    const form = new FormData()
    form.append('file', new Blob([buf], { type: 'audio/ogg' }), 'voice.ogg')
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

// ── Telegram send ─────────────────────────────────────────────────────────
export async function sendTelegram(chatId: number, text: string): Promise<void> {
  const clean = text.replace(/```[\s\S]*?```/g, '').trim()
  await fetch(`${TG}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: clean, parse_mode: 'Markdown', disable_web_page_preview: true }),
  })
}
