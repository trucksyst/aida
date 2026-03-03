# ПЛАН: Auto-Auth + Auto-Search

## Дата: 2026-03-03
## Статус: В работе

---

## Концепция

Пользователь открывает AIDA и **сразу видит грузы** — без кликов, без ручного логина.
Если нужна авторизация — popup появляется **автоматически**.
Кнопки бордов — **только ВКЛ/ВЫКЛ** (🟢/🔴).

---

## Часть 1: Auto-Auth — автоматическая авторизация при ошибках

### Что уже есть (build 0.1.31):
- ✅ `auth-dat.js` — login через popup, silent refresh, token expiry
- ✅ `auth-manager.js` — единый менеджер
- ✅ Message handlers: `LOGIN_BOARD`, `DISCONNECT_BOARD`, `GET_BOARD_AUTH_STATUS`
- ✅ `searchLoads()` собирает `adapterWarnings[]` от всех адаптеров

### Что нужно сделать:

#### 1.1 Определение auth-ошибок в адаптерах
**Файлы:** `dat-adapter.js`, `truckstop-adapter.js`, `truckerpath-adapter.js`
- Адаптер при 401/403/auth error возвращает `{ error: { type: 'auth_required', message: '...' } }`
- Отличаем auth-ошибку от обычной API-ошибки

#### 1.2 Auto-popup очередь в Core
**Файл:** `background.js` (в `searchLoads()`)
- После `Promise.allSettled()` — проверяем `adapterWarnings` на `auth_required`
- Собираем список бордов с auth-ошибками: `authQueue = ['dat', 'truckstop', 'tp']`
- Приоритет: DAT → Truckstop → TruckerPath
- Для каждого борда в очереди:
  1. Сначала `silentRefresh()` (если есть auth-модуль)
  2. Если silent refresh не помог → `login()` (popup)
  3. Popup → юзер кликает "LOG IN ANYWAY" → popup закрывается
  4. Следующий борд в очереди
- После обработки всей очереди → push обновлённые статусы в UI

#### 1.3 Popup не мешает UI
- Popup открывается как отдельное окно (`chrome.windows.create`)
- UI расширения продолжает работать
- После закрытия popup → UI обновляет статусы кнопок

### Что NOT меняем:
- auth-dat.js login() — оставляем как есть (закрывает popup при callback)
- Кнопки бордов — только toggle ВКЛ/ВЫКЛ
- Харвестеры — не трогаем

---

## Часть 2: Auto-Search — автоматический поиск при открытии

### Что уже есть:
- ✅ `lastSearch` сохраняется в Storage при каждом поиске (строка 563 background.js)
- ✅ `clearActive()` + `setLoads()` — перезаписывает loads при поиске

### Что нужно сделать:

#### 2.1 Дефолтные параметры поиска
**Файл:** `ui/app.js` → `init()`
- При первом открытии (нет `lastSearch` в settings):
  - origin.city = город компании из `settings.user` (или пусто)
  - origin.state = стейт компании
  - destination = пусто (все направления)
  - equipment = VAN
  - radius = 50
  - dateFrom = сегодня
  - dateTo = +7 дней

#### 2.2 Auto-search при init
**Файл:** `ui/app.js` → `init()`
1. Загрузить settings из Core → `GET_SETTINGS`
2. Если есть `lastSearch` → заполнить поля формы
3. Если нет → заполнить defaults из компании
4. Вызвать `doSearch()` автоматически
5. Если search вернул auth-ошибки → popup'ы появятся автоматически (часть 1)

#### 2.3 Auto-search при пробуждении SW
**Файл:** `background.js`
- При первом message от UI после пробуждения — если прошло >N минут с последнего поиска → отправить `{ autoSearch: true }` в UI
- UI получает → вызывает `doSearch()` с последними параметрами

---

## Часть 3: Статусы кнопок (УПРОЩЕНО)

### Визуал:
| Цвет | Значение |
|------|----------|
| 🟢 Зелёный | ON — борд подключён и работает |
| 🔴 Красный | OFF — выключен / нет токена / ошибка |

### Клик = toggle:
- 🟢 → клик → 🔴 (disabled)
- 🔴 → клик → 🟢 (enabled, если токен есть)

### Авторизация — НЕ на кнопке:
- Вся авторизация автоматическая (при поиске)
- Popup появляется сам если нужно
- Кнопка ничего не знает об авторизации

---

## Файлы для изменения:

| Файл | Что менять |
|------|-----------|
| `background/background.js` | auto-popup очередь в searchLoads(), auto-search trigger |
| `background/auth/auth-manager.js` | метод `autoResolveAuthErrors(warnings)` |
| `background/adapters/dat-adapter.js` | возвращать `{ error: { type: 'auth_required' } }` |
| `background/adapters/truckstop-adapter.js` | аналогично |
| `background/adapters/truckerpath-adapter.js` | аналогично |
| `ui/app.js` | auto-search в init(), упрощённые кнопки ✅ DONE |
| `ui/components/styles.css` | убрать лишние стили кнопок? (опционально) |

---

## Порядок реализации:
1. ✅ Упростить кнопки до 🟢/🔴 (build 0.1.32)
2. ⬜ Часть 1: auto-popup при ошибках поиска
3. ⬜ Часть 2: auto-search при открытии
4. ⬜ Тестирование полного flow
