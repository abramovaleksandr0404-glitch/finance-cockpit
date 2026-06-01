'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { TrendingUp, Lock, Mail, Eye, EyeOff, AlertCircle, ArrowRight } from 'lucide-react'

type Mode = 'signin' | 'signup' | 'magic'

export default function AuthForm() {
  const router = useRouter()
  const supabase = createClient()

  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    setLoading(true)

    try {
      if (mode === 'magic') {
        const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || window.location.origin
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: {
            emailRedirectTo: `${siteUrl}/auth/callback`,
          },
        })
        if (error) throw error
        setSuccess('Ссылка для входа отправлена на вашу почту')
      } else if (mode === 'signup') {
        const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || window.location.origin
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${siteUrl}/auth/callback`,
          },
        })
        if (error) throw error
        setSuccess('Аккаунт создан! Проверьте почту для подтверждения.')
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        router.push('/dashboard')
        router.refresh()
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Что-то пошло не так'
      if (msg.includes('Invalid login credentials')) {
        setError('Неверный email или пароль')
      } else if (msg.includes('User already registered')) {
        setError('Этот email уже зарегистрирован')
      } else if (msg.includes('Password should be')) {
        setError('Пароль должен быть не менее 6 символов')
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4">
      {/* Logo */}
      <div className="mb-10 flex flex-col items-center gap-3 animate-fade-in">
        <div className="w-14 h-14 rounded-2xl flex items-center justify-center"
          style={{ background: 'linear-gradient(135deg, #1d4ed8, #3b82f6)', boxShadow: '0 0 32px rgba(59,130,246,0.3)' }}>
          <TrendingUp size={28} color="white" strokeWidth={2} />
        </div>
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>
            Finance Cockpit
          </h1>
          <p className="text-xs mt-1" style={{ color: 'var(--tx-muted)' }}>
            personal financial command center
          </p>
        </div>
      </div>

      {/* Card */}
      <div className="w-full max-w-sm card p-6 animate-slide-up" style={{ animationDelay: '0.1s' }}>
        {/* Mode tabs */}
        <div className="flex gap-1 mb-6 p-1 rounded-md" style={{ background: 'var(--bg-base)' }}>
          {(['signin', 'signup', 'magic'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setError(null); setSuccess(null) }}
              className="flex-1 py-1.5 rounded text-xs font-medium transition-all"
              style={{
                background: mode === m ? 'var(--bg-hover)' : 'transparent',
                color: mode === m ? 'var(--tx-primary)' : 'var(--tx-muted)',
                border: mode === m ? '1px solid var(--border-bright)' : '1px solid transparent',
              }}
            >
              {m === 'signin' ? 'Вход' : m === 'signup' ? 'Регистрация' : 'Magic link'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Email */}
          <div>
            <label className="label block mb-1.5">Email</label>
            <div className="relative">
              <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--tx-muted)' }} />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input-base pl-8"
                placeholder="you@example.com"
                required
                autoComplete="email"
              />
            </div>
          </div>

          {/* Password (not for magic link) */}
          {mode !== 'magic' && (
            <div>
              <label className="label block mb-1.5">Пароль</label>
              <div className="relative">
                <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--tx-muted)' }} />
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input-base pl-8 pr-10"
                  placeholder="••••••••"
                  required
                  minLength={6}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                />
                <button
                  type="button"
                  onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2"
                  style={{ color: 'var(--tx-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
                >
                  {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
          )}

          {/* Error / Success */}
          {error && (
            <div className="flex items-center gap-2 text-xs p-3 rounded-md"
              style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#ef4444' }}>
              <AlertCircle size={12} />
              {error}
            </div>
          )}
          {success && (
            <div className="flex items-center gap-2 text-xs p-3 rounded-md"
              style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', color: '#22c55e' }}>
              ✓ {success}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn-primary flex items-center justify-center gap-2"
          >
            {loading ? (
              <span className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
            ) : (
              <>
                {mode === 'signin' ? 'Войти' : mode === 'signup' ? 'Создать аккаунт' : 'Отправить ссылку'}
                <ArrowRight size={14} />
              </>
            )}
          </button>
        </form>
      </div>

      {/* Footer */}
      <p className="mt-6 text-xs animate-fade-in" style={{ color: 'var(--tx-dim)', animationDelay: '0.2s' }}>
        Personal use · Data secured by Supabase RLS
      </p>
    </div>
  )
}
