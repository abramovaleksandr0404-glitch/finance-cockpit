import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import PlannerClient from '@/components/planner/PlannerClient'

export const dynamic = 'force-dynamic'

// ── Локальные типы (planner_* не в Database type — используем any cast + локальные интерфейсы) ──
type PTask = {
  id: string; title: string; description?: string | null
  category?: string | null; priority: string; status: string
  due_date?: string | null; due_time?: string | null
  planned_amount?: number | null; contact_name?: string | null; parent_id?: string | null
}
type PHabit = {
  id: string; title: string; category?: string | null; frequency: string
  target_days_per_week?: number | null; metric_type: string; metric_unit?: string | null; status: string
}
type PHabitLog = {
  id: string; habit_id: string; logged_date: string; done: boolean
  value?: number | null; value_unit?: string | null; note?: string | null
}
type PNotif = {
  id: string; title: string; message?: string | null; recurrence: string
  recurrence_day?: number | null; recurrence_hour: number; recurrence_min: number; notify_at: string
}

const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'

function todayISO() { return new Date().toISOString().slice(0, 10) }
function addDays(iso: string, n: number) {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function mondayISO(iso: string) {
  const dow = new Date(iso + 'T00:00:00Z').getUTCDay()
  return addDays(iso, -((dow + 6) % 7))
}

export default async function PlannerPage() {
  // planner_* tables not in generated Database type — cast to any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = (await createClient()) as any
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth')

  const today = todayISO()
  const weekEnd = addDays(today, 7)
  const weekStart = mondayISO(today)

  const [tasksRes, habitsRes, logsRes, notifsRes] = await Promise.all([
    supabase.from('planner_tasks')
      .select('id,title,description,category,priority,status,due_date,due_time,planned_amount,contact_name,parent_id')
      .eq('user_id', USER_ID)
      .eq('status', 'pending')
      .order('due_date', { ascending: true, nullsFirst: false })
      .order('due_time', { ascending: true, nullsFirst: false })
      .limit(100),
    supabase.from('planner_habits')
      .select('id,title,category,frequency,target_days_per_week,metric_type,metric_unit,status')
      .eq('user_id', USER_ID).eq('status', 'active')
      .order('sort_order', { ascending: true }),
    supabase.from('planner_habit_logs')
      .select('id,habit_id,logged_date,done,value,value_unit,note')
      .eq('user_id', USER_ID)
      .gte('logged_date', weekStart)
      .lte('logged_date', today),
    supabase.from('scheduled_notifications')
      .select('id,title,message,recurrence,recurrence_day,recurrence_hour,recurrence_min,notify_at')
      .eq('user_id', USER_ID).eq('status', 'active')
      .lte('notify_at', addDays(today, 14) + 'T23:59:59Z')
      .order('notify_at', { ascending: true }).limit(10),
  ])

  const tasks = (tasksRes.data ?? []) as PTask[]
  const habits = (habitsRes.data ?? []) as PHabit[]
  const logs = (logsRes.data ?? []) as PHabitLog[]
  const notifs = (notifsRes.data ?? []) as PNotif[]

  // Partition tasks client-friendly
  const overdue  = tasks.filter(t => t.due_date && t.due_date < today)
  const todayT   = tasks.filter(t => t.due_date === today)
  const week     = tasks.filter(t => t.due_date && t.due_date > today && t.due_date <= weekEnd)
  const backlog  = tasks.filter(t => !t.due_date)

  return (
    <PlannerClient
      today={today}
      weekStart={weekStart}
      overdue={overdue}
      todayTasks={todayT}
      weekTasks={week}
      backlog={backlog}
      habits={habits}
      habitLogs={logs}
      reminders={notifs}
    />
  )
}
