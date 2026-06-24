import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const secret = req.headers.get('x-secret')
  if (secret !== process.env.BOT_WEBHOOK_SECRET) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const chatId = Number(process.env.ALLOWED_TELEGRAM_CHAT_ID)
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

  // Удаляем тестовые сообщения (наши паттерны: Баланс, кофе, сухой прогон и т.д.)
  // Оставляем только реальные сообщения пользователя (последние 20 — без старых тестов)
  const { data: msgs } = await db.from('bot_messages')
    .select('id, content, role, created_at')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: false })
    .limit(200)

  if (!msgs) return Response.json({ deleted: 0 })

  // Тестовые паттерны — что могли написать мы в тестах
  const testPatterns = [
    /\[ТЕСТ/i, /dry.?run/i, /тест/i,
    /Баланс одной строкой/i, /Дебет одной строкой/i,
    /Занеси трату 300/i, /Потратил 300/i, /Кофе 300/i,
    /Перечисли.*кредитов/i, /Покажи.*кредиты$/i,
    /Список.*кредитов/i, /Прогноз до конца/i,
    /Займ Алён/i, /Квартальный бонус/i,
    /Что.*купить в июле/i, /Минск в июле/i,
    /Дневной заработок/i, /Покажи последние/i,
    /Удали последнюю трату/i, /Установи.*баланс/i,
    /тест dry_run/i, /А$/, /Спасибо!$/,
    /^Кофе 180/, /^Кофе 200/, /Такси 400/,
    /канцелярию/, /Подписка Нетфликс/
  ]
  
  const toDelete = msgs
    .filter(m => {
      if (m.created_at < cutoff) return false // старые не трогаем
      return testPatterns.some(p => p.test(m.content))
    })
    .map(m => m.id)

  if (toDelete.length > 0) {
    await db.from('bot_messages').delete().in('id', toDelete)
  }

  return Response.json({ checked: msgs.length, deleted: toDelete.length })
}
