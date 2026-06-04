import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'

export async function GET(req: Request) {
  const auth = req.headers.get('authorization')
  const secret = process.env.BOT_WEBHOOK_SECRET
  if (!secret || auth !== `Bearer ${secret}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const days = Math.min(90, Math.max(1, Number(searchParams.get('days') ?? 7)))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data: messages } = await supabase
    .from('bot_messages')
    .select('role,content,created_at')
    .eq('user_id', USER_ID)
    .gte('created_at', since)
    .order('created_at', { ascending: true })

  if (!messages?.length) {
    return new NextResponse('Нет сообщений за указанный период', { status: 404 })
  }

  const lines = messages.map(m => {
    const dt = new Date(m.created_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })
    const who = m.role === 'user' ? 'Пользователь' : 'Бот'
    return `[${dt}] ${who}: ${m.content}`
  })

  return new NextResponse(lines.join('\n\n'), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="chat-export-${days}d.txt"`,
    },
  })
}
