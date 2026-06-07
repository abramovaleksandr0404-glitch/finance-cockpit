import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const auth = req.headers.get('x-runner-secret')
  if (auth !== (process.env.RUNNER_SECRET || 'sprint-runner-2026')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { id, status } = await req.json()
  if (!id || !status) {
    return NextResponse.json({ error: 'id and status required' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ''

  try {
    await fetch(`${url}/rest/v1/sprint_queue?id=eq.${id}`, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ status }),
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
