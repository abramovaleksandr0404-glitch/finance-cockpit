import { processMessage, _lastUsage, setDryRun } from '@/lib/bot'

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

  // dry_run: физически блокирует запись в БД на уровне executeAction
  setDryRun(dry_run === true)
  try {
    const response = await processMessage(message, CHAT_ID)
    return Response.json({ response, ok: true, dry_run: dry_run === true, usage: _lastUsage })
  } finally {
    setDryRun(false)  // сбрасываем всегда
  }
}
