import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { generateMorningBriefing, sendTelegram } from '@/lib/bot'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }
  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const { data: user } = await supabase.from('users').select('telegram_chat_id').eq('id', '5ebdb411-6021-4dfc-9d0d-caa8e0107502').single()
    if (!user?.telegram_chat_id) return NextResponse.json({ ok: false, reason: 'no chat_id' })
    const briefing = await generateMorningBriefing()
    await sendTelegram(user.telegram_chat_id, briefing)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[Cron]', err)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
