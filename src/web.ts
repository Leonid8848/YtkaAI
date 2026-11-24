// Free web access: DuckDuckGo HTML search (keyless) + Jina Reader (keyless).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function unwrapDdgHref(href: string): string {
  const m = /uddg=([^&]+)/.exec(href);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* fallthrough */
    }
  }
  return href.startsWith('//') ? `https:${href}` : href;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function exaSearch(query: string, key: string | undefined, numResults = 8): Promise<SearchResult[] | string> {
  if (!key) return 'search error: EXA_API_KEY не задан';
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      numResults: Math.min(numResults, 10),
      type: 'lite',
      contents: { text: { maxCharacters: 300 } },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    return `search error: Exa ${res.status}${body.slice(0, 150) ? ' — ' + body.slice(0, 150) : ''}`;
  }
  const j: any = await res.json();
  const results: SearchResult[] = (j.results ?? []).map((r: any) => ({
    title: String(r.title ?? ''),
    url: String(r.url ?? ''),
    snippet: String(r.text ?? '').replace(/\s+/g, ' ').trim(),
  }));
  if (!results.length) return 'search: Exa ничего не нашла';
  return results;
}

export async function ddgSearch(query: string, limit = 8): Promise<SearchResult[] | string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=ru-ru`;
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' } });
  if (!res.ok) return `search error: DDG ${res.status}`;
  const html = await res.text();
  if (html.includes('anomaly') || html.includes('challenge')) return 'search error: DDG капча (слишком часто)';

  const results: SearchResult[] = [];
  const anchors = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snipList: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippets.exec(html)) !== null) snipList.push(stripTags(sm[1]));
  let am: RegExpExecArray | null;
  while ((am = anchors.exec(html)) !== null) {
    const r = unwrapDdgHref(am[1]);
    if (!/^https?:\/\//.test(r)) continue;
    results.push({ title: stripTags(am[2]), url: r, snippet: snipList[results.length] ?? '' });
    if (results.length >= limit) break;
  }

  // Fallback: lite endpoint (other markup)
  if (!results.length) {
    const res2 = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, { headers: { 'user-agent': UA, accept: 'text/html' } });
    if (res2.ok) {
      const lite = await res2.text();
      const liteLinks = /<a[^>]+rel="nofollow"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      let lm: RegExpExecArray | null;
      while ((lm = liteLinks.exec(lite)) !== null) {
        const r = unwrapDdgHref(lm[1]);
        if (!/^https?:\/\//.test(r)) continue;
        results.push({ title: stripTags(lm[2]), url: r, snippet: '' });
        if (results.length >= limit) break;
      }
    }
  }

  if (!results.length) return 'search: ничего не найдено (или разметка DDG изменилась)';
  return results;
}

export async function jinaRead(url: string, maxChars = 6000): Promise<string> {
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { 'user-agent': UA, accept: 'text/plain' },
  });
  if (res.ok) {
    const text = await res.text();
    if (text.trim()) return text.slice(0, maxChars);
  }
  // Jina rate-limited/failed — читаем напрямую и чистим HTML
  return await readDirect(url, maxChars, res.status);
}

async function readDirect(url: string, maxChars: number, jinaStatus: number): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.8', 'accept-language': 'ru,en' },
      redirect: 'follow',
    });
  } catch {
    return `read error: страница недоступна (jina ${jinaStatus})`;
  }
  if (!res.ok) return `read error: ${res.status} (jina ${jinaStatus})`;
  let html = await res.text();
  html = html
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  const text = decodeEntities(html).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  if (!text) return 'read: пустая страница';
  return `(${res.url}\n— прочитано напрямую)\n\n${text.slice(0, maxChars)}`;
}
