# Аудит RAW карточек: DAT vs TP vs Truckstop

> Дата: 2026-03-02
> Цель: определить какие данные есть в RAW, какие берёт парсер, какие теряет

---

## Сводная таблица: Контракт vs RAW

| Поле контракта | DAT (где лежит) | DAT берёт? | TP (где лежит) | TP берёт? | TS (где лежит) | TS берёт? |
|---------------|-----------------|------------|----------------|-----------|----------------|-----------|
| **ИДЕНТИФИКАЦИЯ** | | | | | | |
| `id` | `assetInfo.postingId` | ✅ | `shipment_id` | ✅ | TODO | TODO |
| `externalId` | `assetInfo.postingId` | ❌ | `external_id` | ❌ | TODO | TODO |
| `referenceId` | `postersReferenceId` | ❌ | `reference_id` | ❌ | TODO | TODO |
| **ORIGIN** | | | | | | |
| `origin.city` | `assetInfo.origin.city` | ✅ | `pickup.address.city` | ✅ | TODO | TODO |
| `origin.state` | `assetInfo.origin.stateProv` | ✅ | `pickup.address.state` | ✅ | TODO | TODO |
| `origin.zip` | нет в карточке | — | `pickup.address.zip` | ❌ | TODO | TODO |
| `origin.lat` | `assetInfo.origin.latitude` | ❌ | `pickup.location.lat` | ❌ | TODO | TODO |
| `origin.lng` | `assetInfo.origin.longitude` | ❌ | `pickup.location.lng` | ❌ | TODO | TODO |
| **DESTINATION** | | | | | | |
| `destination.city` | `assetInfo.destination.city` | ✅ | `drop_off.address.city` | ✅ | TODO | TODO |
| `destination.state` | `assetInfo.destination.stateProv` | ✅ | `drop_off.address.state` | ✅ | TODO | TODO |
| `destination.zip` | нет в карточке | — | `drop_off.address.zip` | ❌ | TODO | TODO |
| `destination.lat` | `assetInfo.destination.latitude` | ❌ | `drop_off.location.lat` | ❌ | TODO | TODO |
| `destination.lng` | `assetInfo.destination.longitude` | ❌ | `drop_off.location.lng` | ❌ | TODO | TODO |
| **ГРУЗ** | | | | | | |
| `equipment` | `assetInfo.equipmentType` | ✅ | `equipment[0]` | ✅ | TODO | TODO |
| `equipmentAll` | `[equipmentType]` | ❌ | `equipment` (массив) | ❌ | TODO | TODO |
| `weight` | `capacity.maximumWeightPounds` | ✅ | `weight` | ✅ | TODO | TODO |
| `length` | `capacity.maximumLengthFeet` | ✅ | `length` | ❌ | TODO | TODO |
| `width` | нет | — | `width` | ❌ | TODO | TODO |
| `loadSize` | `capacity.fullPartial` | ✅ | `load_size` | ❌ | TODO | TODO |
| **РАССТОЯНИЕ / ЦЕНА** | | | | | | |
| `miles` | `tripLength.miles` | ✅ | `distance_total` | ✅ | TODO | TODO |
| `deadhead` | `originDeadheadMiles.miles` | ❌ | `pickup.deadhead` | ❌ | TODO | TODO |
| `rate` | `rateInfo.bookable.rate.rateUsd` | ✅ | `price_total` | ✅ | TODO | TODO |
| `rpm` | рассчитывается | ✅ | рассчитывается | ✅ | TODO | TODO |
| `avgRate` | `estimatedRatePerMile` | ❌ | `avg_price` | ❌ | TODO | TODO |
| **BROKER** | | | | | | |
| `broker.name` | `posterInfo.companyName` | ✅ | `broker.company` | ✅ | TODO | TODO |
| `broker.contactName` | нет отдельно | — | `broker.contact_name` | ❌ | TODO | TODO |
| `broker.phone` | `contact.phone.number` | ✅ | `broker.phone.number` | ✅ | TODO | TODO |
| `broker.phoneExt` | `contact.phone.extension` | ❌ | `broker.phone.ext` | ❌ | TODO | TODO |
| `broker.email` | `contact.email` | ✅ | `broker.email` | ❌ | TODO | TODO |
| `broker.mc` | `posterDotIds.brokerMcNumber` | ❌ | `broker.mc` | ❌ | TODO | TODO |
| `broker.dot` | `posterDotIds.dotNumber` | ❌ | `broker.dot` | ❌ | TODO | TODO |
| `broker.rating` | `credit.creditScore` | ✅ | `transcredit_rating.score` | ❌ | TODO | TODO |
| `broker.daysToPay` | `credit.daysToPay` | ✅ | `transcredit_rating.days_to_pay` | ❌ | TODO | TODO |
| **ОПИСАНИЕ** | | | | | | |
| `comments` | `comments` ⚠️ МАССИВ | ⚠️ | `description` | ❌ | TODO | TODO |
| **ДАТЫ** | | | | | | |
| `pickupDate` | `availability.earliestWhen` | ✅ | `pickup.date_local` | ✅ | TODO | TODO |
| `deliveryDate` | `availability.latestWhen` | ❌ | `trip_details[D].date_local_start` | ❌ | TODO | TODO |
| **ФЛАГИ** | | | | | | |
| `bookNow` | `rateInfo.bookable` наличие | ❌ | `book_now` | ❌ | TODO | TODO |
| `biddable` | `isNegotiable` | ❌ | `biddable` | ❌ | TODO | TODO |
| `isFactorable` | `isFactorable` | ❌ | нет | — | TODO | TODO |
| `channel` | нет (DAT = direct) | — | `channel` | ❌ | TODO | TODO |
| `source` | нет | — | `channel_drill_down` | ❌ | TODO | TODO |

---

## RAW примеры

### DAT card[0]
```
Endpoint: freight.api.dat.com/one-web-bff/graphql (операция FindLoads)
Путь: data.freightSearchV4.findLoads.results[]
```

Ключевые особенности DAT:
- `comments` — **МАССИВ строк**, не строка. Нужен `.join('\n')`
- `posterDotIds` — отдельный объект с mc/dot (не внутри posterInfo)
- `contact.phone.extension` — добавочный (card[2] имеет "144")
- `estimatedRatePerMile` — DAT уже рассчитал рыночный RPM
- `capacity.fullPartial` — "FULL" / "PARTIAL"
- Координаты lat/lng есть в origin/destination

### TP card (пример с broker)
```
Endpoint: api.truckerpath.com/tl/search/filter/web/v2
Путь: массив карточек в корне ответа
```

Ключевые особенности TP:
- `description` — заметка (Note), `comments` обычно пуст
- `broker.transcredit_rating` — рейтинг внутри broker объекта
- `broker.mc/dot` — внутри broker объекта
- `equipment` — МАССИВ (может быть несколько типов)
- `pickup.deadhead` — deadhead в милях
- `channel` / `channel_drill_down` — источник груза
- `book_now`, `biddable` — флаги

### Truckstop card
```
TODO — нужно перехватить и проанализировать
```
