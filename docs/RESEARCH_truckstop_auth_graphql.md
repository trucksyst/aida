# Truckstop GraphQL API — Исследование (2026-03-05)

## Контекст

При первой установке AIDA или в новом профиле Truckstop не работал автоматически:
- После popup-логина AIDA получала JWT токен
- Но для поиска грузов адаптер требовал **template** (перехваченный запрос с сайта)
- Без template → NO_TEMPLATE error → 0 результатов

## Ключевые находки

### 1. GraphQL endpoint НЕ требует Authorization header

```
URL: https://loadsearch-graphql-api-prod.truckstop.com/v1/graphql
Method: POST
Headers: Content-Type, Origin, Referer — БЕЗ Authorization/Cookie
```

Авторизация происходит через **user-specific IDs** прямо в GraphQL variables.

### 2. User IDs берутся из JWT claims

Код фронтенда Truckstop (`prod-load-search.truckstop.com/blue/5999.*.js`):

```javascript
const x = this.authorizationService.getClaims();
g.carrier_id = x.v5AccountId;           // UUID перевозчика
g.gl_carrier_user_id = x.accountUserId;  // Salesforce User ID
g.account_user_id = x.v5AccountUserId;   // UUID аккаунта пользователя
```

Claims парсятся из JWT (`624.*.js`):

```javascript
getClaims() {
    const ye = this.getTokenInfo();
    // ye.claims содержит: v5AccountId, accountUserId, v5AccountUserId, contactSfId, ...
    localStorage.setItem("v5AccountId", ye.claims.v5AccountId);
    return ye.claims;
}
```

Маппинг claims → userDetails:

| GraphQL variable            | JS код                  | JWT claim          |
|-----------------------------|-------------------------|--------------------|
| `carrier_id`                | `x.v5AccountId`         | `v5AccountId`      |
| `gl_carrier_user_id`        | `x.accountUserId`       | `accountUserId`    |
| `account_user_id`           | `x.v5AccountUserId`     | `v5AccountUserId`  |
| `carrier_factoring_company_id` | отдельный endpoint   | необязателен (404 если нет) |

### 3. GraphQL операция

**Операция**: `LoadSearchSortByBinRateDesc`  
**Query**: `get_loads_with_extra_data_sort_by_bin_rate_desc`  
**Fragment**: `GridLoadSearchFields`

Полные variables.args:
```json
{
  "origin_radius": 125,
  "carrier_id": "<v5AccountId>",
  "gl_carrier_user_id": "<accountUserId>",
  "enable_pinned_loads": true,
  "account_user_id": "<v5AccountUserId>",
  "enable_floating_loads": true,
  "show_empty_minimum_authority_days_required": null,
  "dh_origin_lat": 32.7767,
  "dh_origin_lon": -96.797,
  "pickup_date_begin": "2026-03-05",
  "pickup_date_end": "2026-04-19",
  "carrier_factoring_company_id": null,
  "offset_num": 0,
  "limit_num": 100
}
```

Полный fragment:
```graphql
fragment GridLoadSearchFields on loads_grid_ret_type {
  id modeId modeCode
  originCity originState originCityState originEarlyTime originLateTime originDeadhead originCountry originZipCode
  destinationCity destinationState destinationCityState destinationEarlyTime destinationLateTime destinationDeadhead destinationCountry destinationZipCode
  tripDistance dimensionsLength dimensionsWeight dimensionsWidth dimensionsHeight dimensionsCube
  postedRate equipmentCode equipmentName equipmentOptions
  isBookItNow loadTrackingRequired allInRate
  rpm @include(if: $isPro)
  accountName experienceFactor daysToPay bondTypeId bondEnabled payEnabled dot brokerMC
  commodityId specialInfo createdOn additionalLoadStops loadStateId
  phone legacyLoadId updatedOn canBookItNow daysToPayInteger postedAsUserPhone
  bondTypeSortOrder diamondCount earningsScore loadPopularity factorabilityStatus
  hasTiers isCarrierOnboarded isPinnedLoad isRepost rowType isCompanyFactorable
  __typename
}
```

### 4. Дополнительные endpoints

- `user-preferences-api.truckstop.com/user` — профиль пользователя (без Auth header, через cookies)
- `user-preferences-api.truckstop.com/accounts/factoring-company` — факторинговая компания (может 404)
- `loadsearch-graphql-api-prod.truckstop.com/v1/graphql?GetRecentSearchesAndSelectedSearch` — сохранённые поиски

## Решение

### Архитектура

1. **auth-truckstop.js** — после получения JWT декодировать payload, извлечь claims (`v5AccountId`, `accountUserId`, `v5AccountUserId`), сохранить в `auth:truckstop:meta`
2. **truckstop-adapter.js** — если нет captured template, построить запрос из:
   - Захардкоженного GraphQL query (операция + fragment)
   - Claims из storage (user IDs)
   - Параметров поиска (origin, radius, dates, equipment)
3. **Template от харвестера** — остаётся как приоритетный путь (если пользователь открывал truckstop.com), но больше не обязателен

### Преимущества

- Полностью автономный поиск после popup-логина
- Не нужно открывать сайт truckstop.com и делать ручной поиск
- Шаблон от харвестера используется как fallback/override (может содержать пользовательские настройки сортировки)
