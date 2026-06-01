# Finance Cockpit — Next.js 15

Personal financial dashboard: Next.js 15 · Supabase · Vercel.

## Stack

| Layer | Tech |
|---|---|
| Framework | Next.js 15 (App Router, Server Components, Server Actions) |
| Auth + DB | Supabase (RLS, email/password, magic link) |
| Styling | Tailwind CSS + JetBrains Mono |
| Deploy | Vercel (fra1, EU) |

## Features

- 🔐 Auth — email/password, magic link, RLS-protected data
- 💰 Debit balance — inline editable
- 📅 Monthly view — revenue, variable budget gauge, salary toggles
- 📊 Expenses — add/delete, breakdown by category with stacked bar
- 🏦 Loans — list with payoff progress
- 💳 Cards — utilization bars
- 🎯 Goals — monthly & persistent
- 📈 Salary card — YTD progress to 15% НДФЛ threshold

## Deploy

### Option A — Vercel CLI (recommended)

```bash
# 1. Install deps
npm install

# 2. Install Vercel CLI
npm i -g vercel

# 3. Login (browser will open)
vercel login

# 4. Deploy to your team
vercel deploy --yes --scope team_2R1IxU2s0wkq00VYK6KARE16

# 5. Set env vars (or add via vercel.com dashboard)
vercel env add NEXT_PUBLIC_SUPABASE_URL
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY
```

### Option B — Vercel Dashboard (no CLI)

1. Go to vercel.com → New Project → Import from your PC (drag & drop this folder)
2. Set environment variables in Project Settings → Environment Variables:
   - `NEXT_PUBLIC_SUPABASE_URL` = `https://yhcbtauuatuvwnibhlwg.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = `<anon key from .env.local>`
3. Deploy

### After deploy — configure Supabase

In Supabase Dashboard → Authentication → URL Configuration:
- **Site URL**: `https://your-app.vercel.app`
- **Redirect URLs**: `https://your-app.vercel.app/auth/callback`

## Env vars

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://yhcbtauuatuvwnibhlwg.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | See `.env.local` |

The anon key is a public key — safe to expose in the browser. Security comes from RLS policies.

## Local dev

```bash
npm install
npm run dev
```

Open http://localhost:3000
