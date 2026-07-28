import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { generateMorningBriefing, sendTelegram, sendTelegramWithButtons, executeAction, type BotAction } from '@/lib/bot'
import { computeWorkingDays, computeFirstHalfWorkingDays } from '@/lib/calc'

export const dynamic = 'force-dynamic'

const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'

function mk() { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}` }

export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }
  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const monthKey = mk()
    const today = new Date().getDate()

    // Авто-создание income_event для recurring доходов по дате
    const { data: user } = await supabase.from('users').select('telegram_chat_id,recurring_incomes,debit_balance').eq('id', USER_ID).single()
    const { data: month } = await supabase.from('months').select('recurring_received').eq('user_id', USER_ID).eq('month_key', monthKey).maybeSingle()
    const received = (month?.recurring_received as string[]) ?? []
    const recurringIncomes = (user?.recurring_incomes as {name:string;amount:number;day:number}[]) ?? []

    // ── Sprint 20: авто-инициализация нового месяца в первый рабочий день ──
    const nowD = new Date()
    const isFirstWorkingDay = nowD.getDate() <= 3 && nowD.getDay() !== 0 && nowD.getDay() !== 6
    if (isFirstWorkingDay) {
      const newMonthKey = `${nowD.getFullYear()}-${String(nowD.getMonth()+1).padStart(2,'0')}`
      const { data: existingMonth } = await supabase.from('months').select('id').eq('user_id',USER_ID).eq('month_key',newMonthKey).maybeSingle()
      if (!existingMonth) {
        const { data: holidays } = await supabase.from('ru_holidays').select('holiday_date')
          .gte('holiday_date', newMonthKey+'-01').lte('holiday_date', newMonthKey+'-31')
        const holidayDates = (holidays ?? []).map((h: { holiday_date: string }) => String(h.holiday_date).slice(0,10))
        const wd = computeWorkingDays(nowD.getFullYear(), nowD.getMonth()+1, holidayDates)
        const { data: u } = await supabase.from('users').select('salary_net,fixed_costs').eq('id',USER_ID).single()
        const dailyRate = Math.round(Number(u?.salary_net ?? 0) / wd)
        const advWd = computeFirstHalfWorkingDays(nowD.getFullYear(), nowD.getMonth()+1, holidayDates)
        await supabase.from('months').upsert({
          user_id: USER_ID,
          month_key: newMonthKey,
          fixed_paid: {},
          salary_adv_amount: String(advWd * dailyRate),
          salary_eom_amount: String((wd - advWd) * dailyRate),
        }, { onConflict: 'user_id,month_key' })
        const fixedTotal = ((u?.fixed_costs as { amount: number }[]) ?? []).reduce((sm, f) => sm + Number(f.amount), 0)
        const anchors = [
          { key:'working_days',     value:String(wd) },
          { key:'daily_rate',       value:String(dailyRate) },
          { key:'adv_working_days', value:String(advWd) },
          { key:'eom_working_days', value:String(wd - advWd) },
          { key:'advance_normal',   value:String(advWd * dailyRate) },
          { key:'eom_salary',       value:String((wd - advWd) * dailyRate) },
          { key:'fixed_total',      value:String(fixedTotal) },
          { key:'fixed_unpaid',     value:String(fixedTotal) },
          { key:'var_spent',        value:'0' },
        ]
        for (const a of anchors) {
          await supabase.from('bot_anchors').upsert({ user_id:USER_ID, month_key:newMonthKey, ...a, updated_at:new Date().toISOString() }, { onConflict: 'user_id,month_key,key' })
        }
        if (user?.telegram_chat_id) {
          await sendTelegram(user.telegram_chat_id, `📅 *Новый месяц ${newMonthKey}*\n\nДанные обновлены:\n• Рабочих дней: ${wd}\n• Дневная ставка: ${dailyRate.toLocaleString('ru-RU')} ₽\n• Постоянные сброшены — отметь оплаты`)
        }
      }
    }

    // Sprint 26: напоминание о постоянных расходах 5-го числа
    if (today === 5 && user?.telegram_chat_id) {
      await sendTelegram(user.telegram_chat_id, `📋 Сегодня день оплаты постоянных расходов!\n\nПроверь: ЖКХ, Электричество, Интернет, Зал DDX, Обучение и ИИ.\n\nОтметь оплату через бота командой или кнопкой.`)
    }

    for (const r of recurringIncomes) {
      if (r.day === today && !received.includes(r.name)) {
        // Авто-создаём income_event и зачисляем на дебет
        await supabase.from('income_events').insert({ user_id:USER_ID, month_key:monthKey, event_date:new Date().toISOString().split('T')[0], event_type:'recurring', description:r.name, amount:r.amount, to_debit:true })
        await supabase.from('users').update({ debit_balance:Number(user?.debit_balance??0)+r.amount, debit_updated_at:new Date().toISOString() }).eq('id',USER_ID)
        const newReceived = [...received, r.name]
        month ? await supabase.from('months').update({recurring_received:newReceived}).eq('user_id',USER_ID).eq('month_key',monthKey)
              : await supabase.from('months').insert({user_id:USER_ID,month_key:monthKey,recurring_received:newReceived})
        if (user?.telegram_chat_id) {
          await sendTelegram(user.telegram_chat_id, `💰 *${r.name} зачислена автоматически*\n\n• Сумма: ${r.amount.toLocaleString('ru-RU')} ₽\n• Дебет пополнен`)
        }
      }
    }

    // Автосписание общежития 12-го числа
    if (today === 12) {
      const { data: monthData } = await supabase.from('months').select('fixed_paid').eq('user_id', USER_ID).eq('month_key', monthKey).maybeSingle()
      const { data: userData } = await supabase.from('users').select('fixed_costs,telegram_chat_id').eq('id', USER_ID).single()
      const fc = (userData?.fixed_costs as { name: string; amount: number }[]) ?? []
      const fp = (monthData?.fixed_paid as Record<string, number | boolean>) ?? {}
      const dormIdx = fc.findIndex(f => f.name.toLowerCase().includes('общежити'))
      if (dormIdx >= 0 && !fp[String(dormIdx)]) {
        const dormAction: BotAction = { type: 'mark_single_fixed', name: fc[dormIdx].name }
        await executeAction(dormAction)
        if (userData?.telegram_chat_id) {
          await sendTelegram(userData.telegram_chat_id, `🏠 *Общежитие ${fc[dormIdx].amount.toLocaleString('ru-RU')}₽ списано автоматически* (12-е число)`)
        }
      }
    }

    // Уведомления с inline кнопками за день до recurring
    const advDay = (() => {
      const d = new Date(new Date().getFullYear(), new Date().getMonth(), 15)
      while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1)
      return d.getDate()
    })()
    const monthData = await supabase.from('months').select('salary_adv_received,salary_adv_amount,recurring_received').eq('user_id', USER_ID).eq('month_key', monthKey).maybeSingle()
    const advReceived = !!monthData?.data?.salary_adv_received

    for (const r of recurringIncomes) {
      if (r.day === today + 1 && !received.includes(r.name)) {
        if (user?.telegram_chat_id) {
          await sendTelegramWithButtons(user.telegram_chat_id,
            `⏰ Завтра ${r.day}-го — *${r.name}* ${r.amount.toLocaleString('ru-RU')}₽. Получил?`,
            [[
              { text: '✅ Получил', callback_data: 'received_stipend' },
              { text: '⏭ Ещё нет', callback_data: 'skip' },
            ]]
          )
        }
      }
    }

    // Аванс за день до
    if (today + 1 === advDay && !advReceived) {
      if (user?.telegram_chat_id) {
        const advAmount = Number(monthData?.data?.salary_adv_amount ?? Math.round(Number(user?.debit_balance ?? 0) / 2))
        await sendTelegramWithButtons(user.telegram_chat_id,
          `⏰ Завтра ${advDay}-го — *аванс* ${advAmount.toLocaleString('ru-RU')}₽. Подтвердить получение?`,
          [[
            { text: '✅ Получил аванс', callback_data: 'received_advance' },
            { text: '⏭ Ещё нет', callback_data: 'skip' },
          ]]
        )
      }
    }

    // Аванс В ДЕНЬ аванса
    if (today === advDay && !advReceived) {
      if (user?.telegram_chat_id) {
        const advAmount = Number(monthData?.data?.salary_adv_amount ?? Math.round(Number(user?.debit_balance ?? 0) / 2))
        await sendTelegramWithButtons(user.telegram_chat_id,
          `💸 Сегодня *день аванса* (${advDay}-е). Ожидается ${advAmount.toLocaleString('ru-RU')}₽ — пришёл?`,
          [[
            { text: '✅ Получил аванс', callback_data: 'received_advance' },
            { text: '⏭ Ещё нет', callback_data: 'skip' },
          ]]
        )
      }
    }

    // ЗП в последний рабочий день месяца — уведомление
    const { data: monthRow2 } = await supabase.from('months').select('salary_eom_received,salary_eom_amount,bonus_amount').eq('user_id', USER_ID).eq('month_key', monthKey).maybeSingle()
    const eomReceived = !!monthRow2?.salary_eom_received
    if (!eomReceived) {
      const now2 = new Date()
      const { data: eomHols } = await supabase.from('ru_holidays')
        .select('holiday_date')
        .gte('holiday_date', `${monthKey}-01`)
        .lte('holiday_date', `${monthKey}-31`)
      const eomHolSet = new Set(
        (eomHols ?? []).map((h: { holiday_date: string }) => String(h.holiday_date).slice(0, 10))
      )
      const lastDay = new Date(now2.getFullYear(), now2.getMonth() + 1, 0)
      while (
        lastDay.getDay() === 0 ||
        lastDay.getDay() === 6 ||
        eomHolSet.has(lastDay.toISOString().split('T')[0])
      ) {
        lastDay.setDate(lastDay.getDate() - 1)
      }
      if (today === lastDay.getDate()) {
        const { data: u2 } = await supabase.from('users').select('salary_net').eq('id', USER_ID).single()
        const net2 = Number(u2?.salary_net ?? 121600)
        const advAmt2 = Number(monthData?.data?.salary_adv_amount ?? Math.round(net2 / 2))
        const eomAmt2 = Number(monthRow2?.salary_eom_amount ?? net2 - advAmt2)
        const bonusAmt2 = Number(monthRow2?.bonus_amount ?? 0)
        const total2 = eomAmt2 + bonusAmt2
        if (user?.telegram_chat_id) {
          await sendTelegramWithButtons(user.telegram_chat_id,
            `💸 Сегодня последний рабочий день — ожидается *ЗП + бонус* ${total2.toLocaleString('ru-RU')}₽. Пришла?`,
            [[
              { text: '✅ Получил ЗП', callback_data: 'received_eom' },
              { text: '⏭ Ещё нет', callback_data: 'skip' },
            ]]
          )
        }
      }
    }

    if (!user?.telegram_chat_id) return NextResponse.json({ ok: false, reason: 'no chat_id' })

    const isWeekly = new Date().getDay() === 0
    const briefing = await generateMorningBriefing(isWeekly)
    // briefing === null → LLM недоступен. НЕ шлём пустое «Доброе утро» без цифр.
    // Вместо этого — один короткий честный алерт (статический текст, 0 токенов).
    if (!briefing) {
      await sendTelegram(user.telegram_chat_id,
        '⚠️ Утренний дайджест не собран — Anthropic API недоступен (обычно: закончились кредиты).\n' +
        'Данные в БД в порядке. Проверь console.anthropic.com → Plans & Billing.')
      return NextResponse.json({ ok: false, reason: 'llm_unavailable' })
    }
    await sendTelegram(user.telegram_chat_id, briefing)
    return NextResponse.json({ ok: true, isWeekly })
  } catch (err) {
    console.error('[Cron morning]', err)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
