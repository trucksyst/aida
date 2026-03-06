# PLAN: Следующие задачи

> Дата: 2026-03-06
> Версия: 0.1.81

---

## 1. ✅ Удалить auth-manager.js — ВЫПОЛНЕНО (v0.1.81)

---

## 2. TruckerPath — автологин (popup + harvester)

Сейчас TP работает только если пользователь открывает fleet.truckerpath.com и делает поиск вручную.
Нужно: кнопка TP → popup логин → harvester ловит шаблон → TP автономно ищет.

### Исследование (первый шаг):

1. Открыть fleet.truckerpath.com, залогиниться, сделать поиск
2. Изучить HAR: какие endpoints, какая авторизация (cookies? JWT? API key?)
3. Проверить: можно ли искать грузы напрямую через API (как DAT/TS)?
4. Если да → auth-модуль + built-in search (полная автономия)
5. Если нет → popup → дождаться harvester → popup закрывается → данные в AIDA

### Что уже есть:

- `harvester-truckerpath.js` — работает, ловит поисковые ответы
- `truckerpath-adapter.js` — нормализует грузы в единый формат

---

## 3. AI-анализ грузов (Gemini через chrome.identity)

### Идея

Встроить AI-скоринг прямо в расширение — без внешних сервисов, без API ключей.
Юзер авторизован в Chrome → `chrome.identity.getAuthToken()` → OAuth token → Gemini API.

### Архитектура

```
Search → loads[] → background.js
                    ├→ pushToUI (мгновенно, как сейчас)
                    └→ ai-analyzer.js (фон, 1-2 сек)
                        → chrome.identity.getAuthToken({ scopes: ['generative-language'] })
                        → fetch(Gemini API, { Authorization: Bearer token })
                        → получить scores/рекомендации
                        → обновить loads[].aiScore
                        → pushToUI (обновлённые карточки с badges)
```

### Данные для анализа

Отправляем в Gemini:
```json
{
  "loads": [ { "origin", "dest", "rate", "miles", "rpm", "broker_rating", "deadhead", "weight" } ],
  "preferences": { "min_rpm", "max_deadhead", "avoid_states", "preferred_equipment" }
}
```

Gemini возвращает:
```json
[
  { "id": "dat_123", "score": 92, "reason": "Отличный RPM $3.47, deadhead 45mi, брокер A" },
  { "id": "ts_456", "score": 45, "reason": "Ставка ниже рынка, posted 8 часов назад" }
]
```

### Реализация

1. **manifest.json**: добавить `"identity"` permission, OAuth2 client_id
2. **Создать OAuth2 Client ID** в Google Cloud Console (API: Generative Language)
3. **background/ai-analyzer.js** (~100 строк):
   - `analyzeLoads(loads, preferences)` → fetch к Gemini
   - Результат — массив `{ id, score, reason }`
4. **background.js**: после searchLoads → вызвать analyzer fire-and-forget
5. **UI**: показать `aiScore` как badge на карточке (🟢 90+ / 🟡 60-89 / 🔴 <60)

### Преимущества

- Без API ключей — через Google Account юзера
- Free tier Gemini: 60 запросов/мин (достаточно)
- Юзер кликает "Allow" один раз при первом использовании
- Анализ не блокирует UI — loads показываются сразу, scores подгружаются

---

## Приоритеты

1. ✅ Удалить auth-manager.js — ВЫПОЛНЕНО
2. 🔍 TruckerPath автологин
3. 🧠 AI-анализ грузов (Gemini + chrome.identity)
