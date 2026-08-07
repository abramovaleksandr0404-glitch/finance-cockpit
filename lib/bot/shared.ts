// Чистые хелперы без изменяемого состояния — безопасно вынесены из bot.ts.
// НЕ добавлять сюда ничего, что читает/пишет module-level let (кеш, флаги
// защиты) — именно смешение состояния между файлами уронило прод в июне.
import { createClient, SupabaseClient } from '@supabase/supabase-js'

// Константы (не изменяемое состояние — присваиваются один раз, безопасно
// делить между файлами в отличие от let-флагов защиты, которые остаются
// в bot.ts намеренно).
export const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'
export const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`

export function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export function mk(): string { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}` }

export function rub(n: number): string { return Math.round(n).toLocaleString('ru-RU')+' ₽' }

export function pct(a: number, b: number): number { return b>0 ? Math.round(a/b*100) : 0 }

export function quarterOf(m: number): number { return Math.ceil(m/3) }

export function advanceDay(y: number, m: number): number {
  const d = new Date(y, m-1, 15)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate()-1)
  return d.getDate()
}

export function lastWorkingDayOfMonth(y: number, m: number): number {
  const d = new Date(y, m, 0)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate()-1)
  return d.getDate()
}

export function annuityPaymentFor(principal: number, monthlyRate: number, months: number): number {
  if (months <= 0) return principal
  if (monthlyRate === 0) return principal / months
  const k = Math.pow(1 + monthlyRate, months)
  return (principal * monthlyRate * k) / (k - 1)
}

export function annuityMonthsFor(principal: number, monthlyRate: number, payment: number): number {
  if (principal <= 0) return 0
  if (monthlyRate === 0) return Math.ceil(principal / payment)
  const interestOnly = principal * monthlyRate
  if (payment <= interestOnly) return 999 // платёж не покрывает даже проценты — кредит не гасится
  return Math.ceil(Math.log(payment / (payment - interestOnly)) / Math.log(1 + monthlyRate))
}

export function isGoalThisMonth(g: { month_key: string | null; target_date: string | null }, monthKey: string, now: Date): boolean {
  if (g.month_key === monthKey) return true
  if (g.target_date) {
    const t = new Date(g.target_date)
    return t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth()
  }
  return false
}

export function monthsUntil(endDate: string | null): number | null {
  if (!endDate) return null
  const now = new Date()
  const end = new Date(endDate)
  const months = (end.getFullYear() - now.getFullYear()) * 12 + (end.getMonth() - now.getMonth())
  return months > 0 && months < 600 ? months : null // 600 = защита от мусорных дат
}

export function addMonths(dateStr: string | null, months: number): string {
  const base = dateStr ? new Date(dateStr) : new Date()
  const d = new Date(base.getFullYear(), base.getMonth() + months, 1)
  return d.toISOString().split('T')[0]
}

export function stripLoneSurrogates(s: string): string {
  // Посимвольно убираем непарные суррогаты (битые эмодзи). Работает на ЛЮБОМ Node
  // (toWellFormed есть только в Node 20+; regex с суррогатами хрупок к экранированию).
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xD800 && c <= 0xDBFF) {
      const n = s.charCodeAt(i + 1)
      if (n >= 0xDC00 && n <= 0xDFFF) { out += s[i] + s[i + 1]; i++ }
      // иначе: непарный high surrogate — выбрасываем
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      // непарный low surrogate — выбрасываем
    } else {
      out += s[i]
    }
  }
  return out
}

export function deepCleanSurrogates(obj: unknown): unknown {
  if (typeof obj === 'string') return stripLoneSurrogates(obj)
  if (Array.isArray(obj)) return obj.map(deepCleanSurrogates)
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj as Record<string, unknown>)) {
      out[k] = deepCleanSurrogates((obj as Record<string, unknown>)[k])
    }
    return out
  }
  return obj
}

export function withPrefixCache(blocks: unknown[]): unknown[] {
  if (blocks.length === 0) return blocks
  const last = blocks[blocks.length - 1] as Record<string, unknown>
  blocks[blocks.length - 1] = { ...last, cache_control: { type: 'ephemeral' } }
  return blocks
}
