import { ChatSessionV5, AuthStore } from './auth-exports';
import type { Env, TelegramUpdate } from './env';
import { api } from './telegram';
import { streamWithTools } from './llm';

export { ChatSessionV5, AuthStore };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/setup' && request.method === 'GET') {
      if (url.searchParams.get('key') !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const webhookUrl = `${url.origin}/telegram/webhook`;
      const me = await api(env, 'getMe', {});
      const webhook = await api(env, 'setWebhook', {
        url: webhookUrl,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ['message', 'stopped_message_generation', 'callback_query'],
      });
      const commands = await api(env, 'setMyCommands', {
        commands: [
          { command: 'model', description: 'Выбрать модель (список / переключение / reset)' },
          { command: 'effort', description: 'Эффорт рассуждений: low…ultra' },
        ],
      });
      return Response.json({ webhookUrl, me, webhook, commands });
    }

    if (url.pathname === '/selftest' && request.method === 'GET') {
      if (url.searchParams.get('key') !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      try {
        const sample = await (async () => {
          let out = '';
          for await (const delta of streamWithTools(env, 'Отвечай кратко.', [{ role: 'user', content: 'Ответь одним словом: работает?' }], null, new AbortController().signal)) {
            out += delta;
            if (out.length > 80) break;
          }
          return out;
        })();
        return Response.json({ sample });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }

    if (url.pathname.startsWith('/debug/')) {
      if (url.searchParams.get('key') !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const allowed = env.ALLOWED_USER_IDS.split(',').map((id) => id.trim()).filter(Boolean);
      if (!allowed.length) return new Response('no allowed user', { status: 400 });
      const stub = env.CHAT_SESSION.get(env.CHAT_SESSION.idFromName(allowed[0]));
      return stub.fetch(`https://chat${url.pathname}${url.search}`);
    }

    if (request.method !== 'POST' || url.pathname !== '/telegram/webhook') {
      return new Response('ok');
    }

    if (
      env.TELEGRAM_WEBHOOK_SECRET &&
      request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET
    ) {
      return new Response('forbidden', { status: 403 });
    }

    const update = (await request.json()) as TelegramUpdate;
    const chatId = update.message?.chat.id ?? update.stopped_message_generation?.chat.id;
    if (!chatId) return new Response('ok');

    const stub = env.CHAT_SESSION.get(env.CHAT_SESSION.idFromName(String(chatId)));
    const isStop = Boolean(update.stopped_message_generation);
    const body = isStop
      ? JSON.stringify({ draftId: update.stopped_message_generation!.draft_id })
      : JSON.stringify(update);

    try {
      await stub.fetch(`https://chat${isStop ? '/stop' : '/update'}`, { method: 'POST', body });
    } catch (error) {
      console.error('durable object failed', String(error));
    }

    return new Response('ok');
  },

  // hourly safety sweep: deliver overdue reminders if an alarm chain broke
  async scheduled(_controller: unknown, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<void> {
    const run = async (): Promise<void> => {
      const allowed = env.ALLOWED_USER_IDS.split(',').map((id) => id.trim()).filter(Boolean);
      for (const id of allowed) {
        const stub = env.CHAT_SESSION.get(env.CHAT_SESSION.idFromName(id));
        try {
          await stub.fetch('https://chat/sweep', { method: 'POST' });
        } catch (error) {
          console.error('sweep failed', id, String(error));
        }
      }
    };
    ctx.waitUntil(run());
  },
} satisfies ExportedHandler<Env>;
