/**
 * Finance Cockpit Bot — v5 FINAL
 * Единое окно ко всем действиям сайта
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'
const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}
function mk(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
}
function rub(n: number): string { return Math.round(n).toLocaleString('ru-RU') + ' ₽' }
function pct(a: number, b: number): number { return b > 0 ? Math.round(a/b*100) : 0 }

// ── История ────────────────────────────────────────────────────────────────
export async function getHistory(chatId: number) {
  const { data } = await db().from('bot_messages').select('role,content').eq('chat_id', chatId).order('created_at', { ascending: false }).limit(10)
  return (data ?? []).reverse()
}
export async function saveHistory(chatId: number, role: 'user'|'assistant', content: string) {
  await db().from('bot_messages').insert({ chat_id: chatId, user_id: USER_ID, role, content }).then(() => {})
}
export async function storeChatId(chatId: number) {
  await db().from('users').update({ telegram_chat_id: chatId }).eq('id', USER_ID)
}

// ── Снапшот ────────────────────────────────────────────────────────────────
async function snap(label: string) {
  const s = db()
  const [us, mo, lo, ca, go, ex, ie] = await Promise.all([
    s.from('users').select('*').eq('id', USER_ID).single(),
    s.from('months').select('*').eq('user_id', USER_ID),
    s.from('loans').select('*').eq('user_id', USER_ID),
    s.from('cards').select('*').eq('user_id', USER_ID),
    s.from('goals').select('*').eq('user_id', USER_ID),
    s.from('expenses').select('*').eq('user_id', USER_ID),
    s.from('income_events').select('*').eq('user_id', USER_ID),
  ])
  const state = { users: us.data, months: mo.data??[], loans: lo.data??[], cards: ca.data??[], goals: go.data??[], expenses: ex.data??[], income_events: ie.data??[] }
  await s.from('undo_snapshots').insert({ user_id: USER_ID, description: `[бот] ${label}`, snapshot: state })
  const { data: all } = await s.from('undo_snapshots').select('id').eq('user_id', USER_ID).order('created_at', { ascending: false })
  if (all && all.length > 15) await s.from('undo_snapshots').delete().in('id', all.slice(15).map((r: {id:string}) => r.id))
}

// ── Финансовый контекст ────────────────────────────────────────────────────
export async function getContext(): Promise<string> {
  const supabase = db()
  const monthKey = mk()
  const [{ data: user }, { data: loans }, { data: expenses }, { data: month }, { data: goals }, { data: recentExp }] = await Promise.all([
    supabase.from('users').select('*').eq('id', USER_ID).single(),
    supabase.from('loans').select('name,principal,accrued_int,min_payment,end_date,rate,paid_month,due_day').eq('user_id', USER_ID).order('sort_order'),
    supabase.from('expenses').select('id,amount,category,description,expense_date').eq('user_id', USER_ID).eq('month_key', monthKey),
    supabase.from('months').select('*').eq('user_id', USER_ID).eq('month_key', monthKey).maybeSingle(),
    supabase.from('goals').select('id,name,amount,month_key,purchased').eq('user_id', USER_ID).eq('purchased', false).limit(6),
    supabase.from('expenses').select('id,category,amount,description').eq('user_id', USER_ID).eq('month_key', monthKey).order('expense_date', { ascending: false }).limit(5),
  ])
  if (!user) return 'Данные не загружены'

  const liquid = Number(user.debit_balance ?? 0) + Number(user.tbank_debit ?? 0)
  const varBudget = Number(user.var_budget ?? 40000)
  const varSpent = (expenses ?? []).reduce((s,e) => s+Number(e.amount), 0)
  const varLeft = Math.max(0, varBudget - varSpent)
  const today = new Date().getDate()
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth()+1, 0).getDate()
  const daysLeft = daysInMonth - today + 1
  const daily = Math.round(varLeft / Math.max(1, daysLeft))
  const totalDebt = (loans ?? []).reduce((s,l) => s+Number(l.principal)+Number(l.accrued_int), 0)
  const totalPay = (loans ?? []).reduce((s,l) => s+Number(l.min_payment), 0)

  // Кешфлоу расчёт
  const fixedCosts = user.fixed_costs as {name:string; amount:number}[] ?? []
  const fixedPaid = month?.fixed_paid as Record<string, boolean|number> ?? {}
  const fixedTotal = fixedCosts.reduce((s,f) => s+f.amount, 0)
  const fixedPaidTotal = fixedCosts.reduce((s,f,i) => fixedPaid[String(i)] ? s+f.amount : s, 0)
  const fixedUnpaid = fixedTotal - fixedPaidTotal

  const adv = Number(month?.salary_adv_amount ?? 60800)
  const eom = Number(month?.salary_eom_amount ?? 60800)
  const bonus = 25010
  const pendingIncome = (!month?.salary_adv_received ? adv : 0) + (!month?.salary_eom_received ? eom + bonus : 0)
  const pendingLoans = (loans ?? []).filter(l => l.paid_month !== monthKey).reduce((s,l) => s+Number(l.min_payment), 0)
  const projEnd = liquid + pendingIncome - pendingLoans - fixedUnpaid - (varBudget - varSpent)

  // Бонус
  const nominals = user.nominals as Record<string,number> ?? {}
  const clients = month?.clients as Record<string,number> ?? {}
  const revenue = Number(month?.revenue ?? 41666)
  const pot = Object.entries(clients).reduce((s,[g,n])=>s+(nominals[g]??0)*n,0) + revenue*Number(user.margin_share??0.20)
  const bonusNet = Math.round(Math.max(0,(pot-Number(user.threshold??56000)))*Number(user.moment_share??0.80)*0.87)

  const loanLines = (loans??[]).map(l => {
    const total = Number(l.principal)+Number(l.accrued_int)
    const paid = l.paid_month === monthKey ? '✅' : '⏳'
    let mLeft = ''
    if (l.end_date) { const end=new Date(l.end_date),now=new Date(); mLeft=` [${(end.getFullYear()-now.getFullYear())*12+end.getMonth()-now.getMonth()}мес]` }
    return `  ${l.name}: ${rub(total)} @ ${(Number(l.rate)*100).toFixed(2)}% · ${rub(Number(l.min_payment))}/мес ${paid}${mLeft}`
  }).join('\n')

  const fixedLines = fixedCosts.map((f,i) => {
    const paid = fixedPaid[String(i)] ? '✅' : '⏳'
    return `  ${f.name}: ${rub(f.amount)} ${paid}`
  }).join('\n')

  const expLines = (recentExp??[]).map(e => `  [ID:${e.id.slice(-6)}] ${e.category}: ${rub(e.amount)}${e.description?' ('+e.description+')':''}`).join('\n') || '  нет трат'

  const goalLines = (goals??[]).slice(0,4).map(g => `  [ID:${g.id.slice(-6)}] ${g.name}: ${rub(g.amount)}${g.month_key?' ('+g.month_key+')':' (накопление)'}`).join('\n') || '  нет'

  return `ДАТА: ${new Date().toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}

БАЛАНС И БЮДЖЕТ:
- Ликвидность: ${rub(liquid)} (Сбер: ${rub(user.debit_balance)}, Т-Банк: ${rub(user.tbank_debit??0)})
- Переменные: лимит ${rub(varBudget)} · потрачено ${rub(varSpent)} (${pct(varSpent,varBudget)}%) · осталось ${rub(varLeft)}
- Дневной бюджет: ${rub(daily)}/день · ${daysLeft} дней до конца месяца

КЕШФЛОУ МЕСЯЦА (${monthKey}):
- Будущие поступления (+): аванс${month?.salary_adv_received?' ✅':`+${rub(adv)} ⏳`}, ЗП+бонус${month?.salary_eom_received?' ✅':`+${rub(eom+bonus)} ⏳`}
- Обязательные расходы (-): кредиты ${rub(pendingLoans)}, постоянные неоплаченные ${rub(fixedUnpaid)}, переменные до лимита ${rub(varLeft)}
- Прогноз остатка: ${rub(projEnd)}

КРЕДИТЫ (итого ${rub(totalDebt)}, платёж ${rub(totalPay)}/мес):
${loanLines}

ПОСТОЯННЫЕ (итого ${rub(fixedTotal)}, оплачено ${rub(fixedPaidTotal)}):
${fixedLines}

ПЕРЕМЕННЫЕ ТРАТЫ (последние):
${expLines}

ЦЕЛИ:
${goalLines}

СДЕЛКИ И БОНУС:
- Клиенты: ${JSON.stringify(clients)}, выручка: ${rub(revenue)}
- Прогноз бонуса: ~${rub(bonusNet)}

НАСТРОЙКИ (можно менять):
- Оклад net ${rub(user.salary_net)}, gross ${rub(user.salary_gross)} | Порог: ${rub(user.threshold)} | Момент: ${Number(user.moment_share)*100}% | Марджин: ${Number(user.margin_share)*100}%
- Номиналы: г3=${nominals.g3}, г4=${nominals.g4}, г5-6=${nominals.g56}, г7-8=${nominals.g78}, г9=${nominals.g9}, г10=${nominals.g10}
- Лимит переменных: ${rub(varBudget)} (устанавливается вручную)`
}

// ── Системный промпт ───────────────────────────────────────────────────────
const SYSTEM = `Ты — финансовый ИИ-ассистент Александра (АТОН, продажи инвест. продуктов). Отвечаешь по-русски, чётко, с эмодзи. Александр говорит с тобой как с умным финансовым другом.

ФОРМУЛА БОНУСА:
  Котёл = Σ(клиенты×номинал) + margin_share×выручка
  Сверхпорог = max(0, котёл − порог)
  Момент = сверхпорог × moment_share
  НДФЛ 13% (15% если YTD+момент > 2 400 000₽)
  Бонус на руки = момент − НДФЛ

ПРАВИЛА ОТВЕТА:
1. На вопросы о бюджете/кешфлоу — давай КОНКРЕТНЫЕ ЦИФРЫ из контекста, структурированно
2. Трату записывай ТОЛЬКО при явных словах: потратил/купил/заплатил/списал
3. Гипотетические вопросы ("что если") — считай точно по формуле
4. Максимум 2000 символов в ответе — если нужно больше, дай главное и скажи что можно уточнить
5. При получении зарплаты/аванса — зачисляй на дебет
6. "Отмени" / "undo" — откат последнего действия

ДОСТУПНЫЕ ДЕЙСТВИЯ (добавляй в КОНЕЦ ответа отдельной строкой):
ACTION:{"type":"add_expense","amount":800,"category":"Транспорт","description":"такси"}
ACTION:{"type":"delete_expense","id":"last"}
ACTION:{"type":"add_client","grade":"g10","revenue":80000}
ACTION:{"type":"add_goal","name":"Телефон","amount":50000,"month_key":null}
ACTION:{"type":"mark_goal_bought","name":"Телефон"}
ACTION:{"type":"mark_salary","part":"advance"}
ACTION:{"type":"mark_salary","part":"eom"}
ACTION:{"type":"mark_single_fixed","name":"Интернет"}
ACTION:{"type":"mark_fixed_paid"}
ACTION:{"type":"mark_loan_paid","name":"Кредит А"}
ACTION:{"type":"early_repay","name":"Кредит А","amount":50000}
ACTION:{"type":"add_income_event","amount":20000,"description":"Отпускные"}
ACTION:{"type":"set_balance","account":"sber","amount":18000}
ACTION:{"type":"set_balance","account":"tbank","amount":5000}
ACTION:{"type":"close_month"}
ACTION:{"type":"update_settings","field":"var_budget","value":50000}
ACTION:{"type":"update_settings","field":"salary_net","value":130000}
ACTION:{"type":"update_settings","field":"threshold","value":60000}
ACTION:{"type":"update_settings","field":"moment_share","value":0.75}
ACTION:{"type":"update_settings","field":"nominal","key":"g10","value":90000}
ACTION:{"type":"undo"}

Категории трат: Еда и кафе, Транспорт, Здоровье, Развлечения, Одежда, Инвестиции, Прочее
Грейды: g3=7200₽, g4=14400₽, g56=21600₽, g78=43200₽, g9=64000₽, g10=80000₽`

// ── Тип действия ───────────────────────────────────────────────────────────
interface BotAction {
  type: string
  amount?: number; category?: string; description?: string; id?: string
  grade?: string; revenue?: number; name?: string; month_key?: string|null
  field?: string; key?: string; value?: number|string; account?: string; part?: string
}

// ── Выполнение действий ────────────────────────────────────────────────────
export async function executeAction(action: BotAction): Promise<void> {
  const s = db()
  const monthKey = mk()

  const snapLabel: Record<string,string> = {
    add_expense:'трата',delete_expense:'удаление траты',add_client:'клиент',
    add_goal:'цель',mark_goal_bought:'покупка',mark_salary:'зарплата',
    mark_single_fixed:'постоянная трата',mark_fixed_paid:'постоянные траты',
    mark_loan_paid:'платёж по кредиту',early_repay:'досрочное погашение',
    add_income_event:'доход',set_balance:'баланс',close_month:'закрытие месяца',
    update_settings:'настройки',undo:'отмена',
  }
  if (snapLabel[action.type]) await snap(snapLabel[action.type])

  if (action.type === 'add_expense' && action.amount) {
    await s.from('expenses').insert({ user_id:USER_ID, month_key:monthKey, expense_date:new Date().toISOString().split('T')[0], category:action.category??'Прочее', amount:Math.round(action.amount), description:action.description??null, source_type:'debit' })
    const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
    await s.from('users').update({ debit_balance:Math.round((Number(u?.debit_balance??0)-action.amount)*100)/100, debit_updated_at:new Date().toISOString() }).eq('id',USER_ID)
  }

  if (action.type === 'delete_expense') {
    const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
    let exp
    if (action.id === 'last' || !action.id) {
      const { data } = await s.from('expenses').select('id,amount').eq('user_id',USER_ID).eq('month_key',monthKey).order('created_at',{ascending:false}).limit(1).maybeSingle()
      exp = data
    } else {
      const { data } = await s.from('expenses').select('id,amount').eq('user_id',USER_ID).ilike('id', `%${action.id}%`).maybeSingle()
      exp = data
    }
    if (exp) {
      await s.from('expenses').delete().eq('id',exp.id)
      await s.from('users').update({ debit_balance:Math.round((Number(u?.debit_balance??0)+Number(exp.amount))*100)/100, debit_updated_at:new Date().toISOString() }).eq('id',USER_ID)
    }
  }

  if (action.type === 'add_client' && action.grade) {
    const { data:month } = await s.from('months').select('clients,revenue').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
    const cur = month?.clients as Record<string,number>??{}
    const clients = {...cur, [action.grade]:(cur[action.grade]??0)+1}
    const newRev = Number(month?.revenue??41666) + (action.revenue??0)
    month ? await s.from('months').update({clients,revenue:newRev}).eq('user_id',USER_ID).eq('month_key',monthKey)
           : await s.from('months').insert({user_id:USER_ID,month_key:monthKey,clients,revenue:newRev})
  }

  if (action.type === 'add_goal' && action.name && action.amount) {
    await s.from('goals').insert({ user_id:USER_ID, name:action.name, amount:Math.round(action.amount), month_key:action.month_key??null, sort_order:99 })
  }

  if (action.type === 'mark_goal_bought' && action.name) {
    const { data:goal } = await s.from('goals').select('id,amount').eq('user_id',USER_ID).ilike('name',`%${action.name}%`).maybeSingle()
    if (goal) {
      await s.from('goals').update({ purchased:true, purchased_at:new Date().toISOString().split('T')[0] }).eq('id',goal.id)
      const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
      await s.from('users').update({ debit_balance:Math.round((Number(u?.debit_balance??0)-Number(goal.amount))*100)/100, debit_updated_at:new Date().toISOString() }).eq('id',USER_ID)
    }
  }

  if (action.type === 'mark_salary') {
    const { data:u } = await s.from('users').select('debit_balance,salary_net').eq('id',USER_ID).single()
    const { data:month } = await s.from('months').select('*').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
    const net = Number(u?.salary_net??121600)
    if (action.part === 'advance') {
      const advAmt = Number(month?.salary_adv_amount ?? Math.round(net/2))
      await s.from('months').update({salary_adv_received:true,salary_adv_amount:advAmt}).eq('user_id',USER_ID).eq('month_key',monthKey)
      await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)+advAmt)*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
    }
    if (action.part === 'eom') {
      const advAmt = Number(month?.salary_adv_amount??Math.round(net/2))
      const eomSalary = Number(month?.salary_eom_amount??net-advAmt)
      const bonusAmt = Number(month?.bonus_amount??0)
      const total = eomSalary + bonusAmt
      await s.from('months').update({salary_eom_received:true,salary_eom_amount:eomSalary}).eq('user_id',USER_ID).eq('month_key',monthKey)
      await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)+total)*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
    }
  }

  if (action.type === 'mark_single_fixed' && action.name) {
    const { data:u } = await s.from('users').select('debit_balance,fixed_costs').eq('id',USER_ID).single()
    const { data:month } = await s.from('months').select('fixed_paid').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
    const fixedCosts = u?.fixed_costs as {name:string;amount:number}[]??[]
    const idx = fixedCosts.findIndex(f => f.name.toLowerCase().includes((action.name??'').toLowerCase()))
    if (idx >= 0) {
      const fp = month?.fixed_paid as Record<string,boolean|number>??{}
      if (!fp[String(idx)]) {
        await s.from('months').update({fixed_paid:{...fp,[String(idx)]:fixedCosts[idx].amount}}).eq('user_id',USER_ID).eq('month_key',monthKey)
        await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)-fixedCosts[idx].amount)*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
      }
    }
  }

  if (action.type === 'mark_fixed_paid') {
    const { data:u } = await s.from('users').select('debit_balance,fixed_costs').eq('id',USER_ID).single()
    const { data:month } = await s.from('months').select('fixed_paid').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
    const fixedCosts = u?.fixed_costs as {name:string;amount:number}[]??[]
    const fp = month?.fixed_paid as Record<string,boolean|number>??{}
    const newFp: Record<string,number> = {}
    let total = 0
    fixedCosts.forEach((f,i) => { if (!fp[String(i)]) { newFp[String(i)]=f.amount; total+=f.amount } })
    if (total > 0) {
      await s.from('months').update({fixed_paid:{...fp,...newFp}}).eq('user_id',USER_ID).eq('month_key',monthKey)
      await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)-total)*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
    }
  }

  if (action.type === 'mark_loan_paid' && action.name) {
    const { data:loan } = await s.from('loans').select('*').eq('user_id',USER_ID).ilike('name',`%${action.name}%`).maybeSingle()
    if (loan && loan.paid_month !== monthKey) {
      const pay = Number(loan.min_payment)
      const toInt = Math.min(pay, Number(loan.accrued_int))
      const toPrincipal = pay - toInt
      await s.from('loans').update({ accrued_int:Number(loan.accrued_int)-toInt, principal:Math.max(0,Number(loan.principal)-toPrincipal), paid_month:monthKey, last_pay_principal:toPrincipal, last_pay_interest:toInt }).eq('id',loan.id)
      const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
      await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)-pay)*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
    }
  }

  if (action.type === 'early_repay' && action.name && action.amount) {
    const { data:loan } = await s.from('loans').select('*').eq('user_id',USER_ID).ilike('name',`%${action.name}%`).maybeSingle()
    if (loan) {
      const newPrincipal = Math.max(0, Number(loan.principal) - action.amount)
      const ratio = Number(loan.principal)>0 ? newPrincipal/Number(loan.principal) : 0
      const newPayment = Math.round(Number(loan.min_payment)*ratio*100)/100
      await s.from('loans').update({principal:newPrincipal,min_payment:newPayment}).eq('id',loan.id)
      const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
      await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)-action.amount)*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
    }
  }

  if (action.type === 'add_income_event' && action.amount) {
    await s.from('income_events').insert({ user_id:USER_ID, month_key:monthKey, event_date:new Date().toISOString().split('T')[0], event_type:'other', description:action.description??'Доход', amount:Math.round(action.amount), to_debit:true })
    const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
    await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)+action.amount)*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
  }

  if (action.type === 'set_balance' && action.account && action.amount != null) {
    const field = action.account === 'sber' ? 'debit_balance' : 'tbank_debit'
    await s.from('users').update({[field]:action.amount,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
  }

  if (action.type === 'close_month') {
    await s.from('months').update({closed:true}).eq('user_id',USER_ID).eq('month_key',monthKey)
  }

  if (action.type === 'update_settings' && action.field) {
    const ALLOWED = ['salary_net','salary_gross','ytd_gross','threshold','moment_share','margin_share','var_budget']
    if (action.field === 'nominal' && action.key) {
      const { data:u } = await s.from('users').select('nominals').eq('id',USER_ID).single()
      const nominals = {...(u?.nominals as Record<string,number>??{}), [action.key]:Number(action.value)}
      await s.from('users').update({nominals}).eq('id',USER_ID)
    } else if (ALLOWED.includes(action.field)) {
      await s.from('users').update({[action.field]:Number(action.value)}).eq('id',USER_ID)
    }
  }

  if (action.type === 'undo') {
    const { data:snap } = await s.from('undo_snapshots').select('*').eq('user_id',USER_ID).order('created_at',{ascending:false}).limit(1).maybeSingle()
    if (snap) {
      const st = snap.snapshot as Record<string,unknown>
      if (st.users) { const u={...st.users as Record<string,unknown>}; delete u.id; await s.from('users').update(u).eq('id',USER_ID) }
      await s.from('expenses').delete().eq('user_id',USER_ID)
      await s.from('income_events').delete().eq('user_id',USER_ID)
      await s.from('goals').delete().eq('user_id',USER_ID)
      await s.from('loans').delete().eq('user_id',USER_ID)
      await s.from('months').delete().eq('user_id',USER_ID)
      await s.from('cards').delete().eq('user_id',USER_ID)
      for (const t of ['cards','months','loans','goals','expenses','income_events']) {
        const rows = st[t] as Record<string,unknown>[]|undefined
        if (rows?.length) await s.from(t).insert(rows)
      }
      await s.from('undo_snapshots').delete().eq('id',snap.id)
    }
  }
}

// ── Парсинг + выполнение ────────────────────────────────────────────────────
async function parseAndExecute(fullReply: string, userText: string, chatId: number): Promise<string> {
  const actionMatch = fullReply.match(/^ACTION:(\{.+\})$/m)
  const reply = fullReply.replace(/^ACTION:\{.+\}$/m, '').trim()
  if (actionMatch) {
    try { await executeAction(JSON.parse(actionMatch[1])) } catch(e) { console.error('[action]',e) }
  }
  // Сохранить историю (не ждём)
  Promise.all([saveHistory(chatId,'user',userText), saveHistory(chatId,'assistant',reply)]).catch(()=>{})
  return reply
}

// ── Claude: текст ───────────────────────────────────────────────────────────
export async function processMessage(text: string, chatId: number): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return '⚠️ Добавь ANTHROPIC_API_KEY в Vercel.'
  const [context, history] = await Promise.all([getContext(), getHistory(chatId)])
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST', headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
    body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:700,
      system: SYSTEM+'\n\nКОНТЕКСТ:\n'+context,
      messages:[...history.map(h=>({role:h.role as 'user'|'assistant',content:h.content})),{role:'user',content:text}] })
  })
  const data = await res.json()
  const raw = data.content?.[0]?.text ?? '❌ Ошибка API'
  return parseAndExecute(raw, text, chatId)
}

// ── Claude: изображение ─────────────────────────────────────────────────────
export async function processImage(fileId: string, chatId: number, caption?: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return '⚠️ Нужен ANTHROPIC_API_KEY для чтения скринов.'
  try {
    const fileRes = await fetch(`${TG}/getFile?file_id=${fileId}`)
    const { result } = await fileRes.json()
    if (!result?.file_path) return '❌ Не удалось получить файл'
    const imgRes = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${result.file_path}`)
    const buf = await imgRes.arrayBuffer()
    const base64 = Buffer.from(buf).toString('base64')
    const mime = result.file_path.endsWith('.png') ? 'image/png' : 'image/jpeg'
    const [context, history] = await Promise.all([getContext(), getHistory(chatId)])
    const userText = caption ?? 'Что на этом скрине? Если чек/расход — помоги записать.'
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
      body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:700,
        system:SYSTEM+'\n\nКОНТЕКСТ:\n'+context,
        messages:[...history.map(h=>({role:h.role as 'user'|'assistant',content:h.content})),
          {role:'user',content:[{type:'image',source:{type:'base64',media_type:mime,data:base64}},{type:'text',text:userText}]}] })
    })
    const data = await res.json()
    const raw = data.content?.[0]?.text ?? '❌ Не смог прочитать'
    return parseAndExecute(raw, `[фото: ${userText}]`, chatId)
  } catch(err) { console.error('[vision]',err); return '❌ Ошибка чтения изображения.' }
}

// ── Утренний дайджест ──────────────────────────────────────────────────────
export async function generateMorningBriefing(isWeekly = false): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  const context = await getContext()
  if (!apiKey) return '🌅 Доброе утро, Александр!'
  const today = new Date()
  const dateFmt = today.toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long'})
  const prompt = isWeekly
    ? `Составь ЕЖЕНЕДЕЛЬНЫЙ финансовый отчёт (воскресенье, ${dateFmt}). Включи: 1) итоги недели по тратам и прогрессу, 2) текущий баланс и дневной бюджет, 3) ближайшие платежи на следующей неделе, 4) прогноз бонуса этого месяца, 5) мотивирующий комментарий. Чётко, по делу, с цифрами.`
    : `Краткий утренний дайджест (${dateFmt}): 1) баланс и дневной бюджет, 2) ближайшие платежи по кредитам, 3) прогресс переменных трат, 4) один полезный факт или совет. Не более 10 строк.`
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST', headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
    body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:600,system:SYSTEM+'\n\nКОНТЕКСТ:\n'+context,messages:[{role:'user',content:prompt}]})
  })
  const data = await res.json()
  return data.content?.[0]?.text ?? '🌅 Доброе утро!'
}

// ── Голос ──────────────────────────────────────────────────────────────────
export async function transcribeVoice(fileId: string): Promise<string|null> {
  const groqKey = process.env.GROQ_API_KEY, openaiKey = process.env.OPENAI_API_KEY
  if (!groqKey && !openaiKey) return null
  try {
    const fileRes = await fetch(`${TG}/getFile?file_id=${fileId}`)
    const { result } = await fileRes.json()
    if (!result?.file_path) return null
    const audioRes = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${result.file_path}`)
    const buf = await audioRes.arrayBuffer()
    const form = new FormData()
    form.append('file', new Blob([buf],{type:'audio/ogg'}), 'voice.ogg')
    form.append('model', groqKey ? 'whisper-large-v3-turbo' : 'whisper-1')
    form.append('language', 'ru')
    const whisperRes = await fetch(
      groqKey ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions',
      {method:'POST',headers:{'Authorization':`Bearer ${groqKey??openaiKey}`},body:form}
    )
    const { text } = await whisperRes.json()
    return text ?? null
  } catch { return null }
}

// ── Telegram send (с fallback если Markdown не работает) ──────────────────
export async function sendTelegram(chatId: number, text: string): Promise<void> {
  const clean = text.replace(/```[\s\S]*?```/g,'').trim()
  const chunks = splitMsg(clean, 3800)
  for (const chunk of chunks) {
    const res = await fetch(`${TG}/sendMessage`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:chatId,text:chunk,parse_mode:'Markdown',disable_web_page_preview:true})
    })
    const json = await res.json()
    // Если Markdown упал — отправить plain text
    if (!json.ok) {
      await fetch(`${TG}/sendMessage`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({chat_id:chatId,text:chunk.replace(/[*_`]/g,''),disable_web_page_preview:true})
      })
    }
  }
}

function splitMsg(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const parts: string[] = []
  let i = 0
  while (i < text.length) { parts.push(text.slice(i, i+limit)); i += limit }
  return parts
}
