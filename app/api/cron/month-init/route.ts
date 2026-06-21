import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { computeWorkingDays, computeFirstHalfWorkingDays } from '@/lib/calc'
import { sendTelegram } from '@/lib/bot'

export const dynamic = 'force-dynamic'

const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'

export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Вызывается 30 июня 22:00 UTC — следующий месяц = июль
    const now = new Date()
    const targetYear = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear()
    const targetMonth = now.getMonth() === 11 ? 1 : now.getMonth() + 2
    const monthKey = `${targetYear}-${String(targetMonth).padStart(2,'0')}`

    // Идемпотентность: если запись уже есть — пропустить
    const { data: existing } = await supabase
      .from('months').select('id')
      .eq('user_id', USER_ID).eq('month_key', monthKey).maybeSingle()
    if (existing) {
      return NextResponse.json({ ok: true, skipped: true, monthKey })
    }

    // Праздники следующего месяца из БД
    const { data: holidays } = await supabase
      .from('ru_holidays').select('holiday_date')
      .gte('holiday_date', `${monthKey}-01`)
      .lte('holiday_date', `${monthKey}-31`)
    const holidayDates = (holidays ?? []).map((h: { holiday_date: string }) =>
      String(h.holiday_date).slice(0, 10))

    // Рабочие дни
    const totalWd  = computeWorkingDays(targetYear, targetMonth, holidayDates)
    const advWd    = computeFirstHalfWorkingDays(targetYear, targetMonth, holidayDates)
    const eomWd    = totalWd - advWd

    // Данные пользователя
    const { data: user } = await supabase
      .from('users').select('salary_net,fixed_costs,telegram_chat_id')
      .eq('id', USER_ID).single()
    const salaryNet     = Number(user?.salary_net ?? 121600)
    const dailyRate     = Math.round(salaryNet / totalWd)
    const advanceAmount = advWd * dailyRate
    const eomAmount     = eomWd * dailyRate
    const fixedTotal    = ((user?.fixed_costs as {amount:number}[]) ?? [])
      .reduce((s,f) => s + Number(f.amount), 0)

    // 1. Создать months запись
    await supabase.from('months').insert({
      user_id: USER_ID,
      month_key: monthKey,
      fixed_paid: {},
      salary_adv_amount: String(advanceAmount),
      salary_eom_amount: String(eomAmount),
      salary_adv_received: false,
      salary_eom_received: false,
      closed: false,
    })

    // 2. Обновить bot_anchors
    const anchors = [
      { key:'working_days',     value:String(totalWd) },
      { key:'daily_rate',       value:String(dailyRate) },
      { key:'adv_working_days', value:String(advWd) },
      { key:'eom_working_days', value:String(eomWd) },
      { key:'advance_normal',   value:String(advanceAmount) },
      { key:'eom_salary',       value:String(eomAmount) },
      { key:'fixed_total',      value:String(fixedTotal) },
      { key:'fixed_unpaid',     value:String(fixedTotal) },
      { key:'var_spent',        value:'0' },
    ]
    for (const a of anchors) {
      await supabase.from('bot_anchors').upsert(
        { user_id:USER_ID, month_key:monthKey, ...a, updated_at:new Date().toISOString() },
        { onConflict:'user_id,month_key,key' }
      )
    }

    // 3. Telegram-уведомление
    if (user?.telegram_chat_id) {
      const names: Record<number,string> = {
        1:'Январь',2:'Февраль',3:'Март',4:'Апрель',5:'Май',6:'Июнь',
        7:'Июль',8:'Август',9:'Сентябрь',10:'Октябрь',11:'Ноябрь',12:'Декабрь'
      }
      await sendTelegram(user.telegram_chat_id, [
        `📅 *${names[targetMonth] ?? monthKey} инициализирован*`,
        '',
        `• Рабочих дней: ${totalWd} (аванс ${advWd} + ЗП ${eomWd})`,
        `• Дневная ставка: ${dailyRate.toLocaleString('ru-RU')} ₽`,
        `• Аванс (${advWd} дн): ${advanceAmount.toLocaleString('ru-RU')} ₽`,
        `• ЗП (${eomWd} дн): ${eomAmount.toLocaleString('ru-RU')} ₽`,
        `• Постоянные расходы сброшены ✓`,
        '',
        `⚠️ Обнови принципалы кредитов по выписке банка!`,
      ].join('\n'))
    }

    // 4. Read-after-write
    const { data: verify } = await supabase
      .from('months').select('month_key,salary_adv_amount')
      .eq('user_id',USER_ID).eq('month_key',monthKey).single()

    return NextResponse.json({
      ok:true, monthKey, totalWd, advWd, eomWd,
      dailyRate, advanceAmount, eomAmount, verified:!!verify,
    })
  } catch (err) {
    console.error('[month-init]', err)
    return NextResponse.json({ ok:false, error:String(err) }, { status:500 })
  }
}
