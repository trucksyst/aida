# AIDA Session: builds 0.1.16 → 0.1.30
## Дата: 2026-03-03

---

## Сводка изменений

### 1. Контракт v2 — дочистка (build 0.1.16)
- `retell.js`: `broker?.name` → `broker?.company`
- `ui/app.js`: убраны `zip: ''` из search params
- `background.js`: комментарий дедупликации `origin.zip` → `origin.city`

### 2. Build номер в UI и консоли (builds 0.1.17–0.1.19)
- `ui/app.js`: `init()` читает `chrome.runtime.getManifest().version`, выводит в footer (`#status-build`) и в консоль зелёным бейджем
- `background.js`: SW выводит build при старте

### 3. TruckerPath Search — полный рефакторинг (builds 0.1.20–0.1.29)

#### 3.1 Геокодирование city → lat/lon (build 0.1.20)
**Файл:** `truckerpath-adapter.js`
- Добавлена функция `geocodeCity(city, state)` — Nominatim API (бесплатно, без ключа)
- В `search()`: геокодирует origin и destination **перед** модификацией body
- Передаёт координаты через `enrichedParams._originGeo` / `._destGeo`

#### 3.2 Search Cooldown (build 0.1.21)
**Файл:** `background.js`
- `SEARCH_COOLDOWN_MS = 10_000` и `_searchCooldownUntil`
- После `searchLoads()` — 10 секунд cooldown, все harvester intercepts (DAT/TS/TP) игнорируются
- Решает проблему: харвестеры с вкладок бордов перезаписывали результаты AIDA search

#### 3.3 Deep recursive body patching (builds 0.1.22–0.1.24)
**Файл:** `truckerpath-adapter.js`
- `modifyTemplateBody()` — прямой патч для TP body структуры
- `deepPatchAll()` — fallback рекурсивный обход
- Прямой патч: `parsed.query.pickup.geo.location.{lat, lng, address}`
- Прямой патч: `parsed.query.dropoff.geo.location.{lat, lng, address}`
- Прямой патч: `parsed.query.pickup.geo.deadhead.max` (radius)
- Прямой патч: `parsed.query.pickup.date_local.{from, to}`

#### 3.4 Regex string replacement (builds 0.1.25–0.1.26)
**Файл:** `truckerpath-adapter.js` — метод `search()`
- Вместо JSON parsing/patching — **прямая regex замена** в body string
- `body.replace(/"lat"\s*:\s*-?[\d.]+/, ...)` — координаты
- `body.replace(/"address"\s*:\s*"[^"]*"/, ...)` — адрес
- `body.replace(/"max"\s*:\s*\d+/, ...)` — deadhead/radius
- `body.replace(/"from"\s*:\s*"[^"]*"/, ...)` — даты (ISO T00:00:00)
- `body.replace(/"to"\s*:\s*"[^"]*"/, ...)` — даты (ISO T23:59:59)
- `body.replace(/"mark_new_since"\s*:\s*"[^"]*"/, ...)` — текущее время

#### 3.5 URL fix: coyote/chr → main (build 0.1.27)
**Файл:** `truckerpath-adapter.js`
- TP шлёт 3 параллельных запроса: `/tl/search/`, `/tl/coyote/search/`, `/tl/chr/search/`
- Только `/tl/search/filter/web/v2` возвращает `items[]`
- Если шаблон захватил coyote/chr URL → принудительно заменяем на основной

#### 3.6 Equipment mapping (build 0.1.28)
**Файл:** `truckerpath-adapter.js`
- AIDA equipment codes (VAN, REEFER, FLATBED) → TP format (van, reefer, flatbed)
- `body.replace(/"equipment"\s*:\s*\[[^\]]*\]/, ...)`

#### 3.7 Headers fix — CORS (build 0.1.29)
**Файл:** `truckerpath-adapter.js`
- **Главная проблема**: `Origin: chrome-extension://` — TP API отклонял/фильтровал
- Принудительно `delete headers['origin']` + `headers['Origin'] = 'https://loadboard.truckerpath.com'`
- Аналогично для `Referer`
- Удалены `sec-fetch-*` и `:authority/:method/:path/:scheme` pseudo-headers

### 5. Auth Module — Автономная авторизация бордов (build 0.1.31)

#### 5.1 Анализ DAT Auth Flow
- Проанализированы HAR-файлы логина DAT (login.dat.com, pass, cod, akc)
- Выявлен полный Auth0 flow: email → password → MFA SMS → callback#access_token
- Auth0 Client ID: `e9lzMXbnWNJ0D50C2haado7DiW1akwaC`
- Redirect URI: `https://one.dat.com/callback`
- Token lifetime: 3600 sec (1 час)
- Обнаружен silent refresh через `prompt=none`

#### 5.2 Auth модуль (новый блок `background/auth/`)
**Файл:** `background/auth/auth-dat.js`
- `login()` — открывает popup окно `login.dat.com` через `chrome.windows.create`
- Перехватывает callback URL с `access_token` через `chrome.tabs.onUpdated`
- `silentRefresh()` — обновляет токен без участия пользователя (`prompt=none`)
- `getToken()` — возвращает актуальный токен, при необходимости запускает refresh
- `getStatus()` — `'connected'` | `'expired'` | `'disconnected'`
- `_saveToken()` — сохраняет токен + мета-данные (issuedAt, expiresAt, source)

**Файл:** `background/auth/auth-manager.js`
- Единая точка входа для Core: `login(board)`, `getToken(board)`, `getStatus(board)`
- Реестр auth-модулей: `{ dat: AuthDat, truckstop: TODO, tp: TODO }`
- Fallback для бордов без auth-модуля — прямое чтение из Storage
- `handleHarvestedToken()` — обновляет мета-данные при перехвате токена харвестером

#### 5.3 Интеграция с Core (`background.js`)
- Добавлен `import AuthManager`
- Новые message handlers: `LOGIN_BOARD`, `DISCONNECT_BOARD`, `GET_BOARD_AUTH_STATUS`
- `getSettingsForUI()` — статус борда через AuthManager (не требует `tabOpen`)
- `handleTokenHarvested()` — обновляет мета-данные через AuthManager

#### 5.4 UI — двойная логика кнопок бордов (`ui/app.js`)
- Клик на борд без токена + есть auth-модуль → `loginBoard()` → popup логин
- Клик на борд без токена + нет auth-модуля → toast «откройте вкладку борда»
- Клик на подключённый борд → toggle вкл/выкл (как раньше)
- Правый клик → `disconnectBoard()` → удалить токен
- Анимация `logging-in` на кнопке во время логина
- Обновлённые пустые сообщения: «click a board button to log in»

#### 5.5 CSS — новые состояния кнопок (`styles.css`)
- `.board-toggle.expired` — оранжевый пульсирующий индикатор
- `.board-toggle.no-token` — пустой серый круг (приглашение к логину)
- `.board-toggle.logging-in` — анимация при входе
- `@keyframes pulse-dot` — пульсация для expired/logging-in

#### 5.6 Manifest
- Добавлен `https://login.dat.com/*` в `host_permissions`

---

## Файлы изменённые в сессии:
- `background/adapters/truckerpath-adapter.js` — основной рефакторинг
- `background/background.js` — cooldown, auth integration, комментарии, логи
- `background/auth/auth-dat.js` — **НОВЫЙ** — авторизация DAT
- `background/auth/auth-manager.js` — **НОВЫЙ** — менеджер авторизации
- `background/retell.js` — broker.company
- `ui/app.js` — build footer, auth кнопки, zip cleanup
- `ui/components/styles.css` — auth состояния кнопок
- `harvesters/harvester-truckerpath.js` — build version sync
- `manifest.json` — version bumps, login.dat.com host permission

## TODO (для следующего чата):
- [ ] Проверить что TP search реально возвращает грузы в UI
- [ ] Проверить что `findLoadsInResponse` находит `items` ключ
- [ ] Проверить нормализацию TP raw → контракт v2
- [ ] Тестировать Van/Reefer equipment маппинг
- [ ] Реализовать auth-truckstop.js
- [ ] Реализовать auth-truckerpath.js
- [ ] Тестировать silent refresh DAT (через ~50 мин после логина)
