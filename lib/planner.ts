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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function db(): SupabaseClient<any, any, any> {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!) as any
}

type Row = Record<string, any>

// ── Даты: та же конвенция, что и весь проект (UTC ISO YYYY-MM-DD) ──
function todayISO(): string { return new Date().toISOString().slice(0, 10) }
function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10)
}
function mondayISO(iso: string): string {
  const dow = new Date(iso + 'T00:00:00Z').getUTCDay()  // 0=вс..6=сб
  return addDaysISO(iso, -((dow + 6) % 7))               // сдвиг к понедельнику
}
function resolveLoggedDate(hint?: string): string {
  const t = todayISO()
  if (!hint) return t
  const h = hint.trim().toLowerCase()
  if (h.includes('позавчера')) return addDaysISO(t, -2)
  if (h.includes('вчера')) return addDaysISO(t, -1)
  return t
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
  // ── ПРИВЫЧКИ (P-3) ──
  {
    name: 'add_habit',
    description: 'ОБЯЗАТЕЛЬНО вызывай на: «добавь привычку X», «хочу начать X каждый день», «буду делать X», «хочу привычку медитировать», «добавь зал как привычку». НИКОГДА не отвечай «добавил/готово» без вызова этого инструмента. Привычки — регулярное для себя (зал, медитация, чтение, бег, зарядка), не разовые дела. (зал, зарядка, медитация, чтение, бег, английский). Вызывай на «хочу начать ходить в зал», «добавь привычку медитировать», «буду читать каждый день», «хочу заниматься спортом 3 раза в неделю». НЕ для разовых дел (для них add_task). Привычки — это то, что повторяется и развивает; задачи — разовые поручения.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Название привычки (Зал, Медитация, Чтение)' },
        category: { type: 'string', enum: ['work', 'personal', 'study', 'family', 'health', 'home', 'hobby'], description: 'Сфера (зал/бег → health, чтение → personal/study)' },
        frequency: { type: 'string', enum: ['daily', 'weekly', 'flexible'], description: 'daily=каждый день; weekly=в определённые дни недели; flexible=N раз в неделю без фиксированных дней' },
        target_days_per_week: { type: 'number', description: 'Сколько раз в неделю (для flexible/weekly), напр. зал 3 раза → 3' },
        days_of_week: { type: 'array', items: { type: 'string' }, description: "Фиксированные дни для weekly: ['MO','WE','FR']" },
        metric_type: { type: 'string', enum: ['boolean', 'quantity'], description: 'boolean=просто сделал/не сделал; quantity=с числом (минуты, страницы, кг)' },
        metric_unit: { type: 'string', description: "Единица для quantity: 'мин', 'страниц', 'кг', 'км'" },
      },
      required: ['title'],
    },
  },
  {
    name: 'log_habit',
    description: 'ОБЯЗАТЕЛЬНО вызывай при: «сделал зарядку», «сходил в зал», «помедитировал», «прочитал N страниц», «пожал лёжа 80 кг», «пробежал 5 км», «не делал сегодня», «вчера был в зале». ВСЕГДА передавай value+value_unit если есть число: «80 кг»→value=80,value_unit=кг; «30 страниц»→value=30,value_unit=страниц; «45 мин»→value=45,value_unit=мин. Привычки без названия автосоздаются., «сходил в зал», «помедитировал 15 минут», «прочитал 30 страниц», «пожал лёжа 80 кг», «пробежал 5 км», «сегодня не тренировался». Если такой привычки ещё нет — она создастся автоматически. Поддерживает прошедшие даты («вчера вечером медитировал», «позавчера был в зале»).',
    input_schema: {
      type: 'object',
      properties: {
        habit: { type: 'string', description: 'Название привычки (зал, медитация, чтение)' },
        done: { type: 'boolean', description: 'false если пропустил/не делал (с пояснением в note)' },
        value: { type: 'number', description: 'Интенсивность: минуты / страницы / кг / повторы / км' },
        value_unit: { type: 'string', description: "Единица: 'мин', 'страниц', 'кг', 'км'" },
        logged_date: { type: 'string', description: 'Дата ISO YYYY-MM-DD. По умолчанию сегодня.' },
        logged_relative: { type: 'string', description: 'ТОЛЬКО если не уверен в дате: «сегодня|вчера|позавчера». Сервер посчитает.' },
        note: { type: 'string', description: 'Контекст: почему пропустил, детали тренировки, ощущения' },
      },
      required: ['habit'],
    },
  },
  {
    name: 'list_habits',
    description: 'ОБЯЗАТЕЛЬНО вызывай на: «мои привычки», «покажи привычки», «как я с привычками», «сколько раз был в зале», «статистика привычек». НИКОГДА не отвечай из памяти — только из БД через этот инструмент. «мои привычки», «как у меня с привычками», «статистика привычек», «сколько раз я был в зале».',
    input_schema: { type: 'object', properties: {} },
  },
]

export const PLANNER_TOOL_NAMES = new Set([...plannerTools.map(t => t.name), 'get_planner_summary'])

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

// ═══════════════════════════════════════════════════════════════
// ЯДРО ПЛАНИРОВЩИКА — computePlannerState()
// Единственный источник истины. Бот И сайт читают отсюда.
// LLM не считает — только показывает готовый результат.
// ═══════════════════════════════════════════════════════════════

export interface PlannerTask {
  id: string
  title: string
  description: string | null
  category: string | null
  priority: string
  status: string
  due_date: string | null
  due_time: string | null
  planned_amount: number | null
  contact_name: string | null
  parent_id: string | null
}

export interface HabitToday {
  id: string
  title: string
  category: string | null
  metric_type: string
  metric_unit: string | null
  target_days_per_week: number | null
  done_today: boolean
  today_value: number | null
  week_count: number
}

export interface PlannerState {
  as_of: string                 // ISO date (сегодня)
  today: PlannerTask[]          // due_date = сегодня, pending
  overdue: PlannerTask[]        // due_date < сегодня, pending
  week: PlannerTask[]           // due_date = завтра..+7 дней, pending
  backlog: PlannerTask[]        // due_date IS NULL, pending
  open_count: number            // все pending
  done_today: number            // выполнено сегодня
  habits: HabitToday[]          // активные привычки + статус на сегодня/неделю
}

export async function computePlannerState(): Promise<PlannerState> {
  const s = db()
  const today = todayISO()
  const weekEnd = addDaysISO(today, 7)

  // Один запрос — всё pending + выполненные сегодня
  const { data, error } = await s
    .from('planner_tasks')
    .select('id,title,description,category,priority,status,due_date,due_time,planned_amount,contact_name,parent_id,completed_at')
    .eq('user_id', USER_ID)
    .neq('status', 'cancelled')
    .or(`status.eq.pending,and(status.eq.done,completed_at.gte.${today}T00:00:00Z)`)
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('due_time', { ascending: true, nullsFirst: false })

  if (error) throw new Error(`computePlannerState: ${error.message}`)

  const rows: Row[] = data ?? []
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2, backlog: 3 }

  function sortTasks(arr: Row[]): PlannerTask[] {
    return [...arr]
      .sort((a, b) => {
        // Сначала по времени (если задано), потом по приоритету
        if (a.due_time && b.due_time && a.due_time !== b.due_time) return a.due_time < b.due_time ? -1 : 1
        if (a.due_time && !b.due_time) return -1
        if (!a.due_time && b.due_time) return 1
        return (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1)
      })
      .map(r => ({
        id: r.id,
        title: r.title,
        description: r.description ?? null,
        category: r.category ?? null,
        priority: r.priority,
        status: r.status,
        due_date: r.due_date ?? null,
        due_time: r.due_time ? String(r.due_time).slice(0, 5) : null,
        planned_amount: r.planned_amount ? Math.round(Number(r.planned_amount)) : null,
        contact_name: r.contact_name ?? null,
        parent_id: r.parent_id ?? null,
      }))
  }

  const pending = rows.filter(r => r.status === 'pending')
  const doneToday = rows.filter(r => r.status === 'done')

  // ── Привычки: активные + логи за текущую неделю (Пн-старт) ──
  const weekStart = mondayISO(today)
  const [habitsRes, logsRes] = await Promise.all([
    s.from('planner_habits')
      .select('id,title,category,metric_type,metric_unit,target_days_per_week')
      .eq('user_id', USER_ID).eq('status', 'active')
      .order('sort_order', { ascending: true }),
    s.from('planner_habit_logs')
      .select('habit_id,logged_date,done,value')
      .eq('user_id', USER_ID).gte('logged_date', weekStart),
  ])
  const habitRows: Row[] = habitsRes.data ?? []
  const logRows: Row[] = logsRes.data ?? []

  const habits: HabitToday[] = habitRows.map(h => {
    const mine = logRows.filter(l => l.habit_id === h.id)
    const todayLog = mine.find(l => l.logged_date === today)
    return {
      id: h.id,
      title: h.title,
      category: h.category ?? null,
      metric_type: h.metric_type,
      metric_unit: h.metric_unit ?? null,
      target_days_per_week: h.target_days_per_week ?? null,
      done_today: !!(todayLog && todayLog.done),
      today_value: todayLog && todayLog.value != null ? Number(todayLog.value) : null,
      week_count: mine.filter(l => l.done).length,
    }
  })

  return {
    as_of: today,
    today:   sortTasks(pending.filter(r => r.due_date === today)),
    overdue: sortTasks(pending.filter(r => r.due_date && r.due_date < today)),
    week:    sortTasks(pending.filter(r => r.due_date && r.due_date > today && r.due_date <= weekEnd)),
    backlog: sortTasks(pending.filter(r => !r.due_date)),
    open_count: pending.length,
    done_today: doneToday.length,
    habits,
  }
}

// ── Форматировщик для бота (компактный, Telegram-style) ──
function fmtStateForBot(s: PlannerState): string {
  const ICONS: Record<string, string> = {
    work: '💼', personal: '👤', study: '📚', family: '👨‍👩‍👧', health: '🏃', home: '🏠', hobby: '🎨'
  }
  const PRIO: Record<string, string> = { high: '🔴', medium: '🟡', low: '⚪', backlog: '📋' }

  function fmtLine(t: PlannerTask): string {
    const icon = ICONS[t.category ?? ''] ?? '•'
    const prio = PRIO[t.priority] ?? '•'
    const time = t.due_time ? ` ${t.due_time}` : ''
    const amt  = t.planned_amount ? ` (~${t.planned_amount.toLocaleString('ru-RU')}₽)` : ''
    const who  = t.contact_name ? ` @${t.contact_name}` : ''
    return `${prio}${icon} ${t.title}${time}${amt}${who}`
  }

  const lines: string[] = [`📅 ПЛАН — ${s.as_of}`]

  if (s.overdue.length) {
    lines.push(`\n⚠️ ПРОСРОЧЕНО (${s.overdue.length}):`)
    s.overdue.forEach(t => lines.push('  ' + fmtLine(t)))
  }

  if (s.today.length) {
    lines.push(`\n✅ СЕГОДНЯ (${s.today.length}):`)
    s.today.forEach(t => lines.push('  ' + fmtLine(t)))
  } else {
    lines.push('\n✅ СЕГОДНЯ: задач нет')
  }

  if (s.week.length) {
    lines.push(`\n📆 НА НЕДЕЛЕ (${s.week.length}):`)
    // Группируем по дате
    const byDate: Record<string, PlannerTask[]> = {}
    s.week.forEach(t => {
      const d = t.due_date ?? 'без даты'
      if (!byDate[d]) byDate[d] = []
      byDate[d].push(t)
    })
    Object.entries(byDate).forEach(([date, tasks]) => {
      lines.push(`  ${date}:`)
      tasks.forEach(t => lines.push('    ' + fmtLine(t)))
    })
  }

  if (s.backlog.length) {
    lines.push(`\n📋 БЭКЛОГ: ${s.backlog.length} задач без срока`)
  }

  if (s.habits.length) {
    lines.push(`\n🔁 ПРИВЫЧКИ СЕГОДНЯ:`)
    s.habits.forEach(h => {
      const mark = h.done_today ? '✅' : '⬜'
      const val = h.today_value != null ? ` (${h.today_value}${h.metric_unit ? ' ' + h.metric_unit : ''})` : ''
      const tgt = h.target_days_per_week ? ` — ${h.week_count}/${h.target_days_per_week} за неделю` : (h.week_count ? ` — ${h.week_count}× за неделю` : '')
      lines.push(`  ${mark} ${h.title}${val}${tgt}`)
    })
  }

  const stats = []
  if (s.done_today) stats.push(`выполнено сегодня: ${s.done_today}`)
  stats.push(`всего открытых: ${s.open_count}`)
  lines.push(`\n─\n${stats.join(' | ')}`)

  return lines.join('\n')
}

// ── Инструмент: get_planner_summary ──
async function getPlannerSummary(): Promise<string> {
  const state = await computePlannerState()
  return fmtStateForBot(state)
}

// ═══════════════ Добавляем tool в массив ═══════════════
// (добавлен ниже в plannerTools через re-export патч — см. конец файла)
export const plannerSummaryTool = {
  name: 'get_planner_summary',
  description: 'Сводка планировщика: задачи на сегодня, просроченные, план на неделю, бэклог. Вызывай на: "/today", "план на сегодня", "что у меня сегодня", "задачи на эту неделю", "покажи план", "что нужно сделать". Это NE get_financial_summary — только задачи и дела, без финансов.',
  input_schema: { type: 'object' as const, properties: {} },
}

// ─────────────────────────── ХЕНДЛЕРЫ ПРИВЫЧЕК (P-3) ───────────────────────────
async function addHabit(input: Row): Promise<string> {
  const s = db()
  const title = String(input.title ?? '').trim()
  if (!title) return 'Ошибка: пустое название привычки.'
  const freq = ['daily', 'weekly', 'flexible'].includes(String(input.frequency)) ? String(input.frequency) : 'flexible'
  const row: Row = {
    user_id: USER_ID,
    title,
    category: input.category ?? null,
    frequency: freq,
    target_days_per_week: (typeof input.target_days_per_week === 'number') ? input.target_days_per_week : null,
    days_of_week: Array.isArray(input.days_of_week) ? input.days_of_week : null,
    metric_type: input.metric_type === 'quantity' ? 'quantity' : 'boolean',
    metric_unit: input.metric_unit ?? null,
    status: 'active',
  }
  const { data, error } = await s.from('planner_habits').insert(row).select().single()
  if (error) return `Ошибка создания привычки: ${error.message}`
  const fr = data.target_days_per_week ? `${data.target_days_per_week}×/нед` : data.frequency
  return `Привычка создана (ФАКТ ИЗ БД): «${data.title}» [${data.category ?? 'без категории'}], ${fr}, метрика: ${data.metric_type}${data.metric_unit ? ' (' + data.metric_unit + ')' : ''}.`
}

async function logHabit(input: Row): Promise<string> {
  const s = db()
  const key = String(input.habit ?? '').trim()
  if (!key) return 'Ошибка: не указана привычка.'

  let habit: Row | null = null
  const { data: found } = await s.from('planner_habits')
    .select('id,title,metric_type,metric_unit')
    .eq('user_id', USER_ID).eq('status', 'active').ilike('title', `%${key}%`).limit(1)
  if (found && found.length) habit = found[0]

  let created = false
  if (!habit) {
    const metric = (typeof input.value === 'number') ? 'quantity' : 'boolean'
    const { data: nh, error: ce } = await s.from('planner_habits').insert({
      user_id: USER_ID, title: key, frequency: 'flexible', metric_type: metric,
      metric_unit: input.value_unit ?? null, status: 'active',
    }).select().single()
    if (ce) return `Ошибка автосоздания привычки: ${ce.message}`
    habit = nh; created = true
  }

  const date = (typeof input.logged_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.logged_date))
    ? input.logged_date
    : resolveLoggedDate(input.logged_relative ? String(input.logged_relative) : undefined)
  const done = input.done === false ? false : true

  const { data, error } = await s.from('planner_habit_logs').upsert({
    user_id: USER_ID, habit_id: habit!.id, logged_date: date, done,
    value: (input.value != null && !isNaN(Number(input.value))) ? Number(input.value) : null,
    value_unit: input.value_unit ?? (habit ? habit.metric_unit : null) ?? null,
    note: input.note ?? null, logged_at: new Date().toISOString(),
  }, { onConflict: 'habit_id,logged_date' }).select().single()
  if (error) return `Ошибка чек-ина: ${error.message}`

  const weekStart = mondayISO(todayISO())
  const { data: wl } = await s.from('planner_habit_logs').select('done')
    .eq('user_id', USER_ID).eq('habit_id', habit!.id).gte('logged_date', weekStart)
  const wc = (wl ?? []).filter((l: Row) => l.done).length

  const valStr = data && data.value != null ? ` ${data.value}${data.value_unit ? ' ' + data.value_unit : ''}` : ''
  const status = done ? `✅ отмечено${valStr}` : '⬜ пропуск'
  const pre = created ? `Создал привычку «${habit!.title}» и ` : ''
  const noteStr = input.note ? ' Заметка сохранена.' : ''
  return `${pre}${status} на ${date} (ФАКТ ИЗ БД). За неделю: ${wc}×.${noteStr}`
}

async function listHabits(): Promise<string> {
  const state = await computePlannerState()
  if (!state.habits.length) return 'Привычек пока нет. Создай через add_habit («хочу начать ходить в зал»).'
  const lines = state.habits.map(h => {
    const mark = h.done_today ? '✅' : '⬜'
    const val = h.today_value != null ? ` (сегодня ${h.today_value}${h.metric_unit ? ' ' + h.metric_unit : ''})` : ''
    const tgt = h.target_days_per_week ? `${h.week_count}/${h.target_days_per_week}` : `${h.week_count}×`
    return `${mark} ${h.title} — за неделю ${tgt}${val}`
  })
  return `🔁 ПРИВЫЧКИ (неделя с пн) — ФАКТ ИЗ БД:\n` + lines.join('\n')
}

export async function handlePlannerTool(name: string, input: Record<string, unknown>): Promise<string> {
  const inp = (input ?? {}) as Row
  if (name === 'get_planner_summary') return await getPlannerSummary()
  if (name === 'add_task') return await addTask(inp)
  if (name === 'complete_task') return await completeTask(inp)
  if (name === 'list_tasks') return await listTasks(inp)
  if (name === 'add_habit') return await addHabit(inp)
  if (name === 'log_habit') return await logHabit(inp)
  if (name === 'list_habits') return await listHabits()
  return `Неизвестный planner-инструмент: ${name}`
}
