import { processWithModelForTest } from '@/lib/bot'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!secret || secret !== process.env.BOT_WEBHOOK_SECRET) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  const body = await req.json()
  const { message } = body
  if (!message || typeof message !== 'string') {
    return Response.json({ error: 'message required' }, { status: 400 })
  }
  // TEST_CHAT_ID: фейковый id — тестовые сообщения НЕ попадают в историю реального пользователя
  const TEST_CHAT_ID = -999999
  const response = await processWithModelForTest(message, TEST_CHAT_ID)
  return Response.json({ response, ok: true })
}
