# AIDA v0.1 — Статус по ТЗ

Что сделано и что ещё нужно по [AIDA_v01_TZ.md](./AIDA_v01_TZ.md).

---

## Сделано (реализовано)

### Блоки и файлы

| Блок / функция | Файлы | Статус |
|----------------|--------|--------|
| **Core** | `background/background.js` | ✓ Маршрутизация сообщений, searchLoads, clearActive, saveBookmark, removeBookmark, callBroker, getHistory, getSettings, saveSettings, TOGGLE_AGENT, REFRESH_LOADS, OpenClaw polling, SSE live query |
| **Storage** | `background/storage.js` | ✓ token:, work:loads, settings:user, settings:openclaw, settings:lastSearch, saved:bookmarks, history:calls, clearActive, pruneHistory |
| **Harvester DAT** | `harvesters/harvester-dat.js` | ✓ Перехват Bearer токена (fetch + XHR), перехват ответа поиска (DAT_SEARCH_RESPONSE) с searchId и token |
| **Harvester Truckstop** | `harvesters/harvester-truckstop.js` | ✓ Перехват токена на truckstop.com |
| **Harvester Bridge** | `harvesters/harvester-bridge.js` | ✓ Relay postMessage → chrome.runtime.sendMessage (MAIN → Isolated → Background) |
| **Adapter DAT** | `background/adapters/dat-adapter.js` | ✓ GraphQL FindLoads + GetLocationSuggestions, нормализация, rate limit, worklist API, SSE subscribeLiveQuery |
| **Adapter Truckstop** | `background/adapters/truckstop-adapter.js` | ◐ Заглушка (return []) — реализация в следующей версии |
| **Adapter TruckerPath** | `background/adapters/truckerpath-adapter.js` | ◐ Заглушка (return []) |
| **Retell** | `background/retell.js` | ✓ initiateCall, generateEmail (нет телефона → mailto) |
| **UI** | `ui/sidepanel.html`, `ui/sidepanel.js`, `ui/components/styles.css` | ✓ Полноэкранная вкладка: поиск, таблица грузов, панель деталей, закладки, история, настройки, агент OpenClaw, статус-бар (борды, счётчик, таймер, +N new), тема |

### По пунктам ТЗ (раздел 13 — обязательно в v0.1)

| ТЗ v0.1 | Статус |
|---------|--------|
| Харвестер токенов (DAT) | ✓ |
| Харвестер токенов (Truckstop) | ✓ |
| Адаптер DAT (GraphQL) | ✓ FindLoads + GetLocationSuggestions |
| Адаптер Truckstop (REST) | ◐ Заглушка — нет REST API |
| Поиск грузов (UI + Core) | ✓ + перехват ответа со страницы DAT |
| Storage (токены, work:, settings:) | ✓ + lastSearch |
| Очистка при смене направления (clearActive) | ✓ |
| Закладки (saved) | ✓ + синхронизация с DAT worklist |
| Интеграция Retell (звонки) | ✓ Модуль готов, требуется API-ключ |
| История звонков | ✓ |

### Дополнительно реализовано (не в ТЗ v0.1)

- **SSE live query (DAT)** — подписка на новые грузы в реальном времени через SSE поток. См. раздел «Архитектура SSE» ниже.
- **Перехват ответа поиска** со страницы DAT → грузы в AIDA без повторного запроса к API.
- **GetLocationSuggestions** — резолвинг города → placeId/lat/lng через GraphQL DAT API.
- **Автоподстановка городов** (locations.js) — зоны DAT (Z0–Z9), ~200 городов США, онлайн-поиск через Nominatim.
- **Автозагрузка профиля DAT** — имя, компания, email из identity.api.dat.com.
- **Worklist API** — addToWorklist, updateWorklistStatus, removeFromWorklist (My Loads на DAT).
- **OpenClaw polling** — GET /task + POST /results (в ТЗ помечено v0.2, но реализовано).
- **Keep-alive** — chrome.alarms для предотвращения засыпания Service Worker при активном SSE.
- **Живой таймер** в статус-баре — "just now" / "Xs ago" / "Xm ago" с обновлением каждые 10 сек.
- **Индикатор +N new** — в статус-баре рядом со счётчиком грузов, кликабельный (refresh).

---

## Архитектура SSE — подписка на новые грузы DAT

### Проблема

DAT One (one.dat.com) использует Server-Sent Events (SSE) для push-уведомлений о новых грузах. Стандартный `EventSource` API недоступен в MV3 Service Worker.

### Решение

SSE-клиент реализован на `fetch` + `ReadableStream` + `TextDecoder` внутри Service Worker:

```
┌────────────────────┐   FindLoads    ┌──────────────────────┐
│   UI (вкладка)     │ ────────────→  │   Core (background)  │
│                     │               │                       │
│   +N new (клик)    │ ← pushToUI ── │   startLiveQuery()   │
│   таймер Xm ago   │               │   scheduleLiveRefresh │
└────────────────────┘               └──────────┬────────────┘
                                                │
                                     subscribeLiveQuery(searchId, token)
                                                │
                                     ┌──────────▼────────────┐
                                     │  DAT SSE Endpoint     │
                                     │  liveQueryMatches/v3  │
                                     │  /{searchId}          │
                                     └───────────────────────┘
```

### Поток данных

1. **FindLoads** → ответ содержит `searchId`.
2. **Core** вызывает `startLiveQuery(searchId, token, searchParams)`.
3. **DatAdapter.subscribeLiveQuery** открывает `fetch(GET, Accept: text/event-stream)` к `freight.api.prod.dat.com/notification/v3/liveQueryMatches/{searchId}`.
4. **ReadableStream** парсит SSE-формат (`event:`, `data:`, `id:`, пустая строка — конец блока).
5. При событии с `CREATED` в имени — Core увеличивает `_liveQueryNewCount`.
6. **Debounce push** (3 сек) — события копятся, потом Core шлёт `pushToUI({ newLoadsCount: N })` один раз пачкой.
7. **UI** показывает `+N new` в статус-баре (кликабельно → REFRESH_LOADS).
8. **Debounce refresh** (30 сек тишины) — Core автоматически перезапрашивает FindLoads с теми же параметрами.
9. При новом поиске → `stopLiveQuery()` (AbortController) → новая подписка.

### Типы событий DAT SSE

Фактически наблюдаемые: `DAT_MATCH_CREATED`, `DAT_MATCH_DELETED`, `DAT_MATCH_UPDATED`.
Документированные в API: `EQUIPMENT_MATCH_CREATED/UPDATED/CANCELED`, `LOAD_DATA_CREATED/UPDATED/DELETED`, `SEARCH_MAX`.

### Устойчивость

- **Retry** — до 5 попыток с экспоненциальным backoff (5s × retry).
- **Last-Event-ID** — при reconnect передаётся для продолжения потока.
- **Keep-alive** — `chrome.alarms` (каждые ~25 сек) будит Service Worker.
- **AbortController** — чистая отмена при новом поиске или закрытии.
- **Sanitization** — удаление `\r` и непечатных символов из имён событий (SSE от DAT содержит `\r\n`).

---

## Нужно доработать

| Задача | Приоритет | Заметки |
|--------|-----------|---------|
| Адаптер Truckstop — полноценный REST API | Средний | Сейчас заглушка; нужен реальный API endpoint и нормализация |
| Запросы через контекст вкладки | Низкий | По ТЗ: Origin/Referer через вкладку борда. Сейчас из background с ручными заголовками — работает |
| TruckerPath: харвестер + адаптер | Низкий | Только заглушка |
| Webhook Retell (call_ended) | Средний | Автоматическая смена calling → replied/no_response |
| Settings: вкл/выкл бордов | Низкий | settings:boards[] |

---

## Не входит в v0.1

- SMS через Retell — v0.2
- Автопоиск без участия диспетчера — v0.2
- Мобильное приложение — на будущее
- Харвестеры 3–5 бордов — по готовности

---

## Структура проекта

```
aida/
├── manifest.json              ← MV3 manifest
├── package.json
├── .gitignore
├── background/
│   ├── background.js          ← Core (Service Worker, ~740 строк)
│   ├── storage.js             ← Storage API (~200 строк)
│   ├── retell.js              ← Retell API (~150 строк)
│   └── adapters/
│       ├── dat-adapter.js     ← DAT GraphQL + SSE (~770 строк)
│       ├── truckstop-adapter.js  ← заглушка
│       └── truckerpath-adapter.js ← заглушка
├── harvesters/
│   ├── harvester-bridge.js    ← Relay MAIN→Isolated→Background
│   ├── harvester-dat.js       ← Token + Search intercept (one.dat.com)
│   └── harvester-truckstop.js ← Token intercept (truckstop.com)
├── ui/
│   ├── sidepanel.html         ← Layout (~250 строк)
│   ├── sidepanel.js           ← UI controller (~990 строк)
│   ├── components/styles.css  ← Стили (~600 строк)
│   └── data/locations.js      ← Автоподстановка городов
├── scripts/
│   └── open-dat.js            ← Playwright тест
└── docs/
    ├── AIDA_v01_TZ.md         ← Техническое задание
    ├── STATUS.md              ← Этот файл
    ├── API_REQUESTS.md        ← Примеры запросов
    └── DEBUG.md               ← Отладка
```

---

*Обновлено: 2026-02-28*
