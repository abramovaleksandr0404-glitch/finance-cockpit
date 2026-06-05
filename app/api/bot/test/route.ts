import { processMessage } from '@/lib/bot'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!secret || secret !== process.env.BOT_WEBHOOK_SECRET) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { message } = await req.json()
  if (!message || typeof message !== 'string') {
    return Response.json({ error: 'message required' }, { status: 400 })
  }
  const CHAT_ID = Number(process.env.ALLOWED_TELEGRAM_CHAT_ID)
  const response = await processMessage(message, CHAT_ID)
  return Response.json({ response, ok: true })
}
