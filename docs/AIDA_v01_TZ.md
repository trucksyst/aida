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
| UI        | Страница расширения (SidePanel) | Диспетчер          | Отображение грузов, настройки, закладки, история       |
| Core      | Service Worker (background.js) | UI, агенты         | Маршрутизация команд, агрегация данных, бизнес-логика  |
| Storage   | chrome.storage.local          | Core, Harvesters   | Единое хранилище всех данных расширения                 |
| Harvesters| Content Scripts на вкладках бордов | Страницы DAT, TS и др. | Перехват токенов, передача в Storage              |
| Adapters  | Модули внутри Core            | Core               | Запросы к API каждого борда, нормализация данных       |
| Retell    | Модуль внутри Core            | Core               | Звонки, SMS, email через Retell API                    |

---

## 3. Storage — Единое Хранилище

**Технология:** Всё хранится в `chrome.storage.local`. Одно хранилище, разделение по namespace через префиксы ключей. Session storage не используется.

### Структура данных (Namespaces)

| Namespace  | Ключи                          | Кто пишет   | Кто читает    |
|------------|---------------------------------|-------------|----------------|
| token:     | token:dat, token:truckstop, ...  | Harvesters  | Core / Adapters|
| work:      | work:loads[], work:search_params | Core        | UI, Core       |
| settings:  | settings:user, settings:boards[] | UI → Core   | Core, UI       |
| saved:     | saved:bookmarks[]               | UI → Core   | UI             |
| history:   | history:calls[], history:loads[] | Core        | UI             |

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

---

## 5. Adapters — Переводчики Бордов

Адаптер берёт токен из Storage, формирует запрос (GraphQL для DAT, REST для Truckstop) и возвращает результат в **нормализованном формате**.

### Нормализованный формат карточки груза

```js
{
  id:          string,          // уникальный ID (boardId + originalId)
  board:       'dat' | 'ts' | 'tp' | ...,
  origin:      { city, state, zip },
  destination: { city, state, zip },
  equipment:   string,          // 'VAN' | 'REEFER' | 'FLATBED'
  weight:      number,          // lbs
  miles:       number,
  rate:        number | null,   // $ total
  rpm:         number | null,   // $ per mile
  broker:      { name, phone, email },
  pickupDate:  string,          // ISO date
  postedAt:    string,          // ISO datetime
  status:      'active',
  raw:         object           // оригинальный ответ борда
}
```

**Важно:** запросы через контекст вкладки борда (не из background напрямую), чтобы браузер подставлял Origin, Referer, User-Agent.

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

**Концепция:** Aida UI — полноценный лоадборд диспетчера. Отдельная вкладка/панель расширения, которая заменяет все борды разом.

### Автозапуск

При открытии любого подключённого борда (DAT, Truckstop):

- chrome.tabs.onUpdated
- Открыть вкладку/панель Aida UI
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

**Принцип:** UI никогда не читает из Storage напрямую. Все запросы и записи — через Core API.

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
    ├── sidepanel.html
    ├── sidepanel.js
    └── components/
```

---

## 12. Важные технические решения

- **Service Worker и сон (MV3):** все данные через chrome.storage.local + onChanged; при пробуждении данные на месте.
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

*Источник: Aida_v01_TZ.docx · внесено в проект в виде docs/AIDA_v01_TZ.md*
