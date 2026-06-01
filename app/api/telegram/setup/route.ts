import { NextResponse } from 'next/server'

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
    return NextResponse.json({
      success: true,
      webhook: webhookUrl,
      message: 'Webhook registered! Bot is ready.',
    })
  } else {
    return NextResponse.json({ error: data.description }, { status: 400 })
  }
}
