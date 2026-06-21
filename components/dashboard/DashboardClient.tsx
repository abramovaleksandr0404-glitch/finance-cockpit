'use client'

import { useState, useTransition, useCallback } from 'react'
import {
  Home, TrendingUp, Receipt, Landmark, Target,
  ChevronLeft, ChevronRight, Undo2, Loader2,
} from 'lucide-react'
import { useRouter } from 'next/navigation'

import StatsBar from './StatsBar'
import CashflowWaterfall from './CashflowWaterfall'
import MonthCloseCard from './MonthCloseCard'
import AnalyticsPanel from './AnalyticsPanel'
import SalaryPanel from './SalaryPanel'
import IncomeWidget from './IncomeWidget'
import ExpensesWidget from './ExpensesWidget'
import FixedCostsWidget from './FixedCostsWidget'
import LoansWidget from './LoansWidget'
import DebtChartWidget from './DebtChartWidget'
import AccountsTransferWidget from './AccountsTransferWidget'
import GoalsWidget from './GoalsWidget'
import FinancialHealthCard from './FinancialHealthCard'
import ChartsWidget from './ChartsWidget'
import BalanceHistoryChart from './BalanceHistoryChart'
import HarmfulExpensesWidget from './HarmfulExpensesWidget'
import ThemeToggle from './ThemeToggle'

import { undoLastAction } from '@/app/actions'
import { monthLabel, currentMonthKey } from '@/lib/finance'
import { prevMonthKey } from '@/lib/engine'
import type { DashboardData } from '@/lib/types'

type Tab = 'main' | 'income' | 'expenses' | 'loans' | 'goals'

const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: 'main',     label: 'Главная',  icon: <Home size={20} /> },
  { key: 'income',   label: 'Доходы',   icon: <TrendingUp size={20} /> },
  { key: 'expenses', label: 'Траты',    icon: <Receipt size={20} /> },
  { key: 'loans',    label: 'Долги',    icon: <Landmark size={20} /> },
  { key: 'goals',    label: 'Цели',     icon: <Target size={20} /> },
]

function nextMonthKey(key: string): string {
  const [y, m] = key.split('-').map(Number)
  const d = new Date(y, m, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function DashboardClient({ data, monthKey, initialTab = 'main' }: {
  data: DashboardData; monthKey: string; initialTab?: string
}) {
  const router = useRouter()
  const [tab, setTab] = useState<Tab>((initialTab as Tab) ?? 'main')
  const [undoPending, startUndo] = useTransition()
  const [toast, setToast] = useState<string | null>(null)
  const isCurrent = monthKey === currentMonthKey()
  const month = data.allMonths.find((m) => m.month_key === monthKey)
  const closed = month?.closed ?? false

  const showToast = useCallback((msg: string) => {
    setToast(msg); setTimeout(() => setToast(null), 3000)
  }, [])

  function undo() {
    startUndo(async () => {
      const r = await undoLastAction()
      if (r?.error) showToast('⚠️ ' + r.error)
      else if (r && 'description' in r) showToast('↩ ' + r.description)
      router.refresh()
    })
  }

  function navigate(dir: 'prev' | 'next') {
    router.push(`/dashboard?m=${dir === 'prev' ? prevMonthKey(monthKey) : nextMonthKey(monthKey)}`)
  }

  /* ── Tab content by key ─────────────────────────── */
  function renderTab() {
    switch (tab) {
      case 'main': return (
        <div className="flex flex-col gap-4">
          <FinancialHealthCard data={data} monthKey={monthKey} />
          <StatsBar data={data} monthKey={monthKey} />
          <BalanceHistoryChart history={data.debitHistory} />
          <AccountsTransferWidget user={data.user} cards={data.cards} />
          <CashflowWaterfall data={data} monthKey={monthKey} />
          <MonthCloseCard data={data} monthKey={monthKey} />
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
            <AnalyticsPanel data={data} monthKey={monthKey} />
          </div>
        </div>
      )
      case 'income': return (
        <div className="flex flex-col gap-4">
          <SalaryPanel data={data} monthKey={monthKey} />
          <IncomeWidget data={data} monthKey={monthKey} />
        </div>
      )
      case 'expenses': return (
        <div className="flex flex-col gap-4">
          <ExpensesWidget data={data} monthKey={monthKey} />
          {(data.customCategories?.length ?? 0) > 0 && (
            <HarmfulExpensesWidget customCategories={data.customCategories!} expenses={data.expenses} />
          )}
          <ChartsWidget data={data} monthKey={monthKey} />
          <FixedCostsWidget user={data.user} month={data.allMonths.find(m => m.month_key === monthKey) ?? null} monthKey={monthKey} />
        </div>
      )
      case 'loans': return (
        <div className="flex flex-col gap-4">
          <LoansWidget data={data} />
          <DebtChartWidget data={data} />
        </div>
      )
      case 'goals': return (
        <div className="flex flex-col gap-4">
          <GoalsWidget data={data} monthKey={monthKey} />
        </div>
      )
    }
  }

  /* ── Month pill ─────────────────────────────────── */
  const MonthPill = () => (
    <div className="flex items-center gap-1">
      <button onClick={() => navigate('prev')}
        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', cursor: 'pointer' }}>
        <ChevronLeft size={14} style={{ color: 'var(--tx-muted)' }} />
      </button>
      <div className="px-2.5 h-8 rounded-lg flex items-center gap-1.5 flex-1 justify-center"
        style={{ background: 'var(--bg-hover)', border: `1px solid ${isCurrent ? 'rgba(34,197,94,0.4)' : 'var(--border)'}`, minWidth: 0 }}>
        {isCurrent && <div className="status-dot flex-shrink-0" style={{ background: 'var(--accent-green)' }} />}
        {closed && <span className="text-xs flex-shrink-0">🔒</span>}
        <span className="text-sm font-semibold truncate" style={{ fontFamily: 'Space Grotesk,sans-serif' }}>
          {(() => { const s = monthLabel(monthKey); return s.charAt(0).toUpperCase() + s.slice(1) })()}
        </span>
      </div>
      <button onClick={() => navigate('next')}
        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', cursor: 'pointer' }}>
        <ChevronRight size={14} style={{ color: 'var(--tx-muted)' }} />
      </button>
    </div>
  )

  /* ── Undo button ─────────────────────────────────── */
  const UndoBtn = () => (
    <button onClick={undo} disabled={undoPending} title="Отменить"
      className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
      style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', cursor: undoPending ? 'wait' : 'pointer' }}>
      {undoPending ? <Loader2 size={14} className="animate-spin" style={{ color: 'var(--accent-amber)' }} /> : <Undo2 size={14} style={{ color: 'var(--accent-amber)' }} />}
    </button>
  )

  return (
    <div>
      {/* ══════════════════════════════════ MOBILE ══════════════════════════════════ */}
      <div className="lg:hidden">
        {/* Fixed header */}
        <header className="app-header gap-2">
          <div className="w-7 h-7 rounded-lg flex-shrink-0 flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg,#1d4ed8,#06b6d4)' }}>
            <TrendingUp size={14} color="white" strokeWidth={2.5} />
          </div>
          <div className="flex-1 min-w-0">
            <MonthPill />
          </div>
          <ThemeToggle />
          <UndoBtn />
        </header>

        {/* Scrollable content */}
        <div className="tab-content animate-fade-in" key={tab}>
          {renderTab()}
        </div>

        {/* Bottom nav */}
        <nav className="bottom-nav">
          {TABS.map(({ key, label, icon }) => (
            <button key={key} onClick={() => setTab(key)} className={`bottom-nav-item${tab === key ? ' active' : ''}`}>
              {icon}
              <span>{label}</span>
            </button>
          ))}
          <button onClick={() => router.push('/planner')} className="bottom-nav-item">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            <span>Планер</span>
          </button>
        </nav>
      </div>

      {/* ══════════════════════════════════ DESKTOP ══════════════════════════════════ */}
      <div className="hidden lg:flex h-screen overflow-hidden">
        {/* Sidebar */}
        <aside className="flex flex-col flex-shrink-0" style={{
          width: '220px', height: '100vh', position: 'fixed', top: 0, left: 0,
          background: 'rgba(8,12,20,0.97)', borderRight: '1px solid var(--border)',
          padding: '20px 12px', zIndex: 40,
        }}>
          {/* Logo */}
          <div className="flex items-center gap-2 px-3 mb-6">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'linear-gradient(135deg,#1d4ed8,#06b6d4)' }}>
              <TrendingUp size={16} color="white" strokeWidth={2.5} />
            </div>
            <div>
              <div className="text-sm font-bold" style={{ fontFamily: 'Space Grotesk,sans-serif' }}>Finance</div>
              <div className="label">Cockpit</div>
            </div>
          </div>

          {/* Month switcher */}
          <div className="px-1 mb-5">
            <MonthPill />
          </div>

          {/* Tab nav */}
          <nav className="flex flex-col gap-1 flex-1">
            {TABS.map(({ key, label, icon }) => (
              <button key={key} onClick={() => setTab(key)}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all text-left"
                style={{
                  background: tab === key ? 'rgba(6,182,212,0.1)' : 'transparent',
                  border: `1px solid ${tab === key ? 'rgba(6,182,212,0.25)' : 'transparent'}`,
                  color: tab === key ? 'var(--accent-cyan)' : 'var(--tx-muted)',
                  cursor: 'pointer',
                }}>
                <span style={{ color: tab === key ? 'var(--accent-cyan)' : 'var(--tx-dim)' }}>{icon}</span>
                {label}
              </button>
            ))}
          </nav>

          {/* Theme + Undo */}
          <div className="px-1 mt-4 flex flex-col gap-2">
            <ThemeToggle />
            <button onClick={undo} disabled={undoPending}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm w-full"
              style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)', color: 'var(--accent-amber)', cursor: undoPending ? 'wait' : 'pointer' }}>
              {undoPending ? <Loader2 size={14} className="animate-spin" /> : <Undo2 size={14} />}
              Отменить
            </button>
          </div>
        </aside>

        {/* Main area */}
        <main style={{ marginLeft: '220px', flex: 1, overflowY: 'auto', padding: '24px', maxWidth: '1200px' }}>
          <div className="animate-fade-in" key={tab}>
            {/* Desktop: some tabs use 2-column layout */}
            {(tab === 'main') && (
              <div className="grid gap-6" style={{ gridTemplateColumns: '1fr 380px' }}>
                <div className="flex flex-col gap-5">
                  <FinancialHealthCard data={data} monthKey={monthKey} />
                  <StatsBar data={data} monthKey={monthKey} />
                  <BalanceHistoryChart history={data.debitHistory} />
                  <CashflowWaterfall data={data} monthKey={monthKey} />
                  <MonthCloseCard data={data} monthKey={monthKey} />
                  <AnalyticsPanel data={data} monthKey={monthKey} />
                </div>
                <div className="flex flex-col gap-5">
                  <AccountsTransferWidget user={data.user} cards={data.cards} />
                </div>
              </div>
            )}
            {tab === 'income' && (
              <div className="grid gap-6" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <SalaryPanel data={data} monthKey={monthKey} />
                <IncomeWidget data={data} monthKey={monthKey} />
              </div>
            )}
            {tab === 'expenses' && (
              <div className="grid gap-6" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div className="flex flex-col gap-5">
                  <ExpensesWidget data={data} monthKey={monthKey} />
                  {(data.customCategories?.length ?? 0) > 0 && (
                    <HarmfulExpensesWidget customCategories={data.customCategories!} expenses={data.expenses} />
                  )}
                  <ChartsWidget data={data} monthKey={monthKey} />
                </div>
                <FixedCostsWidget user={data.user} month={data.allMonths.find(m => m.month_key === monthKey) ?? null} monthKey={monthKey} />
              </div>
            )}
            {tab === 'loans' && (
              <div className="grid gap-6" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <LoansWidget data={data} />
                <DebtChartWidget data={data} />
              </div>
            )}
            {tab === 'goals' && (
              <div style={{ maxWidth: '600px' }}>
                <GoalsWidget data={data} monthKey={monthKey} />
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Toast */}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
