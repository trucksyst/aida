# RESEARCH: DAT Auth API — Silent Token Refresh

> Дата: 2026-03-06
> Статус: ЗАВЕРШЕНО ✅
> Контекст: Фаза 0.5 из PLAN_adapter_autonomy.md

---

## Вопрос

Есть ли у DAT простой API endpoint для обновления токена (аналог Truckstop `POST /auth/renew`)?

## Ответ

**Прямого API endpoint нет.** Но найден **надёжный метод через Auth0 `prompt=none`**, который НЕ требует ни харвестера, ни скрытого таба.

---

## Находка: Auth0 `response_mode=web_message` + `prompt=none`

### Что делает сам сайт DAT

DAT использует Auth0 JS SDK v9.30.0. Для обновления токена сайт вызывает `getTokenSilently()`, который:

1. Создаёт скрытый **iframe** (не таб!) с URL:
```
GET https://login.dat.com/authorize
  ?client_id=e9lzMXbnWNJ0D50C2haado7DiW1akwaC
  &response_type=token id_token
  &redirect_uri=https://one.dat.com/callback
  &scope=openid profile email
  &audience=https://prod-api.dat.com
  &response_mode=web_message    ← КЛЮЧЕВОЕ: ответ через postMessage, не redirect
  &prompt=none                  ← без UI
  &nonce=...
  &state=...
```

2. Auth0 проверяет session cookies → если сессия жива → возвращает **HTML-страницу** с JS:
```html
<script>
var authorizationResponse = {
  type: "authorization_response",
  response: {
    "access_token": "eyJ...",
    "id_token": "eyJ...",
    "scope": "openid profile email",
    "expires_in": 86400,
    "token_type": "Bearer"
  }
};
// postMessage обратно в parent window
</script>
```

3. **Токен прямо в HTML response body!** Можно парсить regex-ом без DOM и без iframe.

### Подтверждённые параметры (из HAR)

| Параметр | Значение |
|----------|----------|
| `client_id` | `e9lzMXbnWNJ0D50C2haado7DiW1akwaC` |
| `response_type` | `token id_token` |
| `redirect_uri` | `https://one.dat.com/callback` |
| `scope` | `openid profile email` |
| `audience` | `https://prod-api.dat.com` |
| `response_mode` | `web_message` |
| `prompt` | `none` |
| `auth0Client` | `eyJuYW1lIjoiYXV0aDAuanMiLCJ2ZXJzaW9uIjoiOS4zMC4wIn0=` = `{"name":"auth0.js","version":"9.30.0"}` |

### JWT из HAR

- Длина: 2782 символов
- Время жизни: **1800 сек (30 минут)**, НЕ 3600 как было в конфиге
- `iat`: 1772773367, `exp`: 1772775167

### Cookies

Запрос `prompt=none` отправляет Auth0 session cookies (автоматически из браузера). Ключевые:
- `auth0` / `auth0_compat` — сессионные cookies `login.dat.com`
- Без этих cookies Auth0 вернёт `error=login_required`

---

## Варианты реализации Silent Refresh

### ✅ Вариант A: fetch() из скрытого таба (РЕКОМЕНДУЕМЫЙ)

```js
async silentRefresh() {
    // 1. Открыть скрытый таб на login.dat.com/authorize?prompt=none&response_mode=web_message
    //    Браузер отправит cookies автоматически
    // 2. Auth0 вернёт HTML с access_token в body
    // 3. Перехватить через chrome.tabs.onUpdated (complete) → chrome.scripting.executeScript
    //    → document.body.innerText → парсить access_token
    // 4. Закрыть таб
}
```

**Плюсы:** Cookies отправляются автоматически, надёжный перехват токена.
**Минусы:** Вкладка мелькает (хоть и `active: false`).

### ✅ Вариант B: chrome.offscreen (ЛУЧШИЙ)

```js
async silentRefresh() {
    // 1. chrome.offscreen.createDocument({ url: 'offscreen.html' })
    //    offscreen.html содержит скрытый <iframe src="login.dat.com/authorize?...">
    // 2. iframe загружает Auth0 response → postMessage с access_token
    // 3. offscreen.html ловит postMessage → отправляет в Service Worker
    // 4. chrome.offscreen.closeDocument()
}
```

**Плюсы:** Полностью невидимый, идиоматичный MV3.
**Минусы:** Нужен `offscreen.html` + manifest permission `"offscreen"`.
**Нюанс:** iframe должен быть на домене `one.dat.com` (redirect_uri), чтобы получить postMessage. Может потребоваться `chrome.webNavigation` для перехвата.

### ✅ Вариант C: Скрытый таб с парсингом HTML (ПРОСТЕЙШИЙ)

```js
async silentRefresh() {
    // 1. Открыть скрытый таб: login.dat.com/authorize?prompt=none&response_mode=web_message
    // 2. Auth0 вернёт HTML с access_token (не redirect!)
    // 3. chrome.tabs.onUpdated (complete) → вкладка загрузилась
    // 4. chrome.scripting.executeScript → извлечь body.innerText → regex "access_token":"..."
    // 5. Закрыть таб
}
```

**Плюсы:** Просто, надёжно, токен 100% в body.
**Минусы:** Вкладка мелькает.

### ❌ Вариант D: fetch() напрямую из Service Worker

```js
const resp = await fetch('https://login.dat.com/authorize?prompt=none&...', {
    credentials: 'include'
});
const html = await resp.text();
// Парсим access_token из HTML
```

**НЕ РАБОТАЕТ:** `fetch()` из Service Worker не отправляет third-party cookies `login.dat.com`. Chrome блокирует cross-origin cookies в MV3 Service Worker.

---

## Исследованные endpoints

### `identity.api.dat.com/auth/token/authorizations/v1`

**Результат:** Возвращает СПИСОК РАЗРЕШЕНИЙ (permissions), НЕ токен.
```json
{"authorizations":{"permissions":["Freight:LoadSearches:Manage","Visibility:..."]}}
```
**Не подходит для refresh.**

### `identity.api.dat.com/usurp/v1/session/status`

**Результат:** Проверка статуса "usurp" (конкурирующие сессии).
```json
{"usurped":true}
```
**Не содержит токен.**

### `login.dat.com/userinfo`

**Результат:** OIDC userinfo — профиль пользователя.
```json
{"sub":"auth0|5c2a428f82ce5647850e27b9","name":"...","email":"trucksyst@gmail.com"}
```
**Не содержит новый access_token.**

---

## Рекомендация

**Вариант C** (скрытый таб + парсинг HTML) — самый простой и надёжный:

1. Подход похож на текущий `silentRefresh()`, но **без зависимости от харвестера**
2. Вместо ожидания `TOKEN_HARVESTED` — сами извлекаем токен из loaded HTML через `chrome.scripting.executeScript`
3. `response_mode=web_message` гарантирует что Auth0 вернёт HTML с токеном (не redirect), значит таб загружается 1 раз без redirect chain

**Вариант B** (chrome.offscreen) — upgrade на будущее, если мелькание таба станет проблемой.

---

## Важное уточнение: Token Lifetime

Из HAR выявлено что **реальное время жизни токена = 30 минут (1800 сек)**, а не 3600 как было указано в конфиге `auth-dat.js`. Нужно обновить `DAT_AUTH_CONFIG.tokenLifetimeSec`.
