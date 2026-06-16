import { NextResponse } from 'next/server'

// Эндпоинт для отбивки в Telegram о задеплоенном функционале.
// Вызывается вручную/из CI после успешного деплоя.
export async function POST(req: Request) {
  const auth = req.headers.get('x-runner-secret')
  if (auth !== (process.env.RUNNER_SECRET || 'sprint-runner-2026')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: { text?: string; commit?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }
  if (!body.text) return NextResponse.json({ error: 'text required' }, { status: 400 })

  const botToken = process.env.TELEGRAM_BOT_TOKEN || ''
  const chatId = process.env.ALLOWED_TELEGRAM_CHAT_ID || ''
  if (!botToken || !chatId) return NextResponse.json({ error: 'telegram env missing' }, { status: 500 })

  const commitLine = body.commit ? `\n\n\`${body.commit.slice(0, 10)}\`` : ''
  const message = `🚀 *Задеплоено*\n\n${body.text}${commitLine}`

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
