# PLAN: Автономные адаптеры — Адаптер как плагин

> Дата: 2026-03-06
> Статус: ✅ РЕАЛИЗОВАНО (TP — в перспективу)

---

## Цель

Сделать каждый адаптер **самодостаточным чёрным ящиком (плагином)**.
Core (`background.js`) не знает деталей ни одного борда.
Подключил адаптер — работает. Отключил — не существует.

**Результат:**
- `background.js`: ~1200 строк → **~1039 строк** (Фаза 4 завершена; до ~300 после удаления harvesters и TP-автономии)
- Добавление нового борда = 1 файл адаптера + 1 строка регистрации в `ADAPTERS`
- Отключение борда = адаптер просто не вызывается

---

## Архитектура блоков: до и после

### СЕЙЧАС (ТЗ §2, 6 блоков)

```
┌─────────────────────────────────────────────────────────┐
│ UI (вкладка расширения)                                  │
│  └─ sendMessage → Core                                   │
├─────────────────────────────────────────────────────────┤
│ Core (background.js ~1200 строк)                         │
│  ├─ Message Router                                       │
│  ├─ searchLoads() — ТОЛСТЫЙ оркестратор                  │
│  │   ├─ Знает про DAT claims, tokens, SSE, searchId     │
│  │   ├─ Знает про TS claims, template, auto-refresh     │
│  │   ├─ Знает про TP template, cachedLoads              │
│  │   └─ Auth error handling для каждого борда            │
│  ├─ startLiveQuery() — DAT SSE (~80 строк)              │
│  ├─ startTsAutoRefresh() — TS alarm (~60 строк)         │
│  ├─ loadMoreLoads() — TS пагинация (~40 строк)          │
│  ├─ handleDatSearchResponse() — DAT harvester           │
│  ├─ handleTruckerpathSearchResponse() — TP harvester    │
│  ├─ handleTokenHarvested() — все борды                   │
│  └─ getSettingsForUI() — hardcoded для каждого борда     │
├───────────────┬─────────────────┬───────────────────────┤
│ Adapter DAT   │ Adapter TS      │ Adapter TP            │
│ (только       │ (только         │ (только               │
│  normalize +  │  normalize +    │  normalize +          │
│  fetch)       │  fetch)         │  fetch)               │
├───────────────┴─────────────────┤                       │
│ Auth Manager                     │                       │
│  ├─ auth-dat.js (зависит от     │                       │
│  │   харвестера в silentRefresh) │                       │
│  └─ auth-truckstop.js (✅ ОК)   │                       │
├──────────────────────────────────┴───────────────────────┤
│ Harvesters (content scripts)                             │
│  ├─ harvester-dat.js ← ещё используется для refresh     │
│  ├─ harvester-truckstop.js ← отключён (§18)             │
│  └─ harvester-truckerpath.js ← ещё используется          │
├─────────────────────────────────────────────────────────┤
│ Storage (chrome.storage.local)                           │
└─────────────────────────────────────────────────────────┘
```

**Проблема:** Core — «толстый» блок, который знает детали КАЖДОГО борда.
Добавление/отключение борда → менять 5-6 мест в Core.

---

### ПОСЛЕ (целевая архитектура)

```
┌─────────────────────────────────────────────────────────┐
│ UI (вкладка расширения)                                  │
│  └─ sendMessage → Core                                   │
├─────────────────────────────────────────────────────────┤
│ Core (background.js ~300 строк)                          │
│  ├─ Message Router (switch/case)                         │
│  ├─ Adapter Registry                                     │
│  │   const ADAPTERS = { dat, truckstop, tp, ... }        │
│  ├─ searchLoads() — ТОНКИЙ оркестратор                   │
│  │   for adapter of getActive() → adapter.search(params) │
│  ├─ Alarm Router                                         │
│  │   onAlarm → route to adapter.handleAlarm()            │
│  ├─ pushToUI(), openAidaInTab()                          │
│  └─ Bookmarks, History CRUD                              │
├─────────────────────────────────────────────────────────┤
│                   ADAPTER REGISTRY                        │
│  ┌─────────────────┐ ┌──────────────────┐ ┌───────────┐ │
│  │ DAT Adapter      │ │ Truckstop Adapter│ │TP Adapter │ │
│  │ (чёрный ящик)    │ │ (чёрный ящик)    │ │(чёрн.ящик)│ │
│  │                  │ │                  │ │           │ │
│  │ ● Auth (auth-dat)│ │ ● Auth (auth-ts) │ │ ● Auth    │ │
│  │ ● Search         │ │ ● Search         │ │ ● Search  │ │
│  │ ● SSE Realtime   │ │ ● Alarm Refresh  │ │           │ │
│  │ ● Pagination     │ │ ● Pagination     │ │           │ │
│  │ ● Status         │ │ ● Status         │ │ ● Status  │ │
│  │ ● Login/Logout   │ │ ● Login/Logout   │ │ ● Login   │ │
│  └─────────────────┘ └──────────────────┘ └───────────┘ │
├─────────────────────────────────────────────────────────┤
│ Storage (chrome.storage.local) — общий                   │
├─────────────────────────────────────────────────────────┤
│ ❌ Harvesters — УДАЛЕНЫ                                  │
└─────────────────────────────────────────────────────────┘
```

**Результат:**
- Core не знает деталей ни одного борда
- Каждый адаптер = самодостаточный блок (Auth + Search + Realtime + Paging + Status)
- Harvesters → удалены (адаптеры полностью автономны)
- Auth-модули → поглощены адаптерами (адаптер сам вызывает свой auth)

### Что поглотил адаптер

| Было отдельным блоком | Стало частью адаптера |
|-----------------------|-----------------------|
| `auth-dat.js` (отдельный) | DAT Adapter вызывает `AuthManager.getToken('dat')` внутри себя |
| `auth-truckstop.js` (отдельный) | TS Adapter вызывает `AuthManager.getToken('truckstop')` внутри себя |
| SSE LiveQuery (в Core) | DAT Adapter → `startRealtime()` / `stopRealtime()` |
| Auto-refresh alarm (в Core) | TS Adapter → `startRealtime()` / `stopRealtime()` |
| Пагинация `_tsOffset` (в Core) | TS Adapter → `loadMore()` |
| `handleDatSearchResponse()` (в Core) | Удалено — адаптер сам делает запросы |
| `handleTokenHarvested()` (в Core) | Удалено — адаптер сам через AuthManager |
| Harvesters (content scripts) | Удалены полностью |

### Блоки ТЗ: маппинг

| ТЗ блок | Было | Стало |
|---------|------|-------|
| **UI** | Без изменений | Без изменений |
| **Core** | ~1200 строк, знает детали каждого борда | ~300 строк, тонкий роутер + оркестратор |
| **Storage** | Без изменений | Без изменений |
| **Harvesters** | 3 content scripts | ❌ Удалены |
| **Adapters** | Только normalize + fetch | **Полный плагин:** auth + search + realtime + paging + status |
| **Auth** | Отдельный блок, вызывается из Core | Вызывается из адаптера (AuthManager остаётся как общий фасад) |
| **Retell** | Без изменений | Без изменений |

---

## Принцип: Единый контракт адаптера

Каждый адаптер экспортирует объект с одинаковым API:

```js
const Adapter = {
    name: 'truckstop',              // уникальное имя борда
    
    // Поиск грузов (основной метод)
    async search(params) → { ok, loads[], meta?, error? }
    
    // Realtime-подписка на новые грузы (опционально)
    // Вызывает onUpdate(loads) при появлении новых грузов
    async startRealtime(params, onUpdate) → void
    stopRealtime() → void
    
    // Дозагрузка (infinite scroll, опционально)
    async loadMore() → { ok, loads[], hasMore }
    
    // Статус подключения
    async getStatus() → { connected, status, hasToken }
    
    // Авторизация
    async login() → { ok, token?, error? }
    async disconnect() → void
}
```

**Ключевое:** адаптер **сам** берёт токен, claims, template — Core не передаёт `ctx`.

---

## Фазы рефакторинга

### Фаза 0: Подготовка
- [x] Создать snapshot/бэкап текущего рабочего кода (git tag `pre-autonomy`) ✅
- [x] Убедиться что всё работает как есть (smoke test) ✅

---

### Фаза 0.5: Исследование DAT Auth API (ДО кода)

> **Цель:** выяснить, есть ли у DAT простой API endpoint для обновления токена (аналог Truckstop `/auth/renew`). Если да — `silentRefresh()` станет одним `fetch()`, все риски снимаются.

**Что исследуем:**

1. **`identity.api.dat.com/auth/token/authorizations/v1`** — виден в HAR. Что принимает, что возвращает?
2. **`identity.api.dat.com/usurp/v1/session/status`** — проверка сессии, может содержать подсказки
3. **`login.dat.com/userinfo`** — OIDC endpoint, может работать с существующим токеном
4. **JS-код DAT** (из HAR) — как сам сайт обновляет токен? Auth0 SDK? Какой метод?

**Метод исследования:**
- Разбор HAR-файлов: request/response `identity.api.dat.com/auth/token/*`
- Анализ JS-бандлов DAT на предмет token refresh логики
- Поиск Auth0 SDK конфигурации (checkSession, getTokenSilently)

**Результат:**
- Если найден API endpoint → `silentRefresh()` = один `fetch()` (как Truckstop) → **все риски сняты**
- Если нет API → используем `chrome.offscreen` (Вариант 2) → средний риск остаётся
- Документ: `docs/RESEARCH_dat_auth_api.md`

---

### Фаза 1: Truckstop Adapter → полная автономия

**Почему первый:** TS уже на 90% автономен — auth-модуль готов, харвестер отключён. Осталось:

#### 1.1 Адаптер берёт токен сам

**Сейчас** (background.js знает про claims):
```js
// background.js
const tsToken = await AuthManager.getToken('truckstop');
const tsClaims = (await chrome.storage.local.get('auth:truckstop:claims'))['auth:truckstop:claims'];
TruckstopAdapter.search(params, { token: tsToken, claims: tsClaims });
```

**После** (адаптер сам):
```js
// truckstop-adapter.js
async search(params) {
    const token = await AuthManager.getToken('truckstop');
    const claims = await this._getClaims();
    if (!token) return { ok: false, error: { code: 'AUTH_REQUIRED' } };
    ...
}
```

- Файлы: `truckstop-adapter.js`
- Убрать: параметр `ctx` из `search()` и `refreshNew()`
- Добавить: `import AuthManager` внутрь адаптера
- Добавить: `_getClaims()` метод внутрь адаптера

#### 1.2 Auto-refresh alarm → внутрь адаптера

**Сейчас** (в background.js ~60 строк):
```js
// background.js
function startTsAutoRefresh(params) { chrome.alarms.create('aida-ts-autorefresh', ...) }
function stopTsAutoRefresh() { chrome.alarms.clear('aida-ts-autorefresh') }
chrome.alarms.onAlarm → if name === 'aida-ts-autorefresh' → refreshNew()
```

**После** (в truckstop-adapter.js):
```js
// truckstop-adapter.js
startRealtime(params, onUpdate) {
    this._realtimeParams = params;
    this._onUpdate = onUpdate;
    chrome.alarms.create('aida-ts-autorefresh', { periodInMinutes: 0.5 });
}
stopRealtime() {
    chrome.alarms.clear('aida-ts-autorefresh');
    this._realtimeParams = null;
}
// + обработчик alarm внутри адаптера
```

- Файлы: `truckstop-adapter.js`, удалить из `background.js`
- Перенести: `startTsAutoRefresh()`, `stopTsAutoRefresh()`, alarm handler

#### 1.3 Пагинация → внутрь адаптера

**Сейчас** (в background.js):
```js
let _tsOffset = 0;
const TS_PAGE_SIZE = 100;
async function loadMoreLoads() {
    _tsOffset += TS_PAGE_SIZE;
    TruckstopAdapter.search({ ...lastSearch, offset: _tsOffset }, { token, claims });
}
```

**После** (в truckstop-adapter.js):
```js
// truckstop-adapter.js
_offset: 0,

async search(params) {
    this._offset = 0;        // сброс при новом поиске
    this._lastParams = params;
    return this._doSearch(params, 0);
}

async loadMore() {
    this._offset += 100;
    return this._doSearch(this._lastParams, this._offset);
}
```

- Файлы: `truckstop-adapter.js`, удалить `_tsOffset` и `loadMoreLoads()` из `background.js`

#### 1.4 Статус и login → через адаптер

**Сейчас** (background.js вызывает AuthManager напрямую для каждого борда):
```js
const tsStatus = await AuthManager.getStatus('truckstop');
```

**После** (адаптер оборачивает):
```js
// truckstop-adapter.js
async getStatus() {
    const status = await AuthManager.getStatus('truckstop');
    return { connected: status === 'connected', status, hasToken: status !== 'disconnected' };
}
async login() { return AuthManager.login('truckstop'); }
async disconnect() { return AuthManager.disconnect('truckstop'); }
```

---

### Фаза 2: DAT Adapter → полная автономия

#### 2.1 auth-dat.js — silentRefresh() без харвестера

**Сейчас:** `silentRefresh()` открывает скрытый таб `one.dat.com/search-loads` и ждёт:
1. Callback URL (парсинг `#access_token=...`) — ✅ работает без харвестера
2. Харвестер `TOKEN_HARVESTED` через `onMessage` — ❌ зависимость
3. Проверка storage после загрузки — ❌ зависимость от харвестера

**После:**
- Убрать listener `onMessage` (TOKEN_HARVESTED) из `silentRefresh()`
- Оставить только перехват callback URL через `chrome.tabs.onUpdated`
- Опция: попробовать Auth0 `prompt=none` для прямого silent auth (без загрузки полной страницы)

**Исследовать:** endpoint `identity.api.dat.com/auth/token/authorizations/v1` — возможно позволяет обновить токен по API (аналог `/auth/renew` у Truckstop). Если да → `silentRefresh()` станет одним `fetch()` вызовом.

- Файлы: `auth-dat.js`

#### 2.2 Адаптер берёт токен сам

**Сейчас:**
```js
// dat-adapter.js
async function search(params) {
    const token = await Storage.getToken('dat');  // прямое обращение к Storage!
    ...
}
```

**После:**
```js
// dat-adapter.js
async search(params) {
    const token = await AuthManager.getToken('dat');  // через AuthManager
    if (!token) return { ok: false, error: { code: 'AUTH_REQUIRED' } };
    ...
}
```

- Файлы: `dat-adapter.js`
- Убрать: `import Storage` (для токена), заменить на `import AuthManager`

#### 2.3 SSE LiveQuery → внутрь адаптера

**Сейчас** (в background.js ~80 строк):
```js
startLiveQuery(searchId, token, params) → SSE stream → pushToUI({ newLoadsCount })
scheduleLiveRefresh() → setTimeout → searchLoads(params)
```

**После** (в dat-adapter.js):
```js
// dat-adapter.js
startRealtime(params, onUpdate) {
    // search() уже вернул searchId — запускаем SSE
    this._subscribeSSE(this._lastSearchId, onUpdate);
}
stopRealtime() {
    this._unsubscribeSSE();
}
```

- Файлы: `dat-adapter.js`, удалить из `background.js`
- Перенести: `startLiveQuery()`, `stopLiveQuery()`, `scheduleLiveRefresh()`, keepalive alarm

#### 2.4 Удалить обработчики харвестера DAT из background.js

- Убрать `handleDatSearchResponse()` (~30 строк)
- В `TOKEN_HARVESTED` handler → игнорировать `dat` (как уже для `truckstop`)
- Убрать `DAT_SEARCH_RESPONSE` из switch/case

#### 2.5 Отключить harvester-dat.js

- Убрать из `manifest.json` → `content_scripts` для `one.dat.com`
- Файл `harvesters/harvester-dat.js` можно удалить или архивировать

---

### ~~Фаза 3: TruckerPath Adapter → полная автономия~~ (ОТЛОЖЕНО)

> **Статус:** В перспективу. Пока нет полного понимания auth-flow TP — не трогаем.
> Когда дойдём до автономии TP — применим тот же паттерн что и для DAT/Truckstop.

---

### Фаза 4: Slim background.js (Core)

После фаз 1-3, `background.js` сводится к:

```
background.js (~300 строк)
├── Imports & constants
├── Adapter Registry
│   const adapters = { dat: DatAdapter, truckstop: TruckstopAdapter, tp: TruckerpathAdapter }
│   function getActiveAdapters(settings)
├── Message Router
│   chrome.runtime.onMessage → switch(type)
├── searchLoads(params)           — тонкий оркестратор (вызвать адаптеры, мерж, Storage, push)
├── Bookmark/History CRUD         — проксирование Storage
├── UI helpers
│   pushToUI(), openAidaInTab(), getSettingsForUI()
├── Alarm router
│   chrome.alarms.onAlarm → route to adapter by alarm name prefix
└── Init
    initOnStartup() → refresh tokens all connected boards
```

#### 4.1 Adapter Registry

```js
import DatAdapter from './adapters/dat-adapter.js';
import TruckstopAdapter from './adapters/truckstop-adapter.js';
import TruckerpathAdapter from './adapters/truckerpath-adapter.js';

const ADAPTERS = {
    dat: DatAdapter,
    truckstop: TruckstopAdapter,
    tp: TruckerpathAdapter,
};

function getActiveAdapters() {
    const disabled = settings.disabledBoards || {};
    return Object.entries(ADAPTERS)
        .filter(([name]) => !disabled[name]);
}
```

#### 4.2 searchLoads() — тонкий оркестратор

```js
async function searchLoads(params) {
    const active = getActiveAdapters();
    
    const results = await Promise.allSettled(
        active.map(([name, adapter]) => adapter.search(params))
    );
    
    // Мерж всех loads (адаптеры уже вернули нормализованные данные)
    const allLoads = [];
    const warnings = [];
    for (const [i, r] of results.entries()) {
        if (r.status === 'fulfilled' && r.value?.ok) {
            allLoads.push(...r.value.loads);
        } else {
            warnings.push(`${active[i][0]}: ${r.reason?.message || r.value?.error?.message}`);
        }
    }
    
    await Storage.setLoads(allLoads);
    await pushToUI({ loads: allLoads });
    
    // Realtime: каждый адаптер запускает свой канал
    for (const [name, adapter] of active) {
        adapter.startRealtime?.(params, (newLoads) => handleRealtimeUpdate(name, newLoads));
    }
    
    return { loads: allLoads, warnings };
}
```

#### 4.3 TOGGLE_BOARD — одна строка логики

```js
case 'TOGGLE_BOARD': {
    // flip disabled flag
    // Если отключили → adapter.stopRealtime()
    // Удалить loads этого борда из Storage
    // push
}
```

#### 4.4 getSettingsForUI() — через реестр

```js
async function getSettingsForUI() {
    const boardStatus = {};
    for (const [name, adapter] of Object.entries(ADAPTERS)) {
        boardStatus[name] = await adapter.getStatus();
        boardStatus[name].disabled = !!disabled[name];
    }
    return { ...settings, boardStatus };
}
```

#### 4.5 Alarm Router

```js
chrome.alarms.onAlarm.addListener((alarm) => {
    // Каждый адаптер регистрирует alarm с префиксом своего имени
    // aida-dat-keepalive → DatAdapter.handleAlarm()
    // aida-ts-autorefresh → TruckstopAdapter.handleAlarm()
    const prefix = alarm.name.replace('aida-', '').split('-')[0];
    const adapter = ADAPTERS[prefix] || ADAPTERS[Object.keys(ADAPTERS).find(k => alarm.name.includes(k))];
    if (adapter?.handleAlarm) adapter.handleAlarm(alarm.name);
});
```

---

### Фаза 5: Обновление ТЗ и manifest

- [ ] Обновить `docs/AIDA_v01_TZ.md` §5 (Adapters) — задокументировать единый контракт адаптера
- [ ] Обновить `docs/AIDA_v01_TZ.md` §18 — закрыть все фазы отказа от Harvesters
- [ ] Обновить `manifest.json` — убрать content_scripts для бордов
- [ ] Удалить файлы харвестеров (или переместить в `_archive/`)

---

## Порядок выполнения

| # | Что | Риск | Зависит от |
|---|-----|------|------------|
| 0 | Git tag `pre-autonomy` | — | — |
| **0.5** | **ИССЛЕДОВАНИЕ: DAT auth API endpoint** | — | 0 |
| 1.1 | TS adapter: убрать `ctx`, сам берёт token/claims | Низкий | 0.5 |
| 1.2 | TS adapter: auto-refresh alarm внутрь | Низкий | 1.1 |
| 1.3 | TS adapter: пагинация внутрь | Низкий | 1.1 |
| 1.4 | TS adapter: getStatus/login/disconnect | Низкий | 1.1 |
| **T** | **Тест: TS полностью автономен** | — | 1.1-1.4 |
| 2.1 | DAT auth: silentRefresh (по результатам исследования 0.5) | Зависит от 0.5 | 0.5 |
| 2.2 | DAT adapter: сам берёт token | Низкий | 2.1 |
| 2.3 | DAT adapter: SSE внутрь | Средний | 2.2 |
| 2.4 | background.js: убрать DAT harvester handlers | Низкий | 2.1-2.3 |
| 2.5 | manifest: отключить harvester-dat.js | Низкий | 2.4 |
| **T** | **Тест: DAT полностью автономен** | — | 2.1-2.5 |
| 4.1 | background.js: Adapter Registry | Низкий | 1, 2 |
| 4.2 | background.js: тонкий searchLoads | Средний | 4.1 |
| 4.3 | background.js: тонкий TOGGLE_BOARD | Низкий | 4.1 |
| 4.4 | background.js: getSettingsForUI через реестр | Низкий | 4.1 |
| 4.5 | background.js: Alarm Router | Низкий | 4.1 |
| **T** | **Финальный тест: всё работает, ~300 строк Core** | — | Всё |
| 5 | Обновить ТЗ, manifest, cleanup | Низкий | Всё |
| — | TP автономия — **в перспективу** | — | — |

---

## Риски и митигация

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| DAT silentRefresh без харвестера не стабилен | Средняя | Auth0 prompt=none проверен. Fallback: исследовать identity.api.dat.com/auth/token |
| Alarm routing конфликты | Низкая | Префикс `aida-{board}-` для каждого alarm |
| Адаптер не может pushToUI напрямую | — | Callback `onUpdate` передаётся при startRealtime() |
| Circular import (adapter ↔ AuthManager) | Низкая | AuthManager не знает об адаптерах, адаптер импортирует AuthManager — одностороннее |

---

## Структура после рефакторинга

```
aida/
├── manifest.json                 ← без content_scripts для бордов
├── background/
│   ├── background.js             ← ~300 строк: router + тонкий оркестратор
│   ├── storage.js
│   ├── auth/
│   │   ├── auth-manager.js       ← без изменений (уже хорош)
│   │   ├── auth-dat.js           ← silentRefresh без харвестера
│   │   ├── auth-truckstop.js     ← без изменений (уже хорош)
│   │   └── auth-truckerpath.js   ← TODO (будущее)
│   └── adapters/
│       ├── dat-adapter.js        ← автономный: auth + search + SSE + loadMore
│       ├── truckstop-adapter.js  ← автономный: auth + search + alarm refresh + loadMore
│       └── truckerpath-adapter.js ← автономный: auth + search
├── _archive/
│   └── harvesters/               ← старые харвестеры (историческая справка)
└── ui/
```

---

### Фаза 6: Глубокая зачистка background.js

> **Цель:** убрать из Core ВСЮ борд-специфичную логику — ни одного `if (board === 'dat')`.
> Перенести `fetchDatProfile` в DAT adapter, удалить мёртвые harvester handler'ы.

#### 6.1 fetchDatProfile → в DAT adapter
- `fetchDatProfile(token)` (~20 строк) — сейчас в background.js, вызывается при `TOKEN_HARVESTED`
- Перенести в `dat-adapter.js` как `DatAdapter.fetchProfile()`
- В background.js: `DatAdapter.fetchProfile().catch(console.warn)`

#### 6.2 Удалить мёртвые harvester handler'ы из background.js
- `handleDatSearchResponse()` — DAT теперь ищет через adapter.search(), intercept не нужен
- `handleTokenHarvested()` — DAT adapter сам берёт токен, harvester legacy
- `handleTruckstopRequestCaptured` — уже удалён (комментарий остался)
- Оставить: `handleTruckerpathSearchResponse()` и `handleTruckerpathRequestCaptured()` (TP пока не автономен)

#### 6.3 Убрать борд-специфичные ветки из message router
- `TOKEN_HARVESTED` + `DAT_SEARCH_RESPONSE` — удалить из switch/case
- Оставить: `TP_SEARCH_RESPONSE`, `TP_SEARCH_REQUEST_CAPTURED` (TP ещё не автономен)

#### 6.4 Убрать неиспользуемые импорты
- `normalizeDatResults` — больше не используется в background.js (intercept удалён)
- `normalizeTruckstopResults` — уже не используется

---

## Метрика успеха

- [x] Adapter Registry — добавление борда = 1 файл + 1 строка ✅
- [x] `searchLoads()` — generic loop, без борд-специфичного кода ✅
- [x] `getSettingsForUI()` — через registry ✅
- [x] Единый `handleRealtimeUpdate()` для всех бордов ✅
- [ ] `background.js` ≤ 900 строк (после Фазы 6)
- [ ] Ноль `if (board === 'dat')` или `if (board === 'truckstop')` в `background.js` (кроме TP legacy)
- [ ] Все тесты работают: login, search, realtime, loadMore, toggle, disconnect

