/**
 * On-load daily interest accrual.
 * Called from the dashboard page (server component) before rendering.
 * Idempotent: only runs once per day per loan (last_accrual guards it).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function accrueLoans(supabase: any, userId: string): Promise<void> {
  const today = new Date().toISOString().split('T')[0] // YYYY-MM-DD

  const { data: loans, error } = await supabase
    .from('loans')
    .select('id, principal, accrued_int, rate, last_accrual')
    .eq('user_id', userId)
    .gt('principal', 0)

  if (error || !loans?.length) return

  const updates: Array<{ id: string; accrued_int: number; last_accrual: string }> = []

  for (const loan of loans) {
    const last = (loan.last_accrual as string | null) ?? today
    if (last >= today) continue // already up-to-date

    const days = Math.max(0, Math.round((new Date(today).getTime() - new Date(last).getTime()) / 86_400_000))
    if (days === 0) continue

    const dailyInterest = Number(loan.principal) * Number(loan.rate) / 365
    const toAdd = Math.round(dailyInterest * days * 100) / 100
    updates.push({
      id: loan.id,
      accrued_int: Math.round((Number(loan.accrued_int) + toAdd) * 100) / 100,
      last_accrual: today,
    })
  }

  // Apply updates concurrently
  await Promise.all(
    updates.map(({ id, accrued_int, last_accrual }) =>
      supabase.from('loans').update({ accrued_int, last_accrual }).eq('id', id).eq('user_id', userId)
    )
  )
}
