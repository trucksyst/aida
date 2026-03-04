# Truckstop Auth Module — План реализации
**Дата:** 2026-03-04
**Задача:** Автоматическая авторизация и перелогин Truckstop (по аналогии с DAT)

---

## Анализ (HAR-файлы)

### Обнаруженный Auth Flow
- **Identity Provider:** PingOne DaVinci (аналог Auth0 у DAT)
- **client_id:** `7a99fb37-0cbd-4526-a557-bd283b9e9cf4`
- **Authorize URL:** `auth.truckstop.com/as/authorize`
- **Callback:** `app.truckstop.com/Landing/PingExternalLoginCallback` (form_post)
- **Token endpoint:** `GET v5-auth.truckstop.com/auth/token/{userId}`
- **Renew endpoint:** `POST v5-auth.truckstop.com/auth/renew` + `{token: jwt}`
- **Token TTL:** ~20 минут (1199 сек)
- **Token storage:** `localStorage.setItem("token", jwt)`
- **GraphQL API:** `loadsearch-graphql-api-prod.truckstop.com/v1/graphql` (Hasura + JWT hasura-claims)

### Redirect chain после логина
```
auth.truckstop.com/as/authorize → PingOne DaVinci login form
→ POST app.truckstop.com/Landing/PingExternalLoginCallback (access_token + id_token в body)
→ 302 /Landing/V5Redirector
→ 302 /Search/Loads/V5
→ 302 main.truckstop.com?id={userId}&source=auth.truckstop.com&event=login
→ JS: GET v5-auth.truckstop.com/auth/token/{userId} → JWT
```

---

## План реализации

### Шаг 1. Создать `background/auth/auth-truckstop.js`
- **login()** — popup → `auth.truckstop.com/as/authorize` → перехват redirect chain → извлечь `userId` из `main.truckstop.com?id={userId}` → `GET v5-auth/token/{userId}` → сохранить JWT
- **silentRefresh()** — `POST v5-auth.truckstop.com/auth/renew {token: jwt}` → новый JWT (без popup, без вкладки!)
- **getToken()** — из storage, автообновление за 3 мин до истечения
- **getStatus()** — connected / expired / disconnected
- **disconnect()** — удалить токен + мету

### Шаг 2. Обновить `background/auth/auth-manager.js`
- Подключить `AuthTruckstop` в `AUTH_MODULES.truckstop`
- Теперь `autoResolveAuthErrors` будет работать и для Truckstop

### Шаг 3. Обновить `harvesters/harvester-truckstop.js`
- Добавить перехват ответа от `v5-auth.truckstop.com/auth/token/*` → извлечь accessToken из response body → TOKEN_HARVESTED
- Добавить перехват ответа от `v5-auth.truckstop.com/auth/renew` → аналогично
- Оставить существующий перехват Bearer (fallback)
- Оставить перехват search response/request (без изменений)

### Шаг 4. Обновить `background/background.js`
- `hasAuthModule: true` для truckstop в `getSettingsForUI()`
- searchLoads: при отсутствии template но наличии token — НЕ блокировать (template захватится при первом поиске на странице TS)

### Шаг 5 (опциональный, позже). Обновить `truckstop-adapter.js`
- Построить GraphQL запрос самостоятельно (без template)
- JWT содержит hasura-claims → подходит для прямого запроса к Hasura
- Пока оставляем template-подход как рабочий

---

## Файлы

| Файл | Действие | Статус |
|------|---------|--------|
| `background/auth/auth-truckstop.js` | СОЗДАТЬ | ✅ Done |
| `background/auth/auth-manager.js` | ИЗМЕНИТЬ — подключить AuthTruckstop | ✅ Done |
| `harvesters/harvester-truckstop.js` | ИЗМЕНИТЬ — добавить v5-auth token interception | ✅ Done |
| `background/background.js` | ИЗМЕНИТЬ — hasAuthModule: true, AuthManager.getToken, alarm refresh | ✅ Done |
