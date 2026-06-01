import { NextResponse } from 'next/server'
import { processMessage, sendTelegram, transcribeVoice } from '@/lib/bot'

const WEBHOOK_SECRET = process.env.BOT_WEBHOOK_SECRET

export async function POST(req: Request) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token')
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  let update: Record<string, unknown>
  try { update = await req.json() } catch { return NextResponse.json({ ok: true }) }

  const message = update?.message as Record<string, unknown> | undefined
  if (!message) return NextResponse.json({ ok: true })

  const chatId = (message.chat as Record<string, number>)?.id
  if (!chatId) return NextResponse.json({ ok: true })

  let text = ((message.text as string) ?? '').trim()

  // Голосовое сообщение
  const voice = message.voice as { file_id: string } | undefined
  const audio = message.audio as { file_id: string } | undefined
  if (voice || audio) {
    const fileId = (voice ?? audio)!.file_id
    const transcribed = await transcribeVoice(fileId)
    if (transcribed) {
      text = transcribed
      await sendTelegram(chatId, `🎙 _«${transcribed}»_`)
    } else {
      await sendTelegram(chatId, '🎙 Голос пока не подключён. Добавь GROQ_API_KEY в Vercel (бесплатно).')
      return NextResponse.json({ ok: true })
    }
  }

  if (!text) return NextResponse.json({ ok: true })

  try {
    const reply = await processMessage(text, chatId)
    await sendTelegram(chatId, reply)
  } catch (err) {
    console.error('[Bot]', err)
    await sendTelegram(chatId, '❌ Ошибка. Попробуй ещё раз.')
  }

  return NextResponse.json({ ok: true })
}

export async function GET() {
  return NextResponse.json({ status: '🚀 Finance Cockpit Bot v3 — Smart Agent' })
}
