# AIDA v0.1 — Техническое Задание

Chrome Extension · Агрегатор лоадбордов · Диспетчерский инструмент

---

## 1. Концепция и Назначение

Aida — персональный инструмент диспетчера. Не корпоративная система, не SaaS платформа — личный суперинструмент, который работает в фоне, пока диспетчер занимается своей работой.

**Основная идея:** один запрос диспетчера — данные сразу со всех подключённых лоадбордов в одном окне. Агенты (AI-помощники) помогают анализировать и действовать, но человек остаётся за рулём.

### Ключевые принципы

- Один диспетчер, один браузер, 3–5 лоадбордов одновременно.
- Все данные в одном окне — никаких переключений между вкладками бордов.
- Агенты помогают, но не заменяют диспетчера.
- Простая модульная архитектура — каждый блок можно починить, не трогая остальные.
- Браузер всегда открыт — это рабочий инструмент диспетчера, не приложение которое закрывают.

---

## 2. Архитектура — Блоки и их Роли

### Обзор блоков

Расширение состоит из 7 независимых блоков. Каждый блок имеет свой контракт (API) и не знает о внутреннем устройстве других.

| Блок      | Место                         | Кто вызывает      | Зона ответственности                                    |
|-----------|-------------------------------|--------------------|---------------------------------------------------------|
| UI        | Полноэкранная вкладка расширения (отдельная страница) | Диспетчер | Отображение грузов, настройки, закладки, история       |
| AI Block  | Service Worker (модуль Core) | Core, UI (чат)     | AI-анализ грузов, чат-интенты, рекомендации действий    |
| Core      | Service Worker (background.js) | UI, агенты         | Маршрутизация команд, агрегация данных, бизнес-логика  |
| Storage   | chrome.storage.local          | Core, Harvesters   | Единое хранилище всех данных расширения                 |
| Harvesters| Content Scripts на вкладках бордов | Страницы DAT, TS и др. | Перехват токенов, передача в Storage              |
| Adapters  | Модули внутри Core            | Core               | Запросы к API борда, приведение к единому формату (по DAT) |
| Retell    | Модуль внутри Core            | Core               | Звонки, SMS, email через Retell API                    |

### AI Block — режим работы

- AI Block включается/выключается в настройках (`enabled`).
- При `enabled=true` Core передаёт в AI Block нормализованные грузы из внутреннего потока (`Adapters → Storage:work:loads`).
- При `enabled=false` или ошибке AI система работает в штатном режиме без AI-решений.
- AI Block не выполняет действия напрямую: он возвращает решения/рекомендации Core, а Core решает, что запускать (call/email/telegram).
- Авторизация AI — только через `OAuth` (`chrome.identity.getAuthToken`), без `API key`.
- `OAuth client_id` задаётся в `manifest.json`, а рабочий `projectId` и runtime-параметры хранятся в `settings:ai`.
- Для диспетчера сценарий входа только один: Google OAuth popup (one-click), без ввода логина/пароля.

### AI Block — фактическая реализация подключения

Подключение AI реализовано и проверено в рабочем потоке чата.

**Что добавлено в коде:**

- `manifest.json`
  - permission: `identity`
  - `oauth2.client_id`
  - scope: `https://www.googleapis.com/auth/cloud-platform`
  - host permissions для `https://aiplatform.googleapis.com/*` и `https://*.aiplatform.googleapis.com/*`
- `background/ai-block.js`
  - получение токена через `chrome.identity.getAuthToken()`
  - кэширование `oauthAccessToken`, `oauthExpiresAt`, `oauthScopeKey` в `settings:ai`
  - вызов Vertex AI `generateContent` через `fetch()`
  - fallback при ошибках без падения Core
- `background/background.js`
  - message routes: `GET_AI_STATUS`, `AI_AUTH_CONNECT`, `AI_AUTH_DISCONNECT`, `AI_CHAT`, `AI_ANALYZE_LOADS`
- `background/storage.js`
  - namespace `settings:ai`
  - миграция AI-настроек при чтении/сохранении
- `ui/app.html`, `ui/app.js`, `ui/components/styles.css`
  - плавающий чат-виджет
  - auto-connect при первом открытии
  - блокировка повторных бесконечных попыток входа после отказа пользователя

**Фактический flow подключения:**

1. Диспетчер нажимает на виджет чата.
2. UI вызывает `AI_AUTH_CONNECT` в `background.js`.
3. `background/ai-block.js` запускает `chrome.identity.getAuthToken({ interactive: true })`.
4. Chrome открывает Google OAuth popup.
5. После успешного входа access token сохраняется в `settings:ai`.
6. Следующие запросы в чат используют уже кэшированный токен без повторного popup.
7. UI передаёт сообщение в `AI_CHAT`.
8. AI Block вызывает Vertex endpoint `generateContent`.
9. Ответ возвращается в чат и, если нужно, преобразуется в `actions[]`.

**Фактический endpoint:**

- используется Vertex AI, а не прямой API key Gemini
- endpoint:
  `https://aiplatform.googleapis.com/v1/projects/{projectId}/locations/global/publishers/google/models/{model}:generateContent`
- рабочая модель: `gemini-2.5-flash`

**Нюансы, которые пришлось учесть:**

- `gemini-2.0-flash` для новых проектов больше не подходит как основной дефолт; рабочий дефолт переведён на `gemini-2.5-flash`.
- регион `us-central1` вызывал ошибку `Publisher Model`; для Vertex в проекте используется `location=global`.
- `generative-language` scope оказался неверным для этого сценария; оставлен только `cloud-platform`.
- ручные поля `client id`, `project id`, `api key` убраны из пользовательского UX.
- после смены scope старый токен обязан сбрасываться, иначе чат продолжает работать с невалидным кэшем.
- при отказе пользователя в Google popup UI не должен бесконечно зацикливать повторную авторизацию.
- AI не ломает основной продуктовый поток: при ошибке чата поиск и работа с грузами продолжаются.


### Chat Widget (UI)

- В интерфейсе есть виджет чата в правом нижнем углу (иконка дроида).
- По умолчанию виджет свернут.
- При первом раскрытии автоматически запускается Google OAuth popup для подключения AI-чата.
- При отмене/ошибке входа виджет показывает короткое сообщение и кнопку повторного входа через Google.
- Технические OAuth-поля скрыты от диспетчера в чате (админская преднастройка).
- После onboarding чат работает в обычном режиме помощника.

### Telegram в рамках расширения

- Telegram интегрируется напрямую из Service Worker через Bot API (`fetch`) без отдельного backend.
- Ошибки Telegram не блокируют основной поток поиска/обработки грузов (используется ретрай и логирование).

---

## 3. Storage — Единое Хранилище

**Технология:** Всё хранится в `chrome.storage.local`. Одно хранилище, разделение по namespace через префиксы ключей. Session storage не используется.

### Структура данных (Namespaces)

| Namespace  | Ключи                          | Кто пишет   | Кто читает    |
|------------|---------------------------------|-------------|----------------|
| token:     | token:dat, token:truckstop, ...  | Harvesters  | Core, Adapters |
| work:      | work:loads[], work:search_params | Core        | Core           |
| settings:  | settings:user, settings:boards[], settings:ai | Core        | Core           |
| saved:     | saved:bookmarks[]               | Core        | Core           |
| history:   | history:calls[], history:loads[] | Core        | Core           |

**Важно:** UI и внешние клиенты не обращаются к Storage. Чтение Storage выполняет только Core (и харвестеры только пишут токены). Данные до UI доходят исключительно через API Core (раздел «Взаимодействие блоков»).

### Статусы карточки груза

- **active** — текущий активный поиск по выбранному направлению.
- **saved** — диспетчер сохранил груз в закладки.
- **called** — был совершён звонок, груз попал в историю.

### Очистка при смене направления

`clearActive()` — удаляет все ключи work:* где `status === 'active'`. Ключи saved:* и history:* не трогаются никогда.

---

## 4. Harvesters — Сборщики Токенов

**Принцип:** Харвестер — content script на вкладке лоадборда. Единственная задача — поймать свежий токен из исходящих запросов. Не трогает DOM, не нажимает кнопки.

**Механизм:** Monkey-patching `fetch` и `XMLHttpRequest`. При запросе с `Authorization: Bearer <token>` харвестер передаёт токен в background → Core → Storage.setToken().

**По бордам:**

- harvester-dat.js — freight.api.dat.com
- harvester-truckstop.js — truckstop.com/api
- harvester-truckerpath.js — Trucker Path API
- (+2 борда по аналогии)

### Перехват данных с бордов

Харвестеры не только собирают токены, но и передают в Core перехваченные ответы API борда, чтобы не дублировать запросы и получать данные в том же виде, что и на странице борда.

- **Перехват ответа поиска (реализовано).** На вкладке борда (например, one.dat.com) при выполнении пользователем поиска грузов харвестер перехватывает ответ (GraphQL/REST), извлекает список грузов и отправляет в Core (например, сообщение типа DAT_SEARCH_RESPONSE с сырыми результатами). Core нормализует данные в единый формат, выполняет дедупликацию и записывает в Storage (work:loads). UI затем получает обновлённый список через API Core (GET_LOADS или push). Таким образом, один поиск на сайте борда сразу даёт те же грузы в AIDA без повторного запроса к API из расширения.

- **Перехват вновь поступивших грузов (реализовано для DAT).**
  DAT использует SSE (Server-Sent Events) для уведомления о новых грузах. Механизм:
  1. При поиске (FindLoads) в `criteria.delivery` передаётся `{ notify: true, includeSimilarResults: true }`.
  2. В ответе FindLoads приходит `searchId` — уникальный идентификатор сессии поиска.
  3. Core (background.js) открывает SSE-поток: `GET https://freight.api.prod.dat.com/notification/v3/liveQueryMatches/{searchId}` с `Accept: text/event-stream` и `Authorization: Bearer {token}`.
  4. SSE-поток шлёт события: `EQUIPMENT_MATCH_CREATED` (новый груз), `EQUIPMENT_MATCH_UPDATED` (обновлён), `EQUIPMENT_MATCH_CANCELED` (отменён), `SEARCH_MAX` (лимит).
  5. При `EQUIPMENT_MATCH_CREATED` Core пушит в UI счётчик новых грузов (`{ newLoadsCount: N }`).
  6. UI показывает бар «N new loads available — click to refresh». По клику UI отправляет `REFRESH_LOADS` → Core повторяет FindLoads с теми же параметрами, новая SSE-подписка заменяет старую.
  7. Предыдущая SSE-подписка автоматически закрывается при новом поиске (abort).
  8. Keep-alive через `chrome.alarms` (каждые ~25 сек) не даёт Service Worker заснуть, пока SSE активен.
  Для Truckstop и других бордов механизм определяется отдельно при реализации.

### 4.1 Auth Module — Автономная авторизация бордов

**Принцип:** Auth-модуль позволяет подключать борды без необходимости держать открытой вкладку борда. Пользователь логинится один раз через popup окно в расширении, после чего модуль автоматически поддерживает сессию через silent refresh.

**Архитектура:**

```
background/auth/
├── auth-manager.js    — Единая точка входа. Core вызывает только его.
├── auth-dat.js        — Auth0 flow для DAT
├── auth-truckstop.js  — PingOne flow для Truckstop (popup login + API /auth/renew silent refresh)
└── auth-truckerpath.js — (TODO) Авторизация TruckerPath
```

**API AuthManager:**

| Метод                     | Возвращает                    | Описание                                      |
|---------------------------|-------------------------------|-----------------------------------------------|
| `login(board)`            | `{ ok, token?, error? }`      | Открыть popup логина борда                    |
| `getToken(board)`         | `string \| null`              | Актуальный токен (с авто-refresh)             |
| `getStatus(board)`        | `'connected' \| 'expired' \| 'disconnected'` | Статус подключения              |
| `getAllStatuses()`        | `{ dat: {...}, ts: {...} }`   | Статусы всех бордов                           |
| `disconnect(board)`       | `void`                        | Удалить токен и мета-данные                   |
| `silentRefresh(board)`    | `{ ok, token?, reason? }`     | Обновить токен без участия пользователя        |
| `handleHarvestedToken(board, token)` | `void`             | Сохранить токен от харвестера с мета-данными   |

**Message types (Core API):**

| Тип                    | Параметры       | Описание                            |
|------------------------|-----------------|-------------------------------------|
| `LOGIN_BOARD`          | `{ board }`     | Открыть popup логина для борда      |
| `DISCONNECT_BOARD`     | `{ board }`     | Отключить борд (удалить токен)      |
| `GET_BOARD_AUTH_STATUS` | —              | Получить статусы всех бордов        |

**Flow логина DAT (Auth0):**

1. UI отправляет `LOGIN_BOARD { board: 'dat' }`
2. AuthManager вызывает `AuthDat.login()` → `chrome.windows.create({ type: 'popup' })` на `one.dat.com`
3. Пользователь вводит email → пароль → SMS-код (MFA)
4. Auth0 делает redirect: `one.dat.com/callback#access_token=eyJ...`
5. AuthDat перехватывает URL через `chrome.tabs.onUpdated`, парсит `access_token`
6. Токен сохраняется в `token:dat` (Storage) + мета-данные в `auth:dat:meta` (issuedAt, expiresAt)
7. Popup закрывается, UI обновляет статус борда → 🟢 Connected

**Silent Refresh:**

- Токен DAT живёт 30 минут (1800 сек). Стратегия «refresh at every use»: при каждом getToken() запускается fire-and-forget silentRefresh().
- Механизм: прямой `fetch()` к `login.dat.com/authorize?prompt=none&response_mode=web_message` с Auth0 session cookies из `chrome.cookies` API.
- Auth0 возвращает HTML с access_token в body → токен извлекается regex-ом.
- Без табов, без окон, без offscreen, без харвестера — один HTTP-запрос.
- Если сессия Auth0 мертва → статус борда → `'expired'` → пользователь видит пульсирующую кнопку и может перелогиниться кликом.

**Silent Refresh Truckstop:**

- Токен Truckstop обновляется через API: `POST https://v5-auth.truckstop.com/auth/renew` с текущим JWT.
- Стратегия та же: «refresh at every use» + proactive refresh по alarm каждые 15 минут.

**Flow логина TruckerPath (REST API):**

1. UI отправляет `LOGIN_BOARD { board: 'tp' }`
2. AuthManager вызывает `AuthTruckerpath.login()` → popup `loadboard.truckerpath.com/login`
3. Пользователь вводит email + password
4. При submit — прямой API вызов:
   ```
   POST https://api.truckerpath.com/tl/login/web/v2
   Headers:
     client: WebCarriers/0.0.0
     installation-id: {uuid}  ← генерируется один раз, хранится в Storage
     signature: {md5_hash}    ← MD5 подпись (см. ниже)
     timestamp: {unix_ms}     ← текущее время в ms
     Content-Type: application/json;charset=UTF-8
   Body:
     { email, password, is_reactive: 0, grant_type: "password", device_token: "" }
   ```
5. Response: `{ code: 200, data: { token: "r:{hex32}", expires_in: 30306379, refresh_token: "uuid" } }`
6. Токен сохраняется в `token:truckerpath` (Storage) + мета-данные в `auth:truckerpath:meta`
7. Popup закрывается, UI обновляет статус борда → 🟢 Connected

**Генерация signature (MD5):**
```
signature = MD5(
  "device_token=&email={email}&grant_type=password&password={password}"
  + "&installationId={uuid}&secret=eyFsGFeZ@Sajb$ZW"
  + "&timestamp={timestamp}&url=/tl/login/web/v2"
)
```
- Секрет `eyFsGFeZ@Sajb$ZW` — hardcoded в JS сайта
- MD5 через `blueimp-md5` (или встроенный crypto)
- Подпись требуется **только** для login endpoint, остальные запросы — без подписи

**Хранение токена в TP:**
- TP React-приложение хранит токен в `localStorage.accessToken`
- Все API запросы: заголовок `x-auth-token: r:{hex32}` (не `Authorization: Bearer ...`!)
- Доп. заголовки: `client: WebCarriers/0.0.0`, `installation-id: {uuid}`

**Silent Refresh TruckerPath:**

- Токен живёт **~351 день** (`expires_in: 30306379` сек) — почти год, refresh практически не нужен.
- Проверка валидности: `GET /tl/users/me` с `x-auth-token` → 200 = токен жив.
- `refresh_token` есть в response, но сайт его **не использует** (нет endpoint для refresh).
- Стратегия: при каждом `getToken()` → fire-and-forget проверка через `/tl/users/me`.
- При ошибке 401/403 → статус `'expired'` → пользователь перелогинивается.

**Без авторизации:**
- Поиск грузов работает, но `broker` ограничен — только `company` (нет email, phone, mc, dot, rating).
- Для полноценной работы авторизация обязательна.

**Исследование TruckerPath API (справка):**

- Base URL: `https://api.truckerpath.com`
- Login: `POST /tl/login/web/v2` — email + password + MD5 signature
- Поиск: `POST /tl/search/filter/web/v2` — основной поиск грузов
- Доп. поиски: `/tl/coyote/search/filter/web/v2` (Coyote), `/tl/chr/search/filter/web/v2` (CHR) — параллельные, обычно пустые
- Обратные грузы: `POST /tl/backhaul`
- Профиль: `GET /tl/users/me`
- Геокодинг: `POST /tl/city/place`, `POST /tl/state/city/city-auto-complete`
- reCAPTCHA: запрашивается при ошибке `code: 900006` (2-я попытка логина)

**Совместимость:**

- DAT harvester **удалён** из manifest.json — не нужен для silent refresh.
- Борд считается `connected` если есть актуальный токен. Открытая вкладка борда **не обязательна**.

**Исследование DAT Auth API (справка):**

- Прямого API endpoint для обновления токена (аналог Truckstop `/auth/renew`) **нет**.
- DAT использует Auth0 JS SDK v9.30.0 (`getTokenSilently()`).
- Реализован **direct fetch** — `fetch()` к `login.dat.com/authorize?prompt=none&response_mode=web_message` с cookies из `chrome.cookies` API.
- Auth0 возвращает HTML: `{type: "authorization_response", response: {access_token: "eyJ..."}}` — токен парсится regex.
- Auth0 config: `client_id=e9lzMXbnWNJ0D50C2haado7DiW1akwaC`, `audience=https://prod-api.dat.com`.
- JWT lifetime: **1800 сек (30 мин)**, подтверждено из HAR (`iat`/`exp`).
- Исследованные endpoints: `identity.api.dat.com/auth/token/authorizations/v1` (permissions, не токен), `usurp/v1/session/status` (usurp check), `login.dat.com/userinfo` (профиль, не токен).

**Исследование Truckstop GraphQL API (справка):**

- GraphQL endpoint: `https://loadsearch-graphql-api-prod.truckstop.com/v1/graphql` — **не требует Authorization header**.
- Авторизация через user-specific IDs в GraphQL variables (не через HTTP headers).
- User IDs берутся из JWT claims: `v5AccountId` → `carrier_id`, `accountUserId` → `gl_carrier_user_id`, `v5AccountUserId` → `account_user_id`.
- Claims парсятся из JWT через `auth-truckstop.js._decodeJwtClaims()`.
- Два GraphQL query: `LoadSearchSortByBinRateDesc` (основной), `LoadSearchSortByUpdatedOnDesc` (auto-refresh).
- Fragment: `GridLoadSearchFields on loads_grid_ret_type` — все поля грузов.
- Доп. endpoints: `user-preferences-api.truckstop.com/user` (профиль), `accounts/factoring-company` (факторинг, может 404).


**UI — кнопки бордов (footer):**

| Состояние        | Визуал          | Клик                    | Правый клик      |
|------------------|-----------------|-------------------------|------------------|
| Нет токена       | ○ серый кружок  | Открыть popup логина    | —                |
| Connected        | ● зелёный       | Toggle вкл/выкл         | Отключить (удалить токен) |
| Expired          | ◉ оранж. пульс  | Открыть popup re-login  | Отключить        |
| Disabled         | ● красный       | Включить                | —                |

---

## 5. Adapters — Автономные Плагины

**Каждый адаптер — полностью автономный чёрный ящик (плагин).**
Core (`background.js`) не знает деталей ни одного борда. Подключил адаптер — работает. Отключил — не существует.

Адаптер сам:
- Берёт токен / template из Storage / AuthManager
- Делает запрос к API борда (GraphQL, REST, SSE)
- Нормализует ответ в единый формат
- Управляет своей авторизацией, пагинацией, realtime-подпиской

Добавление нового борда = **1 файл адаптера** + **1 строка в `ADAPTERS` registry** в `background.js`.

### 5.1 Единый контракт адаптера

```js
const Adapter = {
    // ─── Основные методы ─────────────────────────────────────

    /**
     * Поиск грузов по параметрам.
     * Адаптер сам берёт токен, делает запрос к API, нормализует ответ.
     * Автоматически запускает realtime-подписку на новые грузы.
     * При повторном вызове — предыдущая подписка автоматически закрывается.
     * @param {object} params - { origin, destination, equipment, radius, dateFrom, dateTo }
     * @returns {{ ok: boolean, loads: Load[], meta?: object, error?: { code, message } }}
     */
    async search(params),

    /**
     * Дозагрузка (infinite scroll / пагинация).
     * Подгружает следующую страницу результатов — offset увеличивается внутри адаптера.
     * Сейчас реализовано только в Truckstop (GraphQL поддерживает offset).
     * @returns {{ ok: boolean, loads: Load[], hasMore: boolean }}
     */
    async loadMore(),

    /**
     * Зарегистрировать callback для realtime updates (один раз при старте).
     * Адаптер вызывает fn(board, event) при появлении новых грузов.
     * DAT: SSE → event = { type: 'newCount'|'refresh', ... }
     * TS: alarm polling → event = loads[]
     * @param {function} fn - callback(board, event)
     */
    setRealtimeCallback(fn),

    // ─── Авторизация ─────────────────────────────────────────

    /**
     * Статус подключения к борду.
     * DAT/TS: проверяет токен через AuthManager (с авто-refresh).
     * TP: проверяет наличие сохранённого template.
     * @returns {{ connected: boolean, status: string, hasToken: boolean, hasAuthModule: boolean }}
     */
    async getStatus(),

    /**
     * Логин на борд.
     * DAT: popup → Auth0 flow → callback с токеном.
     * TS: popup → truckstop.com login → cookie extraction.
     * TP: нет auth-модуля — возвращает инструкцию залогиниться на вкладке.
     */
    async login(),

    /** Отключение от борда: очистка токена/template, остановка realtime. */
    async disconnect(),

    // ─── Harvester handlers (если нужны) ─────────────────────

    /**
     * ВРЕМЕННО: перехват грузов от content script на вкладке TP.
     * Будет удалено после исследования и полной отвязки TP от страницы.
     * @param {array} rawResults - сырые данные грузов
     * @param {string} sourceUrl - URL откуда перехвачено
     */
    async handleSearchResponse(rawResults, sourceUrl),

    /**
     * ВРЕМЕННО: перехват запроса → сохранение как template для replay.
     * Будет удалено после исследования и полной отвязки TP от страницы.
     * @param {object} msg - { url, method, headers, body }
     */
    async handleRequestCaptured(msg),

    // ─── Специфичные (опционально) ───────────────────────────

    /** Загрузить профиль пользователя с борда (только DAT). */
    async fetchProfile(),
};
```

### 5.2 Adapter Registry

```js
// background.js — единственное место регистрации
const ADAPTERS = {
    dat:       { module: DatAdapter,         displayName: 'DAT',         hasAuthModule: true  },
    truckstop: { module: TruckstopAdapter,   displayName: 'Truckstop',   hasAuthModule: true  },
    tp:        { module: TruckerpathAdapter,  displayName: 'TruckerPath', hasAuthModule: false },
    '123lb':   { module: LB123Adapter,       displayName: '123LB',       hasAuthModule: true  },
};
```

Core вызывает методы через registry: `ADAPTERS[board].module.search(params)`.
Ни одного `if (board === 'dat')` в `background.js`.

### 5.3 Контракт данных — единый формат карточки груза

**Контракт данных — максимальное объединение полей всех бордов.** Каждый адаптер извлекает **ВСЕ** доступные данные из raw-ответа своего борда и маппит их в единый максимальный формат. Поля, отсутствующие у конкретного борда, остаются пустыми (`''`, `null`, `0`). UI выбирает из контракта нужные поля для отображения.

### Единый формат карточки груза (финальный контракт v2)

```js
{
  // === Идентификация ===
  id:            string,          // уникальный ID (boardPrefix + originalId)
  board:         'dat'|'ts'|'tp'|'123lb', // источник
  externalId:    string,          // ID на борде

  // === Origin ===
  origin: {
    city:        string,
    state:       string,          // 2-буквенный код
    lat:         number | null,
    lng:         number | null,
  },

  // === Destination ===
  destination: {
    city:        string,
    state:       string,
    lat:         number | null,
    lng:         number | null,
  },

  // === Груз ===
  equipment:     string,          // аббревиатура: 'V' | 'R' | 'F' | 'SD' | 'DD' | 'LB' | 'RG' | 'HB' | 'T' | 'PO' | 'C' | 'DT' | 'AC' | 'LA' | 'MX'
  equipmentName: string,          // полное название (Auto Carrier, Step Deck...)
  equipmentAll:  string[],        // все типы если несколько (аббревиатуры)
  weight:        number | null,   // lbs
  length:        number | null,   // ft
  fullPartial:   string,          // 'FULL' | 'PARTIAL' | ''

  // === Расстояние / Цена ===
  miles:         number | null,
  deadhead:      number | null,   // миль до pickup
  rate:          number | null,   // $ total
  rpm:           number | null,   // rate ÷ miles

  // === Broker ===
  broker: {
    company:     string,          // название компании
    phone:       string,
    phoneExt:    string,          // добавочный
    email:       string,
    mc:          string,          // MC номер
    dot:         string,          // DOT номер
    address:     string,          // город, штат (HQ)
    rating:      number | null,   // credit score (число или буква→число)
    daysToPay:   number | null,
  },

  // === Описание ===
  notes:         string,          // W×H + description/comments/specialInfo

  // === Даты ===
  pickupDate:    string,          // ISO date
  postedAt:      string,          // ISO datetime

  // === Статус ===
  status:        string,          // 'active' | 'expired'
  bookNow:       boolean,
  factorable:    boolean,

  // === Оригинал ===
  raw:           object
}
```

### Маппинг: AIDA ← RAW (по бордам)

| AIDA | DAT | Truckstop | TruckerPath |
|------|-----|-----------|-------------|
| `id` | `assetInfo.postingId` | `id` | `shipment_id` |
| `externalId` | `resultId` | `legacyLoadId` | `external_id` |
| `origin.city` | `origin.city` | `originCity` | `pickup.address.city` |
| `origin.state` | `origin.stateProv` | `originState` | `pickup.address.state` |
| `origin.lat` | `origin.latitude` | — | `pickup.location.lat` |
| `origin.lng` | `origin.longitude` | — | `pickup.location.lng` |
| `dest.city` | `destination.city` | `destinationCity` | `drop_off.address.city` |
| `dest.state` | `destination.stateProv` | `destinationState` | `drop_off.address.state` |
| `dest.lat` | `destination.latitude` | — | `drop_off.location.lat` |
| `dest.lng` | `destination.longitude` | — | `drop_off.location.lng` |
| `equipment` | `equipmentType` | `equipmentCode` | `equipment[0]` |
| `equipmentName` | маппинг по коду | `equipmentName` | — |
| `equipmentAll` | `[equipmentType]` | `[equipmentCode]` | `equipment` |
| `weight` | `capacity.maximumWeightPounds` | `dimensionsWeight` | `weight` |
| `length` | `capacity.maximumLengthFeet` | `dimensionsLength` | `length` |
| `fullPartial` | `capacity.fullPartial` | — | `load_size` |
| `miles` | `tripLength.miles` | `tripDistance` | `distance_total` |
| `deadhead` | `originDeadheadMiles.miles` | `originDeadhead` | `pickup.deadhead` |
| `rate` | `rateInfo.bookable.rate.rateUsd` | `postedRate` | `price_total` |
| `rpm` | rate ÷ miles | rate ÷ miles | rate ÷ miles |
| `broker.company` | `posterInfo.companyName` | `accountName` | `broker.company` |
| `broker.phone` | `contact.phone.number` | `phone` | `broker.phone.number` |
| `broker.phoneExt` | `contact.phone.extension` | — | `broker.phone.ext` |
| `broker.email` | `contact.email` | ⚠️ отд. запрос | `broker.email` |
| `broker.mc` | `posterDotIds.brokerMcNumber` | `brokerMC` | `broker.mc` |
| `broker.dot` | `posterDotIds.dotNumber` | `dot` | `broker.dot` |
| `broker.address` | `posterInfo.city+state` | — | — |
| `broker.rating` | `credit.creditScore` | `experienceFactor` | `transcredit_rating.score` |
| `broker.daysToPay` | `credit.daysToPay` | `daysToPayInteger` | `transcredit_rating.days_to_pay` |
| `notes` | `comments[].join` | `specialInfo` | `description` + W×H |
| `pickupDate` | `availability.earliestWhen` | `originEarlyTime` | `pickup.date_local` |
| `postedAt` | `servicedWhen` | `updatedOn` (UTC+Z) | `created_at` |
| `status` | `isActive` | `loadStateId` | `expired` |
| `bookNow` | `bookable` ≠ null | `isBookItNow` | `book_now` |
| `factorable` | `isFactorable` | `isCompanyFactorable` | — |

> **Правило:** при добавлении нового борда — если у него есть поле, которого нет в контракте, контракт расширяется. Поля НИКОГДА не удаляются.

### Мои грузы (worklist) — тот же стандарт

Операции «мои грузы» (добавить в worklist, сменить статус на борде — CALLED, SAVED, сброс) тоже в едином формате по DAT. Адаптер борда переводит вызовы Core в запросы к API своего борда (POST/PATCH worklist и т.д.). При добавлении новых бордов — только новый адаптер, без новых форматов и парсеров.

**Важно:** запросы к API борда — через контекст вкладки борда (не из background напрямую), чтобы браузер подставлял Origin, Referer, User-Agent.

---

## 6. Core — Ядро

Живёт в Service Worker. Принимает команды от UI, дёргает блоки, возвращает результат.

### Публичный API Core

| Метод          | Параметры              | Действие                                              |
|----------------|------------------------|--------------------------------------------------------|
| searchLoads    | origin, radius, equipment, dates | Параллельно все адаптеры, дедупликация, массив карточек |
| clearActive    | —                      | Удаляет work:* со статусом active                     |
| saveBookmark   | loadId                 | Статус карточки → saved                                |
| callBroker     | loadId                 | Retell + логирование в history                        |
| getHistory     | dateRange, board       | Записи из history:*                                   |
| getSettings    | —                      | settings:user из Storage                              |
| saveSettings   | объект настроек        | Пишет в Storage                                       |

**Дедупликация:** origin + destination + pickupDate + broker.phone.

**Rate limiting:** не чаще 1 запроса в 2 секунды на борд.

---

## 6.1 Взаимодействие блоков — единый канал API

Все данные между UI (и в будущем OpenClaw, мобильным приложением) и системой проходят **только через контракт API Core**. Никаких обходных путей.

### Правила

1. **UI не использует `chrome.storage`** — ни `get`, ни `set`, ни `onChanged`. Статус бордов (токены), тема, грузы, закладки, история запрашиваются только через сообщения к Core. Обновления в реальном времени UI получает только от Core (см. ниже).
2. **Единственный вход для клиентов** — отправка сообщений в Core (`chrome.runtime.sendMessage` из UI; для внешних клиентов — HTTP к шлюзу, который переводит вызовы в тот же контракт). Ответы и push-обновления идут только от Core к клиенту.
3. **Storage — внутренняя деталь.** Только Core (и харвестеры при записи токенов) обращаются к Storage. Имена ключей и неймспейсов (work:loads, saved:bookmarks и т.д.) не являются частью контракта с UI и не должны быть известны UI.

### Контракт API (сообщения Core)

Клиент (UI или внешний потребитель) может отправлять только следующие типы запросов и получать ответ в указанном формате:

| Тип запроса      | Параметры              | Ответ / действие |
|------------------|------------------------|------------------|
| GET_LOADS        | —                      | `{ loads: Load[] }` |
| GET_BOOKMARKS    | —                      | `{ bookmarks: Load[] }` |
| GET_HISTORY      | `filters?`             | `{ history: Entry[] }` |
| GET_SETTINGS     | —                      | `{ settings }` (user, openclaw, lastSearch, **boardStatus**, **theme** и т.д.) |
| SEARCH_LOADS     | `params` (origin, radius, equipment, dates) | после выполнения Core обновляет данные и шлёт push (см. ниже) |
| SAVE_BOOKMARK    | `loadId`               | `{ ok }` |
| REMOVE_BOOKMARK  | `loadId`               | `{ ok }` |
| CALL_BROKER      | `loadId`               | `{ ok, action?, callId? }` |
| UPDATE_LOAD_STATUS | `loadId`, `status`   | `{ ok }` |
| SAVE_SETTINGS    | `data`                 | `{ ok }` |
| CLEAR_ACTIVE     | —                      | `{ ok }` |
| TOGGLE_AGENT     | `enabled`              | `{ ok }` |
| LOAD_MORE        | `{ board? }`           | Core загружает следующую пачку грузов (offset += limit), мержит и шлёт push |

Вся информация, которая нужна UI (включая статус бордов — есть ли токен, тема оформления), должна приходить в ответах на эти запросы или в push-сообщениях от Core. Отдельного доступа к Storage у UI нет.

### Обновления в реальном времени (push от Core)

Чтобы UI не подписывался на `chrome.storage.onChanged`, обновления доставляются так:

- **Core** при изменении данных (новые грузы, обновление закладок, история, настройки, токены) сам отправляет сообщение во вкладку UI (например, `chrome.tabs.sendMessage` на вкладку с UI или через порт/долгоживущее соединение). Формат сообщения — часть контракта API (например, `{ type: 'DATA_UPDATED', payload: { loads?, bookmarks?, history?, settings? } }`).
- **UI** подписывается только на сообщения от Core (например, `chrome.runtime.onMessage` в контексте UI) и перерисовывает состояние по пришедшему payload. Подписка на ключи Storage в UI не допускается.

Альтернатива (менее предпочтительная): UI периодически запрашивает GET_LOADS / GET_BOOKMARKS и т.д. по таймеру. Тогда push не обязателен, но контракт остаётся тем же — только запросы к Core, без storage.

---

## 7. Retell — Коммуникации

- **initiateCall(phone, context)** — звонок через Retell AI с контекстом груза
- **sendSMS(phone, text)** — SMS брокеру
- **sendEmail(to, subject, body)** — письмо брокеру

После звонка: запись в history:calls[] — `{ loadId, broker, phone, callTime, duration, result, notes }`.

---

## 7.1 Telegram — Уведомления и Управление

**Назначение:** диспетчер получает уведомления о новых грузах и может управлять AIDA через Telegram прямо с телефона — без необходимости сидеть за компьютером.

**Принцип работы:** AIDA сама опрашивает Telegram Bot API через `getUpdates` (long-polling) — **без отдельного сервера**. Chrome Alarm будит Service Worker каждые 5–10 секунд. Всё работает из расширения.

```
Телефон (Telegram) ←→ Telegram Bot API ←→ AIDA Extension (long-polling)
```

### Уведомления (AIDA → Telegram)

AIDA отправляет сообщение диспетчеру когда:

| Событие | Сообщение |
|---|---|
| Найден новый груз с высоким рейтингом | `🟢 DAT: Chicago→Dallas, Van, $2,400 ($2.1/mi), MC#123456, ☎ +1 (555) 000-0000` |
| Автопоиск завершён (30+ грузов) | `🔍 Найдено 47 грузов: DAT 12 · TS 28 · TP 7` |
| Вызов брокера завершён | `📞 Звонок: [company] — [результат]` |
| Борд отключён / токен истёк | `⚠️ DAT: токен истёк, требуется перелогин` |

### Команды (Telegram → AIDA)

| Команда | Действие |
|---|---|
| `/loads` | Показать топ 5 грузов по рейтингу |
| `/search Chicago IL Van` | Запустить поиск по параметрам |
| `/call [loadId]` | Позвонить брокеру через Retell |
| `/save [loadId]` | Сохранить груз в закладки |
| `/status` | Статус бордов (подключены/отключены) |
| `/stop` | Остановить автопоиск |
| `/start` | Запустить автопоиск |

### Реализация

**Настройка (один раз):**
1. Диспетчер создаёт бота через @BotFather → получает `BOT_TOKEN`
2. Пишет боту `/start` → AIDA сохраняет `chat_id`
3. `BOT_TOKEN` и `chat_id` хранятся в `settings:telegram` (chrome.storage.local)

**Long-polling в Service Worker:**
```js
// chrome.alarms будит SW каждые ~5 сек
chrome.alarms.create('telegram-poll', { periodInMinutes: 0.083 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== 'telegram-poll') return;
    const updates = await fetch(
        `https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${offset}&timeout=3`
    ).then(r => r.json());
    for (const update of updates.result) {
        await handleTelegramCommand(update.message.text, update.message.chat.id);
        offset = update.update_id + 1;
    }
});
```

**Отправка уведомления:**
```js
async function sendTelegram(text) {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' })
    });
}
```

### Файлы

- `background/telegram.js` — модуль (polling, отправка, обработка команд)
- Настройки: `settings:telegram` в Storage (`botToken`, `chatId`, `enabled`)
- API Core: новые типы сообщений `SAVE_TELEGRAM_SETTINGS`, `GET_TELEGRAM_STATUS`

### Ограничения

- Chrome должен быть открыт (Service Worker работает только пока браузер открыт)
- Команды выполняются только пока AIDA активна
- Один пользователь — один `chat_id` (личный инструмент, не командный)

---

## 8. History — Архив

Хранится: история звонков, найденные грузы (saved, called). Хранилище: history:* в chrome.storage.local. Доступ только через Core.getHistory(filters).

---

## 9. UI — Интерфейс Диспетчера

**Концепция:** Aida UI — полноценный лоадборд диспетчера по принципу DAT.com: **полноэкранное окно (отдельная вкладка)**, а не боковая панель. В узком слайдере/сайдбаре невозможно нормально работать с грузами с 3–5 сайтов — таблица, фильтры и детали груза требуют полноценного экрана. Диспетчер открывает Aida как отдельную вкладку `chrome-extension://[id]/ui/index.html` и работает только в ней; борды (DAT, Truckstop и др.) открыты в фоне только для харвестеров.

### Автозапуск

При открытии любого подключённого борда (DAT, Truckstop):

- chrome.tabs.onUpdated
- Открыть **вкладку** Aida UI (полноэкранный интерфейс), если ещё не открыта
- Открыть остальные борды в фоне
- Харвестеры собирают токены
- Core по сохранённым параметрам запускает первый поиск автоматически

### Структура UI

| Зона               | Описание                                                                 |
|--------------------|--------------------------------------------------------------------------|
| Sidebar (~50px)    | Иконки: Поиск, Закладки, История, Агент, Настройки, Тема                 |
| Поисковая панель   | Origin, Destination, Radius, Equipment (multi), Date range, Saved presets, кнопка Search |
| Таблица грузов     | Rate, $/mi, Equipment, Origin, Destination, Miles, Weight, Broker, Board, Posted, Status |
| Панель деталей     | При клике на строку: карта (Leaflet/OSRM маршрут), брокер, Позвонить / Написать / Сохранить |
| Статус бар         | Board toggles с per-board счётчиками (DAT 10 · Truckstop 120 · TruckerPath 57), общий Total, время обновления, статус агента |

### Иконки sidebar

- 🔍 Поиск грузов
- 🔖 Закладки (saved)
- 📞 История звонков (called, booked)
- 🤖 Агент — OpenClaw, вкл/выкл polling
- ⚙️ Настройки — компания, Retell, борды
- 🎨 Тема и шрифт

**Принцип:** UI не использует `chrome.storage` вообще (ни get, ни set, ни onChanged). Все данные и обновления — только через контракт API Core (сообщения sendMessage и push от Core). См. раздел «Взаимодействие блоков».

### Единый формат поискового запроса (UI и OpenClaw)

```js
{
  origin:    { city: 'Chicago', state: 'IL', zip: '60601' },
  radius:    10,         // miles
  equipment: ['VAN', 'REEFER'],  // массив — мульти-выбор, см. таблицу Equipment Types ниже
  dateFrom:  '2026-03-01',
  dateTo:    '2026-03-03'
}
```

### Equipment Types (15 типов — пересечение DAT + Truckstop + TruckerPath)

| # | UI value | DAT код | TP API key | Описание |
|---|----------|---------|------------|----------|
| 1 | VAN | V | `van` | Dry Van — закрытый прицеп |
| 2 | REEFER | R | `reefer` | Рефрижератор |
| 3 | FLATBED | F | `flatbed` | Открытая платформа |
| 4 | STEPDECK | SD | `stepdeck` | Step Deck — двухуровневая платформа |
| 5 | DOUBLEDROP | DD | `double drop` | Double Drop — пониженная секция |
| 6 | LOWBOY | LB | `lowboy` | Низкорамная платформа |
| 7 | RGN | RG | — | Removable Gooseneck — съёмная шея (нет в TP) |
| 8 | HOPPER | HB | `hopper bottom` | Hopper Bottom — сыпучие грузы |
| 9 | TANKER | TA | `tanker` | Цистерна |
| 10 | POWERONLY | PO | `power only` | Только тягач (без прицепа) |
| 11 | CONTAINER | C | `containers` | Контейнер |
| 12 | DUMP | DT | `dump trailer` | Самосвальный прицеп |
| 13 | AUTOCARRIER | AC | `auto carrier` | Автовоз |
| 14 | LANDOLL | LA | — | Drop Deck Landoll (нет в TP) |
| 15 | MAXI | MX | — | Flatbed Maxi (нет в TP) |

> **TP Equipment маппинг:** TruckerPath API принимает equipment как массив **lowercase строк с пробелами** (`"power only"`, `"double drop"`, `"hopper bottom"`). Адаптер TP должен маппить AIDA UI value → TP API key при формировании запроса. Типы без TP API key (RGN, LANDOLL, MAXI) — пропускаются при поиске на TP (не отправляются в запрос). TP-эксклюзивные типы (B-Train, Box Truck, Conestoga, Dry Bulk, Hotshot) — не включены в AIDA, т.к. не используются.

### Equipment Multi-Select UI

- Кастомный dropdown с чекбоксами (заменяет стандартный `<select>`)
- В списке: `Van (V)`, `Flatbed (F)`, `Lowboy (LB)`, `RGN (RG)`...
- Кнопка **Apply** внизу списка
- После Apply в поле поиска отображать коды: `(LB),(RG),(DD)`
- `params.equipment` — массив: `['LOWBOY', 'RGN', 'DOUBLEDROP']`
- DAT: собирает все types в один массив `{ types: ['LB','LO','LR','RG','DD'] }`
- Truckstop/TruckerPath: массив названий в шаблон запроса

### §9.1 Реализованные UI-улучшения таблицы грузов

#### Иконки бордов в колонке BOARD
Вместо текстовых лейблов (DAT / TRUCKSTOP / TP) в колонке BOARD отображаются оригинальные логотипы бордов:
- DAT → `icons/dat.png` (border-radius 3px)
- Truckstop → `icons/truckstop.jpg` (border-radius 5px)
- TruckerPath → `icons/tp.webp` (border-radius 5px)

Fallback: если борд неизвестен — показывается текстовый badge как прежде.

#### Менеджер колонок
- Пользователь может показывать/скрывать колонки через панель конфигурации (⚙️)
- Порядок колонок меняется перетаскиванием заголовков (drag-and-drop)
- Ширина колонок меняется перетаскиванием правого края заголовка
- При ресайзе: **левые колонки заморожены** — их ширина фиксируется в px на момент старта, таблица расширяется вправо, не сжимая соседей слева
- Конфигурация (порядок + ширины) сохраняется в `chrome.storage.local`

#### Колонка PICKUP — окно пикапа
Вместо одной даты пикапа отображается диапазон (pickup window):
- Формат: `MM/DD–MM/DD` (например `03/05–03/09`)
- Поля в контракте: `pickupDate` (начало) и `pickupDateEnd` (конец окна)
- DAT: `earliestWhen` → `pickupDate`, `latestWhen` → `pickupDateEnd`
- Truckstop: `originEarlyTime` → `pickupDate`, `originLateTime` → `pickupDateEnd`
- В детаил-панели: длинный формат `Mar 05 – Mar 09`

#### Карта маршрута в детаил-панели (все борды)
Карта (Leaflet + OSRM) теперь работает для всех бордов, не только DAT:
- Если `load.origin.lat/lng` есть (DAT) — карта рисуется сразу
- Если нет (Truckstop, TruckerPath) — геокодирование через Nominatim по city+state
- Пока геокодируется — спиннер из трёх пульсирующих точек
- Если геокодирование не дало результата — карта скрывается
- Функция: `geocodeCityState(city, state)` → `{ lat, lng }`

---

## 10. Поток Данных

**Поиск:** UI → Core.searchLoads(params) → адаптеры → дедупликация → Storage (work:loads) → UI отображает.

**Звонок:** UI → Core.callBroker(loadId) → Retell → history.

---

## 11. Структура проекта

```
aida/
├── manifest.json
├── background/
│   ├── background.js    ← Core
│   ├── storage.js      ← Storage
│   ├── retell.js       ← Retell
│   └── adapters/
│       ├── dat-adapter.js
│       ├── truckstop-adapter.js
│       └── truckerpath-adapter.js
├── harvesters/
│   ├── harvester-dat.js
│   ├── harvester-truckstop.js
│   └── harvester-truckerpath.js
└── ui/
    ├── app.html
    ├── app.js
    └── components/
```

---

## 12. Важные технические решения

- **Жёсткое правило — логирование шагов:** все ключевые шаги (входящий запрос в Core, вызов Storage, вызов адаптера, push в UI, ошибки) логируются в консоль с префиксом `[AIDA/...]` (например `[AIDA/Core]`, `[AIDA/UI]`) для отслеживания работы и отладки. Без исключений.
- **Service Worker и сон (MV3):** все данные через chrome.storage.local; при пробуждении данные на месте.
- **Защита от бана:** запросы через контекст вкладки борда, rate limiting, не менять User-Agent.
- **Дедупликация:** origin.zip + destination.zip + pickupDate + broker.phone.

---

## 13. v0.1 — Обязательно в первой версии

| Функция                         | Статус    |
|---------------------------------|-----------|
| Харвестер токенов (DAT, Truckstop) | ✓ Обязательно |
| Адаптеры DAT (GraphQL), Truckstop (REST) | ✓ Обязательно |
| Поиск грузов (UI + Core)        | ✓ Реализовано |
| Storage (токены, work:, settings:) | ✓ Реализовано |
| Очистка при смене направления    | ✓ Реализовано |
| Закладки (saved)                | ✓ Реализовано |
| Интеграция Retell (звонки)      | ✓ Обязательно |
| История звонков                 | ✓ Обязательно |
| Auth Truckstop (popup + silent refresh) | ✓ Реализовано |
| Truckstop auto-refresh (30s, updatedOn desc) | ✓ Реализовано |
| Truckstop equipment_ids маппинг (GraphQL introspection) | ✓ Реализовано |
| Каскад свежести (wave-0/wave-1 highlight новых грузов) | ✓ Реализовано |
| Per-board счётчики в статус-баре | ✓ Реализовано |
| Search Presets (до 8 сохранённых запросов) | ✓ Реализовано |
| Infinite scroll (LOAD_MORE через offset) | ✓ Реализовано |
| Detail Panel с картой (Leaflet + OSRM маршрут) | ✓ Реализовано |
| postedAt = updatedOn UTC (Z suffix для корректного парсинга) | ✓ Реализовано |
| Иконки бордов в колонке BOARD (DAT, Truckstop, TP) | ✓ Реализовано |
| Менеджер колонок: show/hide, drag-reorder, resize с блокировкой левых | ✓ Реализовано |
| Pickup window (pickupDateEnd) — диапазон дат MM/DD–MM/DD | ✓ Реализовано |
| Карта с геокодингом Nominatim для всех бордов (не только DAT) | ✓ Реализовано |
| SMS и Email через Retell        | ○ v0.2    |
| OpenClaw AI агент               | ○ v0.2    |
| Автопоиск без участия диспетчера | ○ v0.2   |

---

## 14. Жизненный цикл карточки груза

| Статус         | Когда присваивается        | Следующий шаг                    |
|----------------|----------------------------|----------------------------------|
| active         | Груз найден при поиске     | Действие диспетчера/OpenClaw     |
| saved          | Сохранён в закладки        | Звонок/письмо                    |
| calling        | Retell начал звонок        | Webhook о завершении             |
| emailed        | Письмо отправлено (нет телефона) | Ждём ответа 24h              |
| called_pending | Звонок завершён, ждём      | 24h → replied или no_response    |
| replied        | Брокер ответил             | Букинг или отказ                 |
| booked         | Груз забукирован           | history, 60 дней → удаление       |
| no_response    | Нет ответа в течение дня   | Удаление                         |

**Инициация:** есть телефон → Retell.initiateCall() → calling; нет телефона → email скрипт → emailed.

**Чистка:** через Core по расписанию (например раз в час); no_response, emailed/called_pending + 24h, booked + 60 дней.

---

## 15. Внешний API — OpenClaw

- Aida опрашивает: `GET /task` → ответ `{ task: 'search', params: {...} }` или `{ task: 'idle' }`.
- Aida выполняет поиск, затем: `POST /results` с `{ taskId, timestamp, loads }`.
- Настройки: settings:openclaw (url, api_key, interval, enabled). При api_key — заголовок `Authorization: Bearer <api_key>`.

---

## 16. Мобильное приложение (на будущее)

Мобилка — ещё один клиент к той же Aida (те же данные, управление). API те же, что у OpenClaw. Технология: React Native, Push через FCM.

---

## 17. Исправления и уточнения в ТЗ (сводка)

Чтобы блочность и единый канал реально соблюдались в коде, в ТЗ внесено следующее.

1. **Один канал API.** Добавлен раздел **6.1 «Взаимодействие блоков — единый канал API»**: UI и внешние клиенты получают все данные только через контракт Core (сообщения/запросы и ответы). Запрещено использование UI с `chrome.storage` (get/set/onChanged).

2. **Storage читает только Core.** В таблице «Кто читает» по неймспейсам Storage указано только Core (и Adapters для токенов). UI в столбце «Кто читает» не фигурирует. Явно указано, что данные до UI доходят исключительно через API Core.

3. **Обновления в реальном времени — через Core.** Описано, что обновления доставляет Core (push во вкладку UI или явный контракт сообщений), а не подписка UI на `chrome.storage.onChanged`. UI не должен знать ключи Storage.

4. **Контракт API.** В разделе 6.1 приведён перечень типов запросов (GET_LOADS, GET_SETTINGS, SAVE_BOOKMARK и т.д.) и указано, что статус бордов и тема входят в GET_SETTINGS (или отдельный метод контракта), а не в прямое чтение Storage из UI.

5. **Перехват поиска и вновь поступивших.** В разделе «Harvesters» добавлен подраздел «Перехват данных с бордов»: перехват ответа поиска описан как реализованный сценарий; перехват вновь поступивших грузов реализован для DAT через SSE (liveQueryMatches v3) — см. подробное описание в разделе 4.

6. **SSE — реальное время для DAT (реализовано).** После FindLoads Core подписывается на SSE-поток `notification/v3/liveQueryMatches/{searchId}`. При событии `EQUIPMENT_MATCH_CREATED` Core пушит счётчик `newLoadsCount` в UI. UI показывает бар «N new loads available». По клику — `REFRESH_LOADS` → Core повторяет FindLoads. Подписка автоматически отменяется при новом поиске. Keep-alive через `chrome.alarms`.

Итог: ТЗ задаёт «один канал, один контракт, без обходов Storage в UI». Перехват вновь поступивших грузов для DAT реализован через SSE из background.js (Service Worker).

---

## 18. Отказ от блока Harvesters → автономные адаптеры (уточнение v0.1.x)

**Контекст решения:** При детальном изучении архитектуры авторизации каждого лоадборда (DAT Auth0, Truckstop PingOne, TruckerPath) выявлено, что блок Harvesters (content scripts в MAIN world на вкладках бордов) стал архитектурным рудиментом после появления Auth-модулей (`auth-dat.js`, `auth-truckstop.js`). Более того, харвестеры **создают проблемы**: перезаписывают валидные JWT токены невалидными данными (перехват не-JWT Bearer строк из заголовков), что приводит к ошибкам `invalid-jwt` и вынужденным popup-логинам каждые ~20 минут.

**Решение:** Поэтапный отказ от блока Harvesters. Адаптеры становятся полностью автономными «чёрными ящиками» — Auth-модуль обеспечивает токены, адаптер делает запросы к API, Core получает контрактные данные.

### Принцип автономного адаптера

```
Core → Adapter.search(params) → { ok, loads[], meta }
         ↑
    AuthManager.getToken(board) → токен (с авто-refresh до истечения)
```

- Адаптер сам берёт токен через AuthManager
- AuthManager поддерживает сессию через silent refresh (API call или скрытый таб)
- **Открытая вкладка борда НЕ нужна** — это подтверждает принцип §4.1
- UI нужен только для первого логина (popup)
- Для OpenClaw / внешних API — полностью автономная работа без UI

### Стратегия обновления токенов: «Refresh at every use»

Токены обновляются **агрессивно** — не ждём протухания, а обновляем при каждом использовании. Для дешёвых API endpoints (POST `/auth/renew`) нет смысла экономить — надёжность важнее.

**`AuthManager.getToken(board)`** — единственный способ получения токена:
```
getToken(board):
    → токен есть и валидный → вернуть + silentRefresh() fire-and-forget в фоне
    → токен протух → silentRefresh() → подождать → вернуть свежий
    → токена нет → вернуть null (UI покажет «Подключить»)
```

**Три уровня защиты:**

| Уровень | Механизм | Когда | Цель |
|---------|----------|-------|------|
| 1 | `getToken()` + refresh fire-and-forget | При каждом запросе к API борда | Основной: token всегда свежий к следующему запросу |
| 2 | Alarm (`aida-ts-proactive-refresh`, 15 мин) | Фоново, если нет активных поисков | Страховка при неактивности |
| 3 | Retry при ошибке Hasura/API | При любой JWT ошибке | Последний рубеж, не должен срабатывать |

**При старте Service Worker (`init()`):** проверить и обновить токены всех connected бордов ДО первого поиска.

**Важно:** Адаптеры и Core НЕ используют `Storage.getToken()` напрямую. Только `AuthManager.getToken(board)` — это гарантирует что токен всегда проверен и обновлён.

### Фазы отказа от Harvesters

| Фаза | Борд | Действие | Статус |
|------|------|----------|--------|
| 1 | Truckstop | Auth popup (PingOne) + silent refresh (/auth/renew) + проактивный alarm (15 мин), адаптер автономный | ✅ Готово |
| 2 | DAT | Переписать `silentRefresh()` без зависимости от харвестера, отключить `harvester-dat.js` | Запланировано |
| 3 | TruckerPath | `auth-truckerpath.js` (popup + webRequest x-auth-token), адаптер на прямые API, polling 60s | ✅ Готово |

**Заметка: Truckstop dual-query merge (TODO):**

Truckstop GraphQL имеет два query с одинаковыми фильтрами, но разной сортировкой:
- `LoadSearchSortByBinRateDesc` — топ-100 по рейту (самые дорогие)
- `LoadSearchSortByUpdatedOnDesc` — топ-100 по updatedOn (самые свежие)

При `search()` (кнопка Search) нужно вызывать **оба query параллельно** и мержить результаты с дедупликацией по `id`. Это даёт ~130-170 уникальных грузов вместо 100, покрывая и дорогие, и свежие.

При `refreshNew()` (auto-refresh 30 сек) — оставляем `UpdatedOnDesc` один, он только добавляет свежие поверх существующих.

**Детали Фазы 3 (TruckerPath):**

1. **`auth-truckerpath.js`** — модуль авторизации:
   - `login()` → popup `loadboard.truckerpath.com/login` → перехват `x-auth-token` из заголовков через `webRequest` listener, или прямой API вызов `POST /tl/login/web/v2` с MD5 подписью (секрет: `eyFsGFeZ@Sajb$ZW`)
   - `getToken()` → вернуть из Storage `token:truckerpath` (формат `r:{hex32}`)
   - `silentRefresh()` → `GET /tl/users/me` для проверки валидности (токен ~351 день)
   - `getStatus()` / `disconnect()` — по аналогии с `auth-truckstop.js`
   - Storage keys: `token:truckerpath`, `auth:truckerpath:meta`, `auth:truckerpath:installationId`

2. **Переписать `truckerpath-adapter.js`:**
   - Убрать template-replay логику (template capture, `modifyTemplateBody`, `patchSearchParams`)
   - Убрать harvester handlers (`handleSearchResponse`, `handleRequestCaptured`)
   - Прямой `POST /tl/search/filter/web/v2` с параметрами поиска (формат известен из HAR)
   - Заголовки: `x-auth-token`, `client: WebCarriers/0.0.0`, `installation-id: {uuid}`
   - Equipment маппинг AIDA → TP API key (lowercase строки с пробелами)
   - `hasAuthModule: true` в Registry

3. **Удалить `harvester-truckerpath.js`** и убрать из `manifest.json`

### Обновление структуры проекта (после всех фаз)

```
aida/
├── manifest.json              ← без content_scripts для бордов
├── background/
│   ├── background.js          ← Core (без обработки harvester messages)
│   ├── storage.js
│   ├── auth/
│   │   ├── auth-manager.js    ← Единый вход для авторизации
│   │   ├── auth-dat.js        ← Auth0 (login + silent refresh без харвестера)
│   │   ├── auth-truckstop.js  ← PingOne (login + API /auth/renew)
│   │   └── auth-truckerpath.js ← TODO
│   └── adapters/
│       ├── dat-adapter.js     ← Автономный
│       ├── truckstop-adapter.js ← Автономный
│       └── truckerpath-adapter.js
└── ui/
```

> **Примечание:** Раздел 4 (Harvesters) остаётся в ТЗ как историческая справка. Новый код НЕ должен использовать харвестеры для получения токенов или данных поиска. Auth-модули и адаптеры — единственный путь.

> **Подробный план:** см. `docs/PLAN_harvester_removal.md`

## §20. Внешний API (OpenClaw) — расширение

### Текущее состояние
- `GET {url}/task` — получить задание (search params)
- `POST {url}/results` — отправить результаты поиска
- Авторизация: `Authorization: Bearer {api_key}`
- Polling с настраиваемым интервалом (default 5 сек)

### Мульти-бот архитектура
Один внешний сервер (OpenClaw) управляет несколькими экземплярами AIDA.
Каждый бот идентифицируется уникальным `api_key`:

```
Бот "Чикаго→Юг":      api_key = "aida_bot_chi_south_xxx"
Бот "Даллас→Восток":   api_key = "aida_bot_dal_east_yyy"
Бот "Атланта→Запад":   api_key = "aida_bot_atl_west_zzz"
```

- Все боты могут работать с одного аккаунта DAT/TS (разные направления)
- Или разные аккаунты (разные carriers)
- Сервер по ключу знает: какому боту дать задание, чьи результаты пришли
- Ноль доработок в расширении — api_key уже есть в настройках

### Варианты развёртывания
1. **Локальный комп** — Chrome + AIDA, комп не выключать, Chrome в фоне
2. **VPS** — Chrome Desktop + AIDA на сервере, RDP для логина/2FA, работает 24/7
3. **Несколько VPS** — по боту на каждый, общий OpenClaw сервер координирует

### Будущее: AI Автопилот (v0.2)
Подробный план: `docs/PLAN_v02_ai_autopilot.md`
- AI Engine (Gemini через chrome.identity) — скоринг грузов
- Chat UI — диалог с AI-диспетчером
- Retell — автозвонки брокерам
- Email — автописьма (Gmail API через chrome.identity)
- Telegram Bot — уведомления и отчёты
- Автопилот — полный цикл: поиск → анализ → звонок/email → отчёт

### Будущее: Официальные API (v0.3)
- Покупка API-доступа у DAT / Truckstop → прямые API вызовы без браузера
- Чистый серверный продукт, масштабируемый, без зависимости от cookies/Chrome

---

## §99. Синхронизация профиля диспетчера — ВСЕГДА ПОСЛЕДНИЙ ШАГ

> ⚠️ **ВАЖНО:** Этот раздел реализуется ПОСЛЕДНИМ — только когда всё остальное
> готово и структура настроек стабилизировалась. Не реализовывать раньше времени,
> чтобы не переделывать при каждом изменении структуры данных.

### Принцип

Диспетчер настраивает AIDA один раз — все настройки автоматически появляются
на любом другом компьютере где он залогинен в Chrome с тем же Google-аккаунтом.
Никаких кнопок «Синхронизировать», никакого экспорта файлов — всё прозрачно
в фоне, как Chrome синхронизирует свои закладки и пароли.

### Механизм: chrome.storage.sync = зеркало профиля

`chrome.storage.sync` — это стандартный Chrome API. Всё что туда записывается
автоматически синхронизируется через Google-аккаунт на все компьютеры где
залогинен тот же пользователь. Никакого серверного кода не нужно — Chrome делает
всё сам.

### Что синхронизируется (sync) vs что остаётся локальным (local)

| Данные | Хранилище | Почему |
|--------|-----------|--------|
| Имя диспетчера, компания, телефон, email | `sync` | Профиль пользователя — нужен везде |
| Retell API Key, From Number, Agent ID | `sync` | Аккаунт пользователя — нужен везде |
| OpenClaw URL, API Key, интервал | `sync` | Интеграция пользователя — нужна везде |
| Видимые столбцы и их порядок | `sync` | Личные предпочтения — нужны везде |
| Ширины столбцов | `sync` | Личные предпочтения — нужны везде |
| Тема (dark/light) | `sync` | Личные предпочтения — нужны везде |
| Поисковые пресеты | `sync` | Личные маршруты — нужны везде |
| Токены DAT / Truckstop / TruckerPath | `local` | Сессионные, на новом компе — новый логин |
| Текущие грузы | `local` | Реалтайм данные, нерелевантны на другом компе |
| История звонков | `local` | Локальная история |

### Как работает

```
При сохранении настроек:
    Core.SAVE_SETTINGS(data)
         ↓
    chrome.storage.local  ←→  chrome.storage.sync
    (работает сейчас)          (зеркало профиля)
                                     ↓
                            Chrome автоматически
                            синхронизирует через
                            Google-аккаунт

При первом запуске на новом компе:
    init()
      ↓
    chrome.storage.local пустой?
      ↓ да
    Читаем chrome.storage.sync
      ↓
    Есть профиль? → Применяем как стартовые значения
    Нет профиля? → Пустые дефолты
      ↓
    Обычный старт AIDA
    (токены нужно получить заново — залогиниться на бордах)
```

### Изменения в коде (кратко)

1. **`storage.js`** — добавить `setProfile(key, val)`, `getProfile(key)`, `loadFullProfile()`
2. **`background.js` Core `SAVE_SETTINGS`** — дублировать в sync параллельно с local
3. **`background.js` `init()`** — при пустом local загрузить профиль из sync
4. **`app.js`** — при изменении колонок/ширин/темы → писать в sync

### Совместимость с ТЗ §3

`local` остаётся единственным **рабочим** хранилищем Core во время работы.
`sync` — только **резервная копия профиля** для переноса между компами.
Читается из `sync` только один раз: при `init()` если `local` пустой.
Правило «UI не использует chrome.storage» (§6.1) сохраняется полностью.

### Подробный план реализации

См. `docs/PLAN_profile_sync.md`

---

## 19. 123LoadBoard — интеграция (v0.1.86)

**Четвёртый лоадборд.** REST API на `members.123loadboard.com/api/`. Cookie-based авторизация (HttpOnly). HAR-анализ: `log.members.123loadboard.com.har`, `login.123loadboard.com.har`, `serg.members.123loadboard.com.har`, `load.members.123loadboard.com.har`.

### 19.1 Авторизация

- **Метод:** HttpOnly cookies (не Bearer token). HAR не записывает cookies — они устанавливаются браузером автоматически.
- **Логин:** POST-форма `login.123loadboard.com/` — поля `Email`, `Password`, `isRememberMe`, `RedirectLink`. Также OAuth (Google, Facebook, Apple) через `provider` + `ticket` hidden fields.
- **Refresh:** `POST /refreshToken?rnd={random}` — body `{}`, response `{secondsToExpire: 1799}` (~30 мин TTL).
- **Custom headers (обязательные):**
  - `123LB-Api-Version: 1.3`
  - `123LB-BID: {session_id}` (генерируется клиентом, напр. `B3PVoSo1UwD9a`)
  - `123LB-Correlation-Id: {random}` (трекинг запроса)
  - `123LB-MEM-User-Version: 3.116.1` (версия web-приложения)
  - `Content-Type: application/json`
  - `Accept: application/json`

### 19.2 API Endpoints

| Endpoint | Метод | Описание |
|----------|-------|----------|
| `/api/loads/search` | POST | Прямой поиск грузов (без named search) |
| `/api/loads/search/metadata` | POST | Только количество совпадений |
| `/api/loads/named-searches` | POST | Создать named search → получить `id` |
| `/api/loads/named-searches/{id}/search` | POST | Выполнить поиск по named search ID |
| `/api/loads/named-searches` | GET | Список сохранённых поисков |
| `/api/loads/{id}?fields=...&onlineOnly=true` | GET | Детали груза (контакт, мили, notes) |
| `/api/loads/search/similar` | POST | Похожие грузы |
| `/api/loads/ratecheck` | POST | Рейтчек (массив ID) |
| `/api/loads/{id}/backhauls` | GET | Обратные грузы |
| `/api/loads/{id}/routemap` | GET | Карта маршрута (изображение) |
| `/api/profile` | GET | Профиль пользователя |
| `/api/settings/loadsearch` | GET | Настройки поиска (домашний город, радиус) |
| `/api/refreshToken?rnd={random}` | POST | Обновление сессии |

### 19.3 Поиск грузов — flow

**Вариант A: Прямой поиск** (рекомендуется для AIDA)
```
POST /api/loads/search
Body: {
  origin: { states: ["IL"], city: "Chicago", longitude: -87.63, latitude: 41.88, radius: 200, type: "City" },
  destination: { type: "Anywhere" },
  equipmentTypes: ["Van", "Reefer", "Flatbed"],
  metadata: { type: "Regular", limit: 50, fields: "all", sortBy: { field: "Origin", direction: "Ascending" } },
  pickupDates: [],
  includeLoadsWithoutLength: true,
  includeLoadsWithoutWeight: true,
  minWeight: 0, minLength: 0,
  company: { types: "All" }
}
```

**Refresh (polling):** тот же endpoint, но `type: "Refresh"` + `nextToken` из предыдущего response metadata.

**Детали груза:** `GET /api/loads/{id}?fields=id,guid,status,computedMileage,...,dispatchPhone,dispatchName,dispatchEmail,contactName,contactPhone,contactEmail,...&onlineOnly=true` — возвращает контактную информацию, мили, полные notes.

### 19.4 Equipment mapping (123LB ↔ AIDA)

| AIDA ключ | 123LB API строка | UI-метка AIDA |
|-----------|-----------------|---------------|
| `VAN` | `Van` | Van (V) |
| `REEFER` | `Reefer` | Reefer (R) |
| `FLATBED` | `Flatbed` | Flatbed (F) |
| `STEPDECK` | `StepDeck` | Step Deck (SD) |
| `DOUBLEDROP` | `DoubleDrop` | Double Drop (DD) |
| `LOWBOY` | `LowBoy` | Lowboy (LB) |
| `RGN` | `RemovableGooseneck` | RGN (RG) |
| `HOPPER` | `HopperBottom` | Hopper Bottom (HB) |
| `TANKER` | `Tanker` | Tanker (T) |
| `POWERONLY` | `PowerOnly` | Power Only (PO) |
| `CONTAINER` | `Container` | Container (C) |
| `DUMP` | `DumpTruck` | Dump Trailer (DT) |
| `AUTOCARRIER` | `Auto` | Auto Carrier (AC) |
| `LANDOLL` | `Landoll` | Landoll (LA) |
| `MAXI` | `Maxi` | Maxi (MX) |

> **Примечание:** 123LB имеет дополнительные типы (BoxTruck, HotShot, Conestoga, Intermodal, BTrain, MovingVan, Sprinter, CargoVan, AnimalCarrier, BoatHauler, HeavyHaulers, MiniVan, PilotCars) — в AIDA не добавляются, обратный маппинг не нужен. DumpTruck и Dump Trailer — одно и то же.

### 19.5 Data contract mapping (123LB → AIDA)

| AIDA | 123LB Search | 123LB Detail (GET /loads/{id}) |
|------|-------------|-------------------------------|
| `id` | `"123lb_" + id` | — |
| `externalId` | `postReference` | — |
| `origin.city/state` | `originLocation.address.city/state` | ✅ |
| `origin.lat/lng` | `originLocation.geolocation.latitude/longitude` | ✅ (более точные) |
| `dest.city/state` | `destinationLocation.address.city/state` | ✅ |
| `dest.lat/lng` | `destinationLocation.geolocation.latitude/longitude` | ✅ |
| `equipment` | `equipments[0].equipmentType` (маппинг §19.4) | ✅ |
| `equipmentAll` | `equipments[].equipmentType` | ✅ |
| `weight` | `weight` (lbs) | ✅ |
| `length` | `length` (ft) | ✅ |
| `fullPartial` | `loadSize`: `"TL"→"FULL"`, `"LTL"→"PARTIAL"` | — |
| `miles` | ❌ | `computedMileage` |
| `deadhead` | `metadata.userdata.originDeadhead.value` (miles) | — |
| `rate` | `rate.amount` | ✅ |
| `rpm` | rate ÷ miles (вычисляется) | — |
| `broker.company` | `poster.name` | ✅ (+ `poster.address`) |
| `broker.phone` | ❌ | `dispatchPhone.number` или `poster.phone.number` |
| `broker.email` | ❌ | `dispatchEmail` |
| `broker.mc` | `poster.docketNumber` (prefix+number) | ✅ |
| `broker.address` | ❌ | `poster.address.city + state` |
| `notes` | `commodity` (краткое) | `notes` (полные) + `commodity` |
| `pickupDate` | `pickupDates[0]` (ISO date) | ✅ |
| `pickupDateEnd` | `pickupDates[last]` | — |
| `postedAt` | `created` (RFC datetime) | ✅ |
| `status` | `status` = `"Online"` → `"active"` | ✅ |
| `bookNow` | ❌ | `canBookNow` |
| `broker.rating` | ❌ | ❌ (платная фича) |
| `broker.daysToPay` | ❌ | ❌ (платная фича) |

> **Обогащение:** phone, email, miles, notes доступны только через GET /loads/{id}. Адаптер делает batch-запросы на детали после основного поиска (аналогично Truckstop `_enrichLoads`).

### 19.6 Storage keys

```
auth:123lb:meta         — { issuedAt, expiresAt, source, bid }
auth:123lb:search       — { namedSearchId, nextToken, lastRefreshTime }
```

### 19.7 Auth module (auth-123lb.js)

| Метод | Описание |
|-------|----------|
| `login()` | Popup → `login.123loadboard.com/?rd=members.123loadboard.com` → мониторинг `tabs.onUpdated` → redirect на `members.123loadboard.com` → resolve |
| `silentRefresh()` | `POST /refreshToken` → обновить `expiresAt` в storage |
| `getToken()` | Проверить expiresAt → silentRefresh если нужно → вернуть `{ ok: true }` |
| `getStatus()` | `{ connected, status, hasToken, hasAuthModule: true }` |
| `disconnect()` | `chrome.cookies.remove()` для `members.123loadboard.com` |

**Особенность:** 123LB не использует Bearer token. API вызовы из background.js должны проходить через контекст в котором есть cookies для `members.123loadboard.com`. Это работает если cookies не HttpOnly — тогда `fetch()` из service worker подхватит их автоматически. Если cookies HttpOnly — потребуется `chrome.cookies` API для проверки статуса.

### 19.8 Adapter (123lb-adapter.js)

| Метод | Описание |
|-------|----------|
| `search(params)` | POST /api/loads/search → normalize → enrich (batch GET /loads/{id}) |
| `refreshNew(params)` | POST с `type:"Refresh"` + `nextToken` → новые/обновлённые грузы |
| `setRealtimeCallback(fn)` | Polling через chrome.alarms (аналогично Truckstop) |
| `getStatus/login/disconnect()` | Делегирует в Auth123LB |

### 19.9 UI изменения

- **Footer status bar:** Добавить кнопку `board-btn-123lb` (data-board="123lb") — 4я кнопка, с такой же логикой toggle/connect/disconnect как DAT/TS/TP.
- **`updateBoardDots()`:** добавить `'123lb'` в массив boards.
- **`updateStatusBar()`:** добавить подсчёт `boards['123lb']`.
- **Adapter Registry:** `123lb: { module: LB123Adapter, displayName: '123LB', hasAuthModule: true }`.

### 19.10 Manifest.json

Добавить в `host_permissions`:
```json
"https://members.123loadboard.com/*",
"https://login.123loadboard.com/*"
```

### 19.11 Файловая структура

```
background/
  auth/auth-123lb.js           — Auth модуль
  adapters/123lb-adapter.js    — Adapter
ui/
  app.html                     — кнопка board-btn-123lb в footer
  app.js                       — updateBoardDots + updateStatusBar + boards counter
manifest.json                  — host_permissions
```

---

*Источник: Aida_v01_TZ.docx · внесено в проект в виде docs/AIDA_v01_TZ.md*
