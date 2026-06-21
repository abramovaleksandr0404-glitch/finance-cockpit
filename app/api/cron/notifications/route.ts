import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { sendTelegram } from '@/lib/bot'

export const dynamic = 'force-dynamic'

// МСК = UTC+3. Пересчёт следующего notify_at для рекуррентных уведомлений
function nextNotifyAt(row: Record<string, unknown>): Date {
  const now = new Date()
  const hour = Number(row.recurrence_hour ?? 9)
  const min  = Number(row.recurrence_min  ?? 0)
  // UTC-время: МСК - 3ч
  const hourUtc = (hour - 3 + 24) % 24

  if (row.recurrence === 'daily') {
    const next = new Date(now)
    next.setUTCHours(hourUtc, min, 0, 0)
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1)
    return next
  }

  if (row.recurrence === 'weekly') {
    const wday = Number(row.recurrence_wday ?? 1) // 0=вс..6=сб
    const next = new Date(now)
    const curWday = next.getUTCDay()
    let delta = (wday - curWday + 7) % 7
    if (delta === 0) delta = 7
    next.setUTCDate(next.getUTCDate() + delta)
    next.setUTCHours(hourUtc, min, 0, 0)
    return next
  }

  if (row.recurrence === 'monthly') {
    const day = Number(row.recurrence_day ?? 1)
    const next = new Date(now)
    next.setUTCDate(day)
    next.setUTCHours(hourUtc, min, 0, 0)
    if (next <= now) {
      // Переходим на следующий месяц
      next.setUTCMonth(next.getUTCMonth() + 1)
      next.setUTCDate(day)
    }
    return next
  }

  return now
}

export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const now = new Date().toISOString()

  // Все активные уведомления у которых пришло время
  const { data: due, error } = await db
    .from('scheduled_notifications')
    .select('*')
    .eq('status', 'active')
    .lte('notify_at', now)

  if (error) {
    console.error('[notifications cron]', error.message)
    return NextResponse.json({ ok: false, error: error.message })
  }
  if (!due || due.length === 0) return NextResponse.json({ ok: true, sent: 0 })

  let sent = 0
  for (const row of due) {
    const text = row.message || `🔔 ${row.title}`
    try {
      await sendTelegram(Number(row.chat_id), text)
      sent++

      if (row.recurrence === 'once') {
        await db.from('scheduled_notifications').update({ status: 'done', last_sent_at: now }).eq('id', row.id)
      } else {
        const nextAt = nextNotifyAt(row as Record<string, unknown>)
        await db.from('scheduled_notifications').update({
          last_sent_at: now,
          notify_at: nextAt.toISOString(),
        }).eq('id', row.id)
      }
    } catch (e) {
      console.error('[notifications cron] send failed', row.id, e)
    }
  }

  console.log(`[notifications cron] sent ${sent}/${due.length}`)
  return NextResponse.json({ ok: true, sent, total: due.length })
}
