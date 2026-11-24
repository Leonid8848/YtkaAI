# YtkaAI

Личный Telegram-ассистент на Cloudflare Workers: стриминг ответов с нативной кнопкой «Стоп», долговременная память, напоминания (разовые, повторяющиеся, задачи), план дня.

Тип модели — расход из лимита подписки ChatGPT Plus через официальный Sign in with ChatGPT: никакого API-ключа и отдельного баланса.

## Возможности

- **Стриминг в Telegram** через `sendMessageDraft` (раз в секунду, `can_stop: true`); пользователь останавливает генерацию — апдейт `stopped_message_generation` прерывает запрос к модели.
- **Модель через подписку ChatGPT** (Plus): официальный вход Sign in with ChatGPT, запросы на публичный `https://api.openai.com/v1/responses` с OAuth-токеном, `store:false, stream:true`. API-ключ и баланс не нужны.
- **Память** (как у Hermes Agent, на DO SQLite):
  - `profile` — факты о пользователе (бюджет 1500 симв.), всегда в промпте;
  - `notes` — рабочие заметки (2200 симв.);
  - `sessions` — диалог делится на сессии паузой >5 ч; при закрытии сессии старое сжимается в сводку;
  - `messages` + FTS5 — полная история, тул `recall` ищет дословные совпадения;
  - хвост текущей сессии — до 75 сообщений, при переполнении уплотняется в сводку.
- **Инструменты модели**: `memory_save`, `reminder_set/update/cancel`, `plan_update`, `recall`. Модель может использовать несколько инструментов за ход (до 5 раундов).
- **Напоминания**:
  - разовые, ежедневные, по дням недели (`days`, 1=Пн..7=Вс);
  - `kind=text` — уйдёт готовый текст; `kind=task` — в момент срабатывания бот выполняет задание моделью и присылает свежий ответ;
  - доставка через Durable Object Alarms (один будильник на чат, переназначение после каждого срабатывания); неудачная отправка — напоминание остаётся активным, ретрай через 30 с;
  - ежечасный крон-свип доставляет пропущенное, если цепочка будильников прервалась.
- Ответ генерируется только в момент обращения — ничего не пре-генерируется.

## Архитектура

- `src/index.ts` — webhook (`/telegram/webhook`), `/setup` (регистрация вебхука), `/selftest`, проксирование `/debug/*` в DO, cron `scheduled` (свип).
- `src/chat-session.ts` — DO чата (класс `ChatSessionV5`): буфер склейки сообщений (3 с), сессии, генерация со стримингом и тулами, алармы, напоминания, уплотнение истории.
- `src/llm.ts` — клиент Responses API: `streamWithTools` (стрим + луп тулов) и `completeOnce` (стрим с накоплением — для сводок и задач).
- `src/db.ts` — схема и все SQL-операции (DO SQLite).
- `src/tools.ts` — схемы тулов и исполнитель.
- `src/auth-store.ts` — DO с SIWC-токенами: авто-refresh (access живёт 1 ч, refresh ротируется).
- `src/time.ts` — Europe/Moscow (UTC+3, без DST): парсинг «YYYY-MM-DD HH:MM», расчёт повторов.
- `scripts/siwc-login.mjs` — OAuth-вход: открывает браузер, слушает `127.0.0.1:1455/auth/callback`, кладёт токены в `.siwc/credentials.json` (в git не попадает).
- `scripts/push-siwc-auth.mjs` — переносит токены из `.siwc/credentials.json` в секреты воркера.

## Первый деплой

```bash
npm install
npx wrangler login
npx wrangler secret put TELEGRAM_BOT_TOKEN      # токен от @BotFather
node scripts/siwc-login.mjs                     # вход в ChatGPT в браузере
node scripts/push-siwc-auth.mjs
npm run deploy                                  # или: npx wrangler deploy
curl "https://<worker>.workers.dev/setup?key=<TELEGRAM_WEBHOOK_SECRET>"
```

Модель — `LLM_MODEL` в `wrangler.jsonc` (список доступных: `GET /v1/models` с access-токеном). Клиент SIWC — `SIWC_CLIENT_ID` (vars). Пользователь, которому отвечает бот — `ALLOWED_USER_IDS`.

## Диагностика (защищены ключом вебхука)

- `GET /selftest?key=...` — проверяет модель.
- `GET /debug/state?key=...` — счётчики БД, активные напоминания, будильник.
- `GET /debug/remind?key=...&text=...&mins=N[&kind=task]` — тест напоминания.
- `GET /debug/say?key=...&text=...` — сообщение, как будто написал пользователь.
- `GET /debug/deactivate?key=...&id=N`, `/debug/sweep` — ручное управление.

## Нюансы

- Напоминания работают только в приватных чатах; черновик — до 4096 символов.
- Лимит подписки: 429 `subscription_sharing_usage_limit_exceeded` — лимит исчерпан, бот молча дождётся (специальные коды обрабатываются как ошибки модели).
- Секреты: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `SIWC_ACCESS_TOKEN`, `SIWC_REFRESH_TOKEN`. Локальные токены — в `.siwc/` (0600, в git не попадают).
- Класс DO исторически зовётся `ChatSessionV5` — следствие миграций Cloudflare Durable Objects (переименование класса требует танца с миграциями; код это не затрагивает).
