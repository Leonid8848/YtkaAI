import type { Env } from './env';

const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';

interface Tokens {
  access: string;
  refresh: string;
  accountId: string;
  exp: number;
}

export class AuthStore {
  private ctx: DurableObjectState;
  private env: Env;
  private refreshing: Promise<Tokens> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(): Promise<Response> {
    const tokens = await this.load();
    if (tokens.exp - 120 > Date.now() / 1000) {
      return Response.json({ access: tokens.access });
    }
    try {
      const next = await this.refresh(tokens);
      return Response.json({ access: next.access });
    } catch (error) {
      console.error('token refresh failed', String(error));
      return new Response('refresh failed', { status: 502 });
    }
  }

  private async load(): Promise<Tokens> {
    const stored = await this.ctx.storage.get<Tokens>('siwc_v1');
    if (stored) return stored;
    const seed: Tokens = {
      access: this.env.SIWC_ACCESS_TOKEN,
      refresh: this.env.SIWC_REFRESH_TOKEN,
      accountId: '',
      exp: jwtExp(this.env.SIWC_ACCESS_TOKEN),
    };
    if (!seed.access || !seed.refresh) throw new Error('SIWC tokens are not configured');
    await this.ctx.storage.put('siwc_v1', seed);
    return seed;
  }

  private async refresh(tokens: Tokens): Promise<Tokens> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh(tokens).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(tokens: Tokens): Promise<Tokens> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh,
        client_id: this.env.SIWC_CLIENT_ID,
      }),
    });
    if (!res.ok) throw new Error(`refresh ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    const next: Tokens = {
      access: body.access_token,
      refresh: body.refresh_token ?? tokens.refresh,
      accountId: '',
      exp: jwtExp(body.access_token) || Date.now() / 1000 + (body.expires_in ?? 1800),
    };
    await this.ctx.storage.put('siwc_v1', next);
    return next;
  }
}

function jwtPayload(token: string): Record<string, any> {
  const part = token.split('.')[1];
  if (!part) return {};
  const padded = part.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function jwtExp(token: string): number {
  try {
    return Number(jwtPayload(token).exp ?? 0);
  } catch {
    return 0;
  }
}
