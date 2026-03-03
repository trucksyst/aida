# AIDA Session: builds 0.1.16 → 0.1.30
## Дата: 2026-03-03

---

## Сводка изменений

### 1. Контракт v2 — дочистка (build 0.1.16)
- `retell.js`: `broker?.name` → `broker?.company`
- `ui/app.js`: убраны `zip: ''` из search params
- `background.js`: комментарий дедупликации `origin.zip` → `origin.city`

### 2. Build номер в UI и консоли (builds 0.1.17–0.1.19)
- `ui/app.js`: `init()` читает `chrome.runtime.getManifest().version`, выводит в footer (`#status-build`) и в консоль зелёным бейджем
- `background.js`: SW выводит build при старте

### 3. TruckerPath Search — полный рефакторинг (builds 0.1.20–0.1.29)

#### 3.1 Геокодирование city → lat/lon (build 0.1.20)
**Файл:** `truckerpath-adapter.js`
- Добавлена функция `geocodeCity(city, state)` — Nominatim API (бесплатно, без ключа)
- В `search()`: геокодирует origin и destination **перед** модификацией body
- Передаёт координаты через `enrichedParams._originGeo` / `._destGeo`

#### 3.2 Search Cooldown (build 0.1.21)
**Файл:** `background.js`
- `SEARCH_COOLDOWN_MS = 10_000` и `_searchCooldownUntil`
- После `searchLoads()` — 10 секунд cooldown, все harvester intercepts (DAT/TS/TP) игнорируются
- Решает проблему: харвестеры с вкладок бордов перезаписывали результаты AIDA search

#### 3.3 Deep recursive body patching (builds 0.1.22–0.1.24)
**Файл:** `truckerpath-adapter.js`
- `modifyTemplateBody()` — прямой патч для TP body структуры
- `deepPatchAll()` — fallback рекурсивный обход
- Прямой патч: `parsed.query.pickup.geo.location.{lat, lng, address}`
- Прямой патч: `parsed.query.dropoff.geo.location.{lat, lng, address}`
- Прямой патч: `parsed.query.pickup.geo.deadhead.max` (radius)
- Прямой патч: `parsed.query.pickup.date_local.{from, to}`

#### 3.4 Regex string replacement (builds 0.1.25–0.1.26)
**Файл:** `truckerpath-adapter.js` — метод `search()`
- Вместо JSON parsing/patching — **прямая regex замена** в body string
- `body.replace(/"lat"\s*:\s*-?[\d.]+/, ...)` — координаты
- `body.replace(/"address"\s*:\s*"[^"]*"/, ...)` — адрес
- `body.replace(/"max"\s*:\s*\d+/, ...)` — deadhead/radius
- `body.replace(/"from"\s*:\s*"[^"]*"/, ...)` — даты (ISO T00:00:00)
- `body.replace(/"to"\s*:\s*"[^"]*"/, ...)` — даты (ISO T23:59:59)
- `body.replace(/"mark_new_since"\s*:\s*"[^"]*"/, ...)` — текущее время

#### 3.5 URL fix: coyote/chr → main (build 0.1.27)
**Файл:** `truckerpath-adapter.js`
- TP шлёт 3 параллельных запроса: `/tl/search/`, `/tl/coyote/search/`, `/tl/chr/search/`
- Только `/tl/search/filter/web/v2` возвращает `items[]`
- Если шаблон захватил coyote/chr URL → принудительно заменяем на основной

#### 3.6 Equipment mapping (build 0.1.28)
**Файл:** `truckerpath-adapter.js`
- AIDA equipment codes (VAN, REEFER, FLATBED) → TP format (van, reefer, flatbed)
- `body.replace(/"equipment"\s*:\s*\[[^\]]*\]/, ...)`

#### 3.7 Headers fix — CORS (build 0.1.29)
**Файл:** `truckerpath-adapter.js`
- **Главная проблема**: `Origin: chrome-extension://` — TP API отклонял/фильтровал
- Принудительно `delete headers['origin']` + `headers['Origin'] = 'https://loadboard.truckerpath.com'`
- Аналогично для `Referer`
- Удалены `sec-fetch-*` и `:authority/:method/:path/:scheme` pseudo-headers

### 4. Cleanup (build 0.1.30)
- Удалены все debug логи (BUILD, Body patched, request preview, etc.)
- Оставлены только essential: error logs, result count

---

## Файлы изменённые в сессии:
- `background/adapters/truckerpath-adapter.js` — основной рефакторинг
- `background/background.js` — cooldown, комментарии, логи
- `background/retell.js` — broker.company
- `ui/app.js` — build footer, zip cleanup
- `harvesters/harvester-truckerpath.js` — build version sync
- `manifest.json` — version bumps

## TP API формат (из HAR):
```
URL: POST https://api.truckerpath.com/tl/search/filter/web/v2
Headers: x-auth-token, client: WebCarriers/0.0.0, installation-id
Body: {
  query: {
    pickup: {
      geo: {
        location: { address, lat, lng },
        deadhead: { max }
      },
      date_local: { from: "YYYY-MM-DDT00:00:00", to: "YYYY-MM-DDT23:59:59" }
    },
    equipment: ["flatbed"]
  },
  origins: ["TRUCKERPATH"]
}
Response: { search_id, items: [...], meta: { total } }
```

## TODO (для следующего чата):
- [ ] Проверить что TP search реально возвращает грузы в UI
- [ ] Проверить что `findLoadsInResponse` находит `items` ключ
- [ ] Проверить нормализацию TP raw → контракт v2
- [ ] Тестировать Van/Reefer equipment маппинг
