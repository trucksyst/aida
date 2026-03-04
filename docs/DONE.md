# AIDA — что сделано (контекст для передачи)

## Build 0.1.36 (2026-03-03)

### DAT Usurp-Aware Login
- Popup открывает `one.dat.com/search-loads` (1100×750) вместо loginUrl
- Auth0 silent auth через cookies даёт access_token автоматически
- Popup **НЕ закрывается** при получении токена — даёт юзеру увидеть «LOG IN ANYWAY» модал
- Закрывается когда: search-loads загрузился + токен пойман (3 сек), или харвестер TOKEN_HARVESTED (2 сек), или юзер закрыл, или timeout 2 мин
- `dat-adapter.js`: `getLocationSuggestion()` возвращает `'AUTH_FAILED'` на 401/403 → `search()` возвращает `AUTH_REQUIRED`

### Кнопки бордов — простой ON/OFF Toggle
- Один клик = flip состояния (disabled ↔ enabled)
- 🟢 зелёная = ВКЛ, 🔴 красная = ВЫКЛ (по `disabled` флагу, не по `connected`)
- При ВЫКЛЮЧЕНИИ → удаляются все грузы этого борда из storage
- При ВКЛЮЧЕНИИ → авто-поиск с лучшими параметрами:
  - Приоритет: форма → `lastSearch` → company city → Chicago, IL
  - Equipment по умолчанию: Van, dates: сегодня
- Убрано зачёркивание (line-through) у disabled кнопок
- Убраны мёртвые функции: `toggleBoard()`, `loginBoard()`, `disconnectBoard()`

### Auto-Popup Control
- Auto-popup **только для DAT** (есть auth-модуль с silent refresh + login)
- Truckstop/TruckerPath: popup только при ручном клике (LOGIN_BOARD → fallback popup)
- Disabled борды фильтруются из authErrors (двойная защита)
- Борды без токена/шаблона не запускают адаптер (skipResult)

### AIDA Auto-Open
- Убрано авто-открытие при загрузке вкладки борда
- Убрано авто-открытие при старте/перезагрузке расширения
- AIDA открывается **только** при клике на иконку в тулбаре

### Очистка кода
- auth-manager.js: убран мёртвый fallback-popup код из `autoResolveAuthErrors`
- auth-dat.js: убран пустой блок, исправлен синтаксис скобок
- app.js: `ensureSearchParamsAndSearch()` — единая точка для авто-поиска (DRY)

### DAT Silent Refresh (исправлен)
- **Проблема**: `silentRefresh` открывал Auth0 URL напрямую (`prompt=none`). Chrome пропускал быстрый fragment-redirect (`#access_token=...`) в `tabs.onUpdated` → timeout → popup открывался хотя пароль не нужен
- **Решение**: silentRefresh теперь открывает `one.dat.com/search-loads` в скрытом табе. DAT сам делает Auth0 redirect, харвестер на `one.dat.com` ловит токен через `TOKEN_HARVESTED`
- silentRefresh ловит токен из 3 источников: callback URL, storage после page load, TOKEN_HARVESTED от харвестера
- Timeout увеличен 15с → 30с
- **Результат**: popup появляется ТОЛЬКО когда реально нужен пароль (Auth0 cookie протухла)

### TODO (не реализовано)
- Login popup открывается как отдельное окно. Можно переделать на вкладку в том же окне (`chrome.tabs.create({ windowId })` вместо `chrome.windows.create`)

---

## Хранение куки и ключей

- **Токены** (`token:dat`, `token:truckstop`) и **шаблоны запросов** (`settings:truckstopRequestTemplate`, `settings:truckerpathRequestTemplate`) с куками сохраняются в `chrome.storage.local`.
- Данные **не сбрасываются** при закрытии вкладки; хранятся до следующего перехвата на вкладке борда или до переустановки расширения.

## Карточка груза: comments

- Единый формат — поле **`comments`**. Один ключ `RAW_FIELD_COMMENTS` во всех адаптерах.

## TruckerPath

- Харвестер: перехват `loadboard.truckerpath.com` и `api.truckerpath.com`
- Адаптер: маппинг из двух форматов карточек; отсечение плейсхолдеров

## Truckstop

- Адаптер: шаблон + fetch из background, геокод Nominatim, нормализация

## DAT

- Нормализатор: comments только из `raw[RAW_FIELD_COMMENTS]`
