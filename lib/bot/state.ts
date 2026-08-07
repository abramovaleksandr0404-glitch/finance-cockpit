// ЕДИНСТВЕННЫЙ владелец изменяемого состояния бота.
//
// ПОЧЕМУ ЧЕРЕЗ ФУНКЦИИ, А НЕ ПРОСТО export let:
// В ES-модулях импортированную переменную НЕЛЬЗЯ присвоить — только прочитать.
// Если бы actions.ts объявил собственную копию флага, а bot.ts читал свою,
// они бы молча разошлись: запись в одном файле не видна в другом, при этом
// TypeScript не выдаёт ни единой ошибки. Ровно так упал прод в июне.
// Поэтому переменные живут ТОЛЬКО здесь, а доступ — через set/take/get.
//
// НЕ добавлять сюда бизнес-логику. Только хранение и доступ.

// ── Текст последнего сообщения пользователя ──────────────────────────────
// Пишется точками входа (processWithModel / processWithModelForTest),
// читается защитами внутри executeAction.
let _lastUserMessage = ''
export function setLastUserMessage(text: string): void { _lastUserMessage = text }
export function getLastUserMessage(): string { return _lastUserMessage }

// Сослагательное наклонение: «что если», «если погасить», «предположим».
// Такие вопросы требуют РАСЧЁТА, а не записи в БД. Без этой проверки бот
// исполнял гипотетические сценарии как реальные операции.
const HYPOTHETICAL = /\b(если|бы|предполож|допустим|сценари|представ|что будет|хватит ли|стоит ли|имеет смысл|выгодн)\b/i
export function isHypothetical(): boolean {
  // Пустое значение = входная точка не выставила текст. Считаем ситуацию
  // подозрительной и блокируем запись: лучше переспросить, чем испортить данные.
  if (!_lastUserMessage) return true
  return HYPOTHETICAL.test(_lastUserMessage)
}

// Есть ли в сообщении пользователя число, похожее на сумму. Без него
// правка данных не может быть настоящей коррекцией — значит read-only
// вопрос спровоцировал запись, и её надо заблокировать.
export function userMessageHasAmount(): boolean {
  return /\d{3,}/.test(_lastUserMessage.replace(/\s/g, ''))
}

// ── Флаги результата последнего действия ─────────────────────────────────
// Пишутся в executeAction, читаются в handleTool. Семантика везде
// «прочитать и сбросить», поэтому take* вместо get*.

let _lastWriteBlocked = ''
export function setWriteBlocked(reason: string): void { _lastWriteBlocked = reason }
export function takeWriteBlocked(): string { const v = _lastWriteBlocked; _lastWriteBlocked = ''; return v }

let _lastCorrectionRejected = false
export function setCorrectionRejected(): void { _lastCorrectionRejected = true }
export function getCorrectionRejected(): boolean { return _lastCorrectionRejected }

let _lastMemoryOutcome = ''
export function setMemoryOutcome(outcome: string): void { _lastMemoryOutcome = outcome }
export function takeMemoryOutcome(): string { const v = _lastMemoryOutcome; _lastMemoryOutcome = ''; return v }

let _lastActionUnrecognized = ''
export function setActionUnrecognized(actionType: string): void { _lastActionUnrecognized = actionType }
export function takeActionUnrecognized(): string { const v = _lastActionUnrecognized; _lastActionUnrecognized = ''; return v }

// Сброс перед каждым вызовом executeAction — иначе прошлый результат
// протечёт в следующий инструмент.
export function resetActionFlags(): void {
  _lastCorrectionRejected = false
  _lastMemoryOutcome = ''
  _lastWriteBlocked = ''
  _lastActionUnrecognized = ''
}

// ── Учёт токенов ─────────────────────────────────────────────────────────
// _reqUsage копится за ВЕСЬ запрос (все раунды tool-loop), _lastUsage —
// только последний раунд. Без накопления стоимость занижалась в 3-5 раз.
export let _lastUsage: Record<string, number> = {}
export let _reqUsage: Record<string, number> = {}
export function resetReqUsage(): void { _reqUsage = {} }
export function recordUsage(usage: Record<string, unknown>): void {
  _lastUsage = usage as Record<string, number>
  for (const [k, v] of Object.entries(usage)) {
    if (typeof v === 'number') _reqUsage[k] = (_reqUsage[k] ?? 0) + v
  }
  _reqUsage.rounds = (_reqUsage.rounds ?? 0) + 1
}

// ── Кеш уровня запроса (TTL 60s) ─────────────────────────────────────────
// Один раз за запрос, а не 8 раз. Инвалидируется после любой записи в БД.
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
