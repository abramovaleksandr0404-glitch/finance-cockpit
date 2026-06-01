'use client'

import { useState, useTransition } from 'react'
import { TrendingUp, LogOut, User, Undo2, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { monthLabel } from '@/lib/finance'
import { undoLastAction } from '@/app/actions'

interface HeaderProps {
  email: string | null
  monthKey: string
}

export default function Header({ email, monthKey }: HeaderProps) {
  const router = useRouter()
  const supabase = createClient()
  const [pending, startTransition] = useTransition()
  const [toast, setToast] = useState<string | null>(null)

  async function signOut() {
    await supabase.auth.signOut()
    router.push('/auth')
    router.refresh()
  }

  function undo() {
    startTransition(async () => {
      const r = await undoLastAction()
      if (r?.error) setToast(r.error)
      else if (r && 'description' in r) setToast('Отменено: ' + r.description)
      router.refresh()
      setTimeout(() => setToast(null), 3500)
    })
  }

  return (
    <header
      className="sticky top-0 z-30 flex items-center justify-between px-6 py-3"
      style={{
        background: 'rgba(8,12,20,0.92)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {/* Logo */}
      <div className="flex items-center gap-3">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ background: 'linear-gradient(135deg, #1d4ed8, #3b82f6)' }}
        >
          <TrendingUp size={16} color="white" strokeWidth={2.5} />
        </div>
        <div>
          <div className="text-sm font-semibold leading-none" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>
            Finance Cockpit
          </div>
          <div className="label mt-0.5">{monthLabel(monthKey)}</div>
        </div>
      </div>

      {/* Right side */}
      <div className="flex items-center gap-3">
        {/* Undo */}
        <button
          onClick={undo}
          disabled={pending}
          title="Отменить последнее действие"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-all"
          style={{ color: 'var(--accent-amber)', background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.25)', cursor: pending ? 'wait' : 'pointer' }}
        >
          {pending ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
          <span className="hidden sm:inline">Отменить</span>
        </button>

        {/* User */}
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full flex items-center justify-center"
            style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)' }}>
            <User size={12} style={{ color: 'var(--tx-muted)' }} />
          </div>
          <span className="hidden sm:block text-xs" style={{ color: 'var(--tx-muted)' }}>
            {email?.split('@')[0]}
          </span>
        </div>

        {/* Sign out */}
        <button
          onClick={signOut}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-all"
          style={{ color: 'var(--tx-muted)', background: 'transparent', border: '1px solid transparent' }}
        >
          <LogOut size={12} />
          <span className="hidden sm:inline">Выйти</span>
        </button>
      </div>

      {/* Undo toast */}
      {toast && (
        <div className="fixed left-1/2 bottom-6 z-50 px-4 py-2 rounded-lg text-sm animate-slide-up"
          style={{ transform: 'translateX(-50%)', background: 'var(--bg-card)', border: '1px solid var(--accent-amber)', color: 'var(--tx-primary)', boxShadow: '0 8px 30px rgba(0,0,0,0.4)' }}>
          {toast}
        </div>
      )}
    </header>
  )
}
