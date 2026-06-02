import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { sendTelegram } from '@/lib/bot'
import { suggestEarlyRepayment } from '@/lib/calc'

export const dynamic = 'force-dynamic'
const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'
function rub(n: number) { return Math.round(n).toLocaleString('ru-RU') + ' ₽' }

function daysUntilPayment(dueDay: string): number {
  const now = new Date()
  const today = now.getDate()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate()
  const target = dueDay === 'last' ? daysInMonth : Math.min(Number(dueDay), daysInMonth)
  const diff = target - today
  return diff < 0 ? diff + daysInMonth : diff
}

export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }
  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const mk = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}`
    const [{ data: user }, { data: loans }, { data: expenses }] = await Promise.all([
      supabase.from('users').select('telegram_chat_id,debit_balance,tbank_debit,var_budget').eq('id',USER_ID).single(),
      supabase.from('loans').select('name,min_payment,due_day,paid_month,principal,accrued_int,rate').eq('user_id',USER_ID),
      supabase.from('expenses').select('amount').eq('user_id',USER_ID).eq('month_key',mk),
    ])
    if (!user?.telegram_chat_id) return NextResponse.json({ ok: false, reason: 'no chat_id' })

    const alerts: string[] = []

    // Платежи по кредитам
    for (const loan of loans ?? []) {
      if (loan.paid_month === mk) continue
      const days = daysUntilPayment(loan.due_day)
      if (days === 0) alerts.push(`🔴 *Сегодня* платёж: ${loan.name} — ${rub(Number(loan.min_payment))}`)
      else if (days === 1) alerts.push(`⚠️ *Завтра* платёж: ${loan.name} — ${rub(Number(loan.min_payment))}`)
      else if (days === 2) alerts.push(`📅 Послезавтра: ${loan.name} — ${rub(Number(loan.min_payment))}`)
    }

    // Переменные 80%/95%
    const varBudget = Number(user.var_budget ?? 40000)
    const varSpent = (expenses ?? []).reduce((s,e) => s + Number(e.amount), 0)
    const pctUsed = Math.round(varSpent / varBudget * 100)
    if (pctUsed >= 95) alerts.push(`🔴 Переменные: *${pctUsed}%* (${rub(varSpent)} из ${rub(varBudget)}) — лимит исчерпан`)
    else if (pctUsed >= 80) alerts.push(`🟡 Переменные: *${pctUsed}%* (${rub(varSpent)} из ${rub(varBudget)}) — осталось ${rub(varBudget-varSpent)}`)

    // Проактивная рекомендация досрочного погашения
    const liquid = Number(user.debit_balance??0) + Number(user.tbank_debit??0)
    if (liquid > 50000 && loans?.length) {
      const suggestion = suggestEarlyRepayment(loans.map(l => ({
        name:l.name, principal:Number(l.principal), accrued_int:Number(l.accrued_int), rate:Number(l.rate), min_payment:Number(l.min_payment)
      })), liquid, 10000)
      if (suggestion && suggestion.monthlySaving >= 300) {
        alerts.push(`💡 *Совет по кредиту*\n\nСвободных: ${rub(liquid)}\nПогаси ${suggestion.loanName} на ${rub(suggestion.suggestedAmount)}\n• Экономия: ${rub(suggestion.monthlySaving)}/мес\n• Окупаемость: ${suggestion.breakEvenMonths} мес\n• ${suggestion.roiDescription}`)
      }
    }

    if (alerts.length === 0) return NextResponse.json({ ok: true, reason: 'no alerts' })

    const msg = `🔔 *Вечерний дайджест*\n\n${alerts.join('\n\n')}\n\n_Дебет: ${rub(Number(user.debit_balance??0))}_`
    await sendTelegram(user.telegram_chat_id, msg)
    return NextResponse.json({ ok: true, alerts: alerts.length })
  } catch (err) {
    console.error('[Cron evening]', err)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
