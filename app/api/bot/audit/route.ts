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
    { data: backlog }, { data: ideas },
  ] = await Promise.all([
    db.from('bot_corrections').select('id,correction,category,created_at').eq('user_id', USER_ID).order('created_at', { ascending: false }),
    db.from('bot_memories').select('id,content,category,importance,created_at').eq('user_id', USER_ID).order('importance', { ascending: false }),
    db.from('users').select('salary_net,var_budget,fixed_costs,recurring_incomes,debit_balance,debit_tbank').eq('id', USER_ID).maybeSingle(),
    db.from('months').select('*').eq('user_id', USER_ID).eq('month_key', monthKey).maybeSingle(),
    db.from('cards').select('name,card_limit,current_debt').eq('user_id', USER_ID),
    db.from('loans').select('name,principal,rate,min_payment').eq('user_id', USER_ID),
    db.from('bot_anchors').select('key,value,month_key').eq('user_id', USER_ID).in('month_key', [monthKey, 'global']),
    db.from('bot_backlog').select('title,description,priority,status,created_at').eq('user_id', USER_ID).order('created_at', { ascending: false }),
    db.from('bot_ideas').select('content,created_at').eq('user_id', USER_ID).order('created_at', { ascending: false }),
  ])
  const loanLogs = (anchors ?? []).filter(a => a.key.startsWith('loan_log:'))

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
  const fixes: string[] = []

  // ?fixloanlog=1 — заменить журнал Рефинанса/Кредита В на реальную историю.
  // Предыдущие авто-записи содержали цифры от промежуточного расчёта (до
  // ручной коррекции точными банковскими значениями) — вводили в заблуждение.
  if (new URL(req.url).searchParams.get('fixloanlog') === '1') {
    await db.from('bot_anchors').upsert([
      {
        user_id: USER_ID, month_key: 'global', key: 'loan_log:рефинанс',
        value: JSON.stringify([
          { date: '2026-08-03', type: 'early_repay', mode: 'reduce_payment', amount: 80000, note: 'банк: остаток 274063.92' },
          { date: '2026-08-07', type: 'early_repay', mode: 'reduce_term', amount: 10000, principal_after: 265084.49, payment_after: 9881.30, end_date_after: '2030-12-01', note: 'сверено с банком' },
        ]),
        updated_at: new Date().toISOString(),
      },
      {
        user_id: USER_ID, month_key: 'global', key: 'loan_log:кредит в',
        value: JSON.stringify([
          { date: '2026-08-07', type: 'early_repay', mode: 'reduce_term', amount: 10000, principal_after: 107313.31, payment_after: 4489.49, end_date_after: '2029-12-01', note: 'сверено с банком' },
        ]),
        updated_at: new Date().toISOString(),
      },
    ], { onConflict: 'user_id,month_key,key' })
    fixes.push('журнал Рефинанс/Кредит В переписан на банковские данные')
  }

  // ?restoreloans=name:principal:payment,name:principal:payment
  // Точечное восстановление кредита без LLM — модель ранее меняла А/Б
  // без единого следа в журнале, откатывать нужно напрямую.
  const restoreSpec = new URL(req.url).searchParams.get('restoreloans') ?? ''
  if (restoreSpec) {
    for (const part of restoreSpec.split(',')) {
      const [name, principal, payment] = part.split(':')
      if (!name || !principal || !payment) continue
      const { data: hit } = await db.from('loans').select('id')
        .eq('user_id', USER_ID).ilike('name', `%${name}%`).maybeSingle()
      if (hit) {
        await db.from('loans').update({ principal: Number(principal), min_payment: Number(payment) }).eq('id', hit.id)
        fixes.push(`${name}: тело=${principal}, платёж=${payment}`)
      }
    }
  }

  // ?dropanchors=key1,key2 — точечно удалить якоря по ключу
  const dropKeys = (new URL(req.url).searchParams.get('dropanchors') ?? '')
    .split(',').map(x => x.trim()).filter(Boolean)
  if (dropKeys.length) {
    const { data: gone } = await db.from('bot_anchors')
      .delete().eq('user_id', USER_ID).in('key', dropKeys).select('key')
    fixes.push(`якоря удалены: ${(gone ?? []).map(g => g.key).join(', ') || 'нет совпадений'}`)
  }

  // ?nostipend=1 — удалить стипендию из регулярных доходов.
  // Пока строка жива, ядро каждый запрос заново вставляет её в контекст,
  // и никакие слова пользователя «стипендии больше нет» на это не влияют.
  if (new URL(req.url).searchParams.get('nostipend') === '1') {
    const ri = (user?.recurring_incomes ?? []) as { name: string }[]
    const kept = ri.filter(r => !/стипенд/i.test(r.name))
    await db.from('users').update({ recurring_incomes: kept }).eq('id', USER_ID)
    fixes.push(`регулярные доходы: было ${ri.length}, стало ${kept.length}`)
  }

  // ?zerocards=1 — обнулить долги по всем картам (подтверждено пользователем)
  if (new URL(req.url).searchParams.get('zerocards') === '1') {
    await db.from('cards').update({ current_debt: 0 }).eq('user_id', USER_ID)
    fixes.push('все долги по картам обнулены')
  }

  // ?setsources=1 — проставить источник списания постоянным тратам
  if (new URL(req.url).searchParams.get('setsources') === '1') {
    const SRC: Record<string, string> = {
      'ЖКХ': 'credit_tbank', 'коммунал': 'credit_tbank',
      'Электричество': 'debit_sber', 'Интернет': 'debit_sber',
      'DDX': 'debit_sber', 'Обучение': 'debit_sber',
    }
    const fc = (user?.fixed_costs ?? []) as { name: string; source?: string }[]
    const patched = fc.map(f => {
      if (f.source) return f
      const hit = Object.entries(SRC).find(([k]) => f.name.toLowerCase().includes(k.toLowerCase()))
      return hit ? { ...f, source: hit[1] } : f
    })
    await db.from('users').update({ fixed_costs: patched }).eq('id', USER_ID)
    fixes.push(`источники проставлены: ${patched.filter(f => f.source).length}/${patched.length}`)
  }

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
    backlog: backlog ?? [],
    ideas: ideas ?? [],
    fixes,
    deleted,
    corrections_total: corrections?.length ?? 0,
    corrections_junk: junk.length,
    corrections_keep: keep.map(c => ({ cat: c.category, text: String(c.correction).slice(0, 160) })),
    memories_total: memories?.length ?? 0,
    memories_dupes: memDupes.length,
    memories_dupes_list: memDupes,
    memories_survivors: survivors.map(s => ({ id: s.id, text: s.content.slice(0, 130) })),
    loan_logs: loanLogs,
    state: {
      month_key: monthKey,
      salary_net: user?.salary_net,
      var_budget: user?.var_budget,
      fixed_costs: user?.fixed_costs,
      recurring_incomes: user?.recurring_incomes,
      debit_balance: user?.debit_balance,
      debit_tbank: user?.debit_tbank,
      month_row: month,
      cards,
      loans,
      anchors,
    },
  })
}
