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

Расширение состоит из 6 независимых блоков. Каждый блок имеет свой контракт (API) и не знает о внутреннем устройстве других.

| Блок      | Место                         | Кто вызывает      | Зона ответственности                                    |
|-----------|-------------------------------|--------------------|---------------------------------------------------------|
| UI        | Полноэкранная вкладка расширения (отдельная страница) | Диспетчер | Отображение грузов, настройки, закладки, история       |
| Core      | Service Worker (background.js) | UI, агенты         | Маршрутизация команд, агрегация данных, бизнес-логика  |
| Storage   | chrome.storage.local          | Core, Harvesters   | Единое хранилище всех данных расширения                 |
| Harvesters| Content Scripts на вкладках бордов | Страницы DAT, TS и др. | Перехват токенов, передача в Storage              |
| Adapters  | Модули внутри Core            | Core               | Запросы к API борда, приведение к единому формату (по DAT) |
| Retell    | Модуль внутри Core            | Core               | Звонки, SMS, email через Retell API                    |

---

## 3. Storage — Единое Хранилище

**Технология:** Всё хранится в `chrome.storage.local`. Одно хранилище, разделение по namespace через префиксы ключей. Session storage не используется.

### Структура данных (Namespaces)

| Namespace  | Ключи                          | Кто пишет   | Кто читает    |
|------------|---------------------------------|-------------|----------------|
| token:     | token:dat, token:truckstop, ...  | Harvesters  | Core, Adapters |
| work:      | work:loads[], work:search_params | Core        | Core           |
| settings:  | settings:user, settings:boards[] | Core        | Core           |
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

---

## 5. Adapters — Переводчики Бордов

**Контракт данных — максимальное объединение полей всех бордов.** Каждый адаптер извлекает **ВСЕ** доступные данные из raw-ответа своего борда и маппит их в единый максимальный формат. Поля, отсутствующие у конкретного борда, остаются пустыми (`''`, `null`, `0`). UI выбирает из контракта нужные поля для отображения. Контракт не привязан к стандарту конкретного борда — это **супер-набор всех полей всех бордов**.

Принцип: **берём всё → нормализуем в единый формат → UI показывает что нужно.** Если понадобилось новое поле — оно уже в данных, достаточно показать в UI. Не нужно каждый раз лезть в адаптер и парсер.

Адаптер берёт токен из Storage, формирует запрос к API борда (GraphQL для DAT, REST для Truckstop и т.д.) и возвращает результат в едином формате.

### Единый формат карточки груза (финальный контракт v2)

```js
{
  // === Идентификация ===
  id:            string,          // уникальный ID (boardPrefix + originalId)
  board:         'dat'|'ts'|'tp', // источник
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
  equipment:     string,          // 'VAN' | 'FLATBED' | 'STEPDECK' | 'REEFER' ...
  equipmentName: string,          // полное название (Removable Goose Neck...)
  equipmentAll:  string[],        // все типы если несколько
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
| `postedAt` | `servicedWhen` | `createdOn` | `created_at` |
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
| Поисковая панель   | Origin, Radius, Equipment, Date range, кнопка Search                    |
| Таблица грузов     | Rate, Equipment, Origin, Destination, Miles, Weight, Broker, Board, Status |
| Панель деталей     | При клике на строку: карта, брокер, Позвонить / Написать / Сохранить    |
| Статус бар         | Количество грузов, борды, время обновления, статус агента               |

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
  equipment: 'VAN',      // VAN | REEFER | FLATBED
  dateFrom:  '2026-03-01',
  dateTo:    '2026-03-03'
}
```

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
| Поиск грузов (UI + Core)        | ✓ Обязательно |
| Storage (токены, work:, settings:) | ✓ Обязательно |
| Очистка при смене направления    | ✓ Обязательно |
| Закладки (saved)                | ✓ Обязательно |
| Интеграция Retell (звонки)      | ✓ Обязательно |
| История звонков                 | ✓ Обязательно |
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

*Источник: Aida_v01_TZ.docx · внесено в проект в виде docs/AIDA_v01_TZ.md*
