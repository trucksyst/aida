# План: Миграция на максимальный контракт данных

> Дата: 2026-03-02
> Контекст: При анализе TP-карточек обнаружили что парсер теряет 20+ полей.
> Решение: Максимальный контракт — берём ВСЁ, UI показывает что нужно.

---

## Что обнаружили

### TruckerPath — проблемы перехвата
1. `isSearchUrl()` ловил ВСЁ с домена TP (слово `load` в `loadboard.truckerpath.com`)
2. `findLoadsArray()` рекурсивно перебирал весь JSON — находил грузы в sidebar, рекомендациях
3. Каждый мелкий ответ (3-5 грузов) заменял основной поиск (200+ грузов)
4. **Решение:** точечный перехват — `PRIMARY: /tl/search/filter/web/v2`, исключение `truckloads-similar`

### TruckerPath — проблемы парсера
1. `description` ("no conestogas") → не извлекался. На сайте TP это **Note**
2. `broker.email`, `broker.mc`, `broker.dot`, `broker.phone.number` → не извлекались
3. `broker.transcredit_rating` → не извлекался
4. `pickup.address.zip`, координаты `lat/lng` → не извлекались
5. `length`, `width`, `load_size` → не извлекались
6. `channel`, `book_now`, `biddable` → не извлекались
7. Дедупликация удаляла грузы с одинаковым city+date при пустом phone → **убрана**

### Архитектурное решение
- Контракт данных расширен до **максимального супер-набора** всех полей всех бордов
- Записано в ТЗ (раздел 5)
- Принцип: берём ВСЁ → нормализуем → UI берёт что нужно

---

## План реализации

### Фаза 1: DAT — аудит и обновление
- [ ] 1.1 Проверить endpoint перехвата DAT-харвестера (конкретный URL, не перебор)
- [ ] 1.2 Посмотреть RAW карточку DAT в консоли — все ли поля видим
- [ ] 1.3 Сверить DAT `normalize()` с новым контрактом — добавить недостающие поля:
  - `externalId` ← `postingId`
  - `referenceId` ← `postersReferenceId`
  - `origin.lat/lng` ← `origin.latitude/longitude`
  - `destination.lat/lng`
  - `deadhead` ← `originDeadheadMiles.miles`
  - `avgRate` ← `estimatedRatePerMile`
  - `broker.mc` ← `posterDotIds.brokerMcNumber`
  - `broker.dot` ← `posterDotIds.dotNumber`
  - `broker.contactName` ← `posterInfo.contact`
  - `broker.fax` ← если есть
  - `broker.phoneExt` ← `phone.extension`
  - `loadSize` ← `capacity.fullPartial`
  - `pickupTime` ← из `availability.earliestWhen`
  - `deliveryDate` ← из `availability.latestWhen`
  - `channel` ← `''` (DAT = прямой)
  - `bookNow` ← `rateInfo.bookable` наличие
  - `biddable` ← `isNegotiable`
  - `isFactorable` ← `isFactorable`
  - `isNew` ← `false`
  - `equipmentAll` ← `[equipmentType]`
- [ ] 1.4 Тест: поиск DAT → проверить все поля в консоли

### Фаза 2: TruckerPath — аудит и обновление
- [ ] 2.1 Endpoint перехвата: `/tl/search/filter/web/v2` ✅ (уже сделано)
- [ ] 2.2 Посмотреть RAW карточку TP в консоли ✅ (уже сделано)
- [ ] 2.3 Обновить `mapRowToLoad()` под новый контракт:
  - `externalId` ← `external_id`
  - `referenceId` ← `reference_id`
  - `origin.zip` ← `pickup.address.zip`
  - `origin.lat/lng` ← `pickup.location.lat/lng`
  - `destination.zip` ← `drop_off.address.zip`
  - `destination.lat/lng` ← `drop_off.location.lat/lng`
  - `deadhead` ← `pickup.deadhead`
  - `avgRate` ← `avg_price`
  - `broker.contactName` ← `broker.contact_name`
  - `broker.email` ← `broker.email`
  - `broker.mc` ← `broker.mc`
  - `broker.dot` ← `broker.dot`
  - `broker.fax` ← `broker.fax`
  - `broker.phoneExt` ← `broker.phone.ext`
  - `broker.rating` ← `broker.transcredit_rating.score`
  - `broker.daysToPay` ← `broker.transcredit_rating.days_to_pay`
  - `comments` ← `description || comments`
  - `length` ← `length`
  - `width` ← `width`
  - `loadSize` ← `load_size`
  - `equipmentAll` ← `equipment` (массив)
  - `pickupTime` ← из `pickup.date_local`
  - `deliveryDate` ← из `trip_details` type D `date_local_start`
  - `channel` ← `channel`
  - `source` ← `channel_drill_down`
  - `bookNow` ← `book_now`
  - `biddable` ← `biddable`
  - `isNew` ← `is_new`
  - `isFactorable` ← `false`
- [ ] 2.4 Тест: поиск TP → проверить все поля в консоли

### Фаза 3: Truckstop — аудит и обновление
- [ ] 3.1 Проверить endpoint перехвата Truckstop-харвестера
- [ ] 3.2 Посмотреть RAW карточку TS в консоли
- [ ] 3.3 Обновить нормализатор TS под новый контракт
- [ ] 3.4 Тест

### Фаза 4: UI — отображение
- [ ] 4.1 Обновить таблицу грузов — показать новые поля (broker.mc, comments, и т.д.)
- [ ] 4.2 Обновить детальную панель — полная информация о грузе
- [ ] 4.3 Тест UI

---

## Порядок работы
1. **DAT первый** — самый сложный API, больше всего полей
2. **TP второй** — уже разобрали структуру карточки
3. **TS третий** — по аналогии
4. **UI последний** — когда все данные в контракте
