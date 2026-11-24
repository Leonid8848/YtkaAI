# YtkaAI

Telegram-бот с AI-ответами и нативным стримингом на Cloudflare Workers.

## Как это работает

- Webhook принимает апдейты Telegram и передаёт их в Durable Object (один на чат).
- DO стримит ответ модели через `sendMessageDraft` раз в секунду с `can_stop: true`.
- Кнопка остановки присылает апдейт `stopped_message_generation` — DO прерывает генерацию и сохраняет уже полученный текст.
- Модель вызывается через публичный `https://api.openai.com/v1/responses` с OAuth-токеном Sign in with ChatGPT (расход идёт из лимита подписки ChatGPT, не из API-баланса).

## Структура

- `src/index.ts` — webhook, `/setup` (регистрация вебхука), `/selftest`.
- `src/chat-session.ts` — Durable Object чата: стриминг, стоп, дедуп апдейтов.
- `src/llm.ts` — стрим Responses API.
- `src/auth-store.ts` — Durable Object с access/refresh токенами и авто-refresh (refresh-токен ротируется, доступ по ключу `siwc_v1`).
- `scripts/siwc-login.mjs` — вход через Sign in with ChatGPT: открывает браузер, слушает `127.0.0.1:1455/auth/callback`, сохраняет токены в `.siwc/credentials.json` (локально, не в git).
- `scripts/push-siwc-auth.mjs` — переносит токены из `.siwc/credentials.json` в секреты воркера.

## Первый деплой

```bash
npm install
npx wrangler login
npx wrangler secret put TELEGRAM_BOT_TOKEN
node scripts/siwc-login.mjs   # вход в ChatGPT в браузере
node scripts/push-siwc-auth.mjs
npm run deploy
node scripts/push-codex-auth.mjs не нужен — только push-siwc-auth
```

Затем зарегистрировать вебхук: открыть `https://<worker>.workers.dev/setup?key=<TELEGRAM_WEBHOOK_SECRET>`.

Модель задаётся в `wrangler.jsonc` (`LLM_MODEL`), клиент SIWC — `SIWC_CLIENT_ID`. Модели аккаунта: `GET /v1/models` с access-токеном.

## Нюансы

- Токены хранятся локально в `.siwc/` и в секретах воркера; refresh только из воркера (ротация refresh-токена — один писатель).
- Лимиты подписки: при 429 `subscription_sharing_usage_limit_exceeded` — лимит исчерпан.
- Работает только в приватных чатах; черновик — до 4096 символов; апдейты стрима раз в 1 с.
