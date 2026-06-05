import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { currentMonthKey } from '@/lib/finance'
import type { DashboardData } from '@/lib/types'
import MonthSummary from '@/components/dashboard/MonthSummary'

export const dynamic = 'force-dynamic'

export default async function SummaryPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth')

  const params = await searchParams
  const mk = params.m && /^\d{4}-\d{2}$/.test(params.m) ? params.m : currentMonthKey()

  const [
    { data: userRow },
    { data: allMonthsRows },
    { data: expenses },
    { data: loans },
    { data: cards },
    { data: customCategories },
  ] = await Promise.all([
    supabase.from('users').select('*').eq('id', user.id).single(),
    supabase.from('months').select('*').eq('user_id', user.id).order('month_key', { ascending: false }),
    supabase.from('expenses').select('*').eq('user_id', user.id).eq('month_key', mk).order('expense_date', { ascending: false }),
    supabase.from('loans').select('*').eq('user_id', user.id).order('sort_order'),
    supabase.from('cards').select('*').eq('user_id', user.id).order('sort_order'),
    supabase.from('custom_categories').select('id,name,monthly_limit,keywords').eq('user_id', user.id),
  ])

  if (!userRow) redirect('/auth')

  const allMonths = (allMonthsRows ?? []) as DashboardData['allMonths']
  const data: DashboardData = {
    user: userRow,
    currentMonth: allMonths.find(m => m.month_key === mk) ?? null,
    allMonths,
    expenses: expenses ?? [],
    allExpenses: [],
    incomeEvents: [],
    loans: loans ?? [],
    cards: cards ?? [],
    goals: [],
    customCategories: (customCategories ?? []) as DashboardData['customCategories'],
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)', padding: '24px' }}>
      <div style={{ marginBottom: '16px' }}>
        <a href="/dashboard" style={{ fontSize: '13px', color: 'var(--accent-cyan)', textDecoration: 'none' }}>
          ← Назад в дашборд
        </a>
      </div>
      <h1 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '16px' }}>
        Финансовый итог — {mk}
      </h1>
      <MonthSummary data={data} monthKey={mk} />
    </div>
  )
}
