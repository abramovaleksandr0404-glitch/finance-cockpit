import { NextResponse } from 'next/server'
import {
  parseIntent, sendTelegram, transcribeVoice,
  handleGetStatus, handleAddExpense, handleAddClient,
  handleGetLoans, handleGetCashflow, handleGetDaily,
  handleGetGoals, handleAddGoal, handleGetAnalytics, handleHelp,
} from '@/lib/bot'

const WEBHOOK_SECRET = process.env.BOT_WEBHOOK_SECRET

export async function POST(req: Request) {
  // Verify Telegram secret
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

  // ── Voice message → Whisper transcription ──────────────────────────────
  const voice = message.voice as { file_id: string } | undefined
  const audio = message.audio as { file_id: string } | undefined
  if (voice || audio) {
    const fileId = (voice ?? audio)!.file_id
    const transcribed = await transcribeVoice(fileId)
    if (transcribed) {
      text = transcribed
      // Let user know what was heard
      await sendTelegram(chatId, `🎙 _Услышал: «${transcribed}»_`)
    } else {
      await sendTelegram(chatId, '🎙 Голосовые пока не подключены. Напиши текстом!\n\nЧтобы включить: добавь OPENAI_API_KEY в Vercel.')
      return NextResponse.json({ ok: true })
    }
  }

  if (!text) return NextResponse.json({ ok: true })

  // ── Process intent ──────────────────────────────────────────────────────
  try {
    const intent = await parseIntent(text)
    let reply = ''

    switch (intent.action) {
      case 'get_status':   reply = await handleGetStatus(); break
      case 'get_loans':    reply = await handleGetLoans(); break
      case 'get_cashflow': reply = await handleGetCashflow(); break
      case 'get_daily':    reply = await handleGetDaily(); break
      case 'get_goals':    reply = await handleGetGoals(); break
      case 'get_analytics':reply = await handleGetAnalytics(); break
      case 'add_expense':
        reply = await handleAddExpense(intent.amount ?? 0, intent.category ?? 'Прочее', intent.description ?? '')
        break
      case 'add_client':
        reply = await handleAddClient(intent.grade ?? '', intent.revenue)
        break
      case 'add_goal':
        reply = await handleAddGoal(intent.goal_name ?? '', intent.amount ?? 0, intent.goal_month ?? undefined)
        break
      case 'help':
      default:
        reply = handleHelp()
    }

    await sendTelegram(chatId, reply)
  } catch (err) {
    console.error('[Bot]', err)
    await sendTelegram(chatId, '❌ Ошибка. Попробуй ещё раз или напиши /help')
  }

  return NextResponse.json({ ok: true })
}

export async function GET() {
  return NextResponse.json({ status: '🚀 Finance Cockpit Bot v2 is running' })
}
