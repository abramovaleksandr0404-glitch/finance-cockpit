import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

function getChangelogBlock(): string {
  try {
    const changelog = fs.readFileSync(path.join(process.cwd(), 'CHANGELOG.md'), 'utf8')
    const blocks = changelog.match(/## \[Sprint \d+\][\s\S]*?(?=## \[Sprint \d+\]|$)/)
    return blocks ? blocks[0].slice(0, 800) : ''
  } catch {
    return ''
  }
}

/**
 * GET /api/telegram/setup
 * Call after each deploy to register the webhook and notify the owner.
 */
export async function GET(req: Request) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const secret = process.env.BOT_WEBHOOK_SECRET
  const chatId = Number(process.env.ALLOWED_TELEGRAM_CHAT_ID)

  if (!token) return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN not set' }, { status: 500 })

  const host = req.headers.get('host') ?? ''
  const protocol = host.includes('localhost') ? 'http' : 'https'
  const webhookUrl = `${protocol}://${host}/api/telegram`

  const params = new URLSearchParams({ url: webhookUrl })
  if (secret) params.set('secret_token', secret)
  params.set('allowed_updates', JSON.stringify(['message']))
  params.set('drop_pending_updates', 'true')

  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook?${params}`)
  const data = await res.json()

  if (!data.ok) {
    return NextResponse.json({ error: data.description }, { status: 400 })
  }

  let notified = false
  if (chatId) {
    const changelogBlock = getChangelogBlock()
    const notifText = changelogBlock
      ? `🔄 *Система обновлена*\n\n${changelogBlock}`
      : `🔄 *Система обновлена*\n\n_Webhook зарегистрирован. Готов к работе._`

    // Notification message
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: notifText, parse_mode: 'Markdown' }),
      })
      notified = true
    } catch (e) {
      console.error('[setup] Telegram notification failed:', e)
    }

    // Persistent keyboard
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: '⚡ Быстрые кнопки активированы',
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
    } catch (e) {
      console.error('[setup] Keyboard setup failed:', e)
    }
  }

  return NextResponse.json({
    success: true,
    webhook: webhookUrl,
    message: 'Webhook registered! Notification sent.',
    notified,
  })
}
