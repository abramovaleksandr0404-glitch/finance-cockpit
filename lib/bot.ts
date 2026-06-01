/**
 * Finance Cockpit Telegram Bot
 * Core logic: intent parsing, Supabase data access, response formatting
 */
import { createClient } from '@supabase/supabase-js'

const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502' // Alexandr

// ── Supabase admin client (bypasses RLS) ─────────────────────────────────
function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// ── Intent types ─────────────────────────────────────────────────────────
interface Intent {
  action: 'get_status' | 'add_expense' | 'get_loans' | 'get_cashflow' | 'get_daily' | 'help'
  amount?: number
  category?: string
  description?: string
}

// ── Intent parsing (regex, no API needed) ────────────────────────────────
export function parseIntent(text: string): Intent {
  const t = text.toLowerCase().trim()

  // Commands
  if (t === '/start' || t === '/help') return { action: 'help' }
  if (t === '/status' || t === '/stat') return { action: 'get_status' }
  if (t === '/loans' || t === '/debt' || t === '/долги' || t === '/кредиты') return { action: 'get_loans' }
  if (t === '/cashflow' || t === '/plan' || t === '/июнь') return { action: 'get_cashflow' }
  if (t === '/budget' || t === '/день') return { action: 'get_daily' }

  // Expense: "списал 800 на кофе", "потратил 1500", "трата 500 еда", "-800 такси"
  const expRe = /(?:списал|потратил|трата|расход|купил|заплатил|-)\s*(\d[\d\s]*)\s*(?:р|руб|рублей|₽)?(?:\s+(?:на|за)?\s*(.+))?/i
  const m = t.match(expRe)
  if (m) {
    const amount = parseInt(m[1].replace(/\s/g, ''))
    const raw = (m[2] ?? '').trim()
    return { action: 'add_expense', amount, description: raw, category: guessCategory(raw) }
  }

  // Balance / status keywords
  if (/баланс|деньги|сколько|счёт|счет|остаток|статус|итог/.test(t)) return { action: 'get_status' }
  if (/кредит|долг|займ|плате/.test(t)) return { action: 'get_loans' }
  if (/бюджет|день|дневной|тратить/.test(t)) return { action: 'get_daily' }
  if (/кешфлоу|план|месяц|июнь/.test(t)) return { action: 'get_cashflow' }

  return { action: 'help' }
}

function guessCategory(desc: string): string {
  const d = desc.toLowerCase()
  if (/кофе|кафе|ресторан|еда|обед|ужин|завтрак|продукт|магазин|супермаркет/.test(d)) return 'Еда и кафе'
  if (/такси|uber|яндекс\.go|метро|автобус|маршрут|транспорт/.test(d)) return 'Транспорт'
  if (/аптека|лекарств|здоровь|врач/.test(d)) return 'Здоровье'
  if (/кино|театр|развлеч|игр|спорт/.test(d)) return 'Развлечения'
  if (/одежда|обувь/.test(d)) return 'Одежда'
  return 'Прочее'
}

// ── Number formatting ─────────────────────────────────────────────────────
function r(n: number): string {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽'
}

// ── Handlers ─────────────────────────────────────────────────────────────

export async function handleGetStatus(): Promise<string> {
  const sb = getSupabase()
  const [{ data: user }, { data: loans }, { data: months }] = await Promise.all([
    sb.from('users').select('debit_balance, tbank_debit, var_budget').eq('id', USER_ID).single(),
    sb.from('loans').select('principal, accrued_int, min_payment').eq('user_id', USER_ID),
    sb.from('months').select('*').eq('user_id', USER_ID).eq('month_key', currentMK()).single(),
  ])
  if (!user) return '❌ Данные не найдены'

  const liquid = (user.debit_balance ?? 0) + (user.tbank_debit ?? 0)
  const totalDebt = (loans ?? []).reduce((s, l) => s + Number(l.principal) + Number(l.accrued_int), 0)
  const totalPayment = (loans ?? []).reduce((s, l) => s + Number(l.min_payment), 0)
  const { data: expenses } = await sb.from('expenses').select('amount').eq('user_id', USER_ID).eq('month_key', currentMK())
  const varSpent = (expenses ?? []).reduce((s, e) => s + Number(e.amount), 0)
  const varLeft = Math.max(0, (user.var_budget ?? 40000) - varSpent)
  const today = new Date().getDate()
  const daysLeft = new Date(2026, new Date().getMonth(), 0).getDate() - today + 1
  const daily = Math.round(varLeft / Math.max(1, daysLeft))

  return [
    `💰 *Финансовый статус · ${today} июня*`,
    ``,
    `🏦 Ликвидность: *${r(liquid)}*`,
    liquid !== user.debit_balance ? `   Сбер: ${r(user.debit_balance)}  ·  Т-Банк: ${r(user.tbank_debit ?? 0)}` : `   Сбер дебет: ${r(user.debit_balance)}`,
    ``,
    `📊 Переменные траты`,
    `   Потрачено: ${r(varSpent)} из ${r(user.var_budget ?? 40000)}`,
    `   Дневной бюджет: *${r(daily)}* / день (${daysLeft} дн. осталось)`,
    ``,
    `💳 Долг по кредитам: *${r(totalDebt)}*`,
    `   Платёж/мес: ${r(totalPayment)}`,
  ].join('\n')
}

export async function handleAddExpense(amount: number, category: string, description: string): Promise<string> {
  if (!amount || amount <= 0) return '❌ Не понял сумму. Попробуй: «списал 500 на кофе»'
  const sb = getSupabase()
  const mk = currentMK()
  const today = new Date().toISOString().split('T')[0]

  // Insert expense
  await sb.from('expenses').insert({
    user_id: USER_ID,
    month_key: mk,
    expense_date: today,
    category: category || 'Прочее',
    amount: Math.round(amount),
    description: description || null,
    source_type: 'debit',
  })

  // Deduct from debit
  const { data: u } = await sb.from('users').select('debit_balance, var_budget').eq('id', USER_ID).single()
  const newDebit = Math.round((Number(u?.debit_balance ?? 0) - amount) * 100) / 100
  await sb.from('users').update({ debit_balance: newDebit, debit_updated_at: new Date().toISOString() }).eq('id', USER_ID)

  // Recalculate varLeft
  const { data: expenses } = await sb.from('expenses').select('amount').eq('user_id', USER_ID).eq('month_key', mk)
  const varSpent = (expenses ?? []).reduce((s, e) => s + Number(e.amount), 0)
  const varLeft = Math.max(0, (u?.var_budget ?? 40000) - varSpent)
  const daysLeft = new Date(2026, new Date().getMonth(), 0).getDate() - new Date().getDate() + 1
  const daily = Math.round(varLeft / Math.max(1, daysLeft))

  const cat = category !== 'Прочее' ? category : (description || 'Прочее')
  return [
    `✅ *Записано: ${cat} · ${r(amount)}*`,
    ``,
    `Дебет: ${r(newDebit)}`,
    `Переменные: ${r(varSpent)} / ${r(u?.var_budget ?? 40000)}`,
    `Дневной бюджет: *${r(daily)}* / день`,
  ].join('\n')
}

export async function handleGetLoans(): Promise<string> {
  const sb = getSupabase()
  const { data: loans } = await sb.from('loans').select('*').eq('user_id', USER_ID).order('sort_order')
  if (!loans?.length) return '🎉 Кредитов нет!'

  const totalDebt = loans.reduce((s, l) => s + Number(l.principal) + Number(l.accrued_int), 0)
  const totalPay = loans.reduce((s, l) => s + Number(l.min_payment), 0)
  const now = new Date()

  const lines = loans.map((l) => {
    const total = Number(l.principal) + Number(l.accrued_int)
    let months = ''
    if (l.end_date) {
      const end = new Date(l.end_date)
      const m = (end.getFullYear() - now.getFullYear()) * 12 + end.getMonth() - now.getMonth()
      months = ` · ${m} мес`
    }
    return `• *${l.name}*: ${r(total)} · ${(Number(l.rate) * 100).toFixed(1)}%${months}`
  })

  return [
    `🏦 *Кредиты*`,
    ``,
    ...lines,
    ``,
    `Итого: *${r(totalDebt)}*`,
    `Платёж/мес: ${r(totalPay)}`,
    ``,
    `_Для досрочного погашения открой сайт → Долги_`,
  ].join('\n')
}

export async function handleGetDaily(): Promise<string> {
  const sb = getSupabase()
  const [{ data: u }, { data: expenses }] = await Promise.all([
    sb.from('users').select('var_budget').eq('id', USER_ID).single(),
    sb.from('expenses').select('amount').eq('user_id', USER_ID).eq('month_key', currentMK()),
  ])
  const varBudget = u?.var_budget ?? 40000
  const varSpent = (expenses ?? []).reduce((s, e) => s + Number(e.amount), 0)
  const varLeft = Math.max(0, varBudget - varSpent)
  const today = new Date().getDate()
  const daysInMonth = new Date(2026, new Date().getMonth(), 0).getDate()
  const daysLeft = daysInMonth - today + 1
  const daily = Math.round(varLeft / Math.max(1, daysLeft))
  const pct = Math.round((varSpent / varBudget) * 100)

  return [
    `⚡ *Дневной бюджет*`,
    ``,
    `${r(daily)} в день`,
    ``,
    `Лимит переменных: ${r(varBudget)}`,
    `Потрачено: ${r(varSpent)} (${pct}%)`,
    `Осталось: ${r(varLeft)} на ${daysLeft} дней`,
  ].join('\n')
}

export function handleHelp(): string {
  return [
    `🤖 *Finance Cockpit Bot*`,
    ``,
    `📊 *Статус и данные:*`,
    `/status — баланс и сводка`,
    `/loans — кредиты и долги`,
    `/budget — дневной бюджет`,
    `/cashflow — план месяца`,
    ``,
    `💸 *Записать трату:*`,
    `_списал 500 на кофе_`,
    `_потратил 1200 такси_`,
    `_трата 800 еда_`,
    ``,
    `💡 Суммы: «списал 500 кофе», «-800 такси»`,
  ].join('\n')
}

// ── Helpers ───────────────────────────────────────────────────────────────
function currentMK(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// ── Telegram send ─────────────────────────────────────────────────────────
export async function sendTelegram(chatId: number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN!
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  })
}
