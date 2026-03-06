# PLAN: Следующая сессия

> Дата: 2026-03-06
> Версия: 0.1.80

---

## 1. Удалить auth-manager.js (минимальная чистка)

Auth-модули (`auth-dat.js`, `auth-truckstop.js`) — оставить как есть.
Удалить только `auth-manager.js` — бесполезный роутер-прокси.

### Что сделать:

1. **background.js** — заменить `import AuthManager` на прямой импорт:
   ```js
   import AuthDat from './auth/auth-dat.js';
   import AuthTruckstop from './auth/auth-truckstop.js';
   ```

2. **background.js** — заменить все вызовы `AuthManager.xxx(board)`:
   - `AuthManager.login('dat')` → `AuthDat.login()`
   - `AuthManager.login('truckstop')` → `AuthTruckstop.login()`
   - `AuthManager.getToken(board)` → `AUTH_MODULES[board].getToken()`
   - `AuthManager.getStatus(board)` → аналогично
   - `AuthManager.disconnect(board)` → аналогично
   - `AuthManager.getAllStatuses()` → написать inline (5 строк)
   - `AuthManager.autoResolveAuthErrors()` → перенести логику (простой цикл)

3. **dat-adapter.js** — заменить `AuthManager.getToken('dat')` на `AuthDat.getToken()` (прямой import)

4. **Удалить** `background/auth/auth-manager.js`

5. Тест: login/disconnect/search для DAT и Truckstop

---

## 2. TruckerPath — автологин (popup + harvester)

Сейчас TP работает только если пользователь открывает fleet.truckerpath.com и делает поиск вручную.
Нужно: кнопка TP → popup логин → harvester ловит шаблон → TP автономно ищет.

### Исследование (первый шаг):

1. Открыть fleet.truckerpath.com, залогиниться, сделать поиск
2. Изучить HAR: какие endpoints, какая авторизация (cookies? JWT? API key?)
3. Проверить: можно ли искать грузы напрямую через API (как DAT/TS)?
4. Если да → реализовать `auth-truckerpath.js` модуль
5. Если нет → оставить harvester как единственный способ получения данных

### Что уже есть:

- `harvester-truckerpath.js` — работает, ловит поисковые ответы
- `truckerpath-adapter.js` — нормализует грузы в единый формат
- `_openFallbackPopup('tp', url)` — popup уже умеет открываться

### Что нужно:

- Исследовать API: есть ли прямой endpoint для поиска (как GraphQL у TS)?
- Если есть → auth-модуль + built-in search (полная автономия)
- Если нет → popup → дождаться harvester → popup закрывается → данные в AIDA

---

## Приоритеты

1. ✅ Удалить auth-manager.js (быстро, 15 мин)
2. 🔍 Исследование TruckerPath API
3. 🔧 Реализация автологина TP
