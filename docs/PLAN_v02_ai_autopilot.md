# PLAN: AIDA v0.2 — AI Автопилот

> Дата: 2026-03-06
> Основа: Chrome Extension (расширение = платформа)

---

## Общая идея

AIDA из инструмента для ручного поиска → в автономного AI-диспетчера.
Диспетчер задаёт критерии → AIDA сама ищет, анализирует, звонит, пишет, отчитывается.

---

## Архитектура

```
┌─────────────────────────────────────────────────────────┐
│                    AIDA Extension                        │
│                                                         │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────┐  │
│  │ Adapters │───→│  AI Engine   │───→│   Actions     │  │
│  │ DAT/TS/TP│    │ (Gemini API) │    │               │  │
│  └──────────┘    └──────────────┘    │ ☎ Retell Call │  │
│       ↑               │              │ ✉ Email       │  │
│   alarm 30s           │              │ 💬 Telegram   │  │
│   (автопоиск)         ↓              └───────────────┘  │
│              ┌──────────────┐                │          │
│              │  Decisions   │                ↓          │
│              │ score > 85?  │         ┌────────────┐    │
│              │ → звонить    │         │ Chat UI    │    │
│              │ score > 70?  │         │ (диалог)   │    │
│              │ → email      │         └────────────┘    │
│              │ любой?       │                           │
│              │ → telegram   │                           │
│              └──────────────┘                           │
└─────────────────────────────────────────────────────────┘
```

---

## Фазы

### Фаза 1: AI Engine — мозг (Gemini через chrome.identity)

**Что:** AI анализирует грузы и принимает решения.

**Как:**
- `chrome.identity.getAuthToken()` → OAuth → Gemini API
- Юзер кликает "Allow" один раз — без API ключей

**Файл:** `background/ai-engine.js` (~150 строк)

**Функции:**
```js
// Анализ грузов — скоринг
analyzeLoads(loads[], preferences) → [{ id, score, reason, action }]

// Чат — диалог с диспетчером
chat(message, context) → { reply, actions[] }
// "найди reefer из Чикаго на юг" → { reply: "Нашёл 12 грузов...", actions: [{ type: 'search', params }] }

// Анализ брокера
analyzeBroker(mc, dot, rating, daysToPay) → { risk, summary }
```

**action types:** `search`, `call`, `email`, `bookmark`, `skip`

**UI:** Score badge на карточке (🟢🟡🔴) + Chat панель

---

### Фаза 2: Chat UI — диалог с AI

**Что:** Окно чата внутри AIDA — как ChatGPT, но подключённый к данным.

**Где:** Новая панель в UI (slide-out или tab)

**Примеры:**
```
Юзер: "Найди Van из Далласа, минимум 2.50 за милю"
AI:   "Нашёл 8 грузов. Лучший: Dallas→Atlanta, $3.12/mi, 780 миль, брокер A+."
      [Показать] [Позвонить] [Сохранить]

Юзер: "Что по брокеру MC# 456789?"
AI:   "Days to pay: 32, Rating: B, Bond: $75k. Средний риск. 
       Последние отзывы: 2 жалобы на задержку оплаты."

Юзер: "Позвони по первым трём грузам"
AI:   "Звоню... Груз 1: брокер ответил, rate confirmed. 
       Груз 2: не берёт трубку, отправил email.
       Груз 3: перезвонят через 30 мин."
```

**Как чат управляет расширением:**
```
chat("найди reefer из Чикаго") 
  → Gemini парсит интент → { action: 'search', params: { origin: 'Chicago', equipment: 'REEFER' } }
  → background.js вызывает searchLoads(params)
  → результаты возвращаются в чат
```

---

### Фаза 3: Действия — звонки, email, Telegram

#### ☎ Retell Call (уже есть base)
- `background/retell.js` — уже существует
- AI решает: score > 85 → позвонить
- Retell делает звонок → результат в историю
- Если не ответил → fallback к email

#### ✉ Email
- **Вариант A:** Gmail API через `chrome.identity` (тот же Google аккаунт)
  - `scope: 'https://www.googleapis.com/auth/gmail.send'`
  - Отправить шаблонное письмо брокеру
- **Вариант B:** Просто `mailto:` ссылка → откроет почтовый клиент

**Шаблон:**
```
Subject: Available for load #{loadId} ({origin} → {dest})
Body: Hi, our carrier MC# {mc} is available for your load...
```

#### 💬 Telegram Bot
- Создать бота через @BotFather → получить token
- `fetch('https://api.telegram.org/bot{token}/sendMessage', { chat_id, text })`
- Один fetch — без SDK, без зависимостей

**Уведомления:**
```
🟢 Новый груз: Dallas → Atlanta, $2,450, Van, 3.15/mi [Score: 94]
☎ Звонок: MC#456789 — ответил, rate confirmed
✉ Email отправлен: MC#789012 — не ответил на звонок
⚠ Внимание: 3 груза score>90 ждут решения
```

**Настройки в UI:**
- Telegram Bot Token + Chat ID (ввод один раз)
- Какие уведомления слать (новые грузы / звонки / все)

---

### Фаза 4: Автопилот — всё вместе

**Режим:** Переключатель в UI — "Автопилот ВКЛ/ВЫКЛ"

**Цикл (alarm каждые 30-60 сек):**
```
1. Поиск грузов (по сохранённым критериям)
2. AI анализ → скоринг
3. Новые грузы score > порог?
   ├── > 85: Retell звонок брокеру
   ├── > 70: Email брокеру
   └── любой: Telegram уведомление диспетчеру
4. Результаты → история + Telegram отчёт
5. Ждать 30 сек → повторить
```

**Диспетчер в Telegram видит:**
```
📊 AIDA Автопилот — отчёт за час:
• Проанализировано: 340 грузов
• Score > 85: 12 грузов
• Позвонено: 8 брокерам
• Ответили: 5
• Rate confirmed: 3
• Email отправлено: 4
• Ожидают решения: 2 [открыть AIDA]
```

---

## Приоритеты реализации

| # | Что | Сложность | Зависимости |
|---|-----|-----------|-------------|
| 1 | AI Engine (Gemini + chrome.identity) | Средняя | OAuth2 Client ID |
| 2 | Score badges на карточках | Лёгкая | AI Engine |
| 3 | Chat UI (панель диалога) | Средняя | AI Engine |
| 4 | Telegram уведомления | Лёгкая | Bot token |
| 5 | Email (Gmail API) | Средняя | OAuth scope |
| 6 | Retell интеграция (улучшить) | Средняя | Retell аккаунт |
| 7 | Автопилот (цикл) | Лёгкая | Всё выше |

---

## Технические заметки

- **Всё — fetch() вызовы.** Gemini, Retell, Telegram, Gmail — просто HTTP. 
  Браузер легко тянет.
- **chrome.identity** покрывает: Gemini API + Gmail API — один Google аккаунт, без ключей.
- **Telegram Bot** — отдельный от Google, нужен только token.
- **Retell** — отдельный аккаунт, API key в настройках (уже есть).
- **Keep-alive** — alarms каждые 25 сек (уже реализовано).
- **Ограничение** — комп должен быть включён. Для 24/7: VPS + Chrome headless.
