# PLAN: AIDA v0.2 — AI Автопилот уже не актуальный не читаем

> Дата: 2026-03-06
> Основа: Chrome Extension (расширение = платформа)

---

## Общая идея

AIDA из инструмента для ручного поиска → в автономного AI-диспетчера.
Диспетчер задаёт критерии → AIDA сама ищет, анализирует, звонит, пишет, отчитывается.

### Принятые решения (обновление)

- AI реализуется как отдельный **блок** внутри расширения (включаемый/выключаемый), а не как обязательный слой для всех сценариев.
- При первом открытии чата запускается onboarding/регистрация AI-чата. До завершения onboarding — только базовый режим.
- Источник грузов для AI: внутренний поток AIDA (`Adapters → Core → Storage`), без отдельного внешнего API для самих грузов.
- Внешний API используется только для AI-аналитики (Gemini).
- Для AI используется только `OAuth` (через `chrome.identity`), без `API key`.
- Для диспетчера вход в AI-чат — только через Google OAuth popup (one-click), без логина/пароля.
- Технические поля (`OAuth Client ID`, `Project ID`) не показываются диспетчеру в чате; это преднастройка администратора.
- Telegram подключается напрямую из расширения (Service Worker, `fetch`), без отдельного backend.
- При недоступности AI или Telegram система продолжает работать в штатном режиме поиска/работы с грузами.

### Реально выполнено по подключению AI

- Добавлен AI модуль в `background/ai/` и вынесен AI OAuth в `auth/auth-ai.js`.
- Добавлены маршруты `GET_AI_STATUS`, `AI_AUTH_CONNECT`, `AI_AUTH_DISCONNECT`, `AI_CHAT`, `AI_ANALYZE_LOADS` в `background/background.js`.
- В `manifest.json` подключены `identity`, `oauth2.client_id`, scope `cloud-platform` и Vertex host permissions.
- В `Storage` добавлен блок `settings:ai` с миграцией настроек.
- В UI добавлен chat widget с auto-onboarding.
- Подключение подтверждено в рабочем логе: токен получается, статус `online`, чат отвечает через Vertex.

### Архитектурное правило AI (зафиксировано)

- AI OAuth живёт в `auth/`, а не внутри AI use-cases.
- В `background/background.js` остаётся только тонкая маршрутизация AI message types.
- AI не вызывает адаптеры напрямую.
- Любой AI `search` исполняется только через основной Core pipeline.
- AI читает нормализованный контекст AIDA через Storage/Core.
- UI-логика AI выносится из общего `ui/app.js` в отдельные модули `ui/ai/`.

### Текущий план упорядочивания

1. Вынести AI OAuth из старого `ai-block` в `auth/auth-ai.js`.
2. Разбить background AI на `provider`, `chat`, `analyze`, `index`.
3. Перенести UI AI-чат и рендер карточек в `ui/ai/`.
4. Удалить мёртвый и дублирующий AI-код из `ui/app.js` и старый `background/ai-block.js`.
5. После стабилизации добавить AI rules/profile storage и UI управления правилами.

### Как именно подключался AI

1. В расширение добавлен `chrome.identity` для Google OAuth.
2. В `manifest.json` прописан Chrome Extension OAuth client.
3. В `auth/auth-ai.js` реализован вызов `chrome.identity.getAuthToken()`.
4. Полученный access token сохраняется в `settings:ai`.
5. UI чат вызывает background messages, а не ходит в Google API напрямую.
6. AI provider отправляет запрос в Vertex AI через `fetch()` и `Bearer` token.
7. Для Vertex зафиксированы `projectId=logload`, `location=global`, `model=gemini-2.5-flash`.

### Нюансы подключения

- Схема с `API key` полностью отменена.
- Схема с ручным `launchWebAuthFlow` была менее надёжной и заменена на нативный `chrome.identity.getAuthToken()`.
- Старый `location=us-central1` ломал вызов publisher model, поэтому сделана миграция на `global`.
- Старый дефолт `gemini-2.0-flash` заменён на `gemini-2.5-flash`, потому что для новых проектов Google рекомендует 2.5.
- После изменения OAuth scope токен нужно чистить из кэша, иначе остаётся ложное состояние `connected`.
- В UX сохранён принцип "диспетчер, не программист": никаких технических полей в чате.
- При отказе пользователя от входа цикл автологина остановлен, чтобы не раздражать пользователя popup-ами.

---

## Архитектура

```
┌─────────────────────────────────────────────────────────┐
│                    AIDA Extension                        │
│                                                         │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────┐  │
│  │ Adapters │───→│ AI Block     │───→│   Actions     │  │
│  │ DAT/TS/TP│    │ (Gemini API) │    │               │  │
│  └──────────┘    └──────────────┘    │ ☎ Retell Call │  │
│       │               │              │ ✉ Email       │  │
│       │               │              │ 💬 Telegram   │  │
│       ↓               ↓              └───────────────┘  │
│   ┌──────────┐   ┌──────────────┐             │         │
│   │ Storage  │   │ Chat Widget  │             ↓         │
│   │ work:loads│  │ (дроид, UI)  │       ┌────────────┐  │
│   └──────────┘   └──────────────┘       │ Reports    │  │
│                                          │ & History  │  │
│   Fallback: если AI OFF/ERROR → базовый поиск + UI     │
│            если Telegram OFF/ERROR → лог + ретрай       │
└─────────────────────────────────────────────────────────┘
```

---

## Фазы

### Фаза 1: AI Block — мозг (Gemini)

**Что:** AI анализирует грузы и принимает решения.

**Как:**
- `chrome.identity.getAuthToken()` → OAuth
- Gemini вызывается с `Bearer` токеном (OAuth access token)
- Если AI отключён/недоступен — Core работает без AI-решений

**Файлы:** `auth/auth-ai.js`, `background/ai/provider.js`, `background/ai/chat.js`, `background/ai/analyze.js`

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

### Фаза 2: Chat UI Widget — диалог с AI

**Что:** Чат-помощник внутри AIDA — как обычный assistant chat, подключённый к данным.

**Где:** Плавающий виджет в правом нижнем углу (иконка дроида).

**Поведение:**
- По умолчанию свернут.
- По клику раскрывается.
- При первом раскрытии автоматически запускает Google OAuth popup.
- Если авторизация отменена/ошибка — чат показывает понятный текст и кнопку повторного входа через Google.
- После успешного onboarding работает в обычном режиме диалога.

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

**Fallback сценарий:**
- AI недоступен: автопилот пропускает AI-решения и отправляет в UI статус "AI offline".
- Telegram недоступен: автопилот выполняет действия, уведомления ставит в ретрай-очередь.

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
| 1 | AI Block (Gemini, ON/OFF, fallback) | Средняя | OAuth Client ID + Google Cloud project |
| 2 | Chat Widget + onboarding первого входа | Средняя | AI Block |
| 3 | Score badges на карточках | Лёгкая | AI Block |
| 4 | Telegram уведомления (внутри extension) | Лёгкая | Bot token + chat_id |
| 5 | Email (Gmail API / mailto fallback) | Средняя | OAuth scope |
| 6 | Retell интеграция (улучшить) | Средняя | Retell аккаунт |
| 7 | Автопилот (цикл + ретраи) | Средняя | Всё выше |

---

## Технические заметки

- **Всё — fetch() вызовы.** Gemini, Retell, Telegram, Gmail — просто HTTP. 
  Браузер легко тянет.
- **Источник данных для AI:** внутренние `work:loads` из Storage (после нормализации адаптерами).
- **AI Block** работает как переключаемый модуль: `enabled=true/false`.
- **Авторизация AI:** только OAuth через `chrome.identity` (без хранения API ключей).
- **OAuth требования:** `OAuth Client ID` задаётся в `manifest.json`, runtime-параметры AI хранятся в `settings:ai`.
- **UX диспетчера:** в чате не используется ввод логина/пароля и не показываются технические OAuth-параметры.
- **Telegram Bot** — отдельный от Google, нужен только token.
- **Retell** — отдельный аккаунт, API key в настройках (уже есть).
- **Keep-alive** — alarms каждые 25 сек (уже реализовано).
- **Ограничение** — комп должен быть включён. Для 24/7: VPS + Chrome headless.
