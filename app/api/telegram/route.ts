import { NextResponse } from 'next/server'
import { processMessage, processImage, sendTelegram, transcribeVoice, storeChatId, executeAction } from '@/lib/bot'

const WEBHOOK_SECRET = process.env.BOT_WEBHOOK_SECRET

async function answerCallbackQuery(callbackQueryId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
  })
}

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

  // ── Callback query (inline кнопки) ──────────────────────────
  const callbackQuery = body.callback_query as Record<string, unknown> | undefined
  if (callbackQuery) {
    const cbData = callbackQuery.data as string | undefined
    const cbMsgChatId = ((callbackQuery.message as Record<string, unknown>)?.chat as Record<string, number>)?.id
    const cbLabel: Record<string,string> = {
      received_stipend: '🎙 [кнопка] Стипендия получена',
      received_advance: '🎙 [кнопка] Аванс получен',
      received_eom: '🎙 [кнопка] ЗП получена',
      skip: '🎙 [кнопка] Пропустить',
    }
    // Логируем нажатие кнопки
    await import('@/lib/bot').then(b => b.logMessage && b.logMessage(cbMsgChatId ?? 0, 'user', cbLabel[cbData ?? ''] ?? `[кнопка: ${cbData}]`, 'callback'))
    if (cbData === 'received_stipend') {
      await executeAction({ type: 'mark_recurring_received', name: 'Стипендия' })
      await answerCallbackQuery(callbackQuery.id as string, '✅ Стипендия зачислена!')
      if (cbMsgChatId) await sendTelegram(cbMsgChatId, '✅ Стипендия 5 900₽ зачислена на дебет')
    } else if (cbData === 'received_advance') {
      await executeAction({ type: 'mark_salary', part: 'advance' })
      await answerCallbackQuery(callbackQuery.id as string, '✅ Аванс зачислен!')
      if (cbMsgChatId) await sendTelegram(cbMsgChatId, '✅ Аванс зачислен на дебет')
    }
    return NextResponse.json({ ok: true })
  }

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
        // Логируем голосовое с типом 'voice' 
        await import('@/lib/bot').then(b => b.logMessage && b.logMessage(chatId, 'user', `[голос] ${transcribed}`, 'voice'))
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

    const QUICK_ACTIONS: Record<string, string> = {
      '💰 Аванс': 'когда и сколько будет аванс, с учётом всех корректировок',
      '💵 Зарплата': 'когда и сколько будет зарплата в конце месяца',
      '🎯 Бонус': 'какой бонус ожидается и когда',
      '📊 Бюджет месяца': 'полный бюджет текущего месяца: входы, расходы, прогноз',
      '💳 Кредиты': 'все кредиты: остатки, платежи, ближайшие даты, нагрузка в рабочих днях',
      '📉 Вредные': 'вредные расходы: сколько потрачено, лимит, что входит',
      '💸 До аванса': 'сколько осталось потратить до аванса 15 числа: дней, бюджет/день, критичные платежи',
      '⚡ Баланс': 'текущий баланс на всех счетах и прогноз',
      '📋 Бэклог': 'что в бэклоге разработки',
    }
    const mappedText = QUICK_ACTIONS[text] ?? text
    const reply = await processMessage(mappedText, chatId)
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
