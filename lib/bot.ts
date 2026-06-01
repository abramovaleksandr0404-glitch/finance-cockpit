/**
 * Finance Cockpit Bot — v6
 * + Sonnet 4.6 для сложного, Haiku для простого (routing)
 * + Prompt Caching (90% скидка на контекст)
 * + Структурированный контекст с готовыми расчётами
 * + Сжатие истории
 * + Подтверждения перед неоднозначными действиями
 * + Распознавание подписок (Claude/ChatGPT/etc → Обучение и ИИ)
 * + Редактирование постоянных трат через бот
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const USER_ID = '5ebdb411-6021-4dfc-9d0d-caa8e0107502'
const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}
function mk(): string { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}` }
function rub(n: number): string { return Math.round(n).toLocaleString('ru-RU')+' ₽' }
function pct(a: number, b: number): number { return b>0 ? Math.round(a/b*100) : 0 }

// ── История разговора (со сжатием) ────────────────────────────────────────
export async function getHistory(chatId: number) {
  const { data } = await db().from('bot_messages').select('role,content,summary').eq('chat_id', chatId).order('created_at', { ascending: false }).limit(8)
  return (data ?? []).reverse()
}
export async function saveHistory(chatId: number, role: 'user'|'assistant', content: string) {
  // Длинные сообщения сжимаем (>500 символов → summary в первых 200)
  const summary = content.length > 500 ? content.slice(0, 200) + '...' : null
  await db().from('bot_messages').insert({ chat_id: chatId, user_id: USER_ID, role, content, summary }).then(()=>{})
}
export async function storeChatId(chatId: number) {
  await db().from('users').update({ telegram_chat_id: chatId }).eq('id', USER_ID)
}

// ── Снапшот ───────────────────────────────────────────────────────────────
async function snap(label: string) {
  const s = db()
  const [us,mo,lo,ca,go,ex,ie] = await Promise.all([
    s.from('users').select('*').eq('id',USER_ID).single(),
    s.from('months').select('*').eq('user_id',USER_ID),
    s.from('loans').select('*').eq('user_id',USER_ID),
    s.from('cards').select('*').eq('user_id',USER_ID),
    s.from('goals').select('*').eq('user_id',USER_ID),
    s.from('expenses').select('*').eq('user_id',USER_ID),
    s.from('income_events').select('*').eq('user_id',USER_ID),
  ])
  const state = {users:us.data,months:mo.data??[],loans:lo.data??[],cards:ca.data??[],goals:go.data??[],expenses:ex.data??[],income_events:ie.data??[]}
  await s.from('undo_snapshots').insert({user_id:USER_ID,description:`[бот] ${label}`,snapshot:state})
  const { data:all } = await s.from('undo_snapshots').select('id').eq('user_id',USER_ID).order('created_at',{ascending:false})
  if (all && all.length>15) await s.from('undo_snapshots').delete().in('id',all.slice(15).map((r:{id:string})=>r.id))
}

// ── Структурированный контекст с ГОТОВЫМИ расчётами ──────────────────────
// Все цифры посчитаны заранее — Claude не должен сам считать
export async function getContext(): Promise<string> {
  const supabase = db()
  const monthKey = mk()
  const [{data:user},{data:loans},{data:expenses},{data:month},{data:goals},{data:recentExp}] = await Promise.all([
    supabase.from('users').select('*').eq('id',USER_ID).single(),
    supabase.from('loans').select('id,name,principal,accrued_int,min_payment,end_date,rate,paid_month,due_day').eq('user_id',USER_ID).order('sort_order'),
    supabase.from('expenses').select('id,amount,category,description,expense_date').eq('user_id',USER_ID).eq('month_key',monthKey),
    supabase.from('months').select('*').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle(),
    supabase.from('goals').select('id,name,amount,month_key,purchased').eq('user_id',USER_ID).eq('purchased',false).limit(6),
    supabase.from('expenses').select('id,category,amount,description,expense_date').eq('user_id',USER_ID).eq('month_key',monthKey).order('created_at',{ascending:false}).limit(5),
  ])
  if (!user) return 'Данные не загружены'

  // ── ВСЕ РАСЧЁТЫ ДЕЛАЕМ ЗДЕСЬ, чтобы Claude не путался ─────────
  const debitSber = Number(user.debit_balance ?? 0)
  const debitTbank = Number(user.tbank_debit ?? 0)
  const liquid = debitSber + debitTbank

  const salaryNet = Number(user.salary_net ?? 121600)
  const advAmount = Number(month?.salary_adv_amount ?? Math.round(salaryNet/2))
  const eomAmount = Number(month?.salary_eom_amount ?? salaryNet - advAmount)
  const bonusAmount = Number(month?.bonus_amount ?? 25010)
  const advReceived = !!month?.salary_adv_received
  const eomReceived = !!month?.salary_eom_received

  const incomingAdvance = advReceived ? 0 : advAmount
  const incomingEom = eomReceived ? 0 : (eomAmount + bonusAmount)
  const incomingTotal = incomingAdvance + incomingEom

  const fixedCosts = (user.fixed_costs as {name:string;amount:number}[]) ?? []
  const fixedPaid = (month?.fixed_paid as Record<string,number|boolean>) ?? {}
  const fixedTotal = fixedCosts.reduce((s,f)=>s+f.amount,0)
  let fixedPaidSum = 0
  fixedCosts.forEach((f,i) => { if (fixedPaid[String(i)]) fixedPaidSum += (typeof fixedPaid[String(i)]==='number' ? Number(fixedPaid[String(i)]) : f.amount) })
  const fixedUnpaid = Math.max(0, fixedTotal - fixedPaidSum)

  const varBudget = Number(user.var_budget ?? 40000)
  const varSpent = (expenses ?? []).reduce((s,e) => s+Number(e.amount), 0)
  const varLeft = Math.max(0, varBudget - varSpent)

  const today = new Date().getDate()
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth()+1, 0).getDate()
  const daysLeft = daysInMonth - today + 1
  const dailyBudget = Math.round(varLeft / Math.max(1, daysLeft))

  const pendingLoanPayments = (loans ?? []).filter(l => l.paid_month !== monthKey).reduce((s,l) => s+Number(l.min_payment), 0)
  const totalDebt = (loans ?? []).reduce((s,l) => s+Number(l.principal)+Number(l.accrued_int), 0)
  const totalMonthlyPayment = (loans ?? []).reduce((s,l) => s+Number(l.min_payment), 0)

  // Прогноз остатка к концу месяца (включает оставшиеся переменные до лимита)
  const projEnd = liquid + incomingTotal - pendingLoanPayments - fixedUnpaid - varLeft

  // Бонус
  const nominals = (user.nominals as Record<string,number>) ?? {}
  const clients = (month?.clients as Record<string,number>) ?? {}
  const revenue = Number(month?.revenue ?? 41666)
  const marginShare = Number(user.margin_share ?? 0.20)
  const momentShare = Number(user.moment_share ?? 0.80)
  const threshold = Number(user.threshold ?? 56000)
  const clientPot = Object.entries(clients).reduce((s,[g,n])=>s+(nominals[g]??0)*n,0)
  const pot = clientPot + revenue * marginShare
  const excess = Math.max(0, pot - threshold)
  const moment = excess * momentShare
  const bonusNet = Math.round(moment * 0.87)

  // Срок ближайшего платежа
  const upcomingPayments = (loans ?? [])
    .filter(l => l.paid_month !== monthKey)
    .map(l => {
      const due = l.due_day === 'last' ? daysInMonth : Math.min(Number(l.due_day), daysInMonth)
      const days = due - today
      return { name: l.name, due, days: days < 0 ? days + daysInMonth : days, amount: Number(l.min_payment) }
    })
    .sort((a,b) => a.days - b.days)

  const nearestPayment = upcomingPayments[0]

  const recentLines = (recentExp ?? []).map(e => `  [id:${e.id.slice(-6)}] ${e.expense_date} ${e.category}: ${rub(Number(e.amount))}${e.description?' — '+e.description:''}`).join('\n') || '  (нет)'
  const fixedLines = fixedCosts.map((f,i) => `  [idx:${i}] ${f.name}: ${rub(f.amount)} ${fixedPaid[String(i)] ? '✅ '+rub(Number(fixedPaid[String(i)])||f.amount) : '⏳'}`).join('\n')
  const goalLines = (goals ?? []).map(g => `  [id:${g.id.slice(-6)}] ${g.name}: ${rub(Number(g.amount))} ${g.month_key ? '('+g.month_key+')' : '(накопление)'}`).join('\n') || '  (нет)'
  const loanLines = (loans ?? []).map(l => {
    const total = Number(l.principal) + Number(l.accrued_int)
    const paid = l.paid_month === monthKey ? '✅ оплачен' : '⏳ ждёт'
    return `  ${l.name}: остаток ${rub(total)} @ ${(Number(l.rate)*100).toFixed(2)}% · платёж ${rub(Number(l.min_payment))} · ${paid}`
  }).join('\n')

  return `=== ФИНАНСОВЫЙ КОНТЕКСТ АЛЕКСАНДРА ===
ДАТА: ${new Date().toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}
МЕСЯЦ: ${monthKey} | СЕГОДНЯ: день ${today} из ${daysInMonth} | ДО КОНЦА: ${daysLeft} дней

=== ГОТОВЫЕ ЦИФРЫ (НЕ ПЕРЕСЧИТЫВАЙ) ===

ТЕКУЩИЙ БАЛАНС:
  Дебет Сбер: ${rub(debitSber)}
  Т-Банк: ${rub(debitTbank)}
  ИТОГО ЛИКВИДНОСТЬ: ${rub(liquid)}

ПЕРЕМЕННЫЕ ТРАТЫ (лимит установлен вручную):
  Лимит на месяц: ${rub(varBudget)}
  Потрачено: ${rub(varSpent)} (${pct(varSpent,varBudget)}%)
  Осталось: ${rub(varLeft)}
  Дневной бюджет: ${rub(dailyBudget)}/день

КЕШФЛОУ МЕСЯЦА:
  + Будущие поступления:
      Аванс ${advReceived?'УЖЕ ПОЛУЧЕН ✅':rub(advAmount)+' ⏳ '+`(15-го числа)`}
      ЗП+бонус ${eomReceived?'УЖЕ ПОЛУЧЕНЫ ✅':rub(eomAmount+bonusAmount)+' ⏳ '+`(30-го: зп ${rub(eomAmount)} + бонус ${rub(bonusAmount)})`}
      ИТОГО будет получено: ${rub(incomingTotal)}
  − Обязательные расходы:
      Кредиты (неоплаченные): ${rub(pendingLoanPayments)}
      Постоянные (неоплаченные): ${rub(fixedUnpaid)} из ${rub(fixedTotal)} всего
      Переменные до лимита: ${rub(varLeft)}
      ИТОГО к списанию: ${rub(pendingLoanPayments + fixedUnpaid + varLeft)}
  = ПРОГНОЗ ОСТАТКА К КОНЦУ МЕСЯЦА: ${rub(projEnd)}

КРЕДИТЫ (всего: ${rub(totalDebt)}, платёж/мес: ${rub(totalMonthlyPayment)}):
${loanLines}

ПОСТОЯННЫЕ ТРАТЫ (всего: ${rub(fixedTotal)}, оплачено: ${rub(fixedPaidSum)}):
${fixedLines}

ПОСЛЕДНИЕ ПЕРЕМЕННЫЕ ТРАТЫ:
${recentLines}

АКТИВНЫЕ ЦЕЛИ:
${goalLines}

СДЕЛКИ И БОНУС (МАЙ → ИЮНЬ):
  Клиенты: ${JSON.stringify(clients)}
  Выручка: ${rub(revenue)}
  Котёл: ${rub(pot)} (клиенты ${rub(clientPot)} + ${pct(marginShare*100,100)}% выручки ${rub(revenue*marginShare)})
  Порог: ${rub(threshold)} | Сверхпорог: ${rub(excess)}
  Момент: ${rub(moment)} (${pct(momentShare*100,100)}% от сверхпорога)
  Бонус на руки: ~${rub(bonusNet)} (НДФЛ 13%)

БЛИЖАЙШИЙ ПЛАТЁЖ: ${nearestPayment ? `${nearestPayment.name} через ${nearestPayment.days} дн., ${rub(nearestPayment.amount)}` : 'нет неоплаченных'}

=== НАСТРОЙКИ (можно менять) ===
  Оклад net: ${rub(salaryNet)} (gross: ${rub(Number(user.salary_gross))}, YTD: ${rub(Number(user.ytd_gross))})
  Порог: ${rub(threshold)} | Момент: ${(momentShare*100).toFixed(0)}% | Марджин: ${(marginShare*100).toFixed(0)}%
  Номиналы: г3=${nominals.g3}, г4=${nominals.g4}, г5-6=${nominals.g56}, г7-8=${nominals.g78}, г9=${nominals.g9}, г10=${nominals.g10}
  Лимит переменных: ${rub(varBudget)}`
}

// ── Системный промпт (кешируется на 5 минут) ─────────────────────────────
const SYSTEM_PROMPT = `Ты — финансовый ИИ-ассистент Александра (АТОН, продажи инвестиционных продуктов). Александр строит цифровой "второй мозг", и ты — основа его финансовой инфраструктуры.

СТИЛЬ:
- Русский язык, естественная речь как умный финансовый друг
- Структурированно с эмодзи когда уместно
- Конкретные цифры из контекста, БЕЗ собственных вычислений (всё уже посчитано)
- Максимум 3500 символов в ответе

ГЛАВНОЕ ПРАВИЛО — ПОДТВЕРЖДЕНИЯ:
Если запрос ОДНОЗНАЧНЫЙ ("потратил 800 на такси") — сразу выполняй и подтверждай результатом.
Если есть НЕОДНОЗНАЧНОСТЬ — СПРАШИВАЙ перед действием. Примеры неоднозначности:
- Странная сумма (>5000₽ на еду, нетипичная категория)
- Платёж за подписку/сервис (Claude/ChatGPT/Netflix/Spotify) → "Это разовая трата или ежемесячная подписка добавить в постоянные?"
- Упоминание контекста ("это касается X") → переспроси
- Если не уверен в категории/счёте/грейде клиента

РАСПОЗНАВАНИЕ ПОДПИСОК:
"Claude", "ChatGPT", "Cursor", "GitHub Copilot", "OpenAI API" → категория "Обучение и ИИ" в постоянных
"Netflix", "Spotify", "Apple Music", "YouTube Premium" → постоянные "Подписки"
Если оплачена существующая постоянная статья → ACTION mark_single_fixed
Если новая регулярная трата → переспроси "Добавить как новую постоянную статью?"

ОТВЕТЫ НА БЮДЖЕТНЫЕ ВОПРОСЫ:
Когда спрашивают "сколько всего/полный бюджет/кешфлоу" — используй ВСЕ цифры из секции "ГОТОВЫЕ ЦИФРЫ" контекста, структурированно по разделам: текущий баланс → поступления → выходы → прогноз остатка.

ФОРМУЛА БОНУСА (для гипотетик):
  Котёл = Σ(клиенты × номинал) + margin_share × выручка
  Сверхпорог = max(0, Котёл − Порог)
  Момент = Сверхпорог × moment_share
  НДФЛ 13% если YTD+момент ≤ 2 400 000₽, иначе 15% на сумму свыше
  Бонус на руки = Момент − НДФЛ

ДЕЙСТВИЯ (добавляй В КОНЕЦ ответа отдельной строкой, пользователю не видно):
ACTION:{"type":"add_expense","amount":N,"category":"...","description":"..."}
ACTION:{"type":"delete_expense","id":"last"}
ACTION:{"type":"add_client","grade":"g10","revenue":N}
ACTION:{"type":"add_goal","name":"...","amount":N,"month_key":null}
ACTION:{"type":"mark_goal_bought","name":"..."}
ACTION:{"type":"mark_salary","part":"advance"} или "eom"
ACTION:{"type":"mark_single_fixed","name":"Интернет"}
ACTION:{"type":"mark_fixed_paid"}
ACTION:{"type":"mark_loan_paid","name":"Кредит А"}
ACTION:{"type":"early_repay","name":"...","amount":N}
ACTION:{"type":"add_income_event","amount":N,"description":"Отпускные"}
ACTION:{"type":"set_balance","account":"sber","amount":N}
ACTION:{"type":"close_month"}
ACTION:{"type":"add_fixed_cost","name":"...","amount":N}
ACTION:{"type":"remove_fixed_cost","name":"..."}
ACTION:{"type":"edit_fixed_cost","name":"...","new_name":"...","amount":N}
ACTION:{"type":"update_settings","field":"var_budget","value":N}
ACTION:{"type":"update_settings","field":"salary_net","value":N}
ACTION:{"type":"update_settings","field":"threshold","value":N}
ACTION:{"type":"update_settings","field":"moment_share","value":0.75}
ACTION:{"type":"update_settings","field":"nominal","key":"g10","value":90000}
ACTION:{"type":"undo"}

Категории трат: Еда и кафе, Транспорт, Здоровье, Развлечения, Одежда, Инвестиции, Прочее
Грейды клиентов: g3=7200₽, g4=14400₽, g56=21600₽, g78=43200₽, g9=64000₽, g10=80000₽

ВАЖНО: если задача требует уточнения — НЕ выполняй ACTION в этом ответе, просто задай вопрос. Действие выполнишь в следующем сообщении когда получишь подтверждение.`

// ── Тип действия ──────────────────────────────────────────────────────────
interface BotAction {
  type: string
  amount?: number; category?: string; description?: string; id?: string
  grade?: string; revenue?: number; name?: string; new_name?: string; month_key?: string|null
  field?: string; key?: string; value?: number|string; account?: string; part?: string
}

// ── Выполнение действий ───────────────────────────────────────────────────
export async function executeAction(action: BotAction): Promise<void> {
  const s = db()
  const monthKey = mk()

  const snapLabel: Record<string,string> = {
    add_expense:'трата',delete_expense:'удаление',add_client:'клиент',add_goal:'цель',
    mark_goal_bought:'покупка',mark_salary:'зарплата',mark_single_fixed:'постоянная',
    mark_fixed_paid:'все постоянные',mark_loan_paid:'кредит',early_repay:'досрочное',
    add_income_event:'доход',set_balance:'баланс',close_month:'закрытие',
    update_settings:'настройки',add_fixed_cost:'+постоянная',
    remove_fixed_cost:'-постоянная',edit_fixed_cost:'правка постоянной',undo:'отмена',
  }
  if (snapLabel[action.type]) await snap(snapLabel[action.type])

  if (action.type === 'add_expense' && action.amount) {
    await s.from('expenses').insert({user_id:USER_ID,month_key:monthKey,expense_date:new Date().toISOString().split('T')[0],category:action.category??'Прочее',amount:Math.round(action.amount),description:action.description??null,source_type:'debit'})
    const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
    await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)-action.amount)*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
  }

  if (action.type === 'delete_expense') {
    let exp
    if (!action.id || action.id === 'last') {
      const { data } = await s.from('expenses').select('id,amount').eq('user_id',USER_ID).eq('month_key',monthKey).order('created_at',{ascending:false}).limit(1).maybeSingle()
      exp = data
    } else {
      const { data } = await s.from('expenses').select('id,amount').eq('user_id',USER_ID).ilike('id',`%${action.id}%`).maybeSingle()
      exp = data
    }
    if (exp) {
      await s.from('expenses').delete().eq('id',exp.id)
      const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
      await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)+Number(exp.amount))*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
    }
  }

  if (action.type === 'add_client' && action.grade) {
    const { data:month } = await s.from('months').select('clients,revenue').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
    const cur = (month?.clients as Record<string,number>) ?? {}
    const clients = {...cur, [action.grade]:(cur[action.grade]??0)+1}
    const newRev = Number(month?.revenue??41666) + (action.revenue??0)
    month ? await s.from('months').update({clients,revenue:newRev}).eq('user_id',USER_ID).eq('month_key',monthKey)
         : await s.from('months').insert({user_id:USER_ID,month_key:monthKey,clients,revenue:newRev})
  }

  if (action.type === 'add_goal' && action.name && action.amount) {
    await s.from('goals').insert({user_id:USER_ID,name:action.name,amount:Math.round(action.amount),month_key:action.month_key??null,sort_order:99})
  }

  if (action.type === 'mark_goal_bought' && action.name) {
    const { data:goal } = await s.from('goals').select('id,amount').eq('user_id',USER_ID).ilike('name',`%${action.name}%`).maybeSingle()
    if (goal) {
      await s.from('goals').update({purchased:true,purchased_at:new Date().toISOString().split('T')[0]}).eq('id',goal.id)
      const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
      await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)-Number(goal.amount))*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
    }
  }

  if (action.type === 'mark_salary') {
    const { data:u } = await s.from('users').select('debit_balance,salary_net').eq('id',USER_ID).single()
    const { data:month } = await s.from('months').select('*').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
    const net = Number(u?.salary_net??121600)
    if (action.part === 'advance') {
      const advAmt = Number(month?.salary_adv_amount??Math.round(net/2))
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
    const fc = (u?.fixed_costs as {name:string;amount:number}[]) ?? []
    const idx = fc.findIndex(f => f.name.toLowerCase().includes((action.name??'').toLowerCase()))
    if (idx >= 0) {
      const fp = (month?.fixed_paid as Record<string,number|boolean>) ?? {}
      if (!fp[String(idx)]) {
        const amount = action.amount ?? fc[idx].amount
        await s.from('months').update({fixed_paid:{...fp,[String(idx)]:amount}}).eq('user_id',USER_ID).eq('month_key',monthKey)
        await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)-amount)*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
      }
    }
  }

  if (action.type === 'mark_fixed_paid') {
    const { data:u } = await s.from('users').select('debit_balance,fixed_costs').eq('id',USER_ID).single()
    const { data:month } = await s.from('months').select('fixed_paid').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
    const fc = (u?.fixed_costs as {name:string;amount:number}[]) ?? []
    const fp = (month?.fixed_paid as Record<string,number|boolean>) ?? {}
    const newFp: Record<string,number> = {}
    let total = 0
    fc.forEach((f,i) => { if (!fp[String(i)]) { newFp[String(i)]=f.amount; total+=f.amount } })
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
      await s.from('loans').update({accrued_int:Number(loan.accrued_int)-toInt,principal:Math.max(0,Number(loan.principal)-toPrincipal),paid_month:monthKey,last_pay_principal:toPrincipal,last_pay_interest:toInt}).eq('id',loan.id)
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
    await s.from('income_events').insert({user_id:USER_ID,month_key:monthKey,event_date:new Date().toISOString().split('T')[0],event_type:'other',description:action.description??'Доход',amount:Math.round(action.amount),to_debit:true})
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

  // ── Управление постоянными ─────────────────────────────────────
  if (action.type === 'add_fixed_cost' && action.name && action.amount) {
    const { data:u } = await s.from('users').select('fixed_costs').eq('id',USER_ID).single()
    const fc = (u?.fixed_costs as {name:string;amount:number}[]) ?? []
    fc.push({name:action.name, amount:Math.round(action.amount)})
    await s.from('users').update({fixed_costs:fc}).eq('id',USER_ID)
  }

  if (action.type === 'remove_fixed_cost' && action.name) {
    const { data:u } = await s.from('users').select('fixed_costs').eq('id',USER_ID).single()
    const fc = (u?.fixed_costs as {name:string;amount:number}[]) ?? []
    const filtered = fc.filter(f => !f.name.toLowerCase().includes((action.name??'').toLowerCase()))
    await s.from('users').update({fixed_costs:filtered}).eq('id',USER_ID)
  }

  if (action.type === 'edit_fixed_cost' && action.name) {
    const { data:u } = await s.from('users').select('fixed_costs').eq('id',USER_ID).single()
    const fc = (u?.fixed_costs as {name:string;amount:number}[]) ?? []
    const idx = fc.findIndex(f => f.name.toLowerCase().includes((action.name??'').toLowerCase()))
    if (idx >= 0) {
      if (action.new_name) fc[idx].name = action.new_name
      if (action.amount) fc[idx].amount = Math.round(action.amount)
      await s.from('users').update({fixed_costs:fc}).eq('id',USER_ID)
    }
  }

  if (action.type === 'update_settings' && action.field) {
    const ALLOWED = ['salary_net','salary_gross','ytd_gross','threshold','moment_share','margin_share','var_budget']
    if (action.field === 'nominal' && action.key) {
      const { data:u } = await s.from('users').select('nominals').eq('id',USER_ID).single()
      const nominals = {...((u?.nominals as Record<string,number>)??{}), [action.key]:Number(action.value)}
      await s.from('users').update({nominals}).eq('id',USER_ID)
    } else if (ALLOWED.includes(action.field)) {
      await s.from('users').update({[action.field]:Number(action.value)}).eq('id',USER_ID)
    }
  }

  if (action.type === 'undo') {
    const { data:sn } = await s.from('undo_snapshots').select('*').eq('user_id',USER_ID).order('created_at',{ascending:false}).limit(1).maybeSingle()
    if (sn) {
      const st = sn.snapshot as Record<string,unknown>
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
      await s.from('undo_snapshots').delete().eq('id',sn.id)
    }
  }
}

// ── Парсинг + выполнение ──────────────────────────────────────────────────
async function parseAndExecute(fullReply: string, userText: string, chatId: number): Promise<string> {
  const m = fullReply.match(/^ACTION:(\{.+\})$/m)
  const reply = fullReply.replace(/^ACTION:\{.+\}$/m, '').trim()
  if (m) { try { await executeAction(JSON.parse(m[1])) } catch(e) { console.error('[action]',e) } }
  Promise.all([saveHistory(chatId,'user',userText), saveHistory(chatId,'assistant',reply)]).catch(()=>{})
  return reply
}

// ── РОУТИНГ МОДЕЛИ: Haiku для простого, Sonnet для сложного ──────────────
function routeModel(text: string): 'haiku' | 'sonnet' {
  // Sonnet для: гипотетик, длинных сообщений, сложных вопросов, изменений настроек
  const sonnetTriggers = [
    /что если|сколько бонус|посчитай|гипотет|сценари|прогноз/i,
    /повышен|изменил|поменял|пересмотр|формул|порог|номинал/i,
    /полный|весь бюджет|все цифры|подробно|анализ|почему/i,
    /\?.*\?.*\?/, // несколько вопросов в одном сообщении
  ]
  if (text.length > 300) return 'sonnet'
  if (sonnetTriggers.some(re => re.test(text))) return 'sonnet'
  return 'haiku'
}

// ── Claude API: текст с prompt caching ────────────────────────────────────
export async function processMessage(text: string, chatId: number): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return '⚠️ Добавь ANTHROPIC_API_KEY в Vercel.'

  const [context, history] = await Promise.all([getContext(), getHistory(chatId)])
  const model = routeModel(text)
  const modelId = model === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001'

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'x-api-key':apiKey,
      'anthropic-version':'2023-06-01',
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 1500,
      // Кешируем системный промпт (статичный) — 90% скидка на повторы
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: '\n\nКОНТЕКСТ (текущее состояние):\n' + context },
      ],
      messages: [
        ...history.map(h => ({ role: h.role as 'user'|'assistant', content: h.content })),
        { role: 'user', content: text }
      ]
    })
  })
  const data = await res.json()
  const raw = data.content?.[0]?.text ?? '❌ Ошибка API'
  return parseAndExecute(raw, text, chatId)
}

// ── Claude: изображения (всегда Sonnet — лучше vision) ────────────────────
export async function processImage(fileId: string, chatId: number, caption?: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return '⚠️ Нужен ANTHROPIC_API_KEY.'
  try {
    const fileRes = await fetch(`${TG}/getFile?file_id=${fileId}`)
    const { result } = await fileRes.json()
    if (!result?.file_path) return '❌ Не удалось получить файл'
    const imgRes = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${result.file_path}`)
    const buf = await imgRes.arrayBuffer()
    const base64 = Buffer.from(buf).toString('base64')
    const mime = result.file_path.endsWith('.png') ? 'image/png' : 'image/jpeg'
    const [context, history] = await Promise.all([getContext(), getHistory(chatId)])
    const userText = caption ?? 'Что на этом скрине? Если чек/расход — помоги записать (помни: подписки = постоянные!).'
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
      body: JSON.stringify({
        model:'claude-sonnet-4-6', max_tokens:1500,
        system:[
          { type:'text', text:SYSTEM_PROMPT, cache_control:{type:'ephemeral'} },
          { type:'text', text:'\n\nКОНТЕКСТ:\n'+context }
        ],
        messages:[
          ...history.map(h=>({role:h.role as 'user'|'assistant',content:h.content})),
          {role:'user',content:[{type:'image',source:{type:'base64',media_type:mime,data:base64}},{type:'text',text:userText}]}
        ]
      })
    })
    const data = await res.json()
    const raw = data.content?.[0]?.text ?? '❌ Не смог прочитать'
    return parseAndExecute(raw, `[фото: ${userText}]`, chatId)
  } catch(err) { console.error('[vision]',err); return '❌ Ошибка чтения.' }
}

// ── Утренний/недельный дайджест ────────────────────────────────────────────
export async function generateMorningBriefing(isWeekly = false): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  const context = await getContext()
  if (!apiKey) return '🌅 Доброе утро, Александр!'
  const today = new Date()
  const dateFmt = today.toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long'})
  const prompt = isWeekly
    ? `Еженедельный финансовый отчёт (воскресенье, ${dateFmt}). Структура: 1) итоги недели, 2) баланс и дневной бюджет, 3) ближайшие платежи на следующей неделе, 4) прогноз бонуса месяца, 5) что улучшить.`
    : `Краткий утренний дайджест (${dateFmt}). 1) баланс и дневной бюджет, 2) ближайшие платежи, 3) прогресс переменных, 4) один совет дня. 8-10 строк, не больше.`
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
    body:JSON.stringify({
      model: isWeekly ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001',
      max_tokens:800,
      system:[
        {type:'text',text:SYSTEM_PROMPT,cache_control:{type:'ephemeral'}},
        {type:'text',text:'\n\nКОНТЕКСТ:\n'+context}
      ],
      messages:[{role:'user',content:prompt}]
    })
  })
  const data = await res.json()
  return data.content?.[0]?.text ?? '🌅 Доброе утро!'
}

// ── Голос ─────────────────────────────────────────────────────────────────
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
    form.append('file', new Blob([buf],{type:'audio/ogg'}),'voice.ogg')
    form.append('model', groqKey ? 'whisper-large-v3-turbo' : 'whisper-1')
    form.append('language','ru')
    const whisperRes = await fetch(
      groqKey ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions',
      {method:'POST',headers:{'Authorization':`Bearer ${groqKey??openaiKey}`},body:form}
    )
    const { text } = await whisperRes.json()
    return text ?? null
  } catch { return null }
}

// ── Telegram send ──────────────────────────────────────────────────────────
export async function sendTelegram(chatId: number, text: string): Promise<void> {
  const clean = text.replace(/```[\s\S]*?```/g,'').trim()
  const chunks = splitMsg(clean, 3800)
  for (const chunk of chunks) {
    const res = await fetch(`${TG}/sendMessage`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:chatId,text:chunk,parse_mode:'Markdown',disable_web_page_preview:true})
    })
    const json = await res.json()
    if (!json.ok) {
      await fetch(`${TG}/sendMessage`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
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
