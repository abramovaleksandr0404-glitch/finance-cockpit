import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { sendTelegram } from '@/lib/bot'
import fs from 'fs'
import path from 'path'

const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'

function getLatestChangelog(): string {
  try {
    const p = path.join(process.cwd(), 'CHANGELOG.md')
    const content = fs.readFileSync(p, 'utf-8')
    const parts = content.split(/^## /m)
    const block = parts[1]
    if (!block) return ''
    const lines = block.split('\n')
    const title = lines[0].trim()
    const bullets = lines.filter(l => l.startsWith('- ')).map(l => `• ${l.slice(2)}`)
    return `*${title}*\n${bullets.join('\n')}`
  } catch {
    return ''
  }
}

/**
 * GET /api/telegram/setup
 * Call this ONCE after deploy to register the webhook URL with Telegram.
 * After setup, Telegram will POST all messages to /api/telegram
 */
export async function GET(req: Request) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const secret = process.env.BOT_WEBHOOK_SECRET

  if (!token) return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN not set' }, { status: 500 })

  // Derive the webhook URL from the request host
  const host = req.headers.get('host') ?? ''
  const protocol = host.includes('localhost') ? 'http' : 'https'
  const webhookUrl = `${protocol}://${host}/api/telegram`

  const params = new URLSearchParams({ url: webhookUrl })
  if (secret) params.set('secret_token', secret)
  params.set('allowed_updates', JSON.stringify(['message']))
  params.set('drop_pending_updates', 'true')

  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook?${params}`)
  const data = await res.json()

  if (data.ok) {
    // Send update notification to user's Telegram
    try {
      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      )
      const { data: user } = await supabase
        .from('users').select('telegram_chat_id').eq('id', USER_ID).single()
      if (user?.telegram_chat_id) {
        const changelog = getLatestChangelog()
        const fallback = `[Sprint 11]\n• Быстрая клавиатура: 9 кнопок с горячими вопросами\n• Брокерский контекст из якорей broker_*\n• Инструмент days_until_advance\n• Маппинг кнопок в полные запросы`
        const body = `🔄 *Система обновлена*\n\n✅ *Что нового:*\n${changelog || fallback}\n\n_Webhook зарегистрирован. Готов к работе._`
        await sendTelegram(user.telegram_chat_id, body)

        // Отправить постоянную клавиатуру с быстрыми действиями
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: user.telegram_chat_id,
            text: '⚡ Быстрые действия активированы',
            reply_markup: {
              keyboard: [
                [{ text: '💰 Аванс' }, { text: '💵 Зарплата' }, { text: '🎯 Бонус' }],
                [{ text: '📊 Бюджет месяца' }, { text: '💳 Кредиты' }, { text: '📉 Вредные' }],
                [{ text: '💸 До аванса' }, { text: '⚡ Баланс' }, { text: '📋 Бэклог' }],
              ],
              resize_keyboard: true,
              persistent: true,
            },
          }),
        })
      }
    } catch (e) {
      console.error('[setup] notify failed', e)
    }

    return NextResponse.json({
      success: true,
      webhook: webhookUrl,
      message: 'Webhook registered! Bot is ready.',
    })
  } else {
    return NextResponse.json({ error: data.description }, { status: 400 })
  }
}
