'use client'

import { useState, useTransition } from 'react'
import {
  CheckCircle2, Circle, ChevronRight, Bell, Repeat2,
  Dumbbell, BookOpen, Moon, Flame, ArrowLeft, Calendar, ListTodo,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { completeTask, logHabitToday } from '@/app/planner/actions'

// ── Types ──────────────────────────────────────────────────────────────────
interface Task {
  id: string; title: string; description?: string | null
  category?: string | null; priority: string; status: string
  due_date?: string | null; due_time?: string | null
  planned_amount?: number | null; contact_name?: string | null; parent_id?: string | null
}
interface Habit {
  id: string; title: string; category?: string | null; frequency: string
  target_days_per_week?: number | null; metric_type: string; metric_unit?: string | null; status: string
}
interface HabitLog {
  id: string; habit_id: string; logged_date: string; done: boolean; value?: number | null; value_unit?: string | null; note?: string | null
}
interface Reminder {
  id: string; title: string; message?: string | null; recurrence: string
  recurrence_day?: number | null; recurrence_hour: number; recurrence_min: number; notify_at: string
}
interface Props {
  today: string; weekStart: string
  overdue: Task[]; todayTasks: Task[]; weekTasks: Task[]; backlog: Task[]
  habits: Habit[]; habitLogs: HabitLog[]; reminders: Reminder[]
}

// ── Helpers ────────────────────────────────────────────────────────────────
const CATEGORY_ICONS: Record<string, string> = {
  work: '💼', personal: '👤', study: '📚', family: '👨‍👩‍👧', health: '🏃', home: '🏠', hobby: '🎨'
}
const PRIORITY_COLOR: Record<string, string> = {
  high: 'var(--accent-red)', medium: 'var(--accent-amber)', low: 'var(--tx-muted)', backlog: 'var(--border-bright)'
}
function fmt(iso: string | null | undefined) {
  if (!iso) return ''
  return iso.slice(5).replace('-', '/')   // MM/DD
}
function fmtTime(t: string | null | undefined) {
  return t ? String(t).slice(0, 5) : ''
}
function habitDays(weekStart: string, today: string) {
  const days: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + i)
    const iso = d.toISOString().slice(0, 10)
    if (iso <= today) days.push(iso)
  }
  return days
}
const DAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

// ── TaskRow ────────────────────────────────────────────────────────────────
function TaskRow({ task, onDone }: { task: Task; onDone: () => void }) {
  const [isPending, start] = useTransition()
  const [done, setDone] = useState(false)

  function handle() {
    setDone(true)
    start(() => onDone())
  }

  if (done) return null

  const icon = CATEGORY_ICONS[task.category ?? ''] ?? '•'
  const prioColor = PRIORITY_COLOR[task.priority] ?? 'var(--tx-muted)'
  const time = fmtTime(task.due_time)

  return (
    <div
      className="card card-hover flex items-start gap-3 p-3"
      style={{ opacity: isPending ? 0.5 : 1, transition: 'opacity 0.2s' }}
    >
      {/* Checkbox */}
      <button
        onClick={handle}
        className="mt-0.5 flex-shrink-0"
        style={{ color: prioColor, minWidth: 20 }}
      >
        {isPending ? (
          <CheckCircle2 size={20} style={{ color: 'var(--accent-green)' }} />
        ) : (
          <Circle size={20} />
        )}
      </button>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm" style={{ color: 'var(--tx-primary)' }}>{task.title}</span>
          {task.contact_name && (
            <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-hover)', color: 'var(--tx-muted)' }}>
              @{task.contact_name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <span className="text-xs">{icon}</span>
          {time && <span className="text-xs" style={{ color: 'var(--accent-cyan)' }}>{time}</span>}
          {task.planned_amount && (
            <span className="text-xs" style={{ color: 'var(--accent-amber)' }}>
              ~{task.planned_amount.toLocaleString('ru-RU')}₽
            </span>
          )}
          {task.priority === 'high' && (
            <span className="text-xs" style={{ color: prioColor }}>срочно</span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── HabitRow ───────────────────────────────────────────────────────────────
function HabitRow({ habit, logs, days, today }: { habit: Habit; logs: HabitLog[]; days: string[]; today: string }) {
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({})
  const [, start] = useTransition()

  const doneSet = new Set(logs.filter(l => l.habit_id === habit.id && l.done).map(l => l.logged_date))
  const weekCount = logs.filter(l => l.habit_id === habit.id && l.done).length
  const todayLog = logs.find(l => l.habit_id === habit.id && l.logged_date === today)
  const todayDone = optimistic[today] ?? (todayLog?.done ?? false)

  function toggleToday() {
    const next = !todayDone
    setOptimistic(p => ({ ...p, [today]: next }))
    start(() => logHabitToday(habit.id, next))
  }

  const habitIcon =
    habit.title.toLowerCase().includes('зал') || habit.title.toLowerCase().includes('тренир') ? '🏋️' :
    habit.title.toLowerCase().includes('бег') || habit.title.toLowerCase().includes('run') ? '🏃' :
    habit.title.toLowerCase().includes('медит') ? '🧘' :
    habit.title.toLowerCase().includes('чтен') || habit.title.toLowerCase().includes('книг') ? '📖' :
    habit.title.toLowerCase().includes('сон') ? '😴' : '⭐'

  return (
    <div className="card p-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-base">{habitIcon}</span>
          <span className="text-sm font-medium" style={{ color: 'var(--tx-primary)' }}>{habit.title}</span>
          {habit.target_days_per_week && (
            <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-hover)', color: 'var(--tx-muted)' }}>
              {weekCount}/{habit.target_days_per_week}×
            </span>
          )}
        </div>
        {/* Today checkbox */}
        <button onClick={toggleToday} style={{ color: todayDone ? 'var(--accent-green)' : 'var(--tx-muted)' }}>
          {todayDone ? <CheckCircle2 size={20} /> : <Circle size={20} />}
        </button>
      </div>

      {/* Weekly grid */}
      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)` }}>
        {days.map((d, i) => {
          const done = optimistic[d] ?? doneSet.has(d)
          const isToday = d === today
          return (
            <div key={d} className="flex flex-col items-center gap-1">
              <span className="text-xs" style={{ color: isToday ? 'var(--accent-cyan)' : 'var(--tx-muted)', fontSize: '10px' }}>
                {DAY_LABELS[i]}
              </span>
              <div
                className="rounded-md flex items-center justify-center"
                style={{
                  width: 28, height: 28,
                  background: done ? 'var(--accent-green)' : 'var(--bg-hover)',
                  border: isToday ? '1px solid var(--accent-cyan)' : '1px solid var(--border)',
                  opacity: d > today ? 0.35 : 1,
                }}
              >
                {done && <span style={{ fontSize: '12px' }}>✓</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────
export default function PlannerClient({
  today, weekStart,
  overdue, todayTasks, weekTasks, backlog,
  habits, habitLogs, reminders,
}: Props) {
  const router = useRouter()
  const [tab, setTab] = useState<'today' | 'week' | 'habits'>('today')
  const [, start] = useTransition()

  const days = habitDays(weekStart, today)

  // Group week tasks by date
  const byDate: Record<string, Task[]> = {}
  for (const t of weekTasks) {
    const d = t.due_date ?? 'backlog'
    if (!byDate[d]) byDate[d] = []
    byDate[d].push(t)
  }

  const totalToday = overdue.length + todayTasks.length

  return (
    <div style={{ background: 'var(--bg-base)', minHeight: '100vh', color: 'var(--tx-primary)' }}>

      {/* ── Header ── */}
      <header
        className="sticky top-0 z-30 flex items-center justify-between px-4 py-3"
        style={{
          background: 'rgba(8,12,20,0.94)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid var(--border)',
          height: 'var(--header-h)',
        }}
      >
        <button
          onClick={() => router.push('/dashboard')}
          className="flex items-center gap-2 text-sm"
          style={{ color: 'var(--tx-muted)' }}
        >
          <ArrowLeft size={16} />
          Финансы
        </button>

        <div className="flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, #5b21b6, #8b5cf6)' }}
          >
            <Calendar size={14} color="white" strokeWidth={2.5} />
          </div>
          <span className="text-sm font-semibold" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>
            Планировщик
          </span>
        </div>

        <div className="text-xs" style={{ color: 'var(--tx-muted)' }}>
          {today.slice(5).replace('-', '/')}
        </div>
      </header>

      {/* ── Content ── */}
      <div style={{ paddingTop: 16, paddingBottom: 'calc(var(--nav-h) + 24px)', paddingLeft: 16, paddingRight: 16 }}>

        {/* ── TAB: СЕГОДНЯ ─────────────────────────────────────── */}
        {tab === 'today' && (
          <div className="flex flex-col gap-3">
            {/* Overdue */}
            {overdue.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-2">
                  <Flame size={14} style={{ color: 'var(--accent-red)' }} />
                  <span className="text-xs font-medium" style={{ color: 'var(--accent-red)' }}>
                    ПРОСРОЧЕНО · {overdue.length}
                  </span>
                </div>
                <div className="flex flex-col gap-2">
                  {overdue.map(t => (
                    <TaskRow key={t.id} task={t} onDone={() => completeTask(t.id)} />
                  ))}
                </div>
              </section>
            )}

            {/* Today tasks */}
            <section>
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 size={14} style={{ color: 'var(--accent-green)' }} />
                <span className="text-xs font-medium" style={{ color: 'var(--tx-muted)' }}>
                  СЕГОДНЯ · {todayTasks.length}
                </span>
              </div>
              {todayTasks.length === 0 ? (
                <div className="card p-4 text-center">
                  <p className="text-sm" style={{ color: 'var(--tx-muted)' }}>
                    {overdue.length === 0 ? '🎉 День чистый. Используй Telegram чтобы добавить задачу.' : 'Новых задач нет.'}
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {todayTasks.map(t => (
                    <TaskRow key={t.id} task={t} onDone={() => completeTask(t.id)} />
                  ))}
                </div>
              )}
            </section>

            {/* Habits summary for today */}
            {habits.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-2">
                  <Repeat2 size={14} style={{ color: 'var(--accent-violet)' }} />
                  <span className="text-xs font-medium" style={{ color: 'var(--tx-muted)' }}>
                    ПРИВЫЧКИ СЕГОДНЯ · {habits.length}
                  </span>
                </div>
                <div className="card p-3 flex flex-col gap-2">
                  {habits.map(h => {
                    const log = habitLogs.find(l => l.habit_id === h.id && l.logged_date === today)
                    const done = log?.done ?? false
                    const val = log?.value
                    return (
                      <button
                        key={h.id}
                        onClick={() => start(() => logHabitToday(h.id, !done))}
                        className="flex items-center justify-between text-left w-full"
                        style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}
                      >
                        <span className="text-sm" style={{ color: done ? 'var(--tx-muted)' : 'var(--tx-primary)', textDecoration: done ? 'line-through' : 'none' }}>
                          {h.title}
                          {done && val ? ` · ${val}${h.metric_unit ?? ''}` : ''}
                        </span>
                        <span style={{ color: done ? 'var(--accent-green)' : 'var(--border-bright)' }}>
                          {done ? <CheckCircle2 size={18} /> : <Circle size={18} />}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </section>
            )}

            {/* Upcoming reminders */}
            {reminders.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-2">
                  <Bell size={14} style={{ color: 'var(--accent-amber)' }} />
                  <span className="text-xs font-medium" style={{ color: 'var(--tx-muted)' }}>
                    НАПОМИНАНИЯ
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  {reminders.map(r => {
                    const h = r.recurrence_hour, m = String(r.recurrence_min).padStart(2, '0')
                    const when = r.recurrence === 'monthly' ? `${r.recurrence_day}-го в ${h}:${m}`
                             : r.recurrence === 'once'    ? `${fmt(r.notify_at)} ${h}:${m}`
                             : `каждые ${r.recurrence === 'weekly' ? 'нед.' : 'день'} в ${h}:${m}`
                    return (
                      <div key={r.id} className="card p-2.5 flex items-center gap-2">
                        <Bell size={13} style={{ color: 'var(--accent-amber)', flexShrink: 0 }} />
                        <span className="text-sm flex-1" style={{ color: 'var(--tx-primary)' }}>{r.title}</span>
                        <span className="text-xs" style={{ color: 'var(--tx-muted)' }}>{when}</span>
                      </div>
                    )
                  })}
                </div>
              </section>
            )}
          </div>
        )}

        {/* ── TAB: НЕДЕЛЯ ─────────────────────────────────────── */}
        {tab === 'week' && (
          <div className="flex flex-col gap-4">
            {Object.keys(byDate).length === 0 && backlog.length === 0 ? (
              <div className="card p-6 text-center">
                <p className="text-sm" style={{ color: 'var(--tx-muted)' }}>На неделе всё чисто ✨</p>
              </div>
            ) : (
              <>
                {Object.entries(byDate).sort(([a],[b]) => a < b ? -1 : 1).map(([date, tasks]) => (
                  <section key={date}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-medium px-2 py-0.5 rounded" style={{
                        background: 'var(--bg-hover)', color: 'var(--tx-muted)', border: '1px solid var(--border)'
                      }}>
                        {new Date(date + 'T12:00:00Z').toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}
                      </span>
                    </div>
                    <div className="flex flex-col gap-2">
                      {tasks.map(t => (
                        <TaskRow key={t.id} task={t} onDone={() => completeTask(t.id)} />
                      ))}
                    </div>
                  </section>
                ))}
                {backlog.length > 0 && (
                  <section>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-medium px-2 py-0.5 rounded" style={{
                        background: 'var(--bg-hover)', color: 'var(--tx-muted)', border: '1px solid var(--border)'
                      }}>
                        📋 Бэклог · {backlog.length}
                      </span>
                    </div>
                    <div className="flex flex-col gap-2">
                      {backlog.slice(0, 10).map(t => (
                        <TaskRow key={t.id} task={t} onDone={() => completeTask(t.id)} />
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        )}

        {/* ── TAB: ПРИВЫЧКИ ───────────────────────────────────── */}
        {tab === 'habits' && (
          <div className="flex flex-col gap-3">
            {habits.length === 0 ? (
              <div className="card p-6 text-center">
                <p className="text-sm mb-2" style={{ color: 'var(--tx-muted)' }}>
                  Привычек ещё нет
                </p>
                <p className="text-xs" style={{ color: 'var(--tx-muted)' }}>
                  Скажи боту: «добавь привычку ходить в зал 3 раза в неделю»
                </p>
              </div>
            ) : (
              <>
                {/* Week legend */}
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs" style={{ color: 'var(--tx-muted)' }}>
                    Прогресс недели (с пн)
                  </span>
                </div>
                {habits.map(h => (
                  <HabitRow key={h.id} habit={h} logs={habitLogs} days={days} today={today} />
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Bottom Nav ── */}
      <nav
        className="bottom-nav"
        style={{ position: 'fixed', bottom: 0, left: 0, right: 0 }}
      >
        {([
          { key: 'today' as const, label: `Сегодня${totalToday > 0 ? ` (${totalToday})` : ''}`, icon: <CheckCircle2 size={20} /> },
          { key: 'week'  as const, label: 'Неделя', icon: <Calendar size={20} /> },
          { key: 'habits' as const, label: 'Привычки', icon: <Repeat2 size={20} /> },
        ] as const).map(({ key, label, icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`bottom-nav-item${tab === key ? ' active' : ''}`}
          >
            {icon}
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
