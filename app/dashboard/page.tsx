import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { currentMonthKey } from '@/lib/finance'
import { accrueLoans } from '@/lib/accrue'
import type { DashboardData } from '@/lib/types'
import DashboardClient from '@/components/dashboard/DashboardClient'
import { computeFinancialState } from '@/lib/bot/core'

export const dynamic = 'force-dynamic'

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string; t?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth')

  const params = await searchParams
  const mk = params.m && /^\d{4}-\d{2}$/.test(params.m) ? params.m : currentMonthKey()
  const initialTab = params.t ?? 'main'

  // Daily interest accrual (idempotent — once per day)
  await accrueLoans(supabase, user.id)

  // Parallel data fetch
  const [
    { data: userRow },
    { data: allMonthsRows },
    { data: expenses },
    { data: allExpensesRows },
    { data: incomeEvents },
    { data: loans },
    { data: cards },
    { data: goals },
    { data: debitHistory },
    { data: customCategories },
    { data: holidayRows },
  ] = await Promise.all([
    supabase.from('users').select('*').eq('id', user.id).single(),
    supabase.from('months').select('*').eq('user_id', user.id).order('month_key', { ascending: false }),
    supabase.from('expenses').select('*').eq('user_id', user.id).eq('month_key', mk).order('expense_date', { ascending: false }),
    supabase.from('expenses').select('*').eq('user_id', user.id).order('month_key', { ascending: false }).order('expense_date', { ascending: false }),
    supabase.from('income_events').select('*').eq('user_id', user.id).eq('month_key', mk).order('event_date', { ascending: false }),
    supabase.from('loans').select('*').eq('user_id', user.id).order('sort_order'),
    supabase.from('cards').select('*').eq('user_id', user.id).order('sort_order'),
    supabase.from('goals').select('*').eq('user_id', user.id).order('sort_order'),
    supabase.from('debit_history').select('amount,balance_after,description,source_type,created_at').eq('user_id', user.id).order('created_at', { ascending: false }).limit(30),
    supabase.from('custom_categories').select('id,name,monthly_limit,keywords').eq('user_id', user.id),
    supabase.from('ru_holidays').select('holiday_date'),
  ])

  if (!userRow) redirect('/auth')

  const allMonths = (allMonthsRows ?? []) as DashboardData['allMonths']
  const monthRow = allMonths.find((m) => m.month_key === mk) ?? null

  const data: DashboardData = {
    user: userRow,
    currentMonth: monthRow,
    allMonths,
    expenses: expenses ?? [],
    allExpenses: allExpensesRows ?? [],
    incomeEvents: incomeEvents ?? [],
    loans: loans ?? [],
    cards: cards ?? [],
    goals: goals ?? [],
    debitHistory: (debitHistory ?? []) as DashboardData['debitHistory'],
    customCategories: (customCategories ?? []) as DashboardData['customCategories'],
    holidays: (holidayRows ?? []).map((h: { holiday_date: string }) => String(h.holiday_date).slice(0, 10)),
  }

  // ЕДИНОЕ ЯДРО: авторитетные цифры берём из computeFinancialState(), а не
  // пересчитываем на сайте заново. Иначе сайт и бот расходятся — так было
  // с наличными (сайт их не знал) и с переходными платежами по кредитам
  // (сайт показывал регулярные 41 296 ₽ вместо фактических 35 168 ₽).
  let core = null
  try {
    core = await computeFinancialState()
  } catch (e) {
    console.error('[dashboard] ядро недоступно, показываем расчёт сайта:', e)
  }

  // Наличные и переходные платежи живут в bot_anchors — сайт их не читал,
  // из-за чего расходился с ботом. Подмешиваем в data, чтобы существующие
  // расчёты finance.ts автоматически стали верными.
  // bot_anchors нет в сгенерированных типах Supabase — нужен каст
  const { data: anchorRows } = await (supabase as any).from('bot_anchors')
    .select('key,value').eq('user_id', user.id).eq('month_key', 'global') as { data: { key: string; value: string }[] | null }
  const cashOnHand = Number((anchorRows ?? []).find(a => a.key === 'cash_on_hand')?.value ?? 0)
  const paymentOverrides: Record<string, number> = {}
  for (const a of anchorRows ?? []) {
    const m = String(a.key).match(/^loan_payment_override:(.+):(\d{4}-\d{2})$/)
    if (m && m[2] === mk) paymentOverrides[m[1]] = Number(a.value)
  }
  Object.assign(data, { cashOnHand, paymentOverrides })

  return <DashboardClient data={data} monthKey={mk} initialTab={initialTab} core={core} />
}
