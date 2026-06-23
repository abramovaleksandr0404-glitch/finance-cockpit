import { processMessage, _lastUsage } from '@/lib/bot'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!secret || secret !== process.env.BOT_WEBHOOK_SECRET) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  const body = await req.json()
  const { message, dry_run } = body
  if (!message || typeof message !== 'string') {
    return Response.json({ error: 'message required' }, { status: 400 })
  }

  const CHAT_ID = Number(process.env.ALLOWED_TELEGRAM_CHAT_ID)

  // dry_run=true: добавляем к сообщению префикс-инструкцию не записывать в БД.
  // Это не идеальная изоляция, но даёт боту явный сигнал что это тест.
  const testMsg = dry_run
    ? `[ТЕСТ — НЕ ЗАПИСЫВАТЬ В БД, только проанализировать] ${message}`
    : message

  const response = await processMessage(testMsg, CHAT_ID)
  return Response.json({ response, ok: true, dry_run: dry_run ?? false, usage: _lastUsage })
}
