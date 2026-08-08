// ЗАПИСЬ В БД: executeAction и его помощники.
//
// ЗДЕСЬ ЖИВУТ ВСЕ ЗАЩИТЫ — не удалять и не «упрощать» без полного прогона тестов:
//  • _hypo   — сослагательные вопросы («если погасить») не исполняются как операции
//  • _hasAmt — правка данных требует суммы в сообщении пользователя,
//              иначе read-only вопрос мог спровоцировать запись
//  • DERIVED_KEYS — производные значения не пишутся в якоря (два источника правды)
//  • catch-all else — нераспознанный action.type возвращает честный отказ,
//              а не молчаливый no-op с ложным «готово»
// userText === undefined означает СИСТЕМНЫЙ вызов (cron): проверки по тексту
// неприменимы, потому что текста пользователя не было.
import { SupabaseClient } from '@supabase/supabase-js'
import { db, mk, USER_ID, annuityPaymentFor, annuityMonthsFor, monthsUntil, addMonths } from './shared'
import { invalidateCache, setWriteBlocked, setActionUnrecognized,
  setCorrectionRejected, setMemoryOutcome, textIsHypothetical, textHasAmount } from './state'
import { updateAnchors } from './core'
import { computeWorkingDays, computeVacationAdjustment } from '../calc'

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

async function appendLoanLog(s: SupabaseClient, loanName: string, event: Record<string, unknown>): Promise<void> {
  const key = `loan_log:${loanName.toLowerCase()}`
  const { data: cur } = await s.from('bot_anchors').select('value')
    .eq('user_id', USER_ID).eq('month_key', 'global').eq('key', key).maybeSingle()
  let log: Record<string, unknown>[] = []
  try { log = cur?.value ? JSON.parse(String(cur.value)) : [] } catch { log = [] }
  log.push({ date: new Date().toISOString().split('T')[0], ...event })
  if (log.length > 20) log = log.slice(-20) // храним последние 20 событий, не бесконечно
  await s.from('bot_anchors').upsert({
    user_id: USER_ID, month_key: 'global', key, value: JSON.stringify(log),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,month_key,key' })
}

export interface BotAction {
  type: string
  amount?: number; category?: string; description?: string; id?: string
  grade?: string; revenue?: number; name?: string; new_name?: string; month_key?: string|null
  field?: string; key?: string; value?: number|string; account?: string; part?: string
  principal?: number; rate?: number; min_payment?: number; end_date?: string
  days?: number; paid_amount?: number; start_date?: string; vacation_type?: string
  keyword?: string; custom_category_name?: string; monthly_limit?: number; keywords?: string[]
  bot_answered?: string; correction?: string; trigger?: string; category_name?: string
  covers_days?: number; new_category?: string
  // Sprint 6
  title?: string; priority?: number; adv_amount?: number; eom_amount?: number; bonus_amount?: number
  // Sprint 9
  formula?: string
  // Sprint 17
  actual_amount?: number
  // Sprint 19
  content?: string; importance?: number; query?: string
  // Sprint 20
  salary_net?: number; salary_gross?: number
  // Sprint 29
  confirmed?: boolean  // required for income-recording tools to prevent auto-execution
  clients?: Record<string, number>  // for update_revenue: {grade: count}
}

async function recordDebitChange(
  s: SupabaseClient,
  prevBalance: number,
  newBalance: number,
  description: string,
  sourceType: string
): Promise<void> {
  await s.from('debit_history').insert({
    user_id: USER_ID,
    amount: Math.round((newBalance - prevBalance) * 100) / 100,
    balance_after: Math.round(newBalance * 100) / 100,
    description,
    source_type: sourceType,
  }).then(() => {})
}

export async function executeAction(action: BotAction, userText?: string): Promise<void> {
  const _sys = userText === undefined
  const _hypo = !_sys && textIsHypothetical(userText)
  const _hasAmt = _sys || textHasAmount(userText)
  const s = db()
  const monthKey = mk()

  const snapLabel: Record<string,string> = {
    add_expense:'трата',delete_expense:'удаление',add_client:'клиент',add_goal:'цель',
    mark_goal_bought:'покупка',mark_salary:'зарплата',mark_single_fixed:'постоянная',
    mark_fixed_paid:'все постоянные',mark_loan_paid:'кредит',early_repay:'досрочное',pay_card_debt:'погашение карты',update_cash:'наличные',manage_recurring_income:'регулярный доход',manage_debt_owed_to_me:'долг передо мной',
    add_income_event:'доход',set_balance:'баланс',close_month:'закрытие',
    mark_recurring_received:'регулярный доход',
    update_settings:'настройки',add_fixed_cost:'+постоянная',
    remove_fixed_cost:'-постоянная',edit_fixed_cost:'правка',update_loan:'обновление кредита',undo:'отмена',
    record_vacation_pay:'отпускные', create_custom_category:'новая категория',
    add_keyword:'ключевое слово', remove_custom_category:'удал. категории',
    learn_mapping:'обучение', save_correction:'коррекция',
    reclassify_expense:'переклассификация', update_cashflow:'кешфлоу', update_revenue:'выручка',
    add_backlog_item:'бэклог', add_multiday_expense:'мультидневная трата',
    update_salary:'оклад',
  }
  if (snapLabel[action.type]) await snap(snapLabel[action.type])

  // Input validation — защита от некорректных данных
  const VALID_GRADES = ['g3','g4','g56','g78','g9','g10']
  const VALID_CATEGORIES = ['Еда и кафе','Транспорт','Здоровье','Развлечения','Одежда','Инвестиции','Обучение и ИИ','Прочее','Внеплановые','Вредные расходы']
  const VALID_SETTINGS = ['salary_net','salary_gross','ytd_gross','threshold','moment_share','margin_share','var_budget']
  function sanitizeStr(s: string | undefined, maxLen = 500): string | undefined {
    return s ? s.replace(/[<>'"]/g, '').substring(0, maxLen) : s
  }
  if (action.amount != null && (isNaN(action.amount) || action.amount < 0 || action.amount > 10_000_000)) return
  if (action.type === 'add_expense') {
    action.description = sanitizeStr(action.description)
    if (action.category && !VALID_CATEGORIES.includes(action.category)) action.category = 'Прочее'
    // AI-категоризация: fallback если категория не указана или Прочее
    if ((!action.category || action.category === 'Прочее') && action.description) {
      const desc = action.description.toLowerCase()
      // Check bot_learnings first
      const { data: mapping } = await s.from('bot_learnings').select('category').eq('user_id', USER_ID).limit(50)
      const matched = (mapping ?? []).find(m => desc.includes(String(m.category ?? '').toLowerCase()) || desc.includes((m as {trigger?:string}).trigger?.toLowerCase() ?? '~~~~'))
      if (matched?.category && VALID_CATEGORIES.includes(String(matched.category))) {
        action.category = String(matched.category)
      } else {
        const guesses: [string, string[]][] = [
          ['Еда и кафе', ['кафе','ресторан','еда','суши','пицца','бургер','кофе','чай','завтрак','обед','ужин','продукт','магазин','перекус']],
          ['Транспорт', ['такси','метро','автобус','uber','каршеринг','электричк','маршрутк']],
          ['Развлечения', ['кино','театр','концерт','клуб','билет','игр','кино']],
          ['Здоровье', ['аптек','лекарств','врач','клиник','витамин','медицин']],
          ['Одежда', ['одежда','штан','рубашк','куртк','обувь','кроссовк','футболк']],
        ]
        for (const [cat, kws] of guesses) {
          if (kws.some(kw => desc.includes(kw))) { action.category = cat; break }
        }
      }
    }
  }
  if (action.type === 'add_client' && action.grade && !VALID_GRADES.includes(action.grade)) return
  if (action.type === 'update_settings') {
    if (action.field && !VALID_SETTINGS.includes(action.field) && action.field !== 'nominal') return
    if (action.value != null && (isNaN(Number(action.value)) || !isFinite(Number(action.value)))) return
  }
  action.name = sanitizeStr(action.name) as string | undefined
  action.description = sanitizeStr(action.description)

  // ════════════ РАСХОДЫ ════════════════════════════════════════════
  if (action.type === 'add_expense' && action.amount) {
    // Антидубль: та же сумма за последние 5 минут. Описание сравниваем только
    // если оно есть — иначе ilike('') не совпадал ни с чем и дубли проходили.
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    let dupQ = s.from('expenses').select('id').eq('user_id', USER_ID)
      .eq('amount', Math.round(action.amount)).gte('created_at', fiveMinAgo)
    if (action.description) dupQ = dupQ.ilike('description', action.description)
    const { data: dupes } = await dupQ.limit(1)
    if (dupes && dupes.length > 0) { console.log('[add_expense] антидубль: пропуск'); return }

    // ИСТОЧНИК определяет, какой счёт меняется. Раньше add_expense всегда
    // списывал с дебета, а траты с карты шли отдельным инструментом —
    // из-за выбора между двумя путями бот задваивал операции.
    const src = String((action as { source?: string }).source ?? 'debit')
    const CARD_NAMES: Record<string, string> = {
      credit_tbank: 'Т-Банк', credit_sber: 'Сбер кредитка', split: 'Яндекс Сплит',
    }

    // Наличные — отдельная ветка. Без неё src='cash' попадал бы в блок карт
    // ниже (условие src !== 'debit') и ошибочно увеличивал долг Т-Банка.
    if (src === 'cash') {
      const { data: cur } = await s.from('bot_anchors').select('value')
        .eq('user_id', USER_ID).eq('key', 'cash_on_hand').eq('month_key', 'global').maybeSingle()
      const left = Math.max(0, Math.round(Number(cur?.value ?? 0)) - Math.round(action.amount))
      await s.from('bot_anchors').upsert({
        user_id: USER_ID, month_key: 'global', key: 'cash_on_hand',
        value: String(left), updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,month_key,key' })
      await s.from('expenses').insert({
        user_id: USER_ID, month_key: monthKey,
        expense_date: new Date().toISOString().split('T')[0],
        category: action.category ?? 'Прочее',
        amount: Math.round(action.amount),
        description: action.description ?? null,
        source_type: 'cash',
      })
      invalidateCache('core_state', 'context', 'fin_summary', 'loans_summary')
      return
    }

    if (src !== 'debit') {
      const cardName = CARD_NAMES[src] ?? 'Т-Банк'
      const { data: card } = await s.from('cards').select('id,current_debt')
        .eq('user_id', USER_ID).ilike('name', `%${cardName}%`).maybeSingle()
      if (card) {
        await s.from('cards').update({ current_debt: Number(card.current_debt ?? 0) + action.amount }).eq('id', card.id)
      }
      await s.from('expenses').insert({
        user_id: USER_ID, month_key: monthKey,
        expense_date: new Date().toISOString().split('T')[0],
        category: action.category ?? 'Прочее',
        amount: Math.round(action.amount),
        description: action.description ?? null,
        source_type: 'card',
      })
      // Дебет НЕ трогаем: карта — это пассив
      invalidateCache('core_state', 'context', 'fin_summary', 'loans_summary')
      return
    }

    await s.from('expenses').insert({user_id:USER_ID,month_key:monthKey,expense_date:new Date().toISOString().split('T')[0],category:action.category??'Прочее',amount:Math.round(action.amount),description:action.description??null,source_type:'debit'})
    const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
    const prevBal = Number(u?.debit_balance ?? 0)
    const newBal = Math.round((prevBal - action.amount) * 100) / 100
    // READ-AFTER-WRITE: проверяем что UPDATE применился, retry если нет
    const { error: debitErr } = await s.from('users').update({debit_balance:newBal,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
    if (debitErr) console.error('[add_expense] debit UPDATE error:', debitErr)
    const { data: verifyU } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
    if (Math.abs(Number(verifyU?.debit_balance) - newBal) > 1) {
      console.error('[add_expense] debit mismatch, retrying:', verifyU?.debit_balance, '->', newBal)
      await s.from('users').update({debit_balance:newBal,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
    }
    await recordDebitChange(s, prevBal, newBal, `Трата: ${action.description ?? action.category}`, 'expense')
    // Sprint 25: синхронизация якорей var_spent/var_left после каждой траты
    const { data: allExpSync } = await s.from('expenses').select('amount').eq('user_id', USER_ID).eq('month_key', monthKey)
    const newVarSpent = (allExpSync ?? []).reduce((sum: number, e: {amount: number}) => sum + Number(e.amount), 0)
    const { data: usrSync } = await s.from('users').select('var_budget').eq('id', USER_ID).single()
    const newVarLeft = Number(usrSync?.var_budget ?? 45000) - newVarSpent
    await s.from('bot_anchors').upsert([
      { user_id: USER_ID, key: 'var_spent', value: String(Math.round(newVarSpent)), month_key: monthKey, updated_at: new Date().toISOString() },
      { user_id: USER_ID, key: 'var_left', value: String(Math.round(newVarLeft)), month_key: monthKey, updated_at: new Date().toISOString() },
    ], { onConflict: 'user_id,month_key,key' })


  // ── РАСХОДЫ: удаление / переклассификация / мультидневные ────────────
  } else if (action.type === 'delete_expense') {
    let exp
    const isUUID = /^[0-9a-f-]{36}$/i.test(String(action.id ?? ''))
    if (!action.id || action.id === 'last') {
      const { data } = await s.from('expenses').select('id,amount,description,source_type').eq('user_id',USER_ID).eq('month_key',monthKey).order('created_at',{ascending:false}).limit(1).maybeSingle()
      exp = data
    } else if (isUUID) {
      const { data } = await s.from('expenses').select('id,amount,description,source_type').eq('user_id',USER_ID).eq('id',action.id).maybeSingle()
      exp = data
    } else {
      const { data } = await s.from('expenses').select('id,amount,description,source_type').eq('user_id',USER_ID).eq('month_key',monthKey).ilike('description',`%${action.id}%`).order('created_at',{ascending:false}).limit(1).maybeSingle()
      exp = data
    }
    if (!exp) return // Запись не найдена — бот сообщит что не нашёл
    if (exp) {
      await s.from('expenses').delete().eq('id',exp.id)
      // Трата с карты — возвращаем на карту, а не на дебет.
      // Раньше любое удаление зачисляло деньги на дебет и завышало баланс.
      // Трата наличными — возвращаем в наличные, иначе удаление завысило бы дебет
      if ((exp as { source_type?: string }).source_type === 'cash') {
        const { data: cur } = await s.from('bot_anchors').select('value')
          .eq('user_id', USER_ID).eq('key', 'cash_on_hand').eq('month_key', 'global').maybeSingle()
        await s.from('bot_anchors').upsert({
          user_id: USER_ID, month_key: 'global', key: 'cash_on_hand',
          value: String(Math.round(Number(cur?.value ?? 0)) + Number(exp.amount)),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,month_key,key' })
        invalidateCache('core_state', 'context', 'fin_summary', 'loans_summary')
        return
      }
      if ((exp as { source_type?: string }).source_type === 'card') {
        const { data: cardRow } = await s.from('cards').select('id,current_debt')
          .eq('user_id', USER_ID).gt('current_debt', 0)
          .order('current_debt', { ascending: false }).limit(1).maybeSingle()
        if (cardRow) {
          await s.from('cards').update({ current_debt: Math.max(0, Number(cardRow.current_debt) - Number(exp.amount)) }).eq('id', cardRow.id)
        }
        invalidateCache('core_state', 'context', 'fin_summary', 'loans_summary')
        return
      }
      const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
      const prevBal = Number(u?.debit_balance ?? 0)
      const newBal = Math.round((prevBal + Number(exp.amount)) * 100) / 100
      await s.from('users').update({debit_balance:newBal,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
      await recordDebitChange(s, prevBal, newBal, `Удаление траты`, 'expense_delete')
    }

  } else if (action.type === 'add_client' && action.grade) {
    const { data:month } = await s.from('months').select('clients,revenue').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
    const cur = (month?.clients as Record<string,number>) ?? {}
    const clients = {...cur, [action.grade]:(cur[action.grade]??0)+1}
    const newRev = Number(month?.revenue??41666) + (action.revenue??0)
    month ? await s.from('months').update({clients,revenue:newRev}).eq('user_id',USER_ID).eq('month_key',monthKey)
         : await s.from('months').insert({user_id:USER_ID,month_key:monthKey,clients,revenue:newRev})

  } else if (action.type === 'add_goal' && action.name && action.amount) {
    const priority = Math.min(3, Math.max(1, Math.round(Number((action as { priority?: number }).priority ?? 2))))
    await s.from('goals').insert({
      user_id: USER_ID, name: action.name, amount: Math.round(action.amount),
      month_key: action.month_key ?? null,
      target_date: (action as { target_date?: string }).target_date ?? null,
      sort_order: priority,
    })

  } else if (action.type === 'mark_goal_bought' && action.name) {
    if (_hypo) { console.log('[mark_goal_bought] ЗАБЛОКИРОВАНО: гипотетический вопрос'); setWriteBlocked('mark_goal_bought'); return }
    const { data:goal } = await s.from('goals').select('id,amount').eq('user_id',USER_ID).ilike('name',`%${action.name}%`).maybeSingle()
    if (goal) {
      await s.from('goals').update({purchased:true,purchased_at:new Date().toISOString().split('T')[0]}).eq('id',goal.id)
      const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
      await s.from('users').update({debit_balance:Math.round((Number(u?.debit_balance??0)-Number(goal.amount))*100)/100,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
    }

  } else if (action.type === 'delete_goal' && action.name) {
    // Не покупка — дебет не трогаем, просто убираем запись
    await s.from('goals').delete().eq('user_id', USER_ID).ilike('name', `%${action.name}%`)


  // ════════════ ДОХОДЫ И ЗАРПЛАТА ════════════════════════════════════
  } else if (action.type === 'mark_salary') {
    const payW = /получил|пришло|зачисли|поступило|начислили|пришла|зачислилась|перечислили/i
    if (!_sys && !payW.test(userText ?? '')) return
    const { data:u } = await s.from('users').select('debit_balance,salary_net').eq('id',USER_ID).single()
    const { data:month } = await s.from('months').select('*').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
    const net = Number(u?.salary_net??121600)
    if (action.part === 'advance') {
      const advAmt = Number(month?.salary_adv_amount??Math.round(net/2))
      const prevBal = Number(u?.debit_balance??0)
      const newBal = Math.round((prevBal+advAmt)*100)/100
      await s.from('months').update({salary_adv_received:true,salary_adv_amount:advAmt}).eq('user_id',USER_ID).eq('month_key',monthKey)
      await s.from('users').update({debit_balance:newBal,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
      await recordDebitChange(s, prevBal, newBal, `Аванс`, 'salary')
      await s.from('salary_actuals').insert({
        user_id: USER_ID, payment_type: 'advance',
        expected_amount: advAmt, actual_amount: advAmt,
        payment_date: new Date().toISOString().split('T')[0], deviation: 0,
      }).then(() => {})
    }
    if (action.part === 'eom') {
      const advAmt = Number(month?.salary_adv_amount??Math.round(net/2))
      const eomSalary = Number(month?.salary_eom_amount??net-advAmt)
      const bonusAmt = Number(month?.bonus_amount??0)
      const total = eomSalary + bonusAmt
      const prevBal = Number(u?.debit_balance??0)
      const newBal = Math.round((prevBal+total)*100)/100
      await s.from('months').update({salary_eom_received:true,salary_eom_amount:eomSalary}).eq('user_id',USER_ID).eq('month_key',monthKey)
      await s.from('users').update({debit_balance:newBal,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
      await recordDebitChange(s, prevBal, newBal, `ЗП + бонус`, 'salary')
      await s.from('salary_actuals').insert({
        user_id: USER_ID, payment_type: 'eom',
        expected_amount: total, actual_amount: total,
        payment_date: new Date().toISOString().split('T')[0], deviation: 0,
      }).then(() => {})
      // Update YTD gross
      const { data: u3 } = await s.from('users').select('salary_gross,ytd_gross').eq('id', USER_ID).single()
      const newYtd = Number(u3?.ytd_gross ?? 0) + Number(u3?.salary_gross ?? 0)
      await s.from('users').update({ ytd_gross: newYtd }).eq('id', USER_ID)
    }


  // ── постоянные расходы (quick mark) ─────────────────────────────────
  } else if (action.type === 'mark_single_fixed' && action.name) {
    const { data:u } = await s.from('users').select('debit_balance,fixed_costs').eq('id',USER_ID).single()
    const { data:month } = await s.from('months').select('fixed_paid').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
    const fc = (u?.fixed_costs as {name:string;amount:number;source?:string}[]) ?? []
    const idx = fc.findIndex(f => f.name.toLowerCase().includes((action.name??'').toLowerCase()))
    if (idx >= 0) {
      const fp = (month?.fixed_paid as Record<string,number|boolean>) ?? {}
      if (!fp[String(idx)]) {
        const amount = action.amount ?? fc[idx].amount
        const prevBal = Number(u?.debit_balance??0)
        const newBal = Math.round((prevBal - amount)*100)/100
        const newFp = {...fp,[String(idx)]:amount}
        await s.from('months').update({fixed_paid:newFp}).eq('user_id',USER_ID).eq('month_key',monthKey)
        await s.from('users').update({debit_balance:newBal,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
        await recordDebitChange(s, prevBal, newBal, `Постоянная: ${fc[idx].name}`, 'fixed')
        const totalFixed = fc.reduce((sum,f)=>sum+Number(f.amount),0)
        const paidBudget = Object.keys(newFp).reduce((sum,i)=>sum+(fc[Number(i)]?Number(fc[Number(i)].amount):0),0)
        await s.from('bot_anchors').upsert({user_id:USER_ID,month_key:monthKey,key:'fixed_unpaid',value:String(totalFixed-paidBudget),formula:`${totalFixed}-${paidBudget}`,updated_at:new Date().toISOString()},{onConflict:'user_id,month_key,key'})
      }
    }


  // ════════════ ПОСТОЯННЫЕ РАСХОДЫ ════════════════════════════════════
  } else if (action.type === 'mark_fixed_paid') {
    const { data:u } = await s.from('users').select('debit_balance,fixed_costs').eq('id',USER_ID).single()
    const { data:month } = await s.from('months').select('fixed_paid').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
    const fc = (u?.fixed_costs as {name:string;amount:number;source?:string}[]) ?? []
    const fp = (month?.fixed_paid as Record<string,number|boolean>) ?? {}
    const newFp: Record<string,number> = {}
    let totalDebit = 0  // с дебета (уменьшает debit_balance)
    let totalCard = 0   // с кредитки (НЕ уменьшает debit_balance)
    fc.forEach((f,i) => {
      if (!fp[String(i)]) {
        newFp[String(i)] = f.amount
        const isCard = f.source === 'credit_tbank' || f.source === 'credit_sber' || f.source === 'card'
        if (isCard) totalCard += f.amount
        else totalDebit += f.amount
      }
    })
    if (totalDebit + totalCard > 0) {
      await s.from('months').update({fixed_paid:{...fp,...newFp}}).eq('user_id',USER_ID).eq('month_key',monthKey)
      if (totalDebit > 0) {
        // FIX: вычитаем из дебета ТОЛЬКО дебетовые постоянные
        const prevBal = Number(u?.debit_balance??0)
        const newBal = Math.round((prevBal-totalDebit)*100)/100
        await s.from('users').update({debit_balance:newBal,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
        await recordDebitChange(s, prevBal, newBal, `Постоянные с дебета ${totalDebit}₽${totalCard>0?` | с карты ${totalCard}₽ (дебет не тронут)`:''}`, 'fixed')
      }
    }

  } else if (action.type === 'mark_fixed_paid_with_amount' && action.name) {
    const { data:u } = await s.from('users').select('debit_balance,fixed_costs').eq('id',USER_ID).single()
    const { data:month } = await s.from('months').select('fixed_paid').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
    const fc = (u?.fixed_costs as {name:string;amount:number}[]) ?? []
    const idx = fc.findIndex(f => f.name.toLowerCase().includes((action.name??'').toLowerCase()))
    if (idx >= 0) {
      const fp = (month?.fixed_paid as Record<string,number|boolean>) ?? {}
      if (!fp[String(idx)]) {
        const plannedAmount = fc[idx].amount
        const actualAmount = action.actual_amount ?? plannedAmount
        const prevBal = Number(u?.debit_balance??0)
        const newBal = Math.round((prevBal - actualAmount)*100)/100
        const newFp2 = {...fp,[String(idx)]:actualAmount}
        await s.from('months').update({fixed_paid:newFp2}).eq('user_id',USER_ID).eq('month_key',monthKey)
        await s.from('users').update({debit_balance:newBal,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
        await recordDebitChange(s, prevBal, newBal, `Постоянная: ${fc[idx].name} (план ${plannedAmount}₽, факт ${actualAmount}₽)`, 'fixed')
        const totalFixed2 = fc.reduce((sum,f)=>sum+Number(f.amount),0)
        const paidBudget2 = Object.keys(newFp2).reduce((sum,i)=>sum+(fc[Number(i)]?Number(fc[Number(i)].amount):0),0)
        await s.from('bot_anchors').upsert({user_id:USER_ID,month_key:monthKey,key:'fixed_unpaid',value:String(totalFixed2-paidBudget2),formula:`${totalFixed2}-${paidBudget2}`,updated_at:new Date().toISOString()},{onConflict:'user_id,month_key,key'})
      }
    }


  // ════════════ КРЕДИТЫ И ДОСРОЧНЫЕ ПЛАТЕЖИ ════════════════════════
  } else if (action.type === 'mark_loan_paid' && action.name) {
    if (_hypo) { console.log('[mark_loan_paid] ЗАБЛОКИРОВАНО: гипотетический вопрос'); setWriteBlocked('mark_loan_paid'); return }
    const { data:loan } = await s.from('loans').select('*').eq('user_id',USER_ID).ilike('name',`%${action.name}%`).maybeSingle()
    if (loan && loan.paid_month !== monthKey) {
      const pay = Number(loan.min_payment)
      const toInt = Math.min(pay, Number(loan.accrued_int))
      const toPrincipal = pay - toInt
      await s.from('loans').update({accrued_int:Number(loan.accrued_int)-toInt,principal:Math.max(0,Number(loan.principal)-toPrincipal),paid_month:monthKey,last_pay_principal:toPrincipal,last_pay_interest:toInt}).eq('id',loan.id)
      const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
      const prevBal = Number(u?.debit_balance??0)
      const newBal = Math.round((prevBal-pay)*100)/100
      await s.from('users').update({debit_balance:newBal,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
      await recordDebitChange(s, prevBal, newBal, `Кредит: ${loan.name}`, 'loan')
      await appendLoanLog(s, loan.name, {
        type: 'scheduled_payment', amount: pay, to_principal: toPrincipal, to_interest: toInt,
        principal_after: Math.max(0, Number(loan.principal) - toPrincipal),
      })
    }

  } else if (action.type === 'early_repay' && action.name && action.amount) {
    if (_hypo) {
      console.log('[early_repay] ЗАБЛОКИРОВАНО: вопрос сослагательный, нужен расчёт а не запись')
      setWriteBlocked('early_repay')
      return
    }
    const { data:loan } = await s.from('loans').select('*').eq('user_id',USER_ID).ilike('name',`%${action.name}%`).maybeSingle()
    if (loan) {
      // mode определяет какой параметр банк держит постоянным — это РАЗНЫЕ
      // сценарии, не приближение друг друга. Раньше платёж просто масштабировался
      // пропорционально телу — не совпадало ни с одним реальным случаем.
      const mode = (action as { mode?: string }).mode === 'reduce_payment' ? 'reduce_payment' : 'reduce_term'
      const monthlyRate = Number(loan.rate) / 12
      const oldPayment = Number(loan.min_payment)
      const newPrincipal = Math.max(0, Number(loan.principal) - action.amount)
      const monthsBefore = monthsUntil(loan.end_date as string | null) ?? annuityMonthsFor(Number(loan.principal), monthlyRate, oldPayment)

      let newPayment: number, newMonths: number
      if (mode === 'reduce_term') {
        newPayment = oldPayment
        newMonths = annuityMonthsFor(newPrincipal, monthlyRate, newPayment)
      } else {
        newMonths = monthsBefore
        newPayment = Math.round(annuityPaymentFor(newPrincipal, monthlyRate, newMonths) * 100) / 100
      }
      // 999 — сигнальное значение "платёж не покрывает проценты", не реальный
      // срок. Пропускать его в addMonths даёт дату через 80+ лет.
      const monthsSane = newMonths >= 999 ? null : newMonths
      const newEndDate = newPrincipal <= 0 ? new Date().toISOString().split('T')[0]
        : monthsSane != null ? addMonths(null, monthsSane) : loan.end_date

      await s.from('loans').update({ principal: newPrincipal, min_payment: newPayment, end_date: newEndDate }).eq('id', loan.id)
      await appendLoanLog(s, loan.name, {
        type: 'early_repay', mode, amount: action.amount,
        principal_after: newPrincipal, payment_after: newPayment, end_date_after: newEndDate,
        ...(monthsSane == null ? { warning: 'платёж не покрывает проценты — end_date не изменена, требует ручной проверки' } : {}),
      })

      const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
      const prevBal = Number(u?.debit_balance??0)
      const newBal = Math.round((prevBal-action.amount)*100)/100
      await s.from('users').update({debit_balance:newBal,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
      await recordDebitChange(s, prevBal, newBal, `Досрочное (${mode==='reduce_term'?'срок':'платёж'}): ${loan.name}`, 'loan')
    }

  } else if (action.type === 'pay_card_debt' && action.amount != null) {
    if (!_hasAmt) {
      console.log('[pay_card_debt] ЗАБЛОКИРОВАНО: нет суммы в сообщении')
      setWriteBlocked('pay_card_debt:no_amount_in_message')
      return
    }
    // Имя карты приходит в поле card (по схеме инструмента), name — запасной вариант
    const cardName = String((action as { card?: string }).card ?? action.name ?? '')
    if (!cardName) return
    const { data: card } = await s.from('cards').select('id,current_debt,name')
      .eq('user_id', USER_ID).ilike('name', `%${cardName}%`).maybeSingle()
    if (!card) return
    const cur = Number(card.current_debt ?? 0)
    const setExact = Boolean((action as { set_exact?: boolean }).set_exact)
    if (setExact) {
      // Корректировка данных: ставим точный остаток, деньги не двигаются
      await s.from('cards').update({ current_debt: Math.max(0, action.amount) }).eq('id', card.id)
    } else {
      const pay = Math.min(cur, action.amount)
      await s.from('cards').update({ current_debt: cur - pay }).eq('id', card.id)
      // Реальное погашение: деньги уходят с дебета
      const { data: u } = await s.from('users').select('debit_balance').eq('id', USER_ID).single()
      const prev = Number(u?.debit_balance ?? 0)
      const next = Math.round((prev - pay) * 100) / 100
      await s.from('users').update({ debit_balance: next, debit_updated_at: new Date().toISOString() }).eq('id', USER_ID)
      await recordDebitChange(s, prev, next, `Погашение карты: ${card.name}`, 'card_payment')
    }

  } else if (action.type === 'mark_card_payment' && action.name && action.amount) {
    const { data: card } = await s.from('cards').select('id,current_debt').eq('user_id', USER_ID).ilike('name', `%${action.name}%`).maybeSingle()
    if (card) {
      await s.from('cards').update({ current_debt: Number(card.current_debt ?? 0) + action.amount }).eq('id', card.id)
    }
    await s.from('expenses').insert({
      user_id: USER_ID, month_key: monthKey,
      expense_date: new Date().toISOString().split('T')[0],
      category: action.category ?? 'Прочее',
      description: action.description ?? `Кредитная карта: ${action.name}`,
      amount: Math.round(action.amount),
      source_type: 'card',
    })
    // debit_balance НЕ изменяется — карта это пассив
    // Sprint 25+26: синхронизация якорей cards_summary/net_position
    const { data: allCardsSync } = await s.from('cards').select('name,card_limit,current_debt').eq('user_id', USER_ID)
    const cardsSummarySync = (allCardsSync ?? []).map((c: {name:string;card_limit:number;current_debt:number}) =>
      `${c.name}: долг ${c.current_debt}₽, доступно ${c.card_limit - c.current_debt}₽`).join('. ')
    const totalCardDebtSync = (allCardsSync ?? []).reduce((sum: number, c: {current_debt:number}) => sum + Number(c.current_debt ?? 0), 0)
    const { data: uDebit } = await s.from('users').select('debit_balance').eq('id', USER_ID).single()
    const netPosSync = Math.round(Number(uDebit?.debit_balance ?? 0) - totalCardDebtSync)
    await s.from('bot_anchors').upsert([
      { user_id: USER_ID, key: 'cards_summary', value: cardsSummarySync, month_key: 'global', updated_at: new Date().toISOString() },
      { user_id: USER_ID, key: 'net_position', value: String(netPosSync), month_key: 'global', updated_at: new Date().toISOString() },
    ], { onConflict: 'user_id,month_key,key' })


  // ── доход / баланс / закрытие ────────────────────────────────────────
  } else if (action.type === 'add_income_event' && action.amount) {
    await s.from('income_events').insert({user_id:USER_ID,month_key:monthKey,event_date:new Date().toISOString().split('T')[0],event_type:'other',description:action.description??'Доход',amount:Math.round(action.amount),to_debit:true})
    const { data:u } = await s.from('users').select('debit_balance').eq('id',USER_ID).single()
    const prevBal = Number(u?.debit_balance??0)
    const newBal = Math.round((prevBal+action.amount)*100)/100
    await s.from('users').update({debit_balance:newBal,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
    await recordDebitChange(s, prevBal, newBal, action.description ?? 'Доход', 'income')

  // Получена регулярная выплата (стипендия и т.п.): зачислить + пометить чтобы не дублировать в прогнозе
  } else if (action.type === 'mark_recurring_received' && action.name) {
    const payW2 = /получил|пришло|зачисли|поступило|начислили|пришла|зачислилась|перечислили/i
    if (!_sys && !payW2.test(userText ?? '')) return
    const { data:u } = await s.from('users').select('debit_balance,recurring_incomes').eq('id',USER_ID).single()
    const recurring = (u?.recurring_incomes as {name:string;amount:number;day:number}[]) ?? []
    const item = recurring.find(r => r.name.toLowerCase().includes((action.name??'').toLowerCase()))
    const amount = action.amount ?? item?.amount ?? 0
    if (amount > 0) {
      // income_event для истории
      await s.from('income_events').insert({user_id:USER_ID,month_key:monthKey,event_date:new Date().toISOString().split('T')[0],event_type:'recurring',description:item?.name??action.name,amount:Math.round(amount),to_debit:true})
      // зачисление на дебет
      const prevBalR = Number(u?.debit_balance??0)
      const newBalR = Math.round((prevBalR+amount)*100)/100
      await s.from('users').update({debit_balance:newBalR,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
      await recordDebitChange(s, prevBalR, newBalR, action.name ?? item?.name ?? 'Регулярный доход', 'income')
      // пометка received (чтобы forecast не считал ещё раз)
      const { data:month } = await s.from('months').select('recurring_received').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
      const received = (month?.recurring_received as string[]) ?? []
      if (!received.includes(item?.name??action.name)) {
        received.push(item?.name??action.name)
        const { data:exists } = await s.from('months').select('month_key').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
        exists ? await s.from('months').update({recurring_received:received}).eq('user_id',USER_ID).eq('month_key',monthKey)
               : await s.from('months').insert({user_id:USER_ID,month_key:monthKey,recurring_received:received})
      }
    }

  } else if (action.type === 'set_balance' && action.account && action.amount != null) {
    if (!_hasAmt) {
      console.log('[set_balance] ЗАБЛОКИРОВАНО: нет суммы в сообщении пользователя')
      setWriteBlocked('set_balance:no_amount_in_message')
      return
    }
    const field = action.account === 'sber' ? 'debit_balance' : 'tbank_debit'
    const { data:uBal } = await s.from('users').select('debit_balance,tbank_debit').eq('id',USER_ID).single()
    const prevBal = Number(action.account === 'sber' ? uBal?.debit_balance : uBal?.tbank_debit ?? 0)
    await s.from('users').update({[field]:action.amount,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
    await recordDebitChange(s, prevBal, Number(action.amount), `Установка баланса (${action.account})`, 'manual')

  } else if (action.type === 'close_month') {
    await s.from('months').update({closed:true}).eq('user_id',USER_ID).eq('month_key',monthKey)

  } else if (action.type === 'add_fixed_cost' && action.name && action.amount) {
    if (!_hasAmt) {
      console.log('[add_fixed_cost] ЗАБЛОКИРОВАНО: нет суммы в сообщении пользователя')
      setWriteBlocked('add_fixed_cost:no_amount_in_message')
      return
    }
    const { data:u } = await s.from('users').select('fixed_costs').eq('id',USER_ID).single()
    const fc = (u?.fixed_costs as {name:string;amount:number}[]) ?? []
    fc.push({name:action.name, amount:Math.round(action.amount)})
    await s.from('users').update({fixed_costs:fc}).eq('id',USER_ID)
    await updateAnchors(s)

  } else if (action.type === 'remove_fixed_cost' && action.name) {
    const { data:u } = await s.from('users').select('fixed_costs').eq('id',USER_ID).single()
    const fc = (u?.fixed_costs as {name:string;amount:number}[]) ?? []
    const filtered = fc.filter(f => !f.name.toLowerCase().includes((action.name??'').toLowerCase()))
    await s.from('users').update({fixed_costs:filtered}).eq('id',USER_ID)
    await updateAnchors(s)

  } else if (action.type === 'edit_fixed_cost' && action.name) {
    // Защита нужна только если меняется СУММА — переименование без суммы
    // не может испортить деньги, блокировать его было бы лишним.
    if (action.amount && !_hasAmt) {
      console.log('[edit_fixed_cost] ЗАБЛОКИРОВАНО: меняется сумма, но её нет в сообщении пользователя')
      setWriteBlocked('edit_fixed_cost:no_amount_in_message')
      return
    }
    const { data:u } = await s.from('users').select('fixed_costs').eq('id',USER_ID).single()
    const fc = (u?.fixed_costs as {name:string;amount:number}[]) ?? []
    const idx = fc.findIndex(f => f.name.toLowerCase().includes((action.name??'').toLowerCase()))
    if (idx >= 0) {
      if (action.new_name) fc[idx].name = action.new_name
      if (action.amount) fc[idx].amount = Math.round(action.amount)
      await s.from('users').update({fixed_costs:fc}).eq('id',USER_ID)
      await updateAnchors(s)
    }

  } else if (action.type === 'set_month_payment' && action.name && action.amount != null) {
    if (!_hasAmt) {
      console.log('[set_month_payment] ЗАБЛОКИРОВАНО: нет суммы в сообщении')
      setWriteBlocked('set_month_payment:no_amount_in_message')
      return
    }
    const { data: ln } = await s.from('loans').select('name').eq('user_id', USER_ID).ilike('name', `%${action.name}%`).maybeSingle()
    if (!ln) return
    const mkTarget = action.month_key ?? monthKey
    // Регулярный min_payment НЕ трогаем — переопределение живёт отдельно и
    // действует только на указанный месяц. Раньше правка шла прямо в
    // min_payment и затиралась при следующем пересчёте графика.
    await s.from('bot_anchors').upsert({
      user_id: USER_ID, month_key: 'global',
      key: `loan_payment_override:${ln.name.toLowerCase()}:${mkTarget}`,
      value: String(Math.round(action.amount)), updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,month_key,key' })
    await appendLoanLog(s, ln.name, { type: 'month_payment_override', month: mkTarget, amount: Math.round(action.amount) })

  } else if (action.type === 'update_loan' && action.name) {
    // Дважды за сессию update_loan срабатывал БЕЗ запроса пользователя —
    // модель "синхронизировала" кредит в ответ на read-only вопрос про график.
    // Механическая защита: если в сообщении пользователя нет числа похожего
    // на сумму — это не может быть коррекцией банковских данных, блокируем.
    if (!_hasAmt) {
      console.log('[update_loan] ЗАБЛОКИРОВАНО: в сообщении пользователя нет суммы —', (userText ?? '').slice(0, 60))
      setWriteBlocked('update_loan:no_amount_in_message')
      return
    }
    const { data:loan } = await s.from('loans').select('id,name,principal').eq('user_id',USER_ID).ilike('name',`%${action.name}%`).maybeSingle()
    if (loan) {
      const upd: Record<string,unknown> = {}
      // ЗАЩИТА: тело кредита 10к–5млн (отсекаем путаницу тело/переплата)
      if (action.principal != null && action.principal >= 10000 && action.principal <= 5000000) {
        upd.principal = Math.round(action.principal)
      }
      if (action.rate != null) upd.rate = action.rate > 1 ? action.rate / 100 : action.rate
      if (action.min_payment != null && action.min_payment >= 100 && action.min_payment <= 500000) {
        upd.min_payment = Math.round(action.min_payment)
      }
      if (action.end_date) upd.end_date = action.end_date
      if (Object.keys(upd).length) {
        await s.from('loans').update(upd).eq('id', loan.id)
        await appendLoanLog(s, loan.name, {
          type: 'manual_update', fields: upd, principal_before: Number(loan.principal),
        })
        await updateAnchors(s)
      }
    }


  // ── настройки / оклад / отмена / отпускные ────────────────────────
  } else if (action.type === 'update_settings' && action.field) {
    const ALLOWED = ['salary_net','salary_gross','ytd_gross','threshold','moment_share','margin_share','var_budget']
    if (action.field === 'nominal' && action.key) {
      const { data:u } = await s.from('users').select('nominals').eq('id',USER_ID).single()
      const nominals = {...((u?.nominals as Record<string,number>)??{}), [action.key]:Number(action.value)}
      await s.from('users').update({nominals}).eq('id',USER_ID)
    } else if (ALLOWED.includes(action.field)) {
      await s.from('users').update({[action.field]:Number(action.value)}).eq('id',USER_ID)
    }

  } else if (action.type === 'update_salary' && action.salary_net != null) {
    if (!_hasAmt) {
      console.log('[update_salary] ЗАБЛОКИРОВАНО: нет суммы в сообщении пользователя')
      setWriteBlocked('update_salary:no_amount_in_message')
      return
    }
    const upd: Record<string, number> = { salary_net: Math.round(action.salary_net) }
    if (action.salary_gross != null) upd.salary_gross = Math.round(action.salary_gross)
    await s.from('users').update(upd).eq('id', USER_ID)
    await updateAnchors(s)

  } else if (action.type === 'undo') {
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

  } else if (action.type === 'record_vacation_pay' && action.days && action.paid_amount) {
    const now = new Date()
    const { data:u } = await s.from('users').select('debit_balance,salary_net').eq('id',USER_ID).single()
    const salaryNet = Number(u?.salary_net ?? 121600)
    const vacMonthStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`
    const { data: vacHols } = await s.from('ru_holidays').select('holiday_date')
      .gte('holiday_date', `${vacMonthStr}-01`).lte('holiday_date', `${vacMonthStr}-31`)
    const wdays = computeWorkingDays(now.getFullYear(), now.getMonth()+1,
      (vacHols ?? []).map((h: {holiday_date: string}) => String(h.holiday_date).slice(0,10)))
    const adj = computeVacationAdjustment(action.days, action.paid_amount, salaryNet, wdays)
    // Зачислить на дебет
    const prevBalV = Number(u?.debit_balance??0)
    const newBalV = Math.round((prevBalV+action.paid_amount)*100)/100
    await s.from('users').update({debit_balance:newBalV,debit_updated_at:new Date().toISOString()}).eq('id',USER_ID)
    await recordDebitChange(s, prevBalV, newBalV, 'Отпускные/больничный', 'income')
    // income_event — vacation_type поле (sick/vacation) передаётся в input инструмента
    const vacationType = action.vacation_type ?? 'vacation'
    // Если пользователь явно указал откуда вычитать (part='advance'|'eom') — уважаем его слова
    if (action.part === 'advance' || action.part === 'eom') adj.deductFrom = action.part as 'advance' | 'eom'
    await s.from('income_events').insert({user_id:USER_ID,month_key:monthKey,event_date:new Date().toISOString().split('T')[0],event_type:'vacation',description:`${vacationType==='sick'?'Больничный':'Отпускные'} ${action.days}д`,amount:Math.round(action.paid_amount),to_debit:true})
    // Запись корректировки в months
    const { data:month } = await s.from('months').select('salary_adjustments,salary_adv_amount,salary_eom_amount').eq('user_id',USER_ID).eq('month_key',monthKey).maybeSingle()
    const adjustments = (month?.salary_adjustments as unknown[]) ?? []
    const newAdj = {type:vacationType,days:action.days!,paid_amount:action.paid_amount!,deduct:adj.deductFromSalary,date:action.start_date??new Date().toISOString().split('T')[0],deduct_from:adj.deductFrom}
    adjustments.push(newAdj)
    const salaryNet2 = Number(u?.salary_net??121600)
    const advAmt = Number(month?.salary_adv_amount ?? Math.round(salaryNet2/2))
    const eomAmt = Number(month?.salary_eom_amount ?? salaryNet2 - advAmt)
    const updateData: Record<string,unknown> = { salary_adjustments: adjustments }
    if (adj.deductFrom === 'advance') updateData.salary_adv_amount = Math.max(0, advAmt - adj.deductFromSalary)
    else updateData.salary_eom_amount = Math.max(0, eomAmt - adj.deductFromSalary)
    month ? await s.from('months').update(updateData).eq('user_id',USER_ID).eq('month_key',monthKey)
          : await s.from('months').insert({user_id:USER_ID,month_key:monthKey,...updateData})


  // ════════════ КАТЕГОРИИ / ЯКОРЯ / ПАМЯТЬ ═════════════════════════
  } else if (action.type === 'create_custom_category' && action.name) {
    const { data:existing } = await s.from('custom_categories').select('id').eq('user_id',USER_ID).ilike('name',action.name).maybeSingle()
    if (!existing) {
      const ins: Record<string,unknown> = {user_id:USER_ID,name:action.name}
      if (action.monthly_limit != null) ins.monthly_limit = action.monthly_limit
      if (action.keywords) ins.keywords = action.keywords
      await s.from('custom_categories').insert(ins)
    }

  } else if (action.type === 'add_keyword' && action.name && action.keyword) {
    const { data:cat } = await s.from('custom_categories').select('id,keywords').eq('user_id',USER_ID).ilike('name',`%${action.name}%`).maybeSingle()
    if (cat) {
      const kws = (cat.keywords as string[]) ?? []
      if (!kws.includes(action.keyword)) {
        await s.from('custom_categories').update({keywords:[...kws,action.keyword]}).eq('id',cat.id)
      }
    }

  } else if (action.type === 'remove_custom_category' && action.name) {
    await s.from('custom_categories').delete().eq('user_id',USER_ID).ilike('name',`%${action.name}%`)

  } else if (action.type === 'learn_mapping' && action.trigger) {
    const upsertData: Record<string,unknown> = {user_id:USER_ID,trigger:action.trigger.toLowerCase()}
    if (action.category) upsertData.category = action.category
    if (action.custom_category_name) {
      const { data:cat } = await s.from('custom_categories').select('id').eq('user_id',USER_ID).ilike('name',`%${action.custom_category_name}%`).maybeSingle()
      if (cat) upsertData.custom_category_id = cat.id
    }
    await s.from('bot_learnings').upsert(upsertData,{onConflict:'user_id,trigger',ignoreDuplicates:false})

  } else if (action.type === 'save_correction' && action.correction) {
    console.log('[save_correction] called:', action.correction?.slice(0, 50))
    const text = String(action.correction)
    // ГЛАВНОЕ ПРАВИЛО: в коррекции живут ПРАВИЛА ПОВЕДЕНИЯ, а не числа.
    // Число устаревает к следующей трате и начинает противоречить БД —
    // именно так накопились 58 мёртвых коррекций с июньскими суммами.
    if (/\d{3,}/.test(text.replace(/\s/g, ''))) {
      console.log('[save_correction] ОТКЛОНЕНО: содержит суммы')
      setCorrectionRejected()
      return
    }
    const { data: recentMsgs } = await s.from('bot_messages').select('role,content,created_at').eq('user_id', USER_ID).order('created_at', {ascending: false}).limit(4)
    const msgs = (recentMsgs ?? []).reverse()
    const lastUser = msgs.filter(m => m.role === 'user').pop()
    const lastBot = msgs.filter(m => m.role === 'assistant').pop()
    const userSaid = lastUser?.content ?? '[нет сообщения]'
    const botAnswered = action.bot_answered ?? (lastBot?.content?.slice(0, 400) ?? '[нет ответа]')
    // Дедуп: не плодим одинаковые правила
    const { data: dup } = await s.from('bot_corrections')
      .select('id').eq('user_id', USER_ID).ilike('correction', `%${text.slice(0, 35)}%`).limit(1)
    if (dup?.length) { console.log('[save_correction] дубликат, пропуск'); return }
    await s.from('bot_corrections').insert({user_id:USER_ID,user_said:userSaid,bot_answered:botAnswered,correction:text,category:action.category??'rule'})

  } else if (action.type === 'reclassify_expense') {
    const monthKey2 = mk()
    let customCatId: string | null = null
    if (action.custom_category_name) {
      const { data: cat } = await s.from('custom_categories').select('id').eq('user_id', USER_ID).ilike('name', `%${action.custom_category_name}%`).maybeSingle()
      customCatId = cat?.id ?? null
    }
    if (action.keyword) {
      const { data: exps } = await s.from('expenses').select('id').eq('user_id', USER_ID).eq('month_key', monthKey2).ilike('description', `%${action.keyword}%`)
      if (exps?.length) {
        const upd: Record<string, unknown> = {}
        if (action.new_category) upd.category = action.new_category
        if (customCatId) upd.custom_category_id = customCatId
        if (Object.keys(upd).length) await s.from('expenses').update(upd).in('id', exps.map(e => e.id))
      }
      // Запомнить маппинг
      await executeAction({ type: 'learn_mapping', trigger: action.keyword.toLowerCase(), category: action.new_category, custom_category_name: action.custom_category_name })
    }

  } else if (action.type === 'update_cashflow') {
    if (!_hasAmt) {
      console.log('[update_cashflow] ЗАБЛОКИРОВАНО: нет суммы в сообщении пользователя')
      setWriteBlocked('update_cashflow:no_amount_in_message')
      return
    }
    const monthKey3 = mk()
    const upd: Record<string, unknown> = {}
    if (action.adv_amount   != null) upd.salary_adv_amount = action.adv_amount
    if (action.eom_amount   != null) upd.salary_eom_amount = action.eom_amount
    if (action.bonus_amount != null) upd.bonus_amount      = action.bonus_amount
    if (Object.keys(upd).length) {
      const { data: exists } = await s.from('months').select('month_key').eq('user_id', USER_ID).eq('month_key', monthKey3).maybeSingle()
      exists ? await s.from('months').update(upd).eq('user_id', USER_ID).eq('month_key', monthKey3)
             : await s.from('months').insert({ user_id: USER_ID, month_key: monthKey3, ...upd })
    }

  } else if (action.type === 'update_revenue') {
    if (!_hasAmt) {
      console.log('[update_revenue] ЗАБЛОКИРОВАНО: нет суммы в сообщении пользователя')
      setWriteBlocked('update_revenue:no_amount_in_message')
      return
    }
    const targetMk = action.month_key ?? (() => {
      const now = new Date(); const pm = new Date(now.getFullYear(), now.getMonth(), 1)
      pm.setMonth(pm.getMonth()-1)
      return `${pm.getFullYear()}-${String(pm.getMonth()+1).padStart(2,'0')}`
    })()
    const upd: Record<string,unknown> = {}
    if (action.revenue  != null) upd.revenue  = action.revenue
    if (action.clients  != null) upd.clients  = action.clients
    if (Object.keys(upd).length) {
      await s.from('months').upsert({ user_id:USER_ID, month_key:targetMk, ...upd },
        { onConflict:'user_id,month_key' })
      // Сбросить hardcoded bonus_amount следующего месяца → пересчитается динамически
      const [y,m] = targetMk.split('-').map(Number)
      const nextDate = new Date(y, m, 1)
      const nextMk = `${nextDate.getFullYear()}-${String(nextDate.getMonth()+1).padStart(2,'0')}`
      await s.from('months').update({ bonus_amount: null })
        .eq('user_id',USER_ID).eq('month_key',nextMk)
    }


  // ── бэклог / идеи ──────────────────────────────────────────────────
  } else if (action.type === 'add_backlog_item' && action.title) {
    await s.from('bot_backlog').insert({
      user_id: USER_ID,
      title: action.title,
      description: action.description ?? null,
      priority: action.priority ?? 2,
      category: action.category ?? 'feature',
    })

  } else if (action.type === 'add_idea' && action.description) {
    await s.from('bot_ideas').insert({
      user_id: USER_ID,
      idea: action.description,
      context: action.name ?? null,
      category: action.category ?? 'feature',
      priority: action.priority ?? 2,
    }).select()

  } else if (action.type === 'add_multiday_expense' && action.amount) {
    await s.from('expenses').insert({
      user_id: USER_ID, month_key: mk(),
      expense_date: new Date().toISOString().split('T')[0],
      category: action.category ?? 'Еда и кафе',
      amount: Math.round(action.amount),
      description: action.description ?? null,
      source_type: 'debit',
      covers_days: action.covers_days ?? 1,
    })
    const { data: u } = await s.from('users').select('debit_balance').eq('id', USER_ID).single()
    const newBal = Math.round((Number(u?.debit_balance ?? 0) - action.amount) * 100) / 100
    await s.from('users').update({ debit_balance: newBal, debit_updated_at: new Date().toISOString() }).eq('id', USER_ID)
    await recordDebitChange(s, Number(u?.debit_balance ?? 0), newBal, `Мультидневная: ${action.description ?? action.category} (${action.covers_days}д)`, 'expense')

  } else if (action.type === 'manage_recurring_income') {
    const act = String((action as { action?: string }).action ?? '')
    const nm = String(action.name ?? '').trim()
    if (!nm) return
    // add меняет сумму дохода — нужна цифра от пользователя. remove просто
    // убирает по имени, суммы не требует, читай-вопрос его не спровоцирует
    // (уже защищён тем, что имя должно совпасть с существующей записью).
    if (act === 'add' && !_hasAmt) {
      console.log('[manage_recurring_income] ЗАБЛОКИРОВАНО: нет суммы в сообщении')
      setWriteBlocked('manage_recurring_income:no_amount_in_message')
      return
    }
    const { data: uRow } = await s.from('users').select('recurring_incomes').eq('id', USER_ID).single()
    const list = (uRow?.recurring_incomes as { name: string; amount: number; day: number }[]) ?? []
    let next = list
    if (act === 'add') {
      next = [...list.filter(r => r.name.toLowerCase() !== nm.toLowerCase()),
        { name: nm, amount: Math.round(Number(action.amount ?? 0)), day: Math.round(Number((action as { day?: number }).day ?? 1)) }]
    } else if (act === 'remove') {
      next = list.filter(r => r.name.toLowerCase() !== nm.toLowerCase())
    }
    await s.from('users').update({ recurring_incomes: next }).eq('id', USER_ID)

  } else if (action.type === 'manage_debt_owed_to_me') {
    // Долг ДРУГОГО человека передо мной — зеркало loan_from_alyona, но с обратным знаком.
    // Хранится в bot_anchors: одна запись на человека, ключ owed_to_me:<имя>.
    const who = String((action as { who?: string }).who ?? '').trim()
    const act = String((action as { action?: string }).action ?? '')
    // amount == null пропускал amount=0 (0 == null это false в JS) — так
    // записались тестовые owed_to_me:тест и owed_to_me:placeholder с суммой 0.
    if (!who || !action.amount || action.amount <= 0) return
    if (!_hasAmt) {
      console.log('[manage_debt_owed_to_me] ЗАБЛОКИРОВАНО: нет суммы в сообщении')
      setWriteBlocked('manage_debt_owed_to_me:no_amount_in_message')
      return
    }
    const key = `owed_to_me:${who.toLowerCase()}`
    if (act === 'add') {
      await s.from('bot_anchors').upsert({
        user_id: USER_ID, month_key: 'global', key,
        value: String(Math.round(action.amount)), updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,month_key,key' })
    } else if (act === 'repaid') {
      const { data: cur } = await s.from('bot_anchors').select('value')
        .eq('user_id', USER_ID).eq('month_key', 'global').eq('key', key).maybeSingle()
      const left = Math.max(0, Math.round(Number(cur?.value ?? 0)) - Math.round(action.amount))
      if (left === 0) {
        await s.from('bot_anchors').delete().eq('user_id', USER_ID).eq('month_key', 'global').eq('key', key)
      } else {
        await s.from('bot_anchors').upsert({
          user_id: USER_ID, month_key: 'global', key,
          value: String(left), updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,month_key,key' })
      }
    }

  } else if (action.type === 'update_cash' && action.amount != null) {
    if (!_hasAmt) {
      console.log('[update_cash] ЗАБЛОКИРОВАНО: нет суммы в сообщении')
      setWriteBlocked('update_cash:no_amount_in_message')
      return
    }
    // Наличные хранятся в bot_anchors: это факт без собственной таблицы.
    // Производной величиной не является, поэтому запрет на якоря их не касается.
    const delta = Boolean((action as { delta?: boolean }).delta)
    let next = Math.round(action.amount)
    if (delta) {
      const { data: cur } = await s.from('bot_anchors').select('value')
        .eq('user_id', USER_ID).eq('key', 'cash_on_hand').eq('month_key', 'global').maybeSingle()
      next = Math.round(Number(cur?.value ?? 0)) + Math.round(action.amount)
    }
    await s.from('bot_anchors').upsert({
      user_id: USER_ID, month_key: 'global', key: 'cash_on_hand',
      value: String(Math.max(0, next)), updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,month_key,key' })

  } else if (action.type === 'update_anchor' && action.month_key && action.key && action.value != null) {
    // Производные значения в якорях запрещены НА ЗАПИСЬ, а не только на чтение.
    // Иначе бот заново создаёт устаревшие копии таблиц: monthly_loan_payment
    // писался как 37008 при реальных 38558 — снова два источника правды.
    const DERIVED_KEYS = new Set([
      'salary_net', 'var_budget', 'var_spent', 'var_left',
      'total_loans', 'monthly_loan_payment',
      'tbank_credit_debt', 'tbank_credit_available', 'tbank_credit_limit',
      'cards_summary', 'net_position', 'fixed_total', 'fixed_unpaid',
      'advance_normal', 'advance_actual', 'eom_salary', 'daily_rate', 'working_days',
      'forecast_end', 'forecast_after_advance',
    ])
    if (DERIVED_KEYS.has(String(action.key))) {
      console.log(`[update_anchor] отклонён производный ключ: ${action.key}`)
      setWriteBlocked('update_anchor:derived')
      return
    }
    await s.from('bot_anchors').upsert({
      user_id: USER_ID,
      month_key: action.month_key,
      key: action.key,
      value: String(action.value),
      formula: action.formula ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,month_key,key' })

  } else if (action.type === 'save_memory' && action.content) {
    const clean = sanitizeStr(action.content, 1000) ?? ''
    if (!clean) { setMemoryOutcome('empty'); return }
    // Дедуп по смыслу, а не по префиксу: сравниваем набор значимых слов.
    // Префиксный ilike(40) пропускал «Александр работает в АТОН...» ×4 —
    // варианты расходились после 40-го символа.
    const words = (t: string) => new Set(
      t.toLowerCase().replace(/ё/g, 'е')
        .split(/[^a-zа-я0-9]+/)
        .filter(w => w.length > 3)
        .map(w => w.slice(0, 5)))
    const newWords = words(clean)
    const { data: existing } = await s.from('bot_memories')
      .select('id,content').eq('user_id', USER_ID).limit(100)
    const isDup = (existing ?? []).some(m => {
      const oldWords = words(String(m.content))
      const common = [...newWords].filter(w => oldWords.has(w)).length
      const smaller = Math.min(newWords.size, oldWords.size)
      return smaller > 0 && common / smaller >= 0.7
    })
    // Флаг для handleTool: содержит ли заметка сумму. Деньги без своего поля
    // (внешний вклад, чужие акции) должны сопровождаться явным «не считается
    // в балансе» в каждом ответе — а не когда модель случайно вспомнит правило.
    setMemoryOutcome(isDup ? 'duplicate' : (/\d{3,}/.test(clean.replace(/\s/g, '')) ? 'saved_money' : 'saved'))
    if (!isDup) {
      await s.from('bot_memories').insert({
        user_id: USER_ID, content: clean,
        category: action.category ?? 'general',
        importance: Math.min(5, Math.max(1, Math.round(Number(action.importance ?? 3)))),
      })
    } else {
      console.log('[save_memory] дубликат по смыслу, пропуск')
    }
  } else {
    // Ни одна ветка не совпала — action.type не реализован. Без этого флага
    // функция молча ничего не делает, а модель получает generic "успешный"
    // ответ и вольна придумать что угодно (случай: "удали цель" при
    // отсутствующем delete_goal — бот сказал "удалена", хотя действие
    // не существовало вообще).
    console.log('[executeAction] НЕРАСПОЗНАННЫЙ action.type:', action.type)
    setActionUnrecognized(action.type)
  }
}
