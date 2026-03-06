# PLAN: Ликвидация Auth-слоя — Auth → Adapter

> Дата: 2026-03-06
> Статус: ПЛАНИРУЕТСЯ

---

## Проблема

Сейчас 3 слоя для авторизации:
```
background.js → AuthManager → AuthDat/AuthTruckstop → chrome.cookies/storage
```

AuthManager — это роутер-прокси. Каждый адаптер и так автономный (поиск, SSE, realtime).
Auth должен быть частью адаптера, а не отдельным слоем.

## Цель

Адаптер = полностью автономный блок (поиск + авторизация + realtime).
Background.js = тонкий оркестратор — не знает деталей авторизации.

**До:**
```
background/
├── auth/
│   ├── auth-manager.js    ← УДАЛИТЬ
│   ├── auth-dat.js        ← ВМЕРЖИТЬ в dat-adapter.js
│   └── auth-truckstop.js  ← ВМЕРЖИТЬ в truckstop-adapter.js
├── adapters/
│   ├── dat-adapter.js
│   └── truckstop-adapter.js
```

**После:**
```
background/
├── adapters/
│   ├── dat-adapter.js         ← содержит login, silentRefresh, getToken, getStatus
│   └── truckstop-adapter.js   ← содержит login, silentRefresh, getToken, getStatus
```

## Расширенный контракт адаптера

```js
const Adapter = {
    // --- Текущий контракт (не меняется) ---
    search(params)               → { ok, loads, meta, error? }
    loadMore()                   → { ok, loads, hasMore }
    startRealtime(params, cb)    → void
    stopRealtime()               → void

    // --- Новое: Auth (из auth-модуля) ---
    login()                      → { ok, token?, error? }    // popup логина
    getToken()                   → string | null              // актуальный токен (с авто-refresh)
    getStatus()                  → 'connected' | 'expired' | 'disconnected'
    disconnect()                 → void                       // удалить токен

    // --- Опционально ---
    fetchProfile()               → void                       // загрузить профиль (DAT)
};
```

## Шаги

### Шаг 1: Вмержить auth-dat.js в dat-adapter.js
- Скопировать `DAT_AUTH_CONFIG`, `STORAGE_KEYS`, функции `login()`, `silentRefresh()`, `getToken()`, `getStatus()`, `disconnect()`, `_saveToken()`, `_extractTokenFromUrl()` в DatAdapter
- DatAdapter.search() вызывает `this.getToken()` напрямую (вместо `AuthManager.getToken('dat')`)
- Экспорт: `DatAdapter.login`, `DatAdapter.getStatus`, `DatAdapter.disconnect`

### Шаг 2: Вмержить auth-truckstop.js в truckstop-adapter.js
- Скопировать `TS_AUTH_CONFIG`, `STORAGE_KEYS`, функции `login()`, `silentRefresh()`, `getToken()`, `getStatus()`, `disconnect()`, `_saveToken()`, `_decodeJwtClaims()`, `_fetchV5Token()` в TruckstopAdapter
- TruckstopAdapter._getAuth() вызывает `this.getToken()` и `this._getClaims()` напрямую

### Шаг 3: Обновить background.js
- Убрать `import AuthManager`
- `LOGIN_BOARD { board }` → `ADAPTER_REGISTRY[board].module.login()`
- `GET_BOARD_AUTH_STATUS` → iterate adapters, call `.getStatus()`
- `DISCONNECT_BOARD` → `adapter.disconnect()`
- `autoResolveAuthErrors()` → перенести логику в background.js (простой цикл по бордам: `adapter.silentRefresh()` → если failed → `adapter.login()`)
- Init: `adapter.getToken()` вместо `AuthManager.getToken(board)`

### Шаг 4: Удалить файлы
- `background/auth/auth-manager.js` — удалить
- `background/auth/auth-dat.js` — удалить
- `background/auth/auth-truckstop.js` — удалить
- `background/auth/` — удалить папку

### Шаг 5: Обновить ТЗ (§4.1, §5.1)
- §4.1 Auth Module → убрать как отдельную секцию, переописать auth как часть контракта адаптера в §5.1
- §5.1 Контракт адаптера → добавить auth-методы

### Шаг 6: Тест
- Перезагрузить расширение
- Проверить: login DAT (popup), login TS (popup)
- Проверить: silent refresh DAT (direct fetch)
- Проверить: silent refresh TS (API /auth/renew)
- Проверить: search DAT + TS
- Проверить: disconnect + re-login
- Проверить: auto-resolve auth errors

---

## Риски

- **Размер файлов**: dat-adapter.js вырастет с ~970 до ~1200 строк. Приемлемо.
- **Конфликт имён**: `STORAGE_KEYS` используется в обоих адаптерах — нужны уникальные имена или namespace.
- **handleHarvestedToken**: для TP (TruckerPath) ещё используется harvester — оставить как есть в background.js (или в TP adapter когда сделаем).

## Итог

Auth-слой → 0 файлов.
Адаптер = единственная точка входа для всего, что связано с бордом.
Background.js только оркестрирует.
