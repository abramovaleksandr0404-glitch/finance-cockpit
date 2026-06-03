# CLAUDE.md — Операционное руководство для автономной работы

Этот файл читается ПЕРВЫМ в каждой сессии Claude Code. Он описывает проект, архитектуру и рабочий процесс.

## Что это за проект

**Finance Cockpit** — персональная финансовая система Александра (продажи в АТОН, инвест-продукты).
Цель: цифровой «второй мозг» — финансы, работа, планирование, база знаний.

Стек: Next.js 16 (App Router) + Supabase (Postgres) + Vercel + Telegram-бот (Claude Haiku/Sonnet).

## Рабочий процесс автономной сессии

Когда Александр говорит «работай по бэклогу» или «продолжай»:

1. **Прочитай `BACKLOG.md`** — найди верхнюю незакрытую задачу с наивысшим приоритетом
2. **Прочитай `SPRINTS.md`** — пойми в каком спринте мы и какая цель
3. **Реализуй задачу** — пиши код, следуя архитектуре ниже
4. **Прогони eval-тесты**: `npx tsx evals/run.ts` — все должны пройти
5. **Собери проект**: `npm run build` — должен быть чистым
6. **Закоммить**: `git add -A && git commit -m "..." && git push`
7. **Отметь задачу** [x] в `BACKLOG.md`, добавь запись в `## Лог изменений`
8. **Перейди к следующей задаче** — повторяй пока не кончится контекст или задачи

Каждое изменение деплоится автоматически (Vercel watch на GitHub). После деплоя бота — открой `/api/telegram/setup`.

## Архитектура

### Ключевые файлы
- `lib/bot.ts` — вся логика Telegram-бота (контекст, действия, парсинг, Claude API)
- `app/api/telegram/route.ts` — webhook (текст/голос/фото)
- `app/api/cron/morning/route.ts` — утренний дайджест (8:00 МСК)
- `app/api/cron/evening/route.ts` — вечерние алерты (20:00 МСК)
- `lib/engine.ts` — финансовый движок (бонусы, кредиты, аннуитет)
- `lib/finance.ts` — хелперы расчётов
- `app/actions.ts` — server actions для сайта
- `components/dashboard/` — UI виджеты
- `evals/` — тесты

### Supabase (проект yhcbtauuatuvwnibhlwg)
Таблицы: users, months, loans, cards, goals, expenses, income_events, bot_messages, undo_snapshots
- user_id всегда `5ebdb411-6021-4dfc-9d0d-caa8e0107502`
- Бот использует SERVICE_ROLE_KEY (bypass RLS)

### Финансовая модель
- Оклад net 121 600 (аванс 50% 15-го, остаток+бонус посл. раб. день)
- Бонус: котёл = Σ(клиенты×номинал) + 20%×выручка; момент = max(0, котёл−56000)×80%; НДФЛ 13%
- Квартальный: Σ(клиенты квартала×номинал)×множитель (qm2=2, qm3=3); net = ×0.87
- 4 кредита, аннуитет, ~44 144₽/мес
- Номиналы: г3=7200, г4=14400, г56=21600, г78=43200, г9=64000, г10=80000

## Deploy Workflow

### Деплой приложения
Деплой делается через **Vercel MCP tool**, не через `deploy.sh` и не через zip-архивы.
`deploy.sh` существует в репозитории, но для обычной работы не используется.

```
mcp__vercel__deploy_to_vercel  ← стандартный деплой
```

Обычный флоу: `git push` → Vercel автоматически деплоит с main (watch on GitHub).
Форсированный деплой вручную — через `deploy_to_vercel` MCP tool.

### Миграции БД
Все изменения схемы Supabase — через **Supabase MCP tool**:

```
mcp__supabase__apply_migration  ← применить SQL-миграцию
mcp__supabase__list_tables      ← посмотреть текущую схему
mcp__supabase__execute_sql      ← разовый SQL-запрос
```

Перед apply_migration всегда делать `list_tables` чтобы понять текущее состояние схемы.

### Диагностика и логи
```
mcp__vercel__get_runtime_logs       ← логи serverless функций (бот, cron)
mcp__vercel__get_deployment         ← статус конкретного деплоя
mcp__vercel__get_deployment_build_logs  ← логи сборки при ошибке деплоя
mcp__supabase__get_logs             ← логи Supabase (PostgREST, auth и т.п.)
```

## Константы окружения (Vercel env vars)
TELEGRAM_BOT_TOKEN, BOT_WEBHOOK_SECRET, SUPABASE_SERVICE_ROLE_KEY,
ANTHROPIC_API_KEY, GROQ_API_KEY, CRON_SECRET, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY

## Ограничения
- Vercel Hobby: макс 2 cron, 10 сек на serverless функцию
- Telegram: сообщение ≤ 4096 символов, ответ webhook ≤ 60 сек
- Бот: НЕ использовать markdown-таблицы (ломаются на мобильном)

## Правила качества
1. Каждое изменение проходит `npm run build` без ошибок
2. Каждое изменение проходит `npx tsx evals/run.ts`
3. Деструктивные операции бота создают снапшот (для undo)
4. Числа всегда `whiteSpace: nowrap`, лейблы переносятся
5. Бот считает по готовым цифрам из контекста, не пересчитывает сам

## Лог изменений
(добавляй сюда краткую запись после каждой выполненной задачи)
- 2026-06-01: Создан фундамент автономной работы (CLAUDE.md, BACKLOG.md, SPRINTS.md, evals)
- 2026-06-02: Бот переведён на tool calling (надёжное исполнение действий вместо парсинга ACTID). Добавлен mark_recurring_received для стипендии (без двойного учёта).
- 2026-06-02: Интеграция Sprint 1 + tool calling. 44 теста. suggestEarlyRepayment, scenario_analysis tool, авто-income cron, расширенные эвалы.
