'use client'

import { useState, useTransition } from 'react'
import { Banknote, Pencil, Loader2, Check, X, Plus, Gift, Trash2 } from 'lucide-react'
import { editSalaryAmounts, addIncomeEvent, deleteIncomeEvent } from '@/app/actions'
import { rub, calcIncome } from '@/lib/finance'
import type { DashboardData } from '@/lib/types'

const EVENT_TYPES = [
  { key: 'vacation', label: 'Отпускные' },
  { key: 'sick', label: 'Больничные' },
  { key: 'bonus', label: 'Премия' },
  { key: 'other', label: 'Прочее' },
]

export default function SalaryPanel({ data, monthKey }: { data: DashboardData; monthKey: string }) {
  const inc = calcIncome(data, monthKey)
  const month = data.allMonths.find((m) => m.month_key === monthKey) ?? null
  const advReceived = month?.salary_adv_received ?? false
  const eomReceived = month?.salary_eom_received ?? false

  return (
    <div className="card p-5 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Banknote size={14} style={{ color: 'var(--accent-green)' }} />
        <span className="text-sm font-medium">Зарплата</span>
        <span className="label">{inc.totalWorkdays} раб. дней</span>
      </div>

      <SalaryLine
        label={`Аванс · ${inc.advDay} числа`}
        amount={inc.advance}
        received={advReceived}
        disabled={advReceived}
        onSave={(v) => editSalaryAmounts(monthKey, v, null, null)}
      />
      <SalaryLine
        label={`Зарплата · ${inc.eomDay} числа`}
        amount={inc.second}
        received={eomReceived}
        disabled={eomReceived}
        onSave={(v) => editSalaryAmounts(monthKey, null, v, null)}
      />

      <div className="label" style={{ marginTop: '-2px' }}>
        правь суммы при отпуске/больничном, отмечай получение в кешфлоу выше
      </div>

      {/* Unplanned income */}
      <UnplannedIncome monthKey={monthKey} events={data.incomeEvents} />
    </div>
  )
}

function SalaryLine({
  label, amount, received, disabled, onSave,
}: {
  label: string
  amount: number
  received: boolean
  disabled: boolean
  onSave: (v: number) => Promise<{ error?: string } | { success: boolean }>
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(amount)
  const [pending, startTransition] = useTransition()

  function save() {
    setEditing(false)
    if (val !== amount && val > 0) startTransition(async () => { await onSave(val) })
  }

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-md"
      style={{ background: received ? 'rgba(34,197,94,0.05)' : 'var(--bg-hover)', border: '1px solid var(--border)' }}>
      <span className="text-sm" style={{ opacity: received ? 0.7 : 1 }}>
        {received && '✓ '}{label}
      </span>
      {editing ? (
        <div className="flex items-center gap-1">
          <input type="number" value={val} autoFocus onChange={(e) => setVal(parseInt(e.target.value, 10) || 0)}
            onBlur={save} onKeyDown={(e) => e.key === 'Enter' && save()}
            className="w-24 text-right text-sm" style={{ background: 'var(--bg-base)', border: '1px solid var(--accent-green)', borderRadius: '4px', padding: '2px 6px', color: 'var(--tx-primary)', fontFamily: 'JetBrains Mono, monospace', outline: 'none' }} />
        </div>
      ) : (
        <button onClick={() => !disabled && setEditing(true)} disabled={disabled}
          className="flex items-center gap-1 text-sm font-semibold"
          style={{ color: received ? 'var(--accent-green)' : 'var(--tx-primary)', fontFamily: 'JetBrains Mono, monospace', background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', whiteSpace: 'nowrap' }}>
          {pending ? <Loader2 size={11} className="animate-spin" /> : rub(amount)}
          {!disabled && <Pencil size={9} style={{ color: 'var(--tx-dim)' }} />}
        </button>
      )}
    </div>
  )
}

function UnplannedIncome({ monthKey, events }: { monthKey: string; events: DashboardData['incomeEvents'] }) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [type, setType] = useState('vacation')
  const [amount, setAmount] = useState('')
  const [desc, setDesc] = useState('')

  function add() {
    const a = parseFloat(amount)
    if (isNaN(a) || a <= 0) return
    const fd = new FormData()
    fd.set('month_key', monthKey)
    fd.set('event_type', type)
    fd.set('description', desc || EVENT_TYPES.find((t) => t.key === type)?.label || 'Доход')
    fd.set('amount', String(a))
    fd.set('to_debit', 'true')
    startTransition(async () => {
      await addIncomeEvent(fd)
      setAmount(''); setDesc(''); setOpen(false)
    })
  }
  function remove(id: string) {
    startTransition(async () => { await deleteIncomeEvent(id) })
  }

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
      {/* existing events */}
      {events.length > 0 && (
        <div className="flex flex-col gap-1.5 mb-2">
          {events.map((e) => (
            <div key={e.id} className="flex items-center gap-2 py-1.5 px-2 rounded-md" style={{ background: 'rgba(34,197,94,0.05)' }}>
              <Gift size={11} style={{ color: 'var(--accent-green)' }} />
              <span className="text-xs flex-1 truncate">{e.description}</span>
              <span className="text-xs font-semibold" style={{ color: 'var(--accent-green)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>+{rub(e.amount)}</span>
              <button onClick={() => remove(e.id)} className="opacity-40 hover:opacity-100" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                <Trash2 size={11} style={{ color: 'var(--accent-red)' }} />
              </button>
            </div>
          ))}
        </div>
      )}

      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 text-xs"
        style={{ color: open ? 'var(--accent-red)' : 'var(--tx-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>
        {open ? <X size={11} /> : <Plus size={11} />}
        {open ? 'отмена' : 'внеплановый доход (отпускные, больничные, премия)'}
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-2 animate-slide-up">
          <div className="grid grid-cols-2 gap-1.5">
            {EVENT_TYPES.map((t) => (
              <button key={t.key} onClick={() => setType(t.key)} className="text-xs py-1.5 rounded-md"
                style={{ background: type === t.key ? 'rgba(34,197,94,0.15)' : 'var(--bg-base)', border: `1px solid ${type === t.key ? 'var(--accent-green)' : 'var(--border)'}`, color: type === t.key ? 'var(--accent-green)' : 'var(--tx-muted)' }}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1.5">
            <input type="text" value={desc} placeholder="комментарий" onChange={(e) => setDesc(e.target.value)}
              className="input-base flex-1" style={{ fontSize: '13px' }} />
            <input type="number" value={amount} placeholder="₽" onChange={(e) => setAmount(e.target.value)}
              className="input-base w-24" style={{ fontSize: '13px', fontFamily: 'JetBrains Mono, monospace' }} />
            <button onClick={add} disabled={pending} className="px-2.5 rounded-md flex items-center"
              style={{ background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)', cursor: 'pointer' }}>
              {pending ? <Loader2 size={13} className="animate-spin" style={{ color: 'var(--accent-green)' }} /> : <Check size={13} style={{ color: 'var(--accent-green)' }} />}
            </button>
          </div>
          <span className="label">сумма прибавится к дебету и доходу месяца. при отпуске урежь оклад выше на соответствующую сумму</span>
        </div>
      )}
    </div>
  )
}
