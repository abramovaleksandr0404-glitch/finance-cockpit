'use client'

import { useTransition } from 'react'
import { Trash2, Loader2 } from 'lucide-react'
import { deleteExpense } from '@/app/actions'

export default function DeleteExpenseBtn({ id }: { id: string }) {
  const [pending, startTransition] = useTransition()

  function handleDelete() {
    if (!confirm('Удалить расход?')) return
    startTransition(async () => {
      await deleteExpense(id)
    })
  }

  return (
    <button
      onClick={handleDelete}
      disabled={pending}
      className="p-1 rounded transition-all opacity-0 group-hover:opacity-100"
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        color: 'var(--tx-muted)',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-red)' }}
      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--tx-muted)' }}
    >
      {pending ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
    </button>
  )
}
