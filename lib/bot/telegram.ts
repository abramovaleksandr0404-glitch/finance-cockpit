// Telegram-протокол и история сообщений — вынесены из bot.ts.
// Зависят только от db/USER_ID/TG (shared.ts) и друг от друга внутри файла.
// НЕ добавлять сюда обработку бизнес-логики (executeAction, computeFinancialState) —
// это отдельный слой, смешение слоёв — причина июньского падения прода.
import { db, USER_ID, TG } from './shared'

export async function getHistory(chatId: number) {
  // Окно 40 минут: без него в контекст попадали сообщения многочасовой давности,
  // и бот подмешивал прошлую тему в ответ на новый вопрос.
  const since = new Date(Date.now() - 40 * 60 * 1000).toISOString()
  const { data } = await db().from('bot_messages').select('role,content').eq('chat_id', chatId).gte('created_at', since).order('created_at', { ascending: false }).limit(6)
  // ВАЖНО: длинные ответы ассистента заменяем тематическим тегом без форматирования.
  // Причина: первые 200 символов включали заголовки/таблицы → LLM копировал структуру.
  // Тематический тег даёт контекст ("о чём говорили") без шаблона для копирования.
  return (data ?? []).reverse().map((h: {role:string; content:string}) => {
    if (h.role === 'assistant' && h.content.length > 120) {
      // Берём суть без markdown: убираем **, *, #, |, эмодзи-заголовки
      const stripped = h.content.replace(/[*#|_~`]/g,'').replace(/[📊💰🏦📅📤📥🎯⚠️✅]/g,'').trim()
      const summary = Array.from(stripped).slice(0, 80).join('').replace(/\n+/g,' ').trim()
      return { role: h.role, content: `[Ответил: ${summary}…]` }
    }
    return h
  })
}

export async function saveHistory(chatId: number, role: 'user'|'assistant', content: string, msgType = 'text') {
  await db().from('bot_messages').insert({ chat_id: chatId, user_id: USER_ID, role, content, msg_type: msgType }).then(()=>{})
}

export async function logMessage(chatId: number, role: 'user'|'assistant', content: string, msgType = 'text') {
  await db().from('bot_messages').insert({ chat_id: chatId, user_id: USER_ID, role, content, msg_type: msgType }).then(()=>{})
}

export async function checkDeployNotification(chatId: number): Promise<void> {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA
  if (!sha) return
  try {
    const s = db()
    const { data: known } = await s.from('bot_anchors')
      .select('value').eq('user_id', USER_ID).eq('key', 'last_deploy_sha').maybeSingle()
    if (known?.value === sha) return

    // Первый запуск: только запоминаем, не спамим историей деплоев
    const isFirst = !known
    await s.from('bot_anchors').upsert({
      user_id: USER_ID, key: 'last_deploy_sha', value: sha,
      month_key: 'global', updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,key,month_key' })
    if (isFirst) return

    const msg = (process.env.VERCEL_GIT_COMMIT_MESSAGE ?? '').split('\n')[0].slice(0, 300)
    await sendTelegram(chatId, `🚀 *Обновление задеплоено*\n\n${msg || 'без описания'}\n\n\`${sha.slice(0, 8)}\``)
  } catch (e) {
    console.error('[deploy-notify] ', e)
  }
}

export async function storeChatId(chatId: number) {
  await db().from('users').update({ telegram_chat_id: chatId }).eq('id', USER_ID)
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
