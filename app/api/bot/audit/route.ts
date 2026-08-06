import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'

function mk() {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`
}

// Значимые слова для сравнения записей памяти по смыслу
function words(t: string): Set<string> {
  return new Set(
    t.toLowerCase().replace(/ё/g, 'е')
      .split(/[^a-zа-я0-9]+/)
      .filter(w => w.length > 3)
      .map(w => w.slice(0, 5)))
}
function overlap(a: string, b: string): number {
  const wa = words(a), wb = words(b)
  const common = [...wa].filter(w => wb.has(w)).length
  const smaller = Math.min(wa.size, wb.size)
  return smaller > 0 ? common / smaller : 0
}

// Диагностика + разовая чистка self-learning.
// GET            → аудит (только чтение)
// GET ?cleanup=1 → удалить коррекции с цифрами и дубли памяти
export async function GET(req: Request) {
  if (req.headers.get('x-secret') !== process.env.BOT_WEBHOOK_SECRET) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const doCleanup = new URL(req.url).searchParams.get('cleanup') === '1'
  const monthKey = mk()

  const [
    { data: corrections }, { data: memories }, { data: user },
    { data: month }, { data: cards }, { data: loans }, { data: anchors },
  ] = await Promise.all([
    db.from('bot_corrections').select('id,correction,category,created_at').eq('user_id', USER_ID).order('created_at', { ascending: false }),
    db.from('bot_memories').select('id,content,category,importance,created_at').eq('user_id', USER_ID).order('importance', { ascending: false }),
    db.from('users').select('salary_net,var_budget,fixed_costs').eq('id', USER_ID).maybeSingle(),
    db.from('months').select('*').eq('user_id', USER_ID).eq('month_key', monthKey).maybeSingle(),
    db.from('cards').select('name,card_limit,current_debt').eq('user_id', USER_ID),
    db.from('loans').select('name,principal,rate,min_payment').eq('user_id', USER_ID),
    db.from('bot_anchors').select('key,value,month_key').eq('user_id', USER_ID).in('month_key', [monthKey, 'global']),
  ])

  // Коррекция мусорная, если содержит число из 3+ цифр: это данные, а не правило.
  const hasNumbers = (c: { correction: string }) => /\d{3,}/.test(String(c.correction).replace(/\s/g, ''))
  const junk = (corrections ?? []).filter(hasNumbers)
  const keep = (corrections ?? []).filter(c => !hasNumbers(c))

  // Дубли памяти: первую запись оставляем, похожие последующие — в удаление
  const memDupes: { id: string; text: string; sameAs: string }[] = []
  const survivors: { id: string; content: string }[] = []
  for (const m of memories ?? []) {
    const twin = survivors.find(s => overlap(String(s.content), String(m.content)) >= 0.7)
    if (twin) memDupes.push({ id: m.id, text: String(m.content).slice(0, 90), sameAs: String(twin.content).slice(0, 90) })
    else survivors.push({ id: m.id, content: String(m.content) })
  }

  const deleted = { corrections: 0, memories: 0, anchors: 0 }

  // Точечное удаление конкретных записей памяти: ?memids=uuid,uuid
  const memIds = (new URL(req.url).searchParams.get('memids') ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)
  if (memIds.length) {
    await db.from('bot_memories').delete().eq('user_id', USER_ID).in('id', memIds)
    deleted.memories += memIds.length
  }

  if (doCleanup) {
    if (junk.length) {
      await db.from('bot_corrections').delete().in('id', junk.map(c => c.id))
      deleted.corrections = junk.length
    }
    if (memDupes.length) {
      await db.from('bot_memories').delete().in('id', memDupes.map(m => m.id))
      deleted.memories = memDupes.length
    }
    // Якоря-дубликаты таблиц: источник правды — таблица, якорь только устаревает
    const DERIVED = ['salary_net', 'var_budget', 'total_loans', 'monthly_loan_payment',
      'tbank_credit_debt', 'tbank_credit_available', 'tbank_credit_limit',
      'cards_summary', 'net_position', 'fixed_total', 'fixed_unpaid']
    const { data: killed } = await db.from('bot_anchors')
      .delete().eq('user_id', USER_ID).in('key', DERIVED).select('key')
    deleted.anchors = killed?.length ?? 0
  }

  return Response.json({
    mode: doCleanup ? 'CLEANUP EXECUTED' : 'audit only',
    deleted,
    corrections_total: corrections?.length ?? 0,
    corrections_junk: junk.length,
    corrections_keep: keep.map(c => ({ cat: c.category, text: String(c.correction).slice(0, 160) })),
    memories_total: memories?.length ?? 0,
    memories_dupes: memDupes.length,
    memories_dupes_list: memDupes,
    memories_survivors: survivors.map(s => ({ id: s.id, text: s.content.slice(0, 130) })),
    state: {
      month_key: monthKey,
      salary_net: user?.salary_net,
      var_budget: user?.var_budget,
      fixed_costs: user?.fixed_costs,
      month_row: month,
      cards,
      loans,
      anchors,
    },
  })
}
