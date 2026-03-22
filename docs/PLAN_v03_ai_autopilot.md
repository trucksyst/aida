# PLAN: AIDA v0.3 — AI Автопилот (поиск через контракт)

> Дата: 2026-03-21 — 2026-03-22
> Основа: Chrome Extension + Gemini AI

---

## Задача

AIDA уже умеет анализировать грузы через AI. Теперь нужно научить AI **искать** — отправлять поисковые запросы через Core pipeline (адаптеры DAT/Truckstop/TP/123LB) независимо от UI диспетчера.

**Принцип:** Диспетчер ищет Chicago в UI. В чате пишет "найди reefer из Dallas". AIDA ищет Dallas через те же адаптеры, результаты попадают в ту же базу (`work:loads`), но привязаны к своему `searchId`. UI диспетчера продолжает показывать Chicago. AI работает со своими грузами из Dallas.

## Архитектура потоков

```
Диспетчер (UI):
  Кнопка Search → SEARCH_LOADS { params, searchId: 'ui' }
    → searchLoads(params, 'ui')
    → mergeLoads(loads, 'ui')   ← чистит старые UI, мержит новые
    → pushToUI()

AI-чат:
  "найди reefer из Dallas"
    → Gemini → { actions: [{ type: 'search', params }] }
    → AI_SEARCH_LOADS { params, searchId: 'ai_xxx' }
    → searchLoadsExternal(params, 'ai_xxx')
    → mergeLoads(loads, 'ai_xxx')
    → результаты → в чат (карточки)

Закрытие чата:
  → clearChatMessages()         ← чистит DOM
  → chatHistory = []            ← стирает память Gemini
  → CLEAR_AI_LOADS              ← удаляет ai_ грузы из Storage
```

## Реализованные изменения

### 1. `background/background.js`

- **`AI_SEARCH_LOADS`** — новый message type. Вызывает `searchLoadsExternal(params, searchId)`. Работает через тот же pipeline адаптеров.
- **`CLEAR_AI_LOADS`** — удаляет все грузы с `searchId` начинающимся на `ai_` из Storage. Вызывается при закрытии чата.
- **`searchLoads()`** — использует `mergeLoads(loads, 'ui')` вместо `clearActive() + setLoads()`. UI-грузы сосуществуют с AI-грузами.
- **`loadMoreLoads()`** — тегирует пагинированные грузы `searchId: 'ui'`.
- **`handleRealtimeUpdate()`** — тегирует auto-refresh грузы `searchId: 'ui'`.

### 2. `background/storage.js`

- **`clearActiveBySearchId(searchId)`** — удаляет только active грузы с данным searchId.
- **`mergeLoads(newLoads, searchId)`** — мерж с дедупликацией по id + по контенту (fingerprint).
- **`_fingerprint(load)`** — отпечаток по всем значимым полям (origin, dest, equipment, rate, rpm, miles, weight, broker, notes, pickupDate). Убирает перепосты с разными id — оставляет самый свежий.

### 3. `background/ai/prompts.js`

- **3-step Search Flow** — пошаговое подтверждение: город → параметры → поиск.
- **`show_loads` action** — AI обязан возвращать ID грузов через action, не текстом. UI рисует карточки.
- **Compressed Load Format** — описание сжатых полей (`o`, `d`, `r`, `rpm`, `mi`, `w`, `eq`, `br`, `n`, `dt`, `len`).
- **`[loadsCount=N]`** — число грузов вставляется в текст сообщения, AI использует его для точного count.
- Equipment маппинг: русские слова → коды (рефрижератор→REEFER, ван→VAN, и т.д.).

### 4. `background/ai/chat.js`

- **Таймаут 45с** (было 12с) — для больших контекстов с 150+ грузами.

### 5. `background/ai/provider.js`

- **Таймаут fallback 60с** (было 12с).
- **Service Worker keepAlive** — `chrome.runtime.getPlatformInfo()` каждые 20с во время fetch. Предотвращает убийство SW Chrome MV3 при длинных запросах к Gemini.

### 6. `ui/ai/chat-widget.js`

- **`executeChatActions()`** — обработка `show_loads` action: находит грузы по id в `state.loads`, рисует карточками.
- **Сжатый контекст** — грузы сжимаются на лету (~150 байт каждый): короткие имена полей, notes до 80 символов, broker без phone/email.
- **Анимация "AI думает..."** — три пульсирующие точки пока ждём ответ.
- **Очистка при закрытии** — close кнопка чистит: сообщения, chatHistory, saveChatHistory(), CLEAR_AI_LOADS.
- **chatHistory persistence** — сохраняется в `chrome.storage.local` ключ `ai:chatHistory` (30 сообщений).
- **Error handling** — catch блок показывает "AI временно недоступен" вместо крэша.

### 7. `ui/components/styles.css`

- **`.ai-thinking`** — стиль для индикатора "AI думает".
- **`@keyframes thinking-blink`** — анимация пульсирующих точек.

### 8. `ui/app.js`

- **`doSearch()`** — убрано прямое `state.loads = loads`. Теперь только `pushToUI` обновляет state — все грузы из Storage (UI + AI).

### 9. Адаптеры (DAT, Truckstop)

- **Удалено поле `raw`** из normalize. Экономия ~80% размера каждого груза.
- **DAT**: `getDatPostingId` использует `externalId` вместо `raw`.
- **Truckstop**: Добавлено поле `_uuid` для enrichment, `_enrichLoads` использует `_uuid` вместо `raw.id`.

## Что НЕ менялось

- Адаптеры (TP, 123LB) — без изменений
- `auth/*` — авторизация без изменений
- `load-card-renderer.js` — карточки без изменений (уже работали)

## Следующие шаги (v0.4)

1. **Параллельные SSE/Polling** — рефакторинг адаптеров для нескольких подписок по searchId
2. **Аналитика по зонам** — статистика траков по регионам, средние цены, hot lanes
3. **Умная дедупликация** — мерж данных с разных бордов (лучшая цена + описание)
4. **Auto-pilot** — AI автоматически ищет и бронирует грузы по заданным критериям
