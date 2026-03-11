# AIDA — План синхронизации профиля диспетчера
## Profile Sync через chrome.storage.sync

**Версия:** v0.1 (дополнение к основному ТЗ)
**Статус:** Запланировано

---

## Идея

Диспетчер настраивает AIDA один раз — и все настройки автоматически
появляются на любом другом компьютере где он залогинен в Chrome с тем же
Google-аккаунтом. Никаких кнопок «Синхронизировать», никакого экспорта
файлов — всё происходит прозрачно в фоне, как Chrome синхронизирует
свои закладки и пароли.

---

## Что синхронизируется (sync) vs что остаётся локально (local)

### ✅ chrome.storage.sync — профиль диспетчера

| Данные | Ключ | Когда пишется |
|--------|------|---------------|
| Имя диспетчера, компания, телефон, email | `profile:user` | При нажатии "Save settings" |
| Retell API Key, From Number, Agent ID | `profile:retell` | При нажатии "Save settings" |
| OpenClaw URL, API Key, интервал | `profile:openclaw` | При нажатии "Save settings" |
| Видимые столбцы таблицы и их порядок | `profile:columns` | При каждом изменении колонок |
| Ширины столбцов | `profile:colWidths` | При каждом ресайзе |
| Тема (dark/light) | `profile:theme` | При переключении темы |
| Поисковые пресеты (до 8) | `profile:presets` | При сохранении/удалении пресета |

### ❌ chrome.storage.local — локальные данные (не синхронизируются)

| Данные | Почему |
|--------|--------|
| Токены DAT / Truckstop / TruckerPath | Сессионные, на новом компе всё равно нужен логин |
| JWT claims (v5AccountId и др.) | Привязаны к токену, смысла синхронизировать нет |
| Текущие грузы (work:loads) | Реалтайм данные, нерелевантны на другом компе |
| История звонков | Локальная история конкретного компа |
| Закладки | Спорно, можно добавить позже в v0.2 |
| Статус бордов (connected/disabled) | Зависит от наличия токена на конкретном компе |

---

## Архитектура

### Принцип: sync = зеркало settings

Не появляется нового хранилища — `sync` это просто зеркало тех же данных
что уже пишутся в `local`. Core при каждой записи настроек пишет в оба
места параллельно.

```
Диспетчер нажал "Save settings"
       ↓
Core.SAVE_SETTINGS(data)
       ↓
   ┌───┴───────────────────┐
   ↓                       ↓
chrome.storage.local    chrome.storage.sync
 settings:user           profile:user
 settings:...            profile:...
```

### Первый запуск на новом компе

```
init() запускается
       ↓
loadProfile() — читаем chrome.storage.sync
       ↓
   Есть данные в sync?
   ┌──YES──────────────────NO──┐
   ↓                           ↓
Применяем профиль          Используем defaults
из sync как стартовые      (пустые поля)
значения для local
       ↓
Обычный старт AIDA
```

### Изменение настроек на одном компе распространяется на другие

```
Комп A: изменил колонки
       ↓
   writeToSync('profile:columns', [...])
       ↓
Chrome синхронизирует через Google-аккаунт
       ↓
Комп B: chrome.storage.onChanged срабатывает
       ↓
   Core получает событие sync-change
       ↓
Применяет новые колонки (если UI открыт — push в UI)
```

---

## Изменения в коде

### 1. storage.js — новые методы

```js
// Записать в sync (зеркало настроек)
Storage.setProfile(key, value)   // → chrome.storage.sync.set({ [`profile:${key}`]: value })

// Прочитать из sync
Storage.getProfile(key)          // → chrome.storage.sync.get(`profile:${key}`)

// Загрузить весь профиль из sync
Storage.loadFullProfile()        // → все profile:* ключи из sync
```

### 2. background.js (Core) — изменения в SAVE_SETTINGS

```js
case 'SAVE_SETTINGS': {
    // Записать в local (как сейчас)
    await Storage.setSettings(data);
    // Зеркало в sync (новое)
    await Storage.setProfile('user', data.user);
    await Storage.setProfile('retell', data.retell);
    await Storage.setProfile('openclaw', data.openclaw);
    break;
}
```

### 3. background.js (Core) — init()

```js
async function init() {
    // Сначала грузим профиль из sync
    const syncProfile = await Storage.loadFullProfile();
    if (syncProfile && Object.keys(syncProfile).length > 0) {
        // На новом компе — sync есть, local пустой → применяем sync как базу
        await Storage.applyProfileToLocal(syncProfile);
    }
    // Дальше обычный старт...
}
```

### 4. app.js (UI) — при изменении колонок и темы

```js
// Уже существующий saveColumnsOrder() → добавить:
await Storage.setProfile('columns', state.columns);
await Storage.setProfile('colWidths', state.colWidths);

// Уже существующий toggleTheme() → добавить:
await Storage.setProfile('theme', newTheme);
```

### 5. background.js — подписка на sync-изменения (опционально v0.2)

```js
chrome.storage.sync.onChanged.addListener((changes) => {
    // Если настройки изменились на другом компе — применить локально
    // Актуально когда у диспетчера открыты оба компа одновременно
});
```

---

## Лимиты chrome.storage.sync

| Характеристика | Лимит |
|----------------|-------|
| Общий объём | 100 KB |
| Один ключ | 8 KB |
| Операций в час | 1800 |

Наши данные (имя, ключи, 8 пресетов, список колонок) → ~5-10 KB максимум.
Лимиты не критичны.

---

## Порядок реализации

### Фаза 1 — Профиль диспетчера (приоритет)
- [ ] Добавить `Storage.setProfile()` / `getProfile()` / `loadFullProfile()`
- [ ] В Core `SAVE_SETTINGS` → дублировать в sync
- [ ] В Core `init()` → загружать из sync при пустом local
- [ ] Тест: сохранить на одном компе, установить расширение на другом → данные появились

### Фаза 2 — Визуальные настройки
- [ ] При изменении колонок → писать в sync
- [ ] При ресайзе → писать в sync (debounce 1 сек чтобы не частить)
- [ ] При смене темы → писать в sync

### Фаза 3 — Пресеты поиска
- [ ] При сохранении/удалении пресета → писать в sync
- [ ] В init() → загружать пресеты из sync если local пустой

### Фаза 4 — Live sync (v0.2)
- [ ] `chrome.storage.sync.onChanged` → если оба компа открыты одновременно,
      изменения на одном появляются на другом без перезапуска

---

## Совместимость с ТЗ

Согласно §3 ТЗ: «Storage — chrome.storage.local. Одно хранилище.»

Синхронизация через `sync` — **не противоречит** этому принципу:
- `local` остаётся единственным рабочим хранилищем для Core во время работы
- `sync` — это только **резервная копия профиля для переноса между компами**
- Данные в `sync` никогда не читаются в реальном времени во время работы —
  только при первом запуске (`init()`) если `local` пустой

Правило §6.1 «UI не использует chrome.storage» сохраняется — UI по-прежнему
не трогает storage напрямую. Всё через Core API.
