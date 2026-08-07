import { processWithModelForTest } from '@/lib/bot'

export const dynamic = 'force-dynamic'

// Цены Anthropic за 1M токенов (USD)
const PRICE: Record<string, { in: number; out: number }> = {
  haiku:  { in: 1,  out: 5  },
  sonnet: { in: 3,  out: 15 },
}

function estimateCost(u: Record<string, number>, tier: 'haiku' | 'sonnet') {
  const p = PRICE[tier]
  const inp   = (u.input_tokens ?? 0)
  const cw    = (u.cache_creation_input_tokens ?? 0)
  const cr    = (u.cache_read_input_tokens ?? 0)
  const out   = (u.output_tokens ?? 0)
  // cache write = 1.25x, cache read = 0.1x от базовой входной цены
  return ((inp * p.in) + (cw * p.in * 1.25) + (cr * p.in * 0.1) + (out * p.out)) / 1e6
}

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
  // TEST_CHAT_ID: фейковый id — тестовые сообщения НЕ попадают в историю пользователя
  const TEST_CHAT_ID = -999999
  // usage возвращается вместе с ответом: состояние теперь привязано к
  // запросу и снаружи контекста уже недоступно.
  const { text: response, usage } = await processWithModelForTest(message, TEST_CHAT_ID)
  return Response.json({
    response,
    ok: true,
    usage,
    cost_haiku_usd:  Number(estimateCost(usage, 'haiku').toFixed(4)),
    cost_sonnet_usd: Number(estimateCost(usage, 'sonnet').toFixed(4)),
  })
}
