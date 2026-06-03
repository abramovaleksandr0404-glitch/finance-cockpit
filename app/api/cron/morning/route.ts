import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { generateMorningBriefing, sendTelegram, executeAction, type BotAction } from '@/lib/bot'

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

    if (!user?.telegram_chat_id) return NextResponse.json({ ok: false, reason: 'no chat_id' })

    const isWeekly = new Date().getDay() === 0
    const briefing = await generateMorningBriefing(isWeekly)
    await sendTelegram(user.telegram_chat_id, briefing)
    return NextResponse.json({ ok: true, isWeekly })
  } catch (err) {
    console.error('[Cron morning]', err)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
