import type { CodexAuth, Env } from './env';
import { TOOLS } from './tools';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

async function getAuth(env: Env): Promise<CodexAuth> {
  const stub = env.AUTH.get(env.AUTH.idFromName('global'));
  const res = await stub.fetch('https://auth/token');
  if (!res.ok) throw new Error(`auth ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as CodexAuth;
}

function safeJson(args: unknown): any {
  try {
    return typeof args === 'string' ? JSON.parse(args) : (args ?? {});
  } catch {
    return {};
  }
}

/**
 * Streams model output; transparently executes function calls and continues the
 * loop until the model produces a response without tool calls (max 5 rounds).
 * Yields output text deltas. execTool === null => no tools, single round.
 */
export async function* streamWithTools(
  env: Env,
  instructions: string,
  input: any[],
  execTool: ((name: string, args: any) => Promise<string>) | null,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const auth = await getAuth(env);
  let cur = input;

  for (let round = 0; round < (execTool ? 5 : 1); round++) {
    const res = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth.access}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        instructions,
        input: cur,
        ...(execTool ? { tools: TOOLS } : {}),
        stream: true,
        store: false,
      }),
      signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`Responses ${res.status}: ${(await res.text()).slice(0, 1200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const state: { output: any[] | null } = { output: null };

    const handleLine = (line: string): string | null => {
      if (!line.startsWith('data:')) return null;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return null;
      let event: any;
      try {
        event = JSON.parse(data);
      } catch {
        return null;
      }
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta) {
        return event.delta;
      }
      if (event.type === 'response.completed') {
        state.output = event.response?.output ?? [];
      } else if (event.type === 'response.failed' || event.type === 'response.error' || event.type === 'error') {
        const code = event.response?.error?.code ?? event.code;
        const message = event.response?.error?.message ?? event.message ?? 'model error';
        throw new Error(`model ${code ?? ''}: ${message}`.trim());
      }
      return null;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const delta = handleLine(line);
        if (delta) yield delta;
      }
    }
    // flush tail line
    const tailDelta = handleLine(buffer.trim());
    if (tailDelta) yield tailDelta;

    if (!state.output) return;
    const calls = state.output.filter((i: any) => i?.type === 'function_call');
    if (!calls.length || !execTool) return;

    cur = [
      ...cur,
      ...state.output,
      ...calls.map((c: any) => ({
        type: 'function_call_output',
        call_id: c.call_id,
        output: '',
      })),
    ];
    for (let i = 0; i < calls.length; i++) {
      cur[cur.length - calls.length + i].output = await execTool(calls[i].name, safeJson(calls[i].arguments));
    }
  }
}

/** One-shot completion used for summaries and task reminders. The ChatGPT-plan
 * route mandates stream:true on every request, so we stream and just accumulate. */
export async function completeOnce(env: Env, instructions: string, prompt: string, signal: AbortSignal): Promise<string | null> {
  const auth = await getAuth(env);
  const res = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${auth.access}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model: env.LLM_MODEL,
      instructions,
      input: [{ role: 'user', content: prompt }],
      stream: true,
      store: false,
    }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Responses ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let out = '';
  let completed = false;
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let event: any;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        out += event.delta;
      } else if (event.type === 'response.completed') {
        completed = true;
      } else if (event.type === 'response.failed' || event.type === 'response.error' || event.type === 'error') {
        throw new Error(`model ${event.response?.error?.code ?? event.code ?? ''}: ${event.response?.error?.message ?? event.message ?? 'error'}`.trim());
      }
    }
    if (completed) break;
  }
  if (!completed && !out) throw new Error('stream ended without response.completed');
  return out.trim() || null;
}
