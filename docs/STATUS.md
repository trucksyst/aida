# AIDA v0.1 — Статус по ТЗ

Что сделано и что ещё нужно по [AIDA_v01_TZ.md](./AIDA_v01_TZ.md).

---

## Сделано (реализовано)

### Блоки и файлы

| Блок / функция | Файлы | Статус |
|----------------|--------|--------|
| **Core** | `background/background.js` | ✓ Маршрутизация сообщений, searchLoads, clearActive, saveBookmark, callBroker, getHistory, getSettings, saveSettings, TOGGLE_AGENT, OpenClaw polling |
| **Storage** | `background/storage.js` | ✓ token:, work:loads, settings:user, settings:openclaw, settings:lastSearch, saved:bookmarks, history:calls, clearActive, pruneHistory |
| **Harvester DAT** | `harvesters/harvester-dat.js` | ✓ Перехват Bearer токена (fetch + XHR), перехват ответа поиска (DAT_SEARCH_RESPONSE) |
| **Harvester Truckstop** | `harvesters/harvester-truckstop.js` | ✓ Перехват токена на truckstop.com |
| **Adapter DAT** | `background/adapters/dat-adapter.js` | ✓ GraphQL поиск, нормализация, rate limit, normalizeDatResults для перехвата |
| **Adapter Truckstop** | `background/adapters/truckstop-adapter.js` | ✓ REST API, нормализация |
| **Adapter TruckerPath** | `background/adapters/truckerpath-adapter.js` | ◐ Заглушка (return []) |
| **Retell** | `background/retell.js` | ✓ initiateCall, generateEmail (нет телефона → mailto) |
| **UI** | `ui/sidepanel.html`, `ui/sidepanel.js`, `ui/components/styles.css` | ✓ SidePanel: поиск, таблица грузов, панель деталей, закладки, история, настройки, агент OpenClaw, статус-бар, тема |

### По пунктам ТЗ (раздел 13)

| ТЗ v0.1 | Статус |
|---------|--------|
| Харвестер токенов (DAT) | ✓ |
| Харвестер токенов (Truckstop) | ✓ |
| Адаптер DAT (GraphQL) | ✓ |
| Адаптер Truckstop (REST) | ✓ |
| Поиск грузов (UI + Core) | ✓ + перехват ответа со страницы DAT (те же результаты что на сайте) |
| Storage (токены, work:, settings:) | ✓ + lastSearch |
| Очистка при смене направления (clearActive) | ✓ |
| Закладки (saved) | ✓ |
| Интеграция Retell (звонки) | ✓ |
| История звонков | ✓ |
| OpenClaw (polling GET /task, POST /results) | ✓ Реализовано в v0.1 (в ТЗ помечено v0.2) |
| Автооткрытие Side Panel при открытии one.dat.com / truckstop | ✓ |
| Открытие панели по клику на иконку расширения | ✓ (openPanelOnActionClick) |

### Дополнительно реализовано

- Перехват ответа поиска со страницы DAT → те же грузы в AIDA без повторного запроса к API.
- Сохранение последнего поиска (lastSearch) для автозапуска при открытии борда.
- Статусы карточки: active, saved, calling, called_pending, emailed, replied, booked, no_response; pruneHistory по расписанию (alarms).

---

## Нужно доработать / проверить

| Задача | Приоритет | Заметки |
|--------|-----------|---------|
| Запросы адаптеров «через вкладку» | Средний | По ТЗ запросы должны идти через контекст вкладки борда (Origin, Referer). Сейчас DAT/Truckstop вызываются из background; при блокировках — перенести в content script или offscreen. |
| TruckerPath: харвестер + адаптер | Низкий | Сейчас только заглушка адаптера, харвестера нет. |
| SMS через Retell | v0.2 | В ТЗ — v0.2. |
| Webhook Retell по завершении звонка | Средний | Обновление статуса called_pending → replied и т.д. по событию call_ended (если нужна автоматическая смена статуса). |
| Авторизация/настройки бордов (settings:boards[]) | Низкий | В Storage описан settings:boards[] — при необходимости добавить включение/выключение бордов. |

---

## Не входит в v0.1 (по ТЗ)

- SMS и Email через Retell (кроме генерации mailto) — v0.2.
- Автопоиск без участия диспетчера — v0.2 (частично есть через OpenClaw).
- Мобильное приложение — на будущее.
- Харвестеры 3–5 бордов — «по готовности» (сейчас DAT + Truckstop, TruckerPath — заглушка).

---

## Git

В проекте можно инициализировать репозиторий и закоммитить текущее состояние:

```bash
cd /Users/MyFolders/aida
git init
git add .
git commit -m "AIDA v0.1: Core, Storage, Harvesters DAT/Truckstop, Adapters DAT/Truckstop, Retell, UI, OpenClaw, TZ and status doc"
```

Файл `.gitignore` создан в корне проекта.
