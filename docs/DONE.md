# AIDA — что сделано (контекст для передачи)

## Хранение куки и ключей

- **Токены** (`token:dat`, `token:truckstop`) и **шаблоны запросов** (`settings:truckstopRequestTemplate`, `settings:truckerpathRequestTemplate`) с куками сохраняются в `chrome.storage.local`.
- Данные **не сбрасываются** при закрытии вкладки; хранятся до следующего перехвата на вкладке борда или до переустановки расширения.
- В `storage.js` добавлен комментарий о персистентности настроек и шаблонов.

## Карточка груза: comments (описание груза)

- В ТЗ в единый формат карточки добавлено поле **`comments`** (описание груза).
- Во всех трёх адаптерах используется **одно поле** из сырой карточки — константа **`RAW_FIELD_COMMENTS`** (по умолчанию `'comments'`). Имя ключа задаётся после просмотра сырой карточки в консоли (логи `[AIDA/Core] DAT/Truckstop/TruckerPath raw load card`).
- Переборов полей (remarks, description, commodity и т.д.) нет — только один ключ из консоли.
- В UI в блоке Shipment строка **Comments** выводится всегда (значение или «—»).

## TruckerPath

- Харвестер: перехват `loadboard.truckerpath.com` и `api.truckerpath.com`, в т.ч. `v1/loads/load-search`, GraphQL; защита от undefined при разборе; поддержка форматов `pickup_locations`/`drop_offs_locations`, `pickup.address`/`drop_off.address`, `trip_details`, объектов с числовыми ключами.
- Инъекция харвестера из background при загрузке вкладки TruckerPath.
- Адаптер: маппинг из двух форматов карточек (pickup_locations/drop_offs, pickup/drop_off.address, trip_details, price_total, broker.phone.number, all_in_one_date, created_at); отсечение плейсхолдеров (axde_mcleod_origin); один ключ для comments — `RAW_FIELD_COMMENTS`.

## Truckstop

- Адаптер: шаблон + fetch из background, геокод Nominatim, нормализация; comments только из `raw[RAW_FIELD_COMMENTS]`.

## DAT

- В нормализаторе comments только из `raw[RAW_FIELD_COMMENTS]` (без fallback на item).

## Очистка кода

- Убраны лишние «Step»-логи в Core (оставлены логи сырой карточки для выбора полей и ошибки).
- STATUS.md обновлён: Truckstop и TruckerPath отмечены как реализованные; добавлена заметка про персистентность и comments.
