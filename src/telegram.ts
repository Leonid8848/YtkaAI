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

export type InlineKeyboard = { text: string; callback_data: string }[][];

export async function sendWithKeyboard(
  env: Env,
  chatId: number,
  text: string,
  keyboard: InlineKeyboard,
): Promise<boolean> {
  const res = await api<{ ok?: boolean }>(env, 'sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: keyboard },
  });
  return !!res;
}

export async function editWithKeyboard(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
  keyboard: InlineKeyboard,
): Promise<boolean> {
  const res = await api(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: { inline_keyboard: keyboard },
  });
  return !!res;
}

export async function answerCallback(env: Env, callbackId: string, text?: string): Promise<void> {
  await api(env, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    ...(text ? { text, show_alert: false } : {}),
  });
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
