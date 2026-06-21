'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'

const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'

// planner_* tables are not in the generated Database type yet — cast to any
async function db() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await createClient()) as any
}

export async function completeTask(taskId: string) {
  const supabase = await db()
  await supabase.from('planner_tasks')
    .update({ status: 'done', completed_at: new Date().toISOString() })
    .eq('id', taskId).eq('user_id', USER_ID)
  revalidatePath('/planner')
}

export async function logHabitToday(habitId: string, done: boolean, value?: number, unit?: string) {
  const supabase = await db()
  const today = new Date().toISOString().slice(0, 10)
  await supabase.from('planner_habit_logs').upsert({
    user_id: USER_ID,
    habit_id: habitId,
    logged_date: today,
    done,
    value: value ?? null,
    value_unit: unit ?? null,
    logged_at: new Date().toISOString(),
  }, { onConflict: 'habit_id,logged_date' })
  revalidatePath('/planner')
}
