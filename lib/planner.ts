/**
 * Finance Cockpit — Блок ПЛАНИРОВЩИК (P-1: ЗАДАЧИ)
 * --------------------------------------------------------------------------
 * Изолированный модуль (по образцу lib/finance.ts). НЕ трогает финблок.
 * Принципы проекта: числа/факты возвращаются из БД (read-after-write),
 * LLM ничего не выдумывает; единый источник истины — таблицы planner_*.
 *
 * P-1 покрывает задачи (add_task / complete_task / list_tasks).
 * Привычки (planner_habits/_logs) и ядро computePlannerState() — следующие спринты.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'
function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

type Row = Record<string, any>

// ── Даты: та же конвенция, что и весь проект (UTC ISO YYYY-MM-DD) ──
function todayISO(): string { return new Date().toISOString().slice(0, 10) }
function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10)
}
// Резолвер относительных дат — СТРАХОВКА. Обычно модель сама передаёт ISO due_date
// (в системном контексте есть текущая ДАТА с днём недели).
const WD: Record<string, number> = {
  'воскресень': 0, 'понедельник': 1, 'вторник': 2, 'сред': 3, 'четверг': 4, 'пятниц': 5, 'суббот': 6,
}
function resolveRelative(hint?: string): string | null {
  if (!hint) return null
  const h = hint.trim().toLowerCase()
  const t = todayISO()
  if (['сегодня', 'today'].includes(h)) return t
  if (['завтра', 'tomorrow'].includes(h)) return addDaysISO(t, 1)
  if (h === 'послезавтра') return addDaysISO(t, 2)
  for (const [stem, dow] of Object.entries(WD)) {
    if (h.includes(stem)) {
      const cur = new Date(t + 'T00:00:00Z').getUTCDay()
      let delta = (dow - cur + 7) % 7
      if (delta === 0) delta = 7 // «в субботу» = ближайшая будущая, не сегодня
      return addDaysISO(t, delta)
    }
  }
  return null
}

const PRIORITIES = ['high', 'medium', 'low', 'backlog']
function normPriority(p?: string): string {
  if (!p) return 'medium'
  const x = p.toLowerCase()
  if (PRIORITIES.includes(x)) return x
  if (['срочно', 'urgent', 'высок', 'high'].some(k => x.includes(k))) return 'high'
  if (['бэклог', 'backlog', 'когда-нибудь', 'потом'].some(k => x.includes(k))) return 'backlog'
  if (['низк', 'low', 'неважно', 'маловажн'].some(k => x.includes(k))) return 'low'
  return 'medium'
}

// ─────────────────────────── ОПРЕДЕЛЕНИЯ ИНСТРУМЕНТОВ ───────────────────────────
export const plannerTools = [
  {
    name: 'add_task',
    description: 'Личные/рабочие/учебные/бытовые ДЕЛА и ЗАДАЧИ пользователя (НЕ разработка бота — для неё есть add_backlog_item). Вызывай ОБЯЗАТЕЛЬНО когда Александр упоминает дело, поручение, встречу, запись, дедлайн: «надо/нужно сделать X», «задача …», «напомни сделать …», «записался на стрижку/к врачу», «встреча в …», «сдать в деканат завтра», «позвонить Иванову». Если у дела есть конкретное время — это уже важная задача (priority=high). Если связано с тратой — укажи planned_amount; если с человеком — contact_name. НИКОГДА не пиши «записал/добавил» без реального вызова инструмента.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Краткая суть задачи' },
        description: { type: 'string', description: 'Детали/контекст (например, что обсудить)' },
        category: { type: 'string', enum: ['work', 'personal', 'study', 'family', 'health', 'home', 'hobby'], description: 'Сфера задачи' },
        priority: { type: 'string', enum: ['high', 'medium', 'low', 'backlog'], description: 'high=срочно или есть точное время; medium=обычное дело; low=маловажное; backlog=без срока, когда-нибудь' },
        due_date: { type: 'string', description: 'Дедлайн ISO YYYY-MM-DD. Вычисли из контекста (в системе есть текущая ДАТА с днём недели). Пусто = бэклог без срока.' },
        due_relative: { type: 'string', description: 'ТОЛЬКО если не уверен в ISO-дате: «сегодня|завтра|послезавтра|<день недели>». Сервер посчитает сам.' },
        due_time: { type: 'string', description: 'Время HH:MM (24ч), если назначено конкретное время' },
        planned_amount: { type: 'number', description: 'Плановая трата в ₽, если дело связано с расходом (стрижка 6600, чайная церемония 8700)' },
        contact_name: { type: 'string', description: 'Имя человека, связанного с делом (мастер, клиент), напр. «Николай»' },
        parent_title: { type: 'string', description: 'Если это ПОДзадача — точное/частичное название родительской задачи (строится дерево)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'complete_task',
    description: 'Отметить задачу выполненной или отменённой. Вызывай когда Александр говорит «сделал X», «выполнил …», «готово …», «закрыл задачу …», «отмени задачу …». Ищи задачу по названию (частичное совпадение) или по id.',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Название (или часть) задачи, либо её id' },
        cancel: { type: 'boolean', description: 'true = отменить (cancelled) вместо «выполнено»' },
      },
      required: ['task'],
    },
  },
  {
    name: 'list_tasks',
    description: 'Показать задачи пользователя из планировщика (это НЕ финансы и НЕ бэклог разработки). Вызывай на: «что сегодня по делам», «мои задачи», «план на неделю», «что в списке дел», «задачи на завтра», «что просрочено», «что в бэклоге дел».',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['today', 'tomorrow', 'week', 'overdue', 'backlog', 'open', 'all'], description: 'today=на сегодня; tomorrow=завтра; week=ближайшие 7 дней; overdue=просрочено; backlog=без даты; open=все невыполненные (по умолчанию); all=включая выполненные/отменённые' },
        category: { type: 'string', description: 'Фильтр по сфере (необязательно)' },
      },
    },
  },
]

export const PLANNER_TOOL_NAMES = new Set(plannerTools.map(t => t.name))

// ─────────────────────────── ФОРМАТ ───────────────────────────
function fmtTask(t: Row): string {
  const bits: string[] = [`#${String(t.id).slice(0, 8)}`, t.title]
  if (t.due_date) bits.push(t.due_time ? `${t.due_date} ${String(t.due_time).slice(0, 5)}` : `${t.due_date}`)
  else bits.push('без срока')
  bits.push(`[${t.priority}]`)
  if (t.category) bits.push(String(t.category))
  if (t.planned_amount) bits.push(`~${Math.round(Number(t.planned_amount))}₽`)
  if (t.contact_name) bits.push(`@${t.contact_name}`)
  if (t.status && t.status !== 'pending') bits.push(`(${t.status})`)
  return bits.join(' · ')
}

// ─────────────────────────── ХЕНДЛЕРЫ ───────────────────────────
async function addTask(input: Row): Promise<string> {
  const s = db()
  const title = String(input.title ?? '').trim()
  if (!title) return 'Ошибка: пустой title задачи.'

  let dueDate: string | null =
    (typeof input.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.due_date)) ? input.due_date : null
  if (!dueDate && input.due_relative) dueDate = resolveRelative(String(input.due_relative))
  const dueTime: string | null =
    (typeof input.due_time === 'string' && /^\d{1,2}:\d{2}/.test(input.due_time)) ? input.due_time : null

  // Правило Александра: есть конкретное время → задача важная
  let priority = normPriority(input.priority ? String(input.priority) : undefined)
  if (dueTime && priority === 'medium') priority = 'high'

  // Подзадача → ищем родителя по названию
  let parentId: string | null = null
  if (input.parent_title) {
    const { data: par } = await s.from('planner_tasks')
      .select('id,title').eq('user_id', USER_ID)
      .ilike('title', `%${String(input.parent_title)}%`)
      .neq('status', 'cancelled').order('created_at', { ascending: false }).limit(1)
    if (par && par.length) parentId = par[0].id
  }

  const row: Row = {
    user_id: USER_ID,
    title,
    description: input.description ?? null,
    category: input.category ?? null,
    priority,
    status: 'pending',
    due_date: dueDate,
    due_time: dueTime,
    parent_id: parentId,
    planned_amount: (typeof input.planned_amount === 'number') ? Math.round(input.planned_amount) : null,
    contact_name: input.contact_name ?? null,
  }
  const { data, error } = await s.from('planner_tasks').insert(row).select().single()
  if (error) return `Ошибка записи задачи: ${error.message}`

  let extra = ''
  if (row.planned_amount) extra += ` Плановая трата ${row.planned_amount}₽ сохранена в планировщике (в финансовый прогноз пока НЕ включается).`
  if (parentId) extra += ` Привязана как подзадача.`
  return `Задача создана (ФАКТ ИЗ БД): ${fmtTask(data)}.${extra}`
}

async function completeTask(input: Row): Promise<string> {
  const s = db()
  const key = String(input.task ?? '').trim()
  if (!key) return 'Ошибка: не указана задача.'
  const newStatus = input.cancel ? 'cancelled' : 'done'
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)

  let matches: Row[] | null = null
  if (isUuid) {
    const r = await s.from('planner_tasks').select('id,title,status')
      .eq('user_id', USER_ID).eq('id', key)
    matches = r.data
  } else {
    const r = await s.from('planner_tasks').select('id,title,status')
      .eq('user_id', USER_ID).neq('status', 'done').neq('status', 'cancelled')
      .ilike('title', `%${key}%`).order('due_date', { ascending: true, nullsFirst: false }).limit(5)
    matches = r.data
  }

  if (!matches || matches.length === 0) return `Не нашёл активную задачу по «${key}». Уточни название.`
  if (matches.length > 1) return `Нашёл несколько задач по «${key}»: ${matches.map((m: Row) => m.title).join(' | ')}. Уточни какую именно.`

  const { data, error } = await s.from('planner_tasks')
    .update({ status: newStatus, completed_at: new Date().toISOString() })
    .eq('id', matches[0].id).eq('user_id', USER_ID).select().single()
  if (error) return `Ошибка обновления: ${error.message}`
  return `Готово (ФАКТ ИЗ БД): «${data.title}» → ${newStatus}.`
}

async function listTasks(input: Row): Promise<string> {
  const s = db()
  const scope = String(input.scope ?? 'open')
  const t = todayISO()
  let q = s.from('planner_tasks').select('*').eq('user_id', USER_ID)

  if (scope === 'backlog') q = q.is('due_date', null).eq('status', 'pending')
  else if (scope !== 'all') q = q.neq('status', 'cancelled')

  if (scope === 'today') q = q.eq('status', 'pending').eq('due_date', t)
  else if (scope === 'tomorrow') q = q.eq('status', 'pending').eq('due_date', addDaysISO(t, 1))
  else if (scope === 'week') q = q.eq('status', 'pending').gte('due_date', t).lte('due_date', addDaysISO(t, 7))
  else if (scope === 'overdue') q = q.eq('status', 'pending').lt('due_date', t)
  else if (scope === 'open') q = q.eq('status', 'pending')

  if (input.category) q = q.eq('category', String(input.category))

  const { data, error } = await q.order('due_date', { ascending: true, nullsFirst: false }).limit(50)
  if (error) return `Ошибка чтения задач: ${error.message}`
  if (!data || data.length === 0) return `Задач по фильтру «${scope}» нет.`

  const rank: Record<string, number> = { high: 0, medium: 1, low: 2, backlog: 3 }
  const rows = [...data].sort((a: Row, b: Row) => {
    const ad = a.due_date ?? '9999-12-31', bd = b.due_date ?? '9999-12-31'
    if (ad !== bd) return ad < bd ? -1 : 1
    return (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1)
  })
  return `Задачи (${scope}), ${rows.length} шт. — ФАКТ ИЗ БД:\n` + rows.map((r: Row) => '• ' + fmtTask(r)).join('\n')
}

export async function handlePlannerTool(name: string, input: Record<string, unknown>): Promise<string> {
  const inp = (input ?? {}) as Row
  if (name === 'add_task') return await addTask(inp)
  if (name === 'complete_task') return await completeTask(inp)
  if (name === 'list_tasks') return await listTasks(inp)
  return `Неизвестный planner-инструмент: ${name}`
}
