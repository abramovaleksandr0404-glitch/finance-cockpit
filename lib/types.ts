// ── Auto-generated style Supabase types ──────────────────────────────────────
// Compatible with @supabase/supabase-js

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      users: {
        Row: {
          id: string
          email: string | null
          telegram_id: number | null
          created_at: string | null
          salary_net: number
          salary_gross: number
          ytd_gross: number
          threshold: number
          margin_floor: number
          var_budget: number
          nominals: Record<string, number>
          qm2: number
          qm3: number
          tax_threshold: number
          r1: number
          r2: number
          debit_balance: number
          tbank_debit: number
          debit_updated_at: string | null
          fixed_costs: Array<{ name: string; amount: number }>
          annual_pot: number
          margin_share: number
          moment_share: number
        }
        Insert: {
          id: string
          email?: string | null
          telegram_id?: number | null
          created_at?: string | null
          salary_net?: number
          salary_gross?: number
          ytd_gross?: number
          threshold?: number
          margin_floor?: number
          var_budget?: number
          nominals?: Json
          qm2?: number
          qm3?: number
          tax_threshold?: number
          r1?: number
          r2?: number
          debit_balance?: number
          debit_updated_at?: string | null
        }
        Update: {
          id?: string
          email?: string | null
          telegram_id?: number | null
          created_at?: string | null
          salary_net?: number
          salary_gross?: number
          ytd_gross?: number
          threshold?: number
          margin_floor?: number
          var_budget?: number
          nominals?: Json
          qm2?: number
          qm3?: number
          tax_threshold?: number
          r1?: number
          r2?: number
          debit_balance?: number
          debit_updated_at?: string | null
        }
        Relationships: []
      }
      months: {
        Row: {
          id: string
          user_id: string | null
          month_key: string
          revenue: number
          bonus_override: number | null
          clients: Record<string, number>
          fixed_paid: Record<string, number | boolean>
          salary_adv_received: boolean | null
          salary_eom_received: boolean | null
          salary_adv_amount: number | null
          salary_eom_amount: number | null
          bonus_amount: number | null
          closed: boolean | null
          summary: Record<string, number> | null
          created_at: string | null
        }
        Insert: {
          id?: string
          user_id?: string | null
          month_key: string
          revenue?: number
          bonus_override?: number | null
          clients?: Json
          fixed_paid?: Json
          salary_adv_received?: boolean | null
          salary_eom_received?: boolean | null
          created_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string | null
          month_key?: string
          revenue?: number
          bonus_override?: number | null
          clients?: Json
          fixed_paid?: Json
          salary_adv_received?: boolean | null
          salary_eom_received?: boolean | null
          created_at?: string | null
        }
        Relationships: [
          { foreignKeyName: "months_user_id_fkey"; columns: ["user_id"]; referencedRelation: "users"; referencedColumns: ["id"] }
        ]
      }
      expenses: {
        Row: {
          id: string
          user_id: string | null
          month_key: string
          expense_date: string
          category: string
          amount: number
          description: string | null
          source_type: string | null
          card_id: string | null
          created_at: string | null
        }
        Insert: {
          id?: string
          user_id?: string | null
          month_key: string
          expense_date?: string
          category?: string
          amount: number
          description?: string | null
          source_type?: string | null
          card_id?: string | null
          created_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string | null
          month_key?: string
          expense_date?: string
          category?: string
          amount?: number
          description?: string | null
          source_type?: string | null
          card_id?: string | null
          created_at?: string | null
        }
        Relationships: [
          { foreignKeyName: "expenses_user_id_fkey"; columns: ["user_id"]; referencedRelation: "users"; referencedColumns: ["id"] },
          { foreignKeyName: "expenses_card_id_fkey"; columns: ["card_id"]; referencedRelation: "cards"; referencedColumns: ["id"] }
        ]
      }
      income_events: {
        Row: {
          id: string
          user_id: string | null
          month_key: string
          event_type: string
          description: string
          amount: number
          debit_delta: number | null
          card_id: string | null
          card_delta: number | null
          event_date: string
          created_at: string | null
        }
        Insert: {
          id?: string
          user_id?: string | null
          month_key: string
          event_type: string
          description: string
          amount: number
          debit_delta?: number | null
          card_id?: string | null
          card_delta?: number | null
          event_date?: string
          created_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string | null
          month_key?: string
          event_type?: string
          description?: string
          amount?: number
          debit_delta?: number | null
          card_id?: string | null
          card_delta?: number | null
          event_date?: string
          created_at?: string | null
        }
        Relationships: [
          { foreignKeyName: "income_events_user_id_fkey"; columns: ["user_id"]; referencedRelation: "users"; referencedColumns: ["id"] }
        ]
      }
      loans: {
        Row: {
          id: string
          user_id: string | null
          name: string
          rate: number
          principal: number
          accrued_int: number
          min_payment: number
          due_day: string
          original_amt: number
          last_accrual: string
          paid_month: string | null
          sort_order: number | null
          created_at: string | null
          end_date: string | null
          term_months: number | null
          is_annuity: boolean | null
          last_pay_principal: number | null
          last_pay_interest: number | null
        }
        Insert: {
          id?: string
          user_id?: string | null
          name: string
          rate: number
          principal?: number
          accrued_int?: number
          min_payment: number
          due_day?: string
          original_amt: number
          last_accrual?: string
          paid_month?: string | null
          sort_order?: number | null
          created_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string | null
          name?: string
          rate?: number
          principal?: number
          accrued_int?: number
          min_payment?: number
          due_day?: string
          original_amt?: number
          last_accrual?: string
          paid_month?: string | null
          sort_order?: number | null
          created_at?: string | null
        }
        Relationships: [
          { foreignKeyName: "loans_user_id_fkey"; columns: ["user_id"]; referencedRelation: "users"; referencedColumns: ["id"] }
        ]
      }
      cards: {
        Row: {
          id: string
          user_id: string | null
          name: string
          card_limit: number
          current_debt: number
          sort_order: number | null
          created_at: string | null
        }
        Insert: {
          id?: string
          user_id?: string | null
          name: string
          card_limit?: number
          current_debt?: number
          sort_order?: number | null
          created_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string | null
          name?: string
          card_limit?: number
          current_debt?: number
          sort_order?: number | null
          created_at?: string | null
        }
        Relationships: [
          { foreignKeyName: "cards_user_id_fkey"; columns: ["user_id"]; referencedRelation: "users"; referencedColumns: ["id"] }
        ]
      }
      goals: {
        Row: {
          id: string
          user_id: string | null
          month_key: string | null
          name: string
          amount: number
          sort_order: number | null
          created_at: string | null
          purchased: boolean | null
          purchased_at: string | null
          purchased_source: string | null
        }
        Insert: {
          id?: string
          user_id?: string | null
          month_key?: string | null
          name: string
          amount: number
          sort_order?: number | null
          created_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string | null
          month_key?: string | null
          name?: string
          amount?: number
          sort_order?: number | null
          created_at?: string | null
        }
        Relationships: [
          { foreignKeyName: "goals_user_id_fkey"; columns: ["user_id"]; referencedRelation: "users"; referencedColumns: ["id"] }
        ]
      }
      undo_snapshots: {
        Row: {
          id: string
          user_id: string | null
          description: string
          snapshot: Json
          created_at: string | null
        }
        Insert: {
          id?: string
          user_id?: string | null
          description: string
          snapshot: Json
          created_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string | null
          description?: string
          snapshot?: Json
          created_at?: string | null
        }
        Relationships: [
          { foreignKeyName: "undo_snapshots_user_id_fkey"; columns: ["user_id"]; referencedRelation: "users"; referencedColumns: ["id"] }
        ]
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}

// ── Convenience aliases ──────────────────────────────────────────────────────
export type UserProfile    = Database['public']['Tables']['users']['Row']
export type Month          = Database['public']['Tables']['months']['Row']
export type Expense        = Database['public']['Tables']['expenses']['Row']
export type IncomeEvent    = Database['public']['Tables']['income_events']['Row']
export type Loan           = Database['public']['Tables']['loans']['Row']
export type Card           = Database['public']['Tables']['cards']['Row']
export type Goal           = Database['public']['Tables']['goals']['Row']

// ── Debit history entry ──────────────────────────────────────────────────────
export interface DebitHistoryEntry {
  amount: number
  balance_after: number
  description: string
  source_type: string
  created_at: string
}

// ── Custom category ──────────────────────────────────────────────────────────
export interface CustomCategory {
  id: string
  name: string
  monthly_limit: number | null
  keywords?: string[] | null
}

// ── Dashboard bundle ─────────────────────────────────────────────────────────
export interface DashboardData {
  user: UserProfile
  currentMonth: Month | null
  allMonths: Month[]
  expenses: Expense[]        // current month only (variable expenses widget)
  allExpenses: Expense[]     // all months (analytics & trends)
  incomeEvents: IncomeEvent[]
  loans: Loan[]
  cards: Card[]
  goals: Goal[]
  debitHistory?: DebitHistoryEntry[]
  customCategories?: CustomCategory[]
}
