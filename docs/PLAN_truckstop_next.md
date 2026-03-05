# PLAN: Truckstop — следующие шаги

> Создан: 2026-03-05  
> Статус: В работе

---

## Что уже сделано ✅

- [x] Автоматический логин через popup OAuth (PingOne → v5-auth → JWT)
- [x] Silent refresh токена через `POST /auth/renew`
- [x] Декодирование JWT claims (v5AccountId, accountUserId, v5AccountUserId)
- [x] Built-in GraphQL запрос без template (Hasura endpoint + JWT + claims)
- [x] Сортировка грузов по postedAt (newest first) по умолчанию
- [x] Отключён `TS_SEARCH_RESPONSE` — грузы с сайта не пропихиваются
- [x] Auto-refresh каждую минуту (20 свежих грузов через UpdatedOnDesc)
- [x] Подсветка новых грузов (row-new, еле-синий фон, < 3 мин)
- [x] Убран template из search() — только built-in GraphQL + JWT
- [x] Колонка Posted вместо Date — относительное время (NEW, 0:02, 1:15, 5h)

---

## Задача 1: Отключить `TS_SEARCH_RESPONSE`

**Приоритет:** Высокий  
**Сложность:** 15 мин  
**Зачем:** Когда открыт Truckstop рядом, его авто-обновления (polling каждые 2-3 мин) перехватываются харвестером и пропихивают грузы в AIDA. Это дублирует работу адаптера.

### Что делать:
1. В `background.js` — убрать case `TS_SEARCH_RESPONSE`
2. Убрать функцию `handleTruckstopSearchResponse()`
3. Оставить: `TOKEN_HARVESTED` и `TS_SEARCH_REQUEST_CAPTURED`

---

## Задача 2: Infinite Scroll (пагинация)

**Приоритет:** Средний  
**Сложность:** 2-3 часа  
**Зачем:** Адаптер загружает 100 грузов. На сайте 3000+ — при скролле подгружаются следующие порции.

### Механизм (из HAR анализа):
- offset=0 limit=100, offset=100 limit=100, offset=200 limit=100...
- Операция: `LoadSearchSortByUpdatedOnDesc` или `ByBinRateDesc`

### Файлы: UI (app.js), Background (background.js), Adapter (truckstop-adapter.js)

---

## Задача 3: Auto-Refresh (авто-обновление)

**Приоритет:** Средний  
**Сложность:** 1-2 часа  
**Зачем:** Truckstop обновляет грузы каждые 2-3 мин. AIDA — только по кнопке Search.

### Механизм: `chrome.alarms` каждые 2 мин → `searchLoads(lastSearch)`

---

## Задача 4: Очистка кода

**Приоритет:** Низкий  
**Сложность:** 30 мин  
- Обновить docs/STATUS.md
- Убрать устаревшие комментарии

---

## Порядок: 1 → 4 → 3 → 2
