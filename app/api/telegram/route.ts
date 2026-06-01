import { NextResponse } from 'next/server'
import {
  parseIntent, sendTelegram,
  handleGetStatus, handleAddExpense, handleGetLoans, handleGetDaily, handleHelp,
} from '@/lib/bot'

const WEBHOOK_SECRET = process.env.BOT_WEBHOOK_SECRET

export async function POST(req: Request) {
  // Verify Telegram secret token
  const secret = req.headers.get('x-telegram-bot-api-secret-token')
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const update = await req.json()
  const message = update?.message
  if (!message?.text) return NextResponse.json({ ok: true })

  const chatId: number = message.chat.id
  const text: string = (message.text ?? '').trim()

  try {
    const intent = parseIntent(text)
    let reply = ''

    switch (intent.action) {
      case 'get_status':
        reply = await handleGetStatus()
        break
      case 'add_expense':
        reply = await handleAddExpense(intent.amount ?? 0, intent.category ?? 'Прочее', intent.description ?? '')
        break
      case 'get_loans':
        reply = await handleGetLoans()
        break
      case 'get_daily':
        reply = await handleGetDaily()
        break
      case 'get_cashflow':
        reply = await handleGetStatus() // for now same as status
        break
      case 'help':
      default:
        reply = handleHelp()
    }

    await sendTelegram(chatId, reply)
  } catch (err) {
    console.error('[Bot error]', err)
    await sendTelegram(chatId, '❌ Ошибка. Попробуй ещё раз или напиши /help')
  }

  return NextResponse.json({ ok: true })
}

// Health check
export async function GET() {
  return NextResponse.json({ status: 'Finance Cockpit Bot is running 🚀' })
}
