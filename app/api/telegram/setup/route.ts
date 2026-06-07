import { NextResponse } from 'next/server'

export async function GET(req: Request) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const secret = process.env.BOT_WEBHOOK_SECRET
  const chatId = Number(process.env.ALLOWED_TELEGRAM_CHAT_ID)

  if (!token) return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN not set' }, { status: 500 })
  if (!chatId) return NextResponse.json({ error: 'ALLOWED_TELEGRAM_CHAT_ID not set' }, { status: 500 })

  const host = req.headers.get('host') ?? ''
  const protocol = host.includes('localhost') ? 'http' : 'https'
  const webhookUrl = `${protocol}://${host}/api/telegram`

  const params = new URLSearchParams({ url: webhookUrl })
  if (secret) params.set('secret_token', secret)
  params.set('allowed_updates', JSON.stringify(['message', 'callback_query']))
  params.set('drop_pending_updates', 'true')

  const webhookRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook?${params}`)
  const webhookData = await webhookRes.json()
  if (!webhookData.ok) {
    return NextResponse.json({ error: 'setWebhook failed', detail: webhookData.description }, { status: 400 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ''
  let sprintInfo = ''

  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/sprint_queue?status=eq.done&order=sprint_number.desc&limit=1&select=sprint_number,title`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    )
    const data = await res.json()
    if (data?.[0]) {
      sprintInfo = `Sprint ${data[0].sprint_number}: ${data[0].title}`
    }
  } catch {}

  const notifText = sprintInfo
    ? `Система обновлена

Последний деплой: ${sprintInfo}

Бот готов к работе.`
    : `Система обновлена

Бот готов к работе.`

  let notified = false
  let notifyError = ''

  try {
    const msgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: notifText }),
    })
    const msgData = await msgRes.json()
    if (msgData.ok) {
      notified = true
    } else {
      notifyError = msgData.description ?? 'Unknown error'
    }
  } catch (e) {
    notifyError = String(e)
  }

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: 'Быстрые кнопки активированы',
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
  } catch {}

  return NextResponse.json({
    success: true,
    webhook: webhookUrl,
    chat_id: chatId,
    notified,
    notify_error: notifyError || undefined,
  })
}
