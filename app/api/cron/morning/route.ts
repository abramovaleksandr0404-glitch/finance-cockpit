import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { generateMorningBriefing, sendTelegram } from '@/lib/bot'

export const dynamic = 'force-dynamic'
const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'

export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }
  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const now = new Date()
    const today = now.getDate()
    const mk = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`

    const { data: user } = await supabase
      .from('users')
      .select('telegram_chat_id,debit_balance,recurring_incomes')
      .eq('id', USER_ID)
      .single()
    if (!user?.telegram_chat_id) return NextResponse.json({ ok: false, reason: 'no chat_id' })

    // Авто-создание income events для регулярных доходов по датам
    const recurringIncomes = (user.recurring_incomes as { name: string; amount: number; day: number }[]) ?? []
    const autoCreated: string[] = []

    for (const income of recurringIncomes) {
      if (income.day !== today) continue

      // Проверяем, не создали ли уже событие в этом месяце
      const { data: existing } = await supabase
        .from('income_events')
        .select('id')
        .eq('user_id', USER_ID)
        .eq('month_key', mk)
        .ilike('description', `%${income.name}%`)
        .maybeSingle()

      if (existing) continue

      // Создаём income_event и зачисляем на дебет
      const eventDate = now.toISOString().split('T')[0]
      await supabase.from('income_events').insert({
        user_id: USER_ID,
        month_key: mk,
        event_date: eventDate,
        event_type: 'recurring',
        description: income.name,
        amount: Math.round(income.amount),
        to_debit: true,
      })
      const { data: u } = await supabase.from('users').select('debit_balance').eq('id', USER_ID).single()
      await supabase.from('users').update({
        debit_balance: Math.round((Number(u?.debit_balance ?? 0) + income.amount) * 100) / 100,
        debit_updated_at: now.toISOString(),
      }).eq('id', USER_ID)

      autoCreated.push(`${income.name}: +${Math.round(income.amount).toLocaleString('ru-RU')} ₽`)
    }

    const isWeekly = now.getDay() === 0 // Воскресенье = еженедельный отчёт
    const briefing = await generateMorningBriefing(isWeekly)

    // Если были авто-зачисления — добавляем к дайджесту
    const autoMsg = autoCreated.length > 0
      ? `\n\n💰 *Авто-зачислено:*\n${autoCreated.map(s=>`• ${s}`).join('\n')}`
      : ''

    await sendTelegram(user.telegram_chat_id, briefing + autoMsg)
    return NextResponse.json({ ok: true, isWeekly, autoCreated })
  } catch (err) {
    console.error('[Cron morning]', err)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
