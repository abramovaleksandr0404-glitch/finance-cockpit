/**
 * Finance Cockpit — Shared Helpers
 * DB helpers, кеш, Telegram history, updateAnchors, snap, recordDebitChange.
 * НЕ импортирует из bot.ts — нет циклических зависимостей.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { computeWorkingDays } from './calc'

export const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'
export const TG = process.env.TELEGRAM_BOT_TOKEN!
export const db = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
export const mk = () => new Date().toISOString().slice(0, 7)
export const rub = (n: number) => n.toLocaleString('ru-RU') + '₽'
export const pct = (n: number) => (n * 100).toFixed(1) + '%'
export const quarterOf = (d: Date) => Math.ceil((d.getMonth() + 1) / 3)
export const advanceDay = () => new Date(new Date().getFullYear(), new Date().getMonth(), 15)
export const lastWorkingDayOfMonth = (y: number, m: number, hols: string[]) => {
  const hs = new Set(hols)
  for (let d = new Date(y, m, 0); ; d.setDate(d.getDate() - 1)) {
    if (d.getDay() !== 0 && d.getDay() !== 6 && !hs.has(d.toISOString().slice(0,10))) return d
  }
}

// ── Request-level cache (TTL 60s) — один раз за запрос, не 8 ──────────────
const _cache = new Map<string, { value: string; ts: number }>()
const CACHE_TTL = 60_000 // 60 секунд

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const hit = _cache.get(key)
  if (hit && now - hit.ts < CACHE_TTL) return JSON.parse(hit.value) as T
  const value = await fn()
  _cache.set(key, { value: JSON.stringify(value), ts: now })
  return value
}

function invalidateCache(...keys: string[]) {
  keys.forEach(k => _cache.delete(k))
}

const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'
const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}
function mk(): string { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}` }
function rub(n: number): string { return Math.round(n).toLocaleString('ru-RU')+' ₽' }
function pct(a: number, b: number): number { return b>0 ? Math.round(a/b*100) : 0 }
function quarterOf(m: number): number { return Math.ceil(m/3) }

// День аванса: 15-е если рабочий, иначе последний рабочий день перед 15-м
function advanceDay(y: number, m: number): number {
  const d = new Date(y, m-1, 15)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate()-1)
  return d.getDate()
}
// Последний рабочий день месяца (для зп+бонуса)
function lastWorkingDayOfMonth(y: number, m: number): number {
  const d = new Date(y, m, 0)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate()-1)
  return d.getDate()
}

export async function getHistory(chatId: number) {
  const { data } = await db().from('bot_messages').select('role,content').eq('chat_id', chatId).order('created_at', { ascending: false }).limit(6)
  // ВАЖНО: длинные ответы ассистента заменяем тематическим тегом без форматирования.
  // Причина: первые 200 символов включали заголовки/таблицы → LLM копировал структуру.
  // Тематический тег даёт контекст ("о чём говорили") без шаблона для копирования.
  return (data ?? []).reverse().map((h: {role:string; content:string}) => {
    if (h.role === 'assistant' && h.content.length > 120) {
      // Берём суть без markdown: убираем **, *, #, |, эмодзи-заголовки
      const stripped = h.content.replace(/[*#|_~`]/g,'').replace(/[📊💰🏦📅📤📥🎯⚠️✅]/g,'').trim()
      const summary = Array.from(stripped).slice(0, 80).join('').replace(/\n+/g,' ').trim()
      return { role: h.role, content: `[Ответил: ${summary}…]` }
    }
    return h
  })
}
export async function saveHistory(chatId: number, role: 'user'|'assistant', content: string, msgType = 'text') {
  await db().from('bot_messages').insert({ chat_id: chatId, user_id: USER_ID, role, content, msg_type: msgType }).then(()=>{})
}

// Публичная функция для логирования из route.ts
export async function logMessage(chatId: number, role: 'user'|'assistant', content: string, msgType = 'text') {
  await db().from('bot_messages').insert({ chat_id: chatId, user_id: USER_ID, role, content, msg_type: msgType }).then(()=>{})
}
export async function storeChatId(chatId: number) {
  await db().from('users').update({ telegram_chat_id: chatId }).eq('id', USER_ID)
}

export async function updateAnchors(s: SupabaseClient): Promise<void> {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  const monthK = `${year}-${String(month).padStart(2, '0')}`
  const [{ data: u }, { data: loans }, { data: holidays }] = await Promise.all([
    s.from('users').select('salary_net,fixed_costs').eq('id', USER_ID).single(),
    s.from('loans').select('min_payment,principal').eq('user_id', USER_ID),
    s.from('ru_holidays').select('holiday_date')
      .gte('holiday_date', `${year}-${String(month).padStart(2, '0')}-01`)
      .lte('holiday_date', `${year}-${String(month).padStart(2, '0')}-31`),
  ])
  const wd = computeWorkingDays(year, month, (holidays ?? []).map((h: { holiday_date: string }) => String(h.holiday_date).slice(0, 10)))
  const dailyRate = Math.round(Number(u?.salary_net ?? 0) / wd)
  const totalLoans = (loans ?? []).reduce((acc, l) => acc + Number(l.min_payment), 0)
  const totalFixed = (u?.fixed_costs as Array<{ amount: number }> ?? []).reduce((acc, f) => acc + f.amount, 0)
  const anchorRows = [
    { key: 'working_days', value: String(wd), formula: 'рабочих дней с праздниками' },
    { key: 'daily_rate', value: String(dailyRate), formula: `${u?.salary_net}/${wd}` },
    { key: 'monthly_loan_payment', value: String(Math.round(totalLoans)), formula: 'сумма min_payment' },
    { key: 'fixed_total', value: String(totalFixed), formula: 'сумма fixed_costs' },
  ]
  for (const a of anchorRows) {
    await s.from('bot_anchors').upsert(
      { user_id: USER_ID, month_key: monthK, ...a, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,month_key,key' }
    )
  }
  // Sprint 26: автосинхронизация cards_summary при любом обновлении якорей
  const { data: cardsAnchor } = await s.from('cards').select('name,card_limit,current_debt').eq('user_id', USER_ID)
  const cardsSumAnchor = (cardsAnchor ?? []).map((c: {name:string;card_limit:number;current_debt:number}) =>
    `${c.name}: долг ${c.current_debt}₽, доступно ${c.card_limit - c.current_debt}₽`).join('. ')
  const { data: uDebitAnchor } = await s.from('users').select('debit_balance').eq('id', USER_ID).single()
  const totalDebtAnchor = (cardsAnchor ?? []).reduce((sum: number, c: {current_debt:number}) => sum + Number(c.current_debt ?? 0), 0)
  const netPosAnchor = Math.round(Number(uDebitAnchor?.debit_balance ?? 0) - totalDebtAnchor)
  await s.from('bot_anchors').upsert([
    { user_id: USER_ID, month_key: 'global', key: 'cards_summary', value: cardsSumAnchor, updated_at: new Date().toISOString() },
    { user_id: USER_ID, month_key: 'global', key: 'net_position', value: String(netPosAnchor), updated_at: new Date().toISOString() },
  ], { onConflict: 'user_id,month_key,key' })
}

export async function snap(label: string) {
  const s = db()
  const [us,mo,lo,ca,go,ex,ie] = await Promise.all([
    s.from('users').select('*').eq('id',USER_ID).single(),
    s.from('months').select('*').eq('user_id',USER_ID),
    s.from('loans').select('*').eq('user_id',USER_ID),
    s.from('cards').select('*').eq('user_id',USER_ID),
    s.from('goals').select('*').eq('user_id',USER_ID),
    s.from('expenses').select('*').eq('user_id',USER_ID),
    s.from('income_events').select('*').eq('user_id',USER_ID),
  ])
  const state = {users:us.data,months:mo.data??[],loans:lo.data??[],cards:ca.data??[],goals:go.data??[],expenses:ex.data??[],income_events:ie.data??[]}
  await s.from('undo_snapshots').insert({user_id:USER_ID,description:`[бот] ${label}`,snapshot:state})
  const { data:all } = await s.from('undo_snapshots').select('id').eq('user_id',USER_ID).order('created_at',{ascending:false})
  if (all && all.length>15) await s.from('undo_snapshots').delete().in('id',all.slice(15).map((r:{id:string})=>r.id))
}


// ════════════════════════════════════════════════════════════════════════════
// ЕДИНОЕ ФИНАНСОВОЕ ЯДРО — единственный источник истины для всех расчётов.
// Граф зависимостей: слой 0 (сырьё из БД) → слой 1 (агрегаты) → слой 2
// (производные) → слой 3 (прогнозы) → слой 4 (сценарии). Каждая величина
// считается РОВНО ОДИН РАЗ. getContext, getFinancialSummaryJson, сайт и
// дайджесты читают готовые поля и НИКОГДА не пересчитывают сами.
// ════════════════════════════════════════════════════════════════════════════
export interface FinancialState {
  // слой 0 — сырьё
  month_key: string; today: number; days_in_month: number; days_left: number
  debit_sber: number; tbank_debit: number
  // слой 1 — базовые агрегаты
  liquid: number; card_debt: number; net_position: number
  var_spent: number; extra_spent: number
  fixed_total: number; fixed_paid: number
  // слой 2 — производные
  var_budget: number; var_left: number; daily_var_budget: number
  fixed_unpaid: number
  pending_loans: number
  pending_income: number
  pending_salary: number; pending_recurring: number
  stipend_needs_confirm: boolean   // день≥11, не отмечена → бот должен спросить
  // слой 3 — прогнозы
  forecast_eom: number
  planned_total: number; forecast_after_planned: number
  // отпуска / корректировки ЗП
  vacations: { date: string; days: number; type: string; deduct: number; deduct_from: string; paid_amount: number }[]
  salary_loss_total: number  // суммарная потеря из-за отпусков в этом месяце
  // Внеплановые траты (детально)
  extra_expenses: { description: string; amount: number }[]
  // прогноз следующего месяца (пересчитан по ЕГО рабочим дням, БЕЗ отпусков)
  next_month_key: string
  next_working_days: number; next_daily_rate: number
  next_first_half: number; next_second_half: number  // рабочих дней в 1-й и 2-й половинах
  next_adv: number; next_eom: number
  next_forecast: number
  // детали для вывода
  cards: { name: string; debt: number; available: number }[]
  loans_pending: { name: string; amount: number; rate_percent: number; accrued_int: number }[]
  loans_paid: { name: string; amount: number }[]
  loans_all: { name: string; principal: number; accrued_int: number; rate_percent: number; min_payment: number; due_day: string; paid_this_month: boolean; end_date: string|null; months_left: number|null; overpay_total: number|null }[]
  incomes: { name: string; amount: number; received: boolean; status: string }[]
}

// Ежедневное начисление процентов по кредитам (идемпотентно, как на сайте lib/accrue.ts).
// Вызывается из ядра → проценты капают при ЛЮБОМ обращении бота, не только при загрузке сайта.


export async function recordDebitChange(
  s: SupabaseClient,
  prevBalance: number,
  newBalance: number,
  description: string,
  sourceType: string
): Promise<void> {
  await s.from('debit_history').insert({
    user_id: USER_ID,
    amount: Math.round((newBalance - prevBalance) * 100) / 100,
    balance_after: Math.round(newBalance * 100) / 100,
    description,
    source_type: sourceType,
  }).then(() => {})
}

// ── Выполнение действий ───────────────────────────────────────────────────
