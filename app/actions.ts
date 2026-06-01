'use server'

import { revalidatePath } from 'next/cache'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any

async function getClient(): Promise<Sb> {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cs: Array<{ name: string; value: string; options?: Record<string, unknown> }>) => {
          try { cs.forEach(({ name, value, options }) => cookieStore.set(name, value, options as never)) }
          catch {}
        },
      },
    }
  )
}

async function requireUser(): Promise<{ supabase: Sb; userId: string }> {
  const supabase = await getClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth')
  return { supabase, userId: user.id as string }
}

/** Adjust debit by delta (the single source of "what I have now"). */
async function adjustDebit(supabase: Sb, userId: string, delta: number) {
  const { data } = await supabase.from('users').select('debit_balance').eq('id', userId).single()
  const current = Number(data?.debit_balance ?? 0)
  await supabase.from('users').update({
    debit_balance: Math.round((current + delta) * 100) / 100,
    debit_updated_at: new Date().toISOString(),
  }).eq('id', userId)
}

// ── Undo system ──────────────────────────────────────────────────────────────
// Snapshots the full user state before each mutating action, so any action
// (including misclicks) can be rolled back.

async function snapshot(supabase: Sb, userId: string, description: string) {
  const [users, months, loans, cards, goals, expenses, income_events] = await Promise.all([
    supabase.from('users').select('*').eq('id', userId).single(),
    supabase.from('months').select('*').eq('user_id', userId),
    supabase.from('loans').select('*').eq('user_id', userId),
    supabase.from('cards').select('*').eq('user_id', userId),
    supabase.from('goals').select('*').eq('user_id', userId),
    supabase.from('expenses').select('*').eq('user_id', userId),
    supabase.from('income_events').select('*').eq('user_id', userId),
  ])
  const state = {
    users: users.data, months: months.data ?? [], loans: loans.data ?? [],
    cards: cards.data ?? [], goals: goals.data ?? [], expenses: expenses.data ?? [],
    income_events: income_events.data ?? [],
  }
  await supabase.from('undo_snapshots').insert({ user_id: userId, description, snapshot: state })
  const { data: all } = await supabase.from('undo_snapshots')
    .select('id').eq('user_id', userId).order('created_at', { ascending: false })
  if (all && all.length > 15) {
    await supabase.from('undo_snapshots').delete().in('id', all.slice(15).map((r: { id: string }) => r.id))
  }
}

export async function undoLastAction() {
  const { supabase, userId } = await requireUser()
  const { data: snap } = await supabase.from('undo_snapshots')
    .select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (!snap) return { error: 'Нечего отменять' }

  const s = snap.snapshot as Record<string, Record<string, unknown>[] | Record<string, unknown>>

  if (s.users) {
    const u = { ...(s.users as Record<string, unknown>) }
    delete u.id
    await supabase.from('users').update(u).eq('id', userId)
  }

  await supabase.from('expenses').delete().eq('user_id', userId)
  await supabase.from('income_events').delete().eq('user_id', userId)
  await supabase.from('goals').delete().eq('user_id', userId)
  await supabase.from('loans').delete().eq('user_id', userId)
  await supabase.from('months').delete().eq('user_id', userId)
  await supabase.from('cards').delete().eq('user_id', userId)

  for (const table of ['cards', 'months', 'loans', 'goals', 'expenses', 'income_events']) {
    const rows = s[table] as Record<string, unknown>[] | undefined
    if (rows && rows.length) await supabase.from(table).insert(rows)
  }

  await supabase.from('undo_snapshots').delete().eq('id', snap.id)
  revalidatePath('/dashboard')
  return { success: true, description: snap.description as string }
}

/** Ensure a month row exists for any key; returns the row. */
async function ensureMonth(supabase: Sb, userId: string, mk: string) {
  const { data } = await supabase.from('months').select('*')
    .eq('user_id', userId).eq('month_key', mk).maybeSingle()
  if (data) return data
  const { data: u } = await supabase.from('users').select('margin_floor').eq('id', userId).single()
  const { data: created } = await supabase.from('months').insert({
    user_id: userId, month_key: mk,
    revenue: u?.margin_floor ?? 41666,
    clients: {}, fixed_paid: {},
    salary_adv_received: false, salary_eom_received: false,
  }).select('*').single()
  return created
}

// ════════════════════════════════════════════════════════════════════════════
// EXPENSES
// ════════════════════════════════════════════════════════════════════════════

export async function addExpense(formData: FormData) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'добавление траты')
  const mk = (formData.get('month_key') as string)
  await ensureMonth(supabase, userId, mk)

  const amount   = Math.round(parseFloat(formData.get('amount') as string))
  const category = (formData.get('category') as string).trim()
  const desc     = (formData.get('description') as string) ?? ''
  const source   = (formData.get('source_type') as string) ?? 'debit' // 'debit' | card_id
  const date     = (formData.get('expense_date') as string) || new Date().toISOString().split('T')[0]

  if (!amount || amount <= 0 || !category) return { error: 'Укажите сумму и категорию' }

  const isTbankDebit = source === 'tbank_debit'
  const isCard = source !== 'debit' && source !== 'tbank_debit'
  const { error } = await supabase.from('expenses').insert({
    user_id: userId, month_key: mk, expense_date: date,
    category, amount, description: desc || null,
    source_type: isCard ? 'card' : 'debit',
    card_id: isCard ? source : null,
  })
  if (error) return { error: error.message }

  // Ledger effect
  if (isCard) {
    const { data: c } = await supabase.from('cards').select('current_debt').eq('id', source).single()
    await supabase.from('cards').update({ current_debt: Number(c?.current_debt ?? 0) + amount }).eq('id', source)
  } else if (isTbankDebit) {
    const { data: u } = await supabase.from('users').select('tbank_debit').eq('id', userId).single()
    await supabase.from('users').update({ tbank_debit: Math.round((Number(u?.tbank_debit ?? 0) - amount) * 100) / 100 }).eq('id', userId)
  } else {
    await adjustDebit(supabase, userId, -amount)
  }

  revalidatePath('/dashboard')
  return { success: true }
}

export async function deleteExpense(expenseId: string) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'удаление траты')
  const { data: exp } = await supabase.from('expenses')
    .select('amount, source_type, card_id').eq('id', expenseId).eq('user_id', userId).single()

  const { error } = await supabase.from('expenses').delete().eq('id', expenseId).eq('user_id', userId)
  if (error) return { error: error.message }

  if (exp?.source_type === 'card' && exp.card_id) {
    const { data: c } = await supabase.from('cards').select('current_debt').eq('id', exp.card_id).single()
    await supabase.from('cards').update({ current_debt: Math.max(0, Number(c?.current_debt ?? 0) - exp.amount) }).eq('id', exp.card_id)
  } else if (exp?.source_type === 'debit') {
    await adjustDebit(supabase, userId, exp.amount)
  }

  revalidatePath('/dashboard')
  return { success: true }
}

// ════════════════════════════════════════════════════════════════════════════
// DEBIT (manual correction)
// ════════════════════════════════════════════════════════════════════════════

export async function updateDebitBalance(formData: FormData) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'изменение дебета')
  const balance = Math.round(parseFloat(formData.get('balance') as string) * 100) / 100
  if (isNaN(balance)) return { error: 'Некорректный баланс' }
  const { error } = await supabase.from('users').update({
    debit_balance: balance, debit_updated_at: new Date().toISOString(),
  }).eq('id', userId)
  if (error) return { error: error.message }
  revalidatePath('/dashboard')
  return { success: true }
}

export async function updateTbankDebit(formData: FormData) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'изменение Т-Банк дебета')
  const balance = Math.round(parseFloat(formData.get('balance') as string) * 100) / 100
  if (isNaN(balance)) return { error: 'Некорректный баланс' }
  const { error } = await supabase.from('users').update({ tbank_debit: balance }).eq('id', userId)
  if (error) return { error: error.message }
  revalidatePath('/dashboard')
  return { success: true }
}

// ════════════════════════════════════════════════════════════════════════════
// SALARY REALIZATION (advance / eom + bonus) — moves debit
// ════════════════════════════════════════════════════════════════════════════

/** Realize or reverse the salary advance. amount = actual received (for debit move). */
export async function setSalaryAdvance(mk: string, received: boolean, amount: number) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'аванс')
  const m = await ensureMonth(supabase, userId, mk)
  const amt = Math.round(amount)

  if (received && !m.salary_adv_received) {
    await adjustDebit(supabase, userId, amt)
    await supabase.from('months').update({ salary_adv_received: true, salary_adv_amount: amt })
      .eq('user_id', userId).eq('month_key', mk)
  } else if (!received && m.salary_adv_received) {
    await adjustDebit(supabase, userId, -Number(m.salary_adv_amount ?? amt))
    await supabase.from('months').update({ salary_adv_received: false })
      .eq('user_id', userId).eq('month_key', mk)
  }
  revalidatePath('/dashboard')
  return { success: true }
}

/** Realize or reverse EOM salary + bonus together. salaryAmt + bonusAmt move debit. */
export async function setSalaryEom(mk: string, received: boolean, salaryAmt: number, bonusAmt: number) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'зарплата + бонус')
  const m = await ensureMonth(supabase, userId, mk)
  const sAmt = Math.round(salaryAmt)
  const bAmt = Math.round(bonusAmt)

  if (received && !m.salary_eom_received) {
    await adjustDebit(supabase, userId, sAmt + bAmt)
    await supabase.from('months').update({
      salary_eom_received: true, salary_eom_amount: sAmt, bonus_amount: bAmt,
    }).eq('user_id', userId).eq('month_key', mk)
  } else if (!received && m.salary_eom_received) {
    const reverse = Number(m.salary_eom_amount ?? sAmt) + Number(m.bonus_amount ?? bAmt)
    await adjustDebit(supabase, userId, -reverse)
    await supabase.from('months').update({ salary_eom_received: false })
      .eq('user_id', userId).eq('month_key', mk)
  }
  revalidatePath('/dashboard')
  return { success: true }
}

/** Edit projected salary amounts (vacation/sick adjustment) before realizing. */
export async function editSalaryAmounts(mk: string, advAmt: number | null, eomAmt: number | null, bonusAmt: number | null) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'правка зарплаты')
  await ensureMonth(supabase, userId, mk)
  const patch: Record<string, number | null> = {}
  if (advAmt != null) patch.salary_adv_amount = Math.round(advAmt)
  if (eomAmt != null) patch.salary_eom_amount = Math.round(eomAmt)
  if (bonusAmt != null) patch.bonus_amount = Math.round(bonusAmt)
  const { error } = await supabase.from('months').update(patch)
    .eq('user_id', userId).eq('month_key', mk)
  if (error) return { error: error.message }
  revalidatePath('/dashboard')
  return { success: true }
}

// ════════════════════════════════════════════════════════════════════════════
// FIXED COSTS REALIZATION — moves debit
// ════════════════════════════════════════════════════════════════════════════

/** Mark a fixed cost paid (amount editable) or unpaid. Index into user.fixed_costs. */
export async function setFixedPaid(mk: string, index: number, paid: boolean, amount: number) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'постоянная трата')
  const m = await ensureMonth(supabase, userId, mk)
  const fp: Record<string, number | boolean> = { ...(m.fixed_paid || {}) }
  const amt = Math.round(amount)
  const key = String(index)

  const wasPaid = fp[key] != null && fp[key] !== false
  if (paid && !wasPaid) {
    await adjustDebit(supabase, userId, -amt)
    fp[key] = amt
  } else if (!paid && wasPaid) {
    const prev = typeof fp[key] === 'number' ? (fp[key] as number) : amt
    await adjustDebit(supabase, userId, prev)
    delete fp[key]
  } else if (paid && wasPaid) {
    // editing amount of an already-paid item: adjust debit by the diff
    const prev = typeof fp[key] === 'number' ? (fp[key] as number) : amt
    await adjustDebit(supabase, userId, prev - amt)
    fp[key] = amt
  }

  await supabase.from('months').update({ fixed_paid: fp })
    .eq('user_id', userId).eq('month_key', mk)
  revalidatePath('/dashboard')
  return { success: true }
}

// ════════════════════════════════════════════════════════════════════════════
// LOAN PAYMENT — moves debit, applies to principal/interest
// ════════════════════════════════════════════════════════════════════════════

export async function payLoan(mk: string, loanId: string, amount: number) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'платёж по кредиту')
  const { data: l } = await supabase.from('loans').select('*').eq('id', loanId).eq('user_id', userId).single()
  if (!l) return { error: 'Кредит не найден' }
  const pay = Math.round(amount * 100) / 100

  // Annuity: interest first, then principal
  const toInt = Math.min(pay, Number(l.accrued_int))
  const toPrincipal = pay - toInt
  await supabase.from('loans').update({
    accrued_int: Number(l.accrued_int) - toInt,
    principal: Math.max(0, Number(l.principal) - toPrincipal),
    paid_month: mk,
    last_pay_principal: toPrincipal, // stored for exact reversal
    last_pay_interest: toInt,
  }).eq('id', loanId)

  await adjustDebit(supabase, userId, -pay)
  revalidatePath('/dashboard')
  return { success: true }
}

/** Reverse a loan payment for this month — restores exact principal/interest split. */
export async function unpayLoan(mk: string, loanId: string, amount: number) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'отмена платежа по кредиту')
  const { data: l } = await supabase.from('loans').select('*').eq('id', loanId).eq('user_id', userId).single()
  if (!l || l.paid_month !== mk) return { error: 'Нечего отменять' }
  const pay = Math.round(amount * 100) / 100

  // Restore using stored breakdown if available, else best-effort
  const principalPortion = l.last_pay_principal != null ? Number(l.last_pay_principal) : pay
  const interestPortion = l.last_pay_interest != null ? Number(l.last_pay_interest) : 0

  await supabase.from('loans').update({
    principal: Number(l.principal) + principalPortion,
    accrued_int: Number(l.accrued_int) + interestPortion,
    paid_month: null,
    last_pay_principal: null,
    last_pay_interest: null,
  }).eq('id', loanId)
  await adjustDebit(supabase, userId, pay)
  revalidatePath('/dashboard')
  return { success: true }
}

/**
 * Early (extra) repayment: reduces principal and recalculates the monthly payment,
 * keeping the same term (annuity). Money comes from debit.
 */
export async function earlyRepayLoan(loanId: string, repayAmount: number) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'досрочное погашение')
  const { data: l } = await supabase.from('loans').select('*').eq('id', loanId).eq('user_id', userId).single()
  if (!l) return { error: 'Кредит не найден' }
  const repay = Math.round(repayAmount * 100) / 100
  if (repay <= 0) return { error: 'Сумма должна быть больше 0' }

  const oldPrincipal = Number(l.principal)
  const newPrincipal = Math.max(0, oldPrincipal - repay)
  const ratio = oldPrincipal > 0 ? newPrincipal / oldPrincipal : 0
  // Annuity with fixed term: payment ∝ principal
  const newPayment = Math.round(Number(l.min_payment) * ratio * 100) / 100

  await supabase.from('loans').update({
    principal: newPrincipal,
    min_payment: newPayment,
  }).eq('id', loanId)
  await adjustDebit(supabase, userId, -repay)
  revalidatePath('/dashboard')
  return { success: true }
}

/** Manually edit a loan's monthly payment (e.g. to match the bank exactly). */
export async function editLoanPayment(loanId: string, newPayment: number) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'правка платежа')
  const { error } = await supabase.from('loans')
    .update({ min_payment: Math.round(newPayment * 100) / 100 })
    .eq('id', loanId).eq('user_id', userId)
  if (error) return { error: error.message }
  revalidatePath('/dashboard')
  return { success: true }
}

// ════════════════════════════════════════════════════════════════════════════
// UNPLANNED INCOME (отпускные / больничные / премия)
// ════════════════════════════════════════════════════════════════════════════

export async function addIncomeEvent(formData: FormData) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'внеплановый доход')
  const mk = (formData.get('month_key') as string)
  await ensureMonth(supabase, userId, mk)

  const type   = (formData.get('event_type') as string) || 'other'
  const desc   = (formData.get('description') as string) || 'Внеплановый доход'
  const amount = Math.round(parseFloat(formData.get('amount') as string))
  const toDebit = (formData.get('to_debit') as string) !== 'false'
  const date   = (formData.get('event_date') as string) || new Date().toISOString().split('T')[0]
  if (!amount) return { error: 'Укажите сумму' }

  const { error } = await supabase.from('income_events').insert({
    user_id: userId, month_key: mk, event_type: type, description: desc,
    amount, debit_delta: toDebit ? amount : 0, event_date: date,
  })
  if (error) return { error: error.message }
  if (toDebit) await adjustDebit(supabase, userId, amount)

  revalidatePath('/dashboard')
  return { success: true }
}

export async function deleteIncomeEvent(eventId: string) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'удаление дохода')
  const { data: ev } = await supabase.from('income_events')
    .select('debit_delta').eq('id', eventId).eq('user_id', userId).single()
  const { error } = await supabase.from('income_events').delete().eq('id', eventId).eq('user_id', userId)
  if (error) return { error: error.message }
  if (ev?.debit_delta) await adjustDebit(supabase, userId, -Number(ev.debit_delta))
  revalidatePath('/dashboard')
  return { success: true }
}

// ════════════════════════════════════════════════════════════════════════════
// MONTH DATA (revenue, clients)
// ════════════════════════════════════════════════════════════════════════════

export async function updateRevenue(mk: string, revenue: number) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'изменение выручки')
  await ensureMonth(supabase, userId, mk)
  if (isNaN(revenue) || revenue < 0) return { error: 'Некорректная сумма' }
  const { error } = await supabase.from('months').update({ revenue: Math.round(revenue) })
    .eq('user_id', userId).eq('month_key', mk)
  if (error) return { error: error.message }
  revalidatePath('/dashboard')
  return { success: true }
}

export async function updateClients(mk: string, clients: Record<string, number>) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'изменение клиентов')
  await ensureMonth(supabase, userId, mk)
  const { error } = await supabase.from('months').update({ clients })
    .eq('user_id', userId).eq('month_key', mk)
  if (error) return { error: error.message }
  revalidatePath('/dashboard')
  return { success: true }
}

/** Close a month: store a summary snapshot and lock it. */
export async function closeMonth(mk: string, summary: Record<string, number>) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'закрытие месяца')
  await ensureMonth(supabase, userId, mk)
  const { error } = await supabase.from('months')
    .update({ closed: true, summary }).eq('user_id', userId).eq('month_key', mk)
  if (error) return { error: error.message }
  revalidatePath('/dashboard')
  return { success: true }
}

export async function reopenMonth(mk: string) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'открытие месяца')
  const { error } = await supabase.from('months')
    .update({ closed: false }).eq('user_id', userId).eq('month_key', mk)
  if (error) return { error: error.message }
  revalidatePath('/dashboard')
  return { success: true }
}

// ════════════════════════════════════════════════════════════════════════════
// LOANS / CARDS / GOALS CRUD
// ════════════════════════════════════════════════════════════════════════════

export async function addLoan(formData: FormData) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'добавление кредита')
  const { error } = await supabase.from('loans').insert({
    user_id: userId,
    name: (formData.get('name') as string).trim(),
    rate: parseFloat(formData.get('rate') as string) / 100,
    principal: Math.round(parseFloat(formData.get('principal') as string)),
    accrued_int: 0,
    min_payment: Math.round(parseFloat(formData.get('min_payment') as string)),
    due_day: (formData.get('due_day') as string) || 'last',
    original_amt: Math.round(parseFloat(formData.get('principal') as string)),
    last_accrual: new Date().toISOString().split('T')[0],
  })
  if (error) return { error: error.message }
  revalidatePath('/dashboard')
  return { success: true }
}

export async function deleteLoan(loanId: string) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'удаление кредита')
  await supabase.from('loans').delete().eq('id', loanId).eq('user_id', userId)
  revalidatePath('/dashboard')
  return { success: true }
}

export async function addCard(formData: FormData) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'добавление карты')
  const { error } = await supabase.from('cards').insert({
    user_id: userId,
    name: (formData.get('name') as string).trim(),
    card_limit: Math.round(parseFloat(formData.get('card_limit') as string)),
    current_debt: Math.round(parseFloat(formData.get('current_debt') as string) || 0),
  })
  if (error) return { error: error.message }
  revalidatePath('/dashboard')
  return { success: true }
}

export async function deleteCard(cardId: string) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'удаление карты')
  await supabase.from('cards').delete().eq('id', cardId).eq('user_id', userId)
  revalidatePath('/dashboard')
  return { success: true }
}

export async function addGoal(formData: FormData) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'добавление цели')
  const mk = (formData.get('month_key') as string) || null // null = global goal
  // Accept 'goal_name' (new form) or 'name' (legacy)
  const rawName = (formData.get('goal_name') ?? formData.get('name') ?? '') as string
  const name = rawName.trim()
  if (!name) return { error: 'Введи название цели' }
  const amount = Math.round(parseFloat(formData.get('amount') as string))
  if (!amount || amount <= 0) return { error: 'Введи корректную сумму' }
  const { error } = await supabase.from('goals').insert({ user_id: userId, month_key: mk, name, amount })
  if (error) return { error: error.message }
  revalidatePath('/dashboard')
  return { success: true }
}

export async function deleteGoal(goalId: string) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'удаление цели')
  await supabase.from('goals').delete().eq('id', goalId).eq('user_id', userId)
  revalidatePath('/dashboard')
  return { success: true }
}

export async function updateGoal(goalId: string, amount: number, name?: string) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'правка цели')
  const patch: Record<string, number | string> = { amount: Math.round(amount) }
  if (name) patch.name = name
  const { error } = await supabase.from('goals').update(patch).eq('id', goalId).eq('user_id', userId)
  if (error) return { error: error.message }
  revalidatePath('/dashboard')
  return { success: true }
}

// ════════════════════════════════════════════════════════════════════════════
// ACCOUNT TRANSFERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Transfer between accounts / pay off a card.
 * from/to: 'sber' | 'tbank' | '<card_id>'
 */
export async function transfer(from: string, to: string, amount: number) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, `перевод ${from}→${to}`)
  const amt = Math.round(amount * 100) / 100
  if (amt <= 0) return { error: 'Сумма должна быть больше 0' }

  // Debit FROM source
  if (from === 'sber') {
    await adjustDebit(supabase, userId, -amt)
  } else if (from === 'tbank') {
    const { data: u } = await supabase.from('users').select('tbank_debit').eq('id', userId).single()
    await supabase.from('users').update({ tbank_debit: Math.round((Number(u?.tbank_debit ?? 0) - amt) * 100) / 100 }).eq('id', userId)
  } else {
    // from a card — unusual, but possible (card refund)
    const { data: c } = await supabase.from('cards').select('current_debt').eq('id', from).single()
    await supabase.from('cards').update({ current_debt: Math.max(0, Number(c?.current_debt ?? 0) - amt) }).eq('id', from)
  }

  // Credit TO target
  if (to === 'sber') {
    await adjustDebit(supabase, userId, amt)
  } else if (to === 'tbank') {
    const { data: u } = await supabase.from('users').select('tbank_debit').eq('id', userId).single()
    await supabase.from('users').update({ tbank_debit: Math.round((Number(u?.tbank_debit ?? 0) + amt) * 100) / 100 }).eq('id', userId)
  } else {
    // Paying off a credit card
    const { data: c } = await supabase.from('cards').select('current_debt').eq('id', to).single()
    await supabase.from('cards').update({ current_debt: Math.max(0, Number(c?.current_debt ?? 0) - amt) }).eq('id', to)
  }

  revalidatePath('/dashboard')
  return { success: true }
}

// ════════════════════════════════════════════════════════════════════════════
// GOALS — purchase + move to month
// ════════════════════════════════════════════════════════════════════════════

/** Mark a planned purchase as bought. Deducts from the chosen account. */
export async function purchaseGoal(goalId: string, source: string) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'покупка плановой траты')

  const { data: g } = await supabase.from('goals').select('amount, purchased').eq('id', goalId).eq('user_id', userId).single()
  if (!g || g.purchased) return { error: 'Цель не найдена или уже куплена' }
  const amt = Math.round(Number(g.amount) * 100) / 100

  // Deduct from source account
  if (source === 'sber') {
    await adjustDebit(supabase, userId, -amt)
  } else if (source === 'tbank') {
    const { data: u } = await supabase.from('users').select('tbank_debit').eq('id', userId).single()
    await supabase.from('users').update({ tbank_debit: Math.round((Number(u?.tbank_debit ?? 0) - amt) * 100) / 100 }).eq('id', userId)
  } else {
    // credit card
    const { data: c } = await supabase.from('cards').select('current_debt').eq('id', source).single()
    await supabase.from('cards').update({ current_debt: Number(c?.current_debt ?? 0) + amt }).eq('id', source)
  }

  await supabase.from('goals').update({
    purchased: true,
    purchased_at: new Date().toISOString().split('T')[0],
    purchased_source: source,
  }).eq('id', goalId).eq('user_id', userId)

  revalidatePath('/dashboard')
  return { success: true }
}

/** Update goal's name, amount, and/or move to a specific month (or back to global). */
export async function updateGoalDetails(goalId: string, updates: { name?: string; amount?: number; month_key?: string | null }) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'изменение цели')
  const patch: Record<string, unknown> = {}
  if (updates.name != null) patch.name = updates.name
  if (updates.amount != null) patch.amount = Math.round(updates.amount)
  if ('month_key' in updates) patch.month_key = updates.month_key ?? null
  const { error } = await supabase.from('goals').update(patch).eq('id', goalId).eq('user_id', userId)
  if (error) return { error: error.message }
  revalidatePath('/dashboard')
  return { success: true }
}

export async function updateUserSettings(formData: FormData) {
  const { supabase, userId } = await requireUser()
  await snapshot(supabase, userId, 'настройки')
  const fields: Record<string, number> = {}
  for (const f of ['salary_net','salary_gross','threshold','margin_floor','var_budget','ytd_gross']) {
    const v = Math.round(parseFloat(formData.get(f) as string))
    if (!isNaN(v)) fields[f] = v
  }
  // okupaemost auto = 40% of gross
  if (fields.salary_gross) fields.threshold = Math.round(fields.salary_gross * 0.40)
  if (!Object.keys(fields).length) return { error: 'Нет данных' }
  const { error } = await supabase.from('users').update(fields).eq('id', userId)
  if (error) return { error: error.message }
  revalidatePath('/dashboard')
  return { success: true }
}
