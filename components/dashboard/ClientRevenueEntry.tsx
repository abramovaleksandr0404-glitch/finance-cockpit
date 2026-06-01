'use client'

import { useState, useTransition } from 'react'
import { Plus, Minus, X, Loader2, Check } from 'lucide-react'
import { updateClients, updateRevenue } from '@/app/actions'

const GRADES = [
  { key: 'g3', label: 'Гр3' }, { key: 'g4', label: 'Гр4' }, { key: 'g56', label: 'Гр5-6' },
  { key: 'g78', label: 'Гр7-8' }, { key: 'g9', label: 'Гр9' }, { key: 'g10', label: 'Гр10' },
]

export default function ClientRevenueEntry({
  monthKey, currentClients, currentRevenue,
}: {
  monthKey: string
  currentClients: Record<string, number>
  currentRevenue: number
}) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'add' | 'remove'>('add')
  const [pending, startTransition] = useTransition()
  const [grade, setGrade] = useState('g3')
  const [dealRevenue, setDealRevenue] = useState('')
  const [changeClient, setChangeClient] = useState(true)

  function apply() {
    startTransition(async () => {
      const sign = mode === 'add' ? 1 : -1
      if (changeClient) {
        const cur = currentClients[grade] || 0
        const next = { ...currentClients, [grade]: Math.max(0, cur + sign) }
        if (next[grade] === 0) delete next[grade]
        await updateClients(monthKey, next)
      }
      const amt = parseFloat(dealRevenue)
      if (!isNaN(amt) && amt > 0) {
        await updateRevenue(monthKey, Math.max(0, currentRevenue + sign * amt))
      }
      setDealRevenue(''); setOpen(false)
    })
  }

  const accent = mode === 'add' ? 'var(--accent-cyan)' : 'var(--accent-red)'

  return (
    <div>
      <button onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-all w-full justify-center"
        style={{ background: open ? 'var(--bg-hover)' : 'rgba(6,182,212,0.08)', border: `1px solid ${open ? 'var(--border)' : 'rgba(6,182,212,0.25)'}`, color: open ? 'var(--tx-muted)' : 'var(--accent-cyan)' }}>
        {open ? <X size={12} /> : <Plus size={12} />}
        {open ? 'Закрыть' : 'Клиенты и выручка'}
      </button>

      {open && (
        <div className="mt-3 rounded-lg p-3 flex flex-col gap-3 animate-slide-up"
          style={{ background: 'var(--bg-hover)', border: '1px solid var(--border-bright)' }}>
          {/* Add / Remove toggle */}
          <div className="grid grid-cols-2 gap-1.5">
            <button onClick={() => setMode('add')} className="flex items-center justify-center gap-1 text-xs py-1.5 rounded-md"
              style={{ background: mode === 'add' ? 'rgba(6,182,212,0.15)' : 'var(--bg-base)', border: `1px solid ${mode === 'add' ? 'var(--accent-cyan)' : 'var(--border)'}`, color: mode === 'add' ? 'var(--accent-cyan)' : 'var(--tx-muted)' }}>
              <Plus size={11} /> Добавить
            </button>
            <button onClick={() => setMode('remove')} className="flex items-center justify-center gap-1 text-xs py-1.5 rounded-md"
              style={{ background: mode === 'remove' ? 'rgba(239,68,68,0.12)' : 'var(--bg-base)', border: `1px solid ${mode === 'remove' ? 'var(--accent-red)' : 'var(--border)'}`, color: mode === 'remove' ? 'var(--accent-red)' : 'var(--tx-muted)' }}>
              <Minus size={11} /> Убрать (мисклик)
            </button>
          </div>

          {/* Client grade toggle */}
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={changeClient} onChange={(e) => setChangeClient(e.target.checked)} id="cc" />
            <label htmlFor="cc" className="label">{mode === 'add' ? 'засчитать' : 'убрать'} клиента грейда:</label>
          </div>
          {changeClient && (
            <div className="grid grid-cols-3 gap-1.5">
              {GRADES.map((g) => (
                <button key={g.key} onClick={() => setGrade(g.key)} className="text-xs py-1.5 rounded-md"
                  style={{ background: grade === g.key ? `${accent}26` : 'var(--bg-base)', border: `1px solid ${grade === g.key ? accent : 'var(--border)'}`, color: grade === g.key ? accent : 'var(--tx-muted)' }}>
                  {g.label} {currentClients[g.key] ? `(${currentClients[g.key]})` : ''}
                </button>
              ))}
            </div>
          )}

          <div>
            <label className="label block mb-1">Выручка по сделке ₽ ({mode === 'add' ? 'плюс' : 'минус'} к месяцу)</label>
            <input type="number" value={dealRevenue} onChange={(e) => setDealRevenue(e.target.value)}
              placeholder="можно оставить пустым" className="input-base" style={{ fontFamily: 'JetBrains Mono, monospace' }} />
          </div>

          <button onClick={apply} disabled={pending} className="btn-primary flex items-center justify-center gap-2"
            style={mode === 'remove' ? { background: 'var(--accent-red)' } : undefined}>
            {pending ? <><Loader2 size={13} className="animate-spin" /> …</> : <><Check size={13} /> {mode === 'add' ? 'Засчитать' : 'Убрать'}</>}
          </button>
          <span className="label">любое действие можно откатить кнопкой «Отменить» вверху</span>
        </div>
      )}
    </div>
  )
}
