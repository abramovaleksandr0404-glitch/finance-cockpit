'use client'

import { useState, useTransition } from 'react'
import { Wallet, CreditCard, ArrowRightLeft, Loader2, Check, ChevronDown } from 'lucide-react'
import { transfer } from '@/app/actions'
import { rub } from '@/lib/finance'
import BalanceEditor from './BalanceEditor'
import type { UserProfile, Card } from '@/lib/types'

interface Props {
  user: UserProfile
  cards: Card[]
}

export default function AccountsTransferWidget({ user, cards }: Props) {
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState('sber')
  const [to, setTo] = useState('tbank')
  const [amount, setAmount] = useState('')
  const [pending, startTransition] = useTransition()

  const debitAccounts = [
    { id: 'sber', label: 'Сбер дебет', balance: user.debit_balance },
    { id: 'tbank', label: 'Т-Банк дебет', balance: user.tbank_debit ?? 0 },
  ]
  const cardAccounts = cards.map((c) => ({
    id: c.id, label: c.name + ' (кредит)', limit: Number(c.card_limit),
    balance: Number(c.card_limit) - Number(c.current_debt), debt: Number(c.current_debt),
  }))

  const allAccounts = [...debitAccounts, ...cardAccounts]
  const totalLiquid = user.debit_balance + (user.tbank_debit ?? 0)
  // Net position: дебет (Сбер) минус совокупный долг по кредитным картам
  const totalDebt = cards.reduce((s, c) => s + Number(c.current_debt), 0)
  const netPosition = Number(user.debit_balance) - totalDebt

  function doTransfer() {
    const amt = parseFloat(amount)
    if (isNaN(amt) || amt <= 0) return
    startTransition(async () => {
      await transfer(from, to, amt)
      setAmount(''); setOpen(false)
    })
  }

  return (
    <div className="card overflow-hidden">
      {/* Header + total */}
      <div className="p-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2">
          <Wallet size={14} style={{ color: 'var(--accent-green)' }} />
          <span className="text-sm font-medium">Счета</span>
        </div>
        <div className="text-right">
          <div className="text-base font-bold" style={{ color: 'var(--accent-green)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
            {rub(totalLiquid)}
          </div>
          <div className="label">ликвидность</div>
          {totalDebt > 0 && (
            <div className="label" style={{ marginTop: '2px', whiteSpace: 'nowrap', color: netPosition >= 0 ? 'var(--accent-cyan)' : 'var(--accent-red)' }}>
              Чистая: {rub(netPosition)} (дебет − долг карты)
            </div>
          )}
        </div>
      </div>

      <div className="p-4 flex flex-col gap-3">
        {/* Debit accounts */}
        {debitAccounts.map((a) => (
          <div key={a.id} className="flex items-center justify-between py-2 px-3 rounded-lg"
            style={{ background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.15)' }}>
            <span className="text-sm">{a.label}</span>
            <BalanceEditor currentBalance={a.balance} kind={a.id as 'sber' | 'tbank'} />
          </div>
        ))}

        {/* Credit cards */}
        {cardAccounts.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="label">Кредитные карты</div>
            {cardAccounts.map((a) => (
              <div key={a.id} className="flex items-center justify-between py-2 px-3 rounded-lg"
                style={{ background: 'rgba(6,182,212,0.04)', border: '1px solid var(--border)' }}>
                <div className="flex items-center gap-1.5">
                  <CreditCard size={11} style={{ color: 'var(--tx-dim)' }} />
                  <span className="text-sm">{cards.find((c) => c.id === a.id)?.name}</span>
                </div>
                <div className="text-right" style={{ fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
                  {a.debt > 0
                    ? <>
                        <span className="text-xs font-semibold" style={{ color: 'var(--accent-red)' }}>долг {rub(a.debt)}</span>
                        <div className="label">лимит {rub(a.limit, { compact: true })} · доступно {rub(a.balance, { compact: true })}</div>
                      </>
                    : <span className="text-xs" style={{ color: 'var(--accent-cyan)' }}>доступно {rub(a.balance, { compact: true })}</span>
                  }
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Transfer button */}
        <button onClick={() => setOpen((v) => !v)}
          className="flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all"
          style={{ background: open ? 'var(--bg-hover)' : 'rgba(59,130,246,0.08)', border: `1px solid ${open ? 'var(--border)' : 'rgba(59,130,246,0.25)'}`, color: open ? 'var(--tx-muted)' : 'var(--accent-blue)', cursor: 'pointer' }}>
          {open ? <ChevronDown size={14} /> : <ArrowRightLeft size={14} />}
          {open ? 'Закрыть' : 'Перевести / Пополнить / Погасить'}
        </button>

        {/* Transfer form */}
        {open && (
          <div className="rounded-lg p-3 flex flex-col gap-3 animate-slide-up"
            style={{ background: 'var(--bg-hover)', border: '1px solid var(--border-bright)' }}>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="label mb-1">Откуда</div>
                <select value={from} onChange={(e) => setFrom(e.target.value)} className="input-base" style={{ fontSize: '13px' }}>
                  {allAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </div>
              <div>
                <div className="label mb-1">Куда</div>
                <select value={to} onChange={(e) => setTo(e.target.value)} className="input-base" style={{ fontSize: '13px' }}>
                  {allAccounts.filter((a) => a.id !== from).map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </div>
            </div>
            <div>
              <div className="label mb-1">Сумма ₽</div>
              <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)}
                placeholder="0" className="input-base" style={{ fontFamily: 'JetBrains Mono, monospace' }} />
            </div>
            {from !== to && parseFloat(amount) > 0 && (
              <div className="label text-center">
                {allAccounts.find((a) => a.id === from)?.label} → {allAccounts.find((a) => a.id === to)?.label}: {rub(parseFloat(amount))}
              </div>
            )}
            <button onClick={doTransfer} disabled={pending || from === to || !amount} className="btn-primary flex items-center justify-center gap-2">
              {pending ? <><Loader2 size={13} className="animate-spin" /> …</> : <><Check size={13} /> Выполнить</>}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
