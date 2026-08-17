// Состояние, ПРИВЯЗАННОЕ К ЗАПРОСУ, а не к процессу.
//
// ПОЧЕМУ НЕ ПРОСТО module-level let:
// Serverless переиспользует разогретый контейнер. Два одновременных запроса
// делят один модуль — второй перезаписывает userMessage первого, и защита
// читает ЧУЖОЙ текст. Проверено экспериментально: гипотетический вопрос
// «если погасить 20000» + параллельная запись → погашение исполнилось,
// потому что в момент проверки в переменной лежал текст другого запроса.
// AsyncLocalStorage даёт каждому запросу свою копию без переписывания
// сигнатур всех функций по цепочке.

import { AsyncLocalStorage } from 'node:async_hooks'

type ReqState = {
  userMessage: string
  // Системный вызов (cron): проверок по тексту пользователя нет, т.к. текста
  // и не было. Иначе fail-safe заблокировал бы легитимные автосписания.
  trusted: boolean
  writeBlocked: string
  correctionRejected: boolean
  memoryOutcome: string
  actionUnrecognized: string
  notFound: string
  usage: Record<string, number>
  lastUsage: Record<string, number>
}

function fresh(trusted: boolean): ReqState {
  return { userMessage: '', trusted, writeBlocked: '', correctionRejected: false,
    memoryOutcome: '', actionUnrecognized: '', notFound: '', usage: {}, lastUsage: {} }
}

const als = new AsyncLocalStorage<ReqState>()

// Вне контекста запроса (cron) возвращаем СВЕЖИЙ объект каждый раз —
// не общий, чтобы параллельные кроны тоже не пересекались.
// Потеря контекста НЕ должна открывать защиты. trusted:false = проверки
// работают. Системные вызовы (cron) получают trusted ЯВНО через runAsSystem.
function cur(): ReqState {
  return als.getStore() ?? fresh(false)
}

// Оборачивает обработку одного пользовательского сообщения.
// Всё внутри получает изолированное состояние.
export function runInRequest<T>(userMessage: string, fn: () => Promise<T>): Promise<T> {
  const st = fresh(false)
  st.userMessage = userMessage
  return als.run(st, fn)
}

// Системный вызов (cron, автосписания): текста пользователя нет, проверки
// по нему неприменимы. Режим включается ЯВНО — не по умолчанию, чтобы
// случайная потеря контекста не открыла защиты.
export function runAsSystem<T>(fn: () => Promise<T>): Promise<T> {
  return als.run(fresh(true), fn)
}

// ── Текст сообщения пользователя ─────────────────────────────────────────
export function getLastUserMessage(): string { return cur().userMessage }

// Сослагательное наклонение: «что если», «если погасить», «предположим».
// Такие вопросы требуют РАСЧЁТА, а не записи в БД.
// ВАЖНО про границы слова: \b в JavaScript определяется через \w = [A-Za-z0-9_],
// то есть ТОЛЬКО латиница. Для кириллицы \b не срабатывает никогда — именно
// поэтому эта защита была мертва и гипотетические погашения исполнялись.
// Используем явные границы: начало/конец строки или не-буква.
//
// Список маркеров пополняется по факту находок. «смоделируй 30000» прошло
// мимо и реально списало деньги: глагол моделирования отсутствовал, а число
// в сообщении отключало вторую защиту. Любой глагол «покажи что было бы»
// должен быть здесь.
const HYPOTHETICAL = /(^|[^а-яёa-z])(если|бы|предполож|допустим|сценари|представ|что будет|что произойдёт|что произойдет|хватит ли|стоит ли|имеет смысл|выгодн|смодел|прикин|сравни|посчитай сколько|каким станет|как изменится|во что выльется|прогноз|симул|вариант)/i
export function isHypothetical(): boolean {
  const st = cur()
  // Диагностика: виден ли контекст запроса в момент проверки
  if (!als.getStore()) console.log('[state] ⚠️ КОНТЕКСТ ПОТЕРЯН при isHypothetical')
  if (st.trusted) return false // системный вызов — блокировать нечего
  // Пустой текст внутри пользовательского запроса = что-то пошло не так.
  // Блокируем: лучше переспросить, чем испортить данные.
  if (!st.userMessage) return true
  return HYPOTHETICAL.test(st.userMessage)
}

// Есть ли в сообщении число, похожее на сумму. Без него правка данных не
// может быть настоящей коррекцией — значит read-only вопрос спровоцировал запись.
// Чистые версии — принимают текст явно, не зависят от контекста.
// Используются там, где текст доступен напрямую.
export function textIsHypothetical(text: string): boolean {
  if (!text) return true
  return HYPOTHETICAL.test(text)
}
export function textHasAmount(text: string): boolean {
  // \d{3,} ловит обычные суммы. Отдельно \b0\b — иначе установка в НОЛЬ
  // никогда не проходила защиту: "Т-Банк дебет 0" не содержит 3+ цифр
  // подряд. Живой случай: пользователь трижды повторил "Т-Банк дебет 0",
  // бот трижды отказал, ссылаясь на "поломанный set_balance" — на самом
  // деле ломался не set_balance, а эта проверка перед ним.
  return /\d{3,}|\b0\b/.test((text ?? '').replace(/\s/g, ''))
}

export function userMessageHasAmount(): boolean {
  const st = cur()
  if (st.trusted) return true // системный вызов не проверяем по тексту
  return /\d{3,}/.test(st.userMessage.replace(/\s/g, ''))
}

// ── Флаги результата последнего действия ─────────────────────────────────
export function setWriteBlocked(reason: string): void { cur().writeBlocked = reason }
export function takeWriteBlocked(): string { const s = cur(); const v = s.writeBlocked; s.writeBlocked = ''; return v }

export function setCorrectionRejected(): void { cur().correctionRejected = true }
export function getCorrectionRejected(): boolean { return cur().correctionRejected }

export function setMemoryOutcome(outcome: string): void { cur().memoryOutcome = outcome }
export function takeMemoryOutcome(): string { const s = cur(); const v = s.memoryOutcome; s.memoryOutcome = ''; return v }

export function setActionUnrecognized(actionType: string): void { cur().actionUnrecognized = actionType }
export function takeActionUnrecognized(): string { const s = cur(); const v = s.actionUnrecognized; s.actionUnrecognized = ''; return v }

// Действие «найти-и-изменить» (удалить трату, отметить цель купленной) не
// нашло подходящую запись и тихо вышло. Без этого флага handleTool падал в
// общий блок, отдающий баланс/карты — вида «факт из БД», и модель сочиняла
// правдоподобный рассказ об успехе поверх операции, которая ничего не сделала.
export function setActionNotFound(what: string): void { cur().notFound = what }
export function takeActionNotFound(): string { const s = cur(); const v = s.notFound; s.notFound = ''; return v }

export function resetActionFlags(): void {
  const s = cur()
  s.correctionRejected = false
  s.memoryOutcome = ''
  s.writeBlocked = ''
  s.actionUnrecognized = ''
  s.notFound = ''
}

// ── Учёт токенов ─────────────────────────────────────────────────────────
// Копится за ВЕСЬ запрос (все раунды tool-loop). Читается через getReqUsage()
// ВНУТРИ контекста — снаружи состояние уже недоступно, это осознанно.
export function resetReqUsage(): void { cur().usage = {} }
export function getReqUsage(): Record<string, number> { return { ...cur().usage } }
export function recordUsage(usage: Record<string, unknown>): void {
  const s = cur()
  s.lastUsage = usage as Record<string, number>
  for (const [k, v] of Object.entries(usage)) {
    if (typeof v === 'number') s.usage[k] = (s.usage[k] ?? 0) + v
  }
  s.usage.rounds = (s.usage.rounds ?? 0) + 1
}

// ── Кеш уровня запроса (TTL 60s) ─────────────────────────────────────────
// Остаётся общим на контейнер СОЗНАТЕЛЬНО: пользователь один, данные те же,
// а TTL 60s ограничивает устаревание. Инвалидируется после любой записи.
const _cache = new Map<string, { value: string; ts: number }>()
const CACHE_TTL = 60_000

export async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const hit = _cache.get(key)
  if (hit && now - hit.ts < CACHE_TTL) return JSON.parse(hit.value) as T
  const value = await fn()
  _cache.set(key, { value: JSON.stringify(value), ts: now })
  return value
}

export function invalidateCache(...keys: string[]): void {
  keys.forEach(k => _cache.delete(k))
}
