import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'

// Временный диагностический эндпоинт: показывает содержимое bot_corrections
// и bot_memories, чтобы провести аудит без обращений к Anthropic API.
export async function GET(req: Request) {
  if (req.headers.get('x-secret') !== process.env.BOT_WEBHOOK_SECRET) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  const [{ data: corrections }, { data: memories }] = await Promise.all([
    db.from('bot_corrections')
      .select('id,correction,category,created_at')
      .eq('user_id', USER_ID)
      .order('created_at', { ascending: false }),
    db.from('bot_memories')
      .select('id,content,category,importance,created_at')
      .eq('user_id', USER_ID)
      .order('importance', { ascending: false }),
  ])

  const byCategory: Record<string, number> = {}
  for (const c of corrections ?? []) {
    const k = c.category ?? 'null'
    byCategory[k] = (byCategory[k] ?? 0) + 1
  }

  // Коррекции, содержащие конкретные суммы — кандидаты на удаление:
  // числа должны жить в БД, а не в правилах поведения.
  const hasNumbers = (corrections ?? []).filter(c =>
    /\d[\d\s.,]{3,}/.test(String(c.correction)))

  return Response.json({
    corrections_total: corrections?.length ?? 0,
    by_category: byCategory,
    read_into_context: ['formula', 'fact'],
    with_numbers_count: hasNumbers.length,
    corrections: (corrections ?? []).map(c => ({
      id: c.id,
      cat: c.category,
      date: String(c.created_at).slice(0, 10),
      text: String(c.correction).slice(0, 220),
    })),
    memories_total: memories?.length ?? 0,
    memories: (memories ?? []).map(m => ({
      id: m.id,
      cat: m.category,
      imp: m.importance,
      text: String(m.content).slice(0, 220),
    })),
  })
}
