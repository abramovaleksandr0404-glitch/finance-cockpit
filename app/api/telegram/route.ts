import { NextResponse } from 'next/server'
import { processMessage, processImage, sendTelegram, transcribeVoice, storeChatId } from '@/lib/bot'

const WEBHOOK_SECRET = process.env.BOT_WEBHOOK_SECRET

export async function POST(req: Request) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token')
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) return new NextResponse('Unauthorized', { status: 401 })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ ok: true }) }

  const ALLOWED = Number(process.env.ALLOWED_TELEGRAM_CHAT_ID)
  const incomingId = ((body.message as Record<string, Record<string, number>>)?.chat?.id)
    ?? (((body.callback_query as Record<string, unknown>)?.message as Record<string, Record<string, number>>)?.chat?.id)
    ?? 0
  if (incomingId !== ALLOWED) return NextResponse.json({ ok: true })

  const message = body.message as Record<string, unknown> | undefined
  if (!message) return NextResponse.json({ ok: true })

  const chatId = incomingId

  // Сохранить chat_id для утреннего дежурства
  storeChatId(chatId).catch(() => {})

  try {
    // ── Голосовое сообщение ──────────────────────────────────
    const voice = message.voice as { file_id: string } | undefined
    const audio = message.audio as { file_id: string } | undefined
    if (voice || audio) {
      const fileId = (voice ?? audio)!.file_id
      const transcribed = await transcribeVoice(fileId)
      if (transcribed) {
        await sendTelegram(chatId, `🎙 _«${transcribed}»_`)
        const reply = await processMessage(transcribed, chatId)
        await sendTelegram(chatId, reply)
      } else {
        await sendTelegram(chatId, '🎙 Голос не подключён. Добавь GROQ_API_KEY в Vercel (бесплатно на console.groq.com).')
      }
      return NextResponse.json({ ok: true })
    }

    // ── Фото / скрин ──────────────────────────────────────────
    const photos = message.photo as { file_id: string; file_size: number }[] | undefined
    const document = message.document as { file_id: string; mime_type?: string } | undefined
    if (photos?.length || document?.mime_type?.startsWith('image/')) {
      const fileId = photos ? photos[photos.length - 1].file_id : document!.file_id
      const caption = (message.caption as string) || undefined
      const reply = await processImage(fileId, chatId, caption)
      await sendTelegram(chatId, reply)
      return NextResponse.json({ ok: true })
    }

    // ── Текстовое сообщение ───────────────────────────────────
    const text = ((message.text as string) ?? '').trim()
    if (!text) return NextResponse.json({ ok: true })

    const reply = await processMessage(text, chatId)
    await sendTelegram(chatId, reply)

  } catch (err) {
    console.error('[Bot]', err)
    await sendTelegram(chatId, '❌ Ошибка. Попробуй ещё раз.')
  }

  return NextResponse.json({ ok: true })
}

export async function GET() {
  return NextResponse.json({ status: '🚀 Finance Cockpit Bot v4 — Vision + Smart Agent' })
}
