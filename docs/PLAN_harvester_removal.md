# PLAN: Удаление блока Harvesters → автономные адаптеры

**Дата:** 2026-03-05
**Контекст:** При детальном изучении архитектуры каждого лоадборда выявлено, что блок Harvesters (content scripts на вкладках бордов) конфликтует с Auth-модулями и адаптерами. Харвестеры — рудимент из эпохи до auth-модулей, когда единственным способом получить токен была открытая вкладка борда. С появлением `auth-dat.js` и `auth-truckstop.js` харвестеры стали не только избыточны, но и вредны (перезапись JWT невалидными данными).

---

## Принцип: Адаптер = чёрный ящик

```
Core → Adapter.search(params) → { ok, loads[], meta }
         ↑
    AuthManager.getToken(board) → токен (с авто-refresh)
```

Core не знает деталей авторизации и API борда. Адаптер сам:
- Берёт токен через AuthManager
- Если токен протух → silentRefresh()
- Если сессия мертва → возвращает AUTH_REQUIRED → Core открывает popup
- Формирует запрос к API, нормализует ответ
- Возвращает контрактные данные

**Открытая вкладка борда НЕ нужна.** UI нужен только для первого логина.

---

## Фаза 1: Truckstop (СЕЙЧАС)

### Что делаем:
1. **Отключить harvester-truckstop.js** — убрать из manifest.json content_scripts
2. **Убрать обработку TS сообщений от харвестера** в background.js:
   - `TS_SEARCH_REQUEST_CAPTURED` → удалить handler
   - `TS_SEARCH_RESPONSE` → уже отключён (строки 193-198)
   - `TOKEN_HARVESTED` для truckstop → убрать перезапись токена
3. **Валидация JWT** в `auth-truckstop.js` `_saveToken()` — проверять 3 части
4. **Проактивный silent refresh** — alarm каждые 15 мин, дёргает `AuthTruckstop.silentRefresh()` ЗАРАНЕЕ, до протухания
5. **Удалить truckstopRequestTemplate** из settings (не используется)

### Что остаётся работать:
- `auth-truckstop.js` → login popup + silent refresh (POST /auth/renew)
- `truckstop-adapter.js` → built-in GraphQL search + refreshNew()
- Auto-refresh alarm каждые 1 мин

### Риски:
- Нет. Харвестер Truckstop сейчас только вредит.

---

## Фаза 2: DAT (СЛЕДУЮЩАЯ СЕССИЯ)

### Что нужно:
1. **Переписать `auth-dat.js` `silentRefresh()`** — сейчас открывает скрытый таб и ЖДЁТ харвестер. Нужно ловить `#access_token=` из URL через `chrome.tabs.onUpdated` напрямую (как уже делается в `login()`).
2. **Убрать `DAT_SEARCH_RESPONSE`** из background.js — адаптер уже ищет сам через GraphQL.
3. **Отключить harvester-dat.js** — убрать из manifest.json.
4. **SSE (liveQuery)** — уже работает из background.js, харвестер не нужен.

### Риски:
- Auth0 redirect chain может не отдать `#access_token` в URL скрытого таба (проверить). Fallback: `chrome.webNavigation.onCompleted` + парсинг URL.

---

## Фаза 3: TruckerPath (ПОЗЖЕ)

### Текущее состояние:
- Нет auth-модуля (`auth-truckerpath.js` = TODO)
- Зависит от template с открытой вкладки (harvester-truckerpath.js)
- API TruckerPath требует токен из cookies сайта

### Что нужно:
1. Изучить auth-flow TruckerPath (PingOne / custom)
2. Написать `auth-truckerpath.js`
3. Сделать адаптер автономным
4. Убрать харвестер

### Риски:
- TruckerPath может не иметь API для renew (нужен research)

---

## Итоговая архитектура (после всех фаз)

```
aida/
├── background/
│   ├── background.js          ← Core (без обработки harvester messages)
│   ├── storage.js
│   ├── auth/
│   │   ├── auth-manager.js    ← Единый вход для авторизации
│   │   ├── auth-dat.js        ← Auth0 login + silent refresh (без харвестера)
│   │   ├── auth-truckstop.js  ← PingOne login + API renew
│   │   └── auth-truckerpath.js ← TODO
│   └── adapters/
│       ├── dat-adapter.js     ← Полностью автономный
│       ├── truckstop-adapter.js ← Полностью автономный
│       └── truckerpath-adapter.js ← TODO: сделать автономным
├── harvesters/                ← УДАЛИТЬ (или оставить пустую папку до Фазы 3)
└── ui/
```

Manifest.json: убрать все content_scripts для бордов (DAT, Truckstop). Оставить только bridge (если нужен для чего-то ещё).
