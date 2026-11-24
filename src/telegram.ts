import type { Env } from './env';

const API = 'https://api.telegram.org';

export async function api<T = unknown>(
  env: Env,
  method: string,
  payload: Record<string, unknown>,
): Promise<T | null> {
  const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Telegram ${method} ${res.status}: ${body.slice(0, 300)}`);
    return null;
  }
  return (await res.json()) as T;
}

export async function sendPlainText(
  env: Env,
  chatId: number,
  threadId: number | undefined,
  text: string,
): Promise<boolean> {
  let ok = true;
  for (const part of splitText(text, 4000)) {
    const res = await api<{ ok?: boolean }>(env, 'sendMessage', {
      chat_id: chatId,
      message_thread_id: threadId,
      text: part,
    });
    if (!res) ok = false;
  }
  return ok;
}

function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}
