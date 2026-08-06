import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'

// Временный диагностический эндпоинт: полный снимок состояния без обращений к Anthropic API.
// ?part=learn — коррекции и память; ?part=state — финансовое состояние; ?part=chat — история диалога.
export async function GET(req: Request) {
  if (req.headers.get('x-secret') !== process.env.BOT_WEBHOOK_SECRET) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const part = new URL(req.url).searchParams.get('part') ?? 'learn'
  const cut = (v: unknown, n = 200) => String(v ?? '').slice(0, n)

  if (part === 'learn') {
    const [{ data: corrections }, { data: memories }] = await Promise.all([
      db.from('bot_corrections').select('id,correction,category,created_at')
        .eq('user_id', USER_ID).order('created_at', { ascending: false }),
      db.from('bot_memories').select('id,content,category,importance,created_at')
        .eq('user_id', USER_ID).order('importance', { ascending: false }),
    ])
    const byCat: Record<string, number> = {}
    for (const c of corrections ?? []) byCat[c.category ?? 'null'] = (byCat[c.category ?? 'null'] ?? 0) + 1
    return Response.json({
      corrections_total: corrections?.length ?? 0,
      by_category: byCat,
      corrections: (corrections ?? []).map(c => ({
        id: c.id, cat: c.category, date: cut(c.created_at, 10), text: cut(c.correction, 200),
      })),
      memories_total: memories?.length ?? 0,
      memories: (memories ?? []).map(m => ({
        id: m.id, cat: m.category, imp: m.importance, date: cut(m.created_at, 10), text: cut(m.content, 200),
      })),
    })
  }

  if (part === 'state') {
    const [{ data: user }, { data: months }, { data: cards }, { data: loans }, { data: anchors }, { data: exp }] =
      await Promise.all([
        db.from('users').select('salary_net,var_budget,fixed_costs,telegram_chat_id').eq('id', USER_ID).single(),
        db.from('months').select('*').eq('user_id', USER_ID).order('month_key', { ascending: false }).limit(3),
        db.from('cards').select('name,card_limit,current_debt').eq('user_id', USER_ID),
        db.from('loans').select('name,principal,rate,min_payment,due_day,paid_month').eq('user_id', USER_ID),
        db.from('bot_anchors').select('month_key,key,value,updated_at').eq('user_id', USER_ID)
          .order('updated_at', { ascending: false }).limit(60),
        db.from('expenses').select('amount,category,description,created_at').eq('user_id', USER_ID)
          .order('created_at', { ascending: false }).limit(25),
      ])
    return Response.json({ user, months, cards, loans, anchors, recent_expenses: exp })
  }

  // part=chat
  const { data: msgs } = await db.from('bot_messages')
    .select('role,content,created_at').eq('user_id', USER_ID)
    .order('created_at', { ascending: false }).limit(80)
  return Response.json({
    count: msgs?.length ?? 0,
    messages: (msgs ?? []).reverse().map(m => ({
      t: cut(m.created_at, 16), role: m.role, text: cut(m.content, 300),
    })),
  })
}
