import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { currentMonthKey } from '@/lib/finance'
import { accrueLoans } from '@/lib/accrue'
import type { DashboardData } from '@/lib/types'
import DashboardClient from '@/components/dashboard/DashboardClient'

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
  }

  return <DashboardClient data={data} monthKey={mk} initialTab={initialTab} />
}
