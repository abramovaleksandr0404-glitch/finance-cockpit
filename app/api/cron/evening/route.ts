import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { sendTelegram } from '@/lib/bot'

export const dynamic = 'force-dynamic'

const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'

function rub(n: number): string {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽'
}

function daysUntil(dayOfMonth: number, isLastDay: boolean = false): number {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth()
  const today = now.getDate()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const targetDay = isLastDay ? daysInMonth : Math.min(dayOfMonth, daysInMonth)
  const diff = targetDay - today
  return diff < 0 ? diff + daysInMonth : diff
}

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
    const [{ data: user }, { data: loans }, { data: expenses }] = await Promise.all([
      supabase.from('users').select('telegram_chat_id,debit_balance,var_budget').eq('id', USER_ID).single(),
      supabase.from('loans').select('name,min_payment,due_day,paid_month').eq('user_id', USER_ID),
      supabase.from('expenses').select('amount').eq('user_id', USER_ID).eq('month_key', new Date().toISOString().slice(0, 7)),
    ])

    if (!user?.telegram_chat_id) return NextResponse.json({ ok: false, reason: 'no chat_id' })

    const alerts: string[] = []

    // Проверить ближайшие платежи по кредитам
    const now = new Date()
    const currentMK = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`
    for (const loan of loans ?? []) {
      if (loan.paid_month === currentMK) continue // уже оплачен
      const isLast = loan.due_day === 'last'
      const dayNum = isLast ? 0 : Number(loan.due_day)
      const days = daysUntil(dayNum, isLast)
      if (days === 1) {
        alerts.push(`⚠️ *Завтра* платёж: ${loan.name} — ${rub(Number(loan.min_payment))}`)
      } else if (days === 0) {
        alerts.push(`🔴 *Сегодня* платёж: ${loan.name} — ${rub(Number(loan.min_payment))}`)
      }
    }

    // Проверить бюджет переменных
    const varBudget = Number(user.var_budget ?? 40000)
    const varSpent = (expenses ?? []).reduce((s,e) => s + Number(e.amount), 0)
    const pct = Math.round(varSpent / varBudget * 100)
    if (pct >= 90) {
      alerts.push(`🔴 Переменные: использовано *${pct}%* (${rub(varSpent)} из ${rub(varBudget)})`)
    } else if (pct >= 75) {
      alerts.push(`🟡 Переменные: использовано *${pct}%* (${rub(varSpent)} из ${rub(varBudget)})`)
    }

    if (alerts.length === 0) return NextResponse.json({ ok: true, reason: 'no alerts today' })

    const msg = `🔔 *Вечерний алерт*\n\n${alerts.join('\n')}\n\n_Дебет: ${rub(user.debit_balance)}_`
    await sendTelegram(user.telegram_chat_id, msg)

    return NextResponse.json({ ok: true, alerts: alerts.length })
  } catch (err) {
    console.error('[Cron evening]', err)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
