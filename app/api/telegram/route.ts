import { NextResponse } from 'next/server'
import { processMessage, processImage, processImages, sendTelegram, transcribeVoice, storeChatId, executeAction, checkDeployNotification, addToMediaGroup, listMediaGroup, clearMediaGroup } from '@/lib/bot'

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
  // Новая версия выкачена — сообщаем один раз, не блокируя ответ
  checkDeployNotification(chatId).catch(() => {})

  try {
    // ── Голосовое сообщение ──────────────────────────────────
    const voice = message.voice as { file_id: string } | undefined
    const audio = message.audio as { file_id: string } | undefined
    if (voice || audio) {
      const fileId = (voice ?? audio)!.file_id
      const transcribed = await transcribeVoice(fileId)
      if (transcribed) {
        await sendTelegram(chatId, `🎙 _«${transcribed}»_`)
        // ЗАДАЧА 3 (пересмотрено): длинное голосовое ≠ автоматически "выгрузка
        // мыслей". Реальный случай: пользователь голосом с цифрами исправлял
        // баланс и траты (1358 симв, полноценная финансовая коррекция) —
        // чистый порог по длине пометил бы это "не финансовой командой" и
        // велел боту просто сложить в идеи, откуда и растёт "бот меня не слышит".
        // Теперь смотрим на СОДЕРЖАНИЕ: если есть цифры и финансовые слова —
        // это команда, даже если длинная. "Выгрузка мыслей" — это длинно И
        // без единого числа.
        const LONG_VOICE = 800
        const hasNumbers = /\d{2,}/.test(transcribed)
        const hasFinanceWords = /дебет|баланс|трат|перевод|долг|кредит|наличн|карт|банк|₽|рубл|оплат|погас/i.test(transcribed)
        const looksFinancial = hasNumbers && hasFinanceWords
        const voiceText = (transcribed.length > LONG_VOICE && !looksFinancial)
          ? `[ДЛИННОЕ ГОЛОСОВОЕ ${transcribed.length} симв — это выгрузка мыслей/идей. Сохрани суть через add_idea (можно несколько идей отдельными вызовами), затем кратко перечисли что записал. НЕ выполняй как финансовую команду.]\n\n${transcribed}`
          : transcribed
        // historyText — чистая транскрипция без инъекции инструкции. Раньше
        // и logMessage, и внутренний saveHistory писали ОДНО и то же голосовое
        // дважды разным текстом: инструкция утекала в историю как будто её
        // произнёс пользователь.
        const reply = await processMessage(voiceText, chatId, `[голос] ${transcribed}`)
        await sendTelegram(chatId, reply)
      } else {
        await sendTelegram(chatId, '🎙 Голос не подключён. Добавь GROQ_API_KEY в Vercel (бесплатно на console.groq.com).')
      }
      return NextResponse.json({ ok: true })
    }

    // ── Фото / скрин ──────────────────────────────────────────
    const photos = message.photo as { file_id: string; file_size: number }[] | undefined
    const document = message.document as { file_id: string; mime_type?: string } | undefined
    const mediaGroupId = message.media_group_id as string | undefined
    if (photos?.length || document?.mime_type?.startsWith('image/')) {
      const fileId = photos ? photos[photos.length - 1].file_id : document!.file_id
      const caption = (message.caption as string) || undefined

      if (mediaGroupId) {
        // Альбом: Telegram шлёт каждое фото ОТДЕЛЬНЫМ вебхуком — своя
        // serverless-функция без общей памяти с соседними фото. Подпись
        // достаётся только ПЕРВОМУ фото группы. Живой случай: пользователь
        // прислал 3 фото Т-Банка + 1 Сбер с одной подписью — бот честно
        // ответил "вижу только одно фото".
        //
        // Решение: буферизуем в БД, ждём debounce-окно. Кто из фото группы
        // "последний" (за время ожидания больше фото не пришло) — тот
        // забирает всю группу и отвечает одним сообщением на все сразу.
        // Остальные молча завершаются без ответа пользователю.
        await addToMediaGroup(mediaGroupId, fileId, caption)
        const before = await listMediaGroup(mediaGroupId)
        await new Promise(r => setTimeout(r, 2200))
        const after = await listMediaGroup(mediaGroupId)
        if (after.length !== before.length || after.length === 0) {
          // Выросло за время ожидания — не последний, промолчать.
          // Пусто — кто-то другой уже забрал группу первым.
          return NextResponse.json({ ok: true })
        }
        await clearMediaGroup(mediaGroupId, after.map(a => a.fileId))
        const groupCaption = after.find(a => a.caption)?.caption
        const reply = await processImages(after.map(a => a.fileId), chatId, groupCaption)
        await sendTelegram(chatId, reply)
        return NextResponse.json({ ok: true })
      }

      const reply = await processImage(fileId, chatId, caption)
      await sendTelegram(chatId, reply)
      return NextResponse.json({ ok: true })
    }

    // ── Текстовое сообщение ───────────────────────────────────
    const text = ((message.text as string) ?? '').trim()
    if (!text) return NextResponse.json({ ok: true })

    // ── ПЛАНИРОВЩИК: /today /plan /week — bypass LLM, прямо из ядра ────────
    const PLANNER_SLASH = new Set(['/today', '/plan', '/week', '/habits'])
    if (PLANNER_SLASH.has(text.split(' ')[0].toLowerCase())) {
      const { todayPlannerResponse } = await import('@/lib/planner')
      const planReply = await todayPlannerResponse()
      await sendTelegram(chatId, planReply)
      return NextResponse.json({ ok: true })
    }

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
