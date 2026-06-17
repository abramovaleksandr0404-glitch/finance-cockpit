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
      supabase.from('expenses').select('amount,category').eq('user_id',USER_ID).eq('month_key',mk),
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
    const varSpent = (expenses ?? []).filter((e:{category:string}) => e.category !== 'Внеплановые').reduce((s,e) => s + Number(e.amount), 0)
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

    // Кастомные категории алерты
    const { data: customCats } = await supabase.from('custom_categories').select('name,monthly_limit,alert_at_percent,id').eq('user_id',USER_ID)
    if (customCats?.length) {
      const { data: custExp } = await supabase.from('expenses').select('amount,custom_category_id').eq('user_id',USER_ID).eq('month_key',mk).not('custom_category_id','is',null)
      for (const cat of customCats) {
        if (!cat.monthly_limit) continue
        const spent = (custExp??[]).filter(e=>e.custom_category_id===cat.id).reduce((s,e)=>s+Number(e.amount),0)
        const pct = Math.round(spent/cat.monthly_limit*100)
        const threshold = cat.alert_at_percent ?? 80
        if (pct >= threshold) alerts.push(`🎯 *${cat.name}*: ${rub(spent)} из ${rub(cat.monthly_limit)} (${pct}%)`)
      }
    }

    // Smart cashflow alerts
    const now2 = new Date()
    const today2 = now2.getDate()
    const daysInMonth2 = new Date(now2.getFullYear(), now2.getMonth() + 1, 0).getDate()

    // А. Половина бюджета меньше чем за полмесяца
    const pctUsedVar = varSpent / varBudget
    if (pctUsedVar > 0.5 && today2 < 15) {
      const dailyLeft = Math.round((varBudget - varSpent) / Math.max(1, daysInMonth2 - today2))
      alerts.push(`⚡ Уже потрачено *${Math.round(pctUsedVar * 100)}%* переменного лимита, а только ${today2}-е. Дневной бюджет: ${rub(dailyLeft)}`)
    }

    // Б. Дебет < 5000 и до зп > 5 дней
    const liquidEvening = Number(user.debit_balance ?? 0) + Number(user.tbank_debit ?? 0)
    const advDayEvening = (() => {
      const d = new Date(now2.getFullYear(), now2.getMonth(), 15)
      while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1)
      return d.getDate()
    })()
    const daysToAdvance = advDayEvening > today2 ? advDayEvening - today2 : 0
    if (liquidEvening < 5000 && daysToAdvance > 5) {
      alerts.push(`⚠️ Дебет *${rub(liquidEvening)}* — до аванса ещё *${daysToAdvance} дней*. Осторожно с тратами.`)
    }

    // В. Вредные расходы > 60%
    const { data: harmfulCats } = await supabase.from('custom_categories').select('id,name,monthly_limit').eq('user_id', USER_ID).ilike('name', '%вред%')
    if (harmfulCats?.length) {
      for (const cat of harmfulCats) {
        if (!cat.monthly_limit) continue
        const { data: harmExp } = await supabase.from('expenses').select('amount').eq('user_id', USER_ID).eq('month_key', mk).not('custom_category_id', 'is', null).eq('custom_category_id', cat.id)
        const harmSum = (harmExp ?? []).reduce((s, e) => s + Number(e.amount), 0)
        const harmPct = Math.round(harmSum / cat.monthly_limit * 100)
        if (harmPct > 60) alerts.push(`🔴 *${cat.name}*: ${rub(harmSum)} из ${rub(cat.monthly_limit)} (${harmPct}%) — подумай.`)
      }
    }

    if (alerts.length === 0) return NextResponse.json({ ok: true, reason: 'no alerts' })

    // Rate limit: не чаще раза в 3 дня
    const { data: alertAnchor } = await supabase.from('bot_anchors')
      .select('value').eq('user_id', USER_ID).eq('month_key', 'global').eq('key', 'last_evening_alert_date').maybeSingle()
    if (alertAnchor?.value) {
      const lastDate = new Date(alertAnchor.value as string)
      const daysSince = Math.floor((Date.now() - lastDate.getTime()) / 86400000)
      if (daysSince < 3) return NextResponse.json({ ok: true, reason: `rate_limited (${daysSince}d ago)` })
    }

    const msg = `🔔 *Вечерний дайджест*\n\n${alerts.join('\n\n')}\n\n_Дебет: ${rub(Number(user.debit_balance??0))}_`
    await sendTelegram(user.telegram_chat_id, msg)

    // Обновляем дату последнего алерта
    await supabase.from('bot_anchors').upsert({
      user_id: USER_ID, month_key: 'global', key: 'last_evening_alert_date',
      value: new Date().toISOString().split('T')[0], updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,month_key,key' })

    return NextResponse.json({ ok: true, alerts: alerts.length })
  } catch (err) {
    console.error('[Cron evening]', err)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
