# AIDA — Запросы поиска и смены статуса

Краткая справка: как из расширения выполняются **поиск грузов** и **смена статуса** (worklist / «мои грузы») на бордах. Примеры взяты из AiDispatch_v2 и реализованы в AIDA.

---

## 1. Поиск грузов (из расширения)

**Откуда:** UI (вкладка AIDA) → `chrome.runtime.sendMessage({ type: 'SEARCH_LOADS', params })` → Core → адаптеры бордов.

**Формат параметров (единый для UI и OpenClaw):**

```js
{
  origin:    { city: 'Chicago', state: 'IL', zip: '60601' },
  radius:    10,         // miles
  equipment: 'VAN',      // VAN | REEFER | FLATBED
  dateFrom:  '2026-03-01',
  dateTo:    '2026-03-03'
}
```

**Поведение:**

- Core вызывает параллельно `DatAdapter.search(params)` и `TruckstopAdapter.search(params)` (и др. по мере подключения бордов).
- Результаты приводятся к единому формату карточки (по DAT), дедупликация по `origin + destination + pickupDate + broker.phone`.
- Ответ пишется в Storage (`work:loads`), UI обновляется через `chrome.storage.onChanged`.

**DAT (GraphQL):**

- URL: `https://freight.api.dat.com/one-web-bff/graphql`
- Операция: `freightSearchV4FindLoads`, переменные: origin, equipmentTypes, pickupDates, count, start, при необходимости destination.
- Заголовки: `Authorization: Bearer <token>`, `Origin: https://one.dat.com`, `Referer: https://one.dat.com/`

**Truckstop (REST):**

- URL: `https://api.truckstop.com/api/v2/loads/search` (уточнять по DevTools)
- Body: origin, destination, equipmentTypes, pickupDateStart/End, pageSize, pageNumber.
- Заголовки: `Authorization: Bearer <token>`, Origin/Referer для truckstop.com.

---

## 2. Смена статуса на борде (worklist / «мои грузы»)

По ТЗ операции «мои грузы» (добавить в worklist, сменить статус — CALLED, SAVED, сброс) в едином формате по DAT; адаптер переводит вызовы Core в запросы к API борда.

### DAT Worklist API (по образцу AiDispatch_v2)

Базовый URL: `https://freight.api.dat.com/worklist-service/v1/items`

Заголовки для всех запросов:

- `Content-Type: application/json`
- `Authorization: Bearer <token>`
- `Origin: https://one.dat.com`
- `Referer: https://one.dat.com/`

#### Добавить в My Loads (Mark as Called / Saved)

- **Метод:** `POST`
- **URL:** `https://freight.api.dat.com/worklist-service/v1/items`
- **Body:**
  ```json
  {
    "postingId": "<id груза на DAT>",
    "userStatus": "CALLED"
  }
  ```
  или `"userStatus": "SAVED"` для «сохранён».
- **Ответ:** `{ "id": "<worklistItemId>" }` — этот id нужен для PATCH/DELETE.

#### Обновить статус (SAVED или сброс)

- **Метод:** `PATCH`
- **URL:** `https://freight.api.dat.com/worklist-service/v1/items/<worklistItemId>`
- **Body:**
  ```json
  { "userStatus": "SAVED" }
  ```
  или `{ "userStatus": null }` для сброса.

#### Удалить из My Loads

- **Метод:** `DELETE`
- **URL:** `https://freight.api.dat.com/worklist-service/v1/items/<worklistItemId>`

---

## 3. Связь с действиями в AIDA

| Действие в UI | Core | Адаптер DAT |
|---------------|------|-------------|
| **Search** | `SEARCH_LOADS` → `searchLoads(params)` | `DatAdapter.search(params)`, TruckstopAdapter.search(params) |
| **Save (закладка)** | `SAVE_BOOKMARK` → `saveBookmark(loadId)` | `addToWorklist(load, 'SAVED')` или `updateWorklistStatus(worklistItemId, 'SAVED')` |
| **Call** | `CALL_BROKER` → `callBroker(loadId)` | `addToWorklist(load, 'CALLED')` (если ещё нет worklistItemId), сохраняем id в карточке |
| **Remove bookmark** | `REMOVE_BOOKMARK` → `removeBookmark(loadId)` | `removeFromWorklist(worklistItemId)` при наличии id |
| **Update status** | `UPDATE_LOAD_STATUS` | Локально в Storage; при необходимости синхронизация с бордом через адаптер (по текущей реализации — при save/call/remove). |

`worklistItemId` хранится в карточке груза (`load.worklistItemId`) после первого успешного POST в worklist; используется для последующих PATCH/DELETE.

---

## 4. Токен

Токен для запросов к API борда берётся из Storage (`token:dat`, `token:truckstop`), куда его кладут харвестеры с вкладок one.dat.com / truckstop.com. Без токена адаптеры не выполняют запросы к API (поиск и worklist возвращают пустой результат / отказ).
