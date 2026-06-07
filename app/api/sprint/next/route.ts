import { NextResponse } from 'next/server'

export async function GET(req: Request) {
  const auth = req.headers.get('x-runner-secret')
  if (auth !== (process.env.RUNNER_SECRET || 'sprint-runner-2026')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ''

  try {
    const res = await fetch(
      `${url}/rest/v1/sprint_queue?status=eq.pending&order=priority.asc,sprint_number.asc&limit=1&select=id,title,prompt,sprint_number`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    )
    const data = await res.json()
    return NextResponse.json(data)
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
