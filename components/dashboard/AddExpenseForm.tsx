'use client'

import { useState, useRef, useTransition } from 'react'
import { Plus, X, Loader2 } from 'lucide-react'
import { addExpense } from '@/app/actions'
import type { Card } from '@/lib/types'

const CATEGORIES = [
  'Такси', 'Продукты', 'Фастфуд', 'Кафе и рестораны',
  'Транспорт', 'Витамины и здоровье', 'Одежда', 'Красота',
  'Развлечения', 'Прочее',
]

export default function AddExpenseForm({ monthKey, cards }: { monthKey: string; cards: Card[] }) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)

  function handleSubmit(formData: FormData) {
    setError(null)
    startTransition(async () => {
      const result = await addExpense(formData)
      if (result?.error) {
        setError(result.error)
      } else {
        formRef.current?.reset()
        setOpen(false)
      }
    })
  }

  return (
    <div>
      {/* Toggle button */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
        style={{
          background: open ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.08)',
          border: `1px solid ${open ? 'rgba(239,68,68,0.25)' : 'rgba(34,197,94,0.25)'}`,
          color: open ? 'var(--accent-red)' : 'var(--accent-green)',
        }}
      >
        {open ? <X size={12} /> : <Plus size={12} />}
        {open ? 'Отмена' : 'Добавить'}
      </button>

      {/* Slide-down form */}
      {open && (
        <div
          className="mt-3 rounded-lg p-4 animate-slide-up"
          style={{ background: 'var(--bg-hover)', border: '1px solid var(--border-bright)' }}
        >
          <form ref={formRef} action={handleSubmit} className="flex flex-col gap-3">
            <input type="hidden" name="month_key" value={monthKey} />
            {/* Amount + Category row */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label block mb-1">Сумма ₽</label>
                <input
                  name="amount"
                  type="number"
                  min="1"
                  placeholder="1500"
                  required
                  className="input-base mono"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                />
              </div>
              <div>
                <label className="label block mb-1">Категория</label>
                <select name="category" required className="input-base" defaultValue="">
                  <option value="" disabled>Выбрать…</option>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Description + Source row */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label block mb-1">Описание</label>
                <input
                  name="description"
                  type="text"
                  placeholder="Необязательно"
                  className="input-base"
                />
              </div>
              <div>
                <label className="label block mb-1">Источник</label>
                <select name="source_type" className="input-base" defaultValue="debit">
                  <option value="debit">Сбер дебет</option>
                  <option value="tbank_debit">Т-Банк дебет</option>
                  {cards.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} (кредит)</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Date */}
            <div>
              <label className="label block mb-1">Дата</label>
              <input
                name="expense_date"
                type="date"
                defaultValue={new Date().toISOString().split('T')[0]}
                className="input-base"
              />
            </div>

            {/* Error */}
            {error && (
              <div className="text-xs p-2 rounded" style={{ background: 'rgba(239,68,68,0.08)', color: 'var(--accent-red)' }}>
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={pending}
              className="btn-primary flex items-center justify-center gap-2"
            >
              {pending ? (
                <><Loader2 size={13} className="animate-spin" /> Сохранение…</>
              ) : (
                <><Plus size={13} /> Записать расход</>
              )}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
