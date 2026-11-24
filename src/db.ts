import { fmtMsk, nextRepeat, nowMsk, parseMskDT, todayMsk } from './time';

export type SqlLike = { exec: (query: string, ...params: unknown[]) => Iterable<any> };

export function run(sql: SqlLike, query: string, ...params: unknown[]): any[] {
  return [...sql.exec(query, ...params)];
}

export function rows(sql: SqlLike, query: string, ...params: unknown[]): any[] {
  return run(sql, query, ...params);
}

export function initSchema(sql: SqlLike): void {
  run(sql, `CREATE TABLE IF NOT EXISTS sessions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    closed_at INTEGER,
    summary TEXT
  )`);
  run(sql, `CREATE TABLE IF NOT EXISTS messages(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    responded INTEGER NOT NULL DEFAULT 1,
    in_context INTEGER NOT NULL DEFAULT 1
  )`);
  run(sql, `CREATE TABLE IF NOT EXISTS profile(id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)`);
  run(sql, `CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)`);
  run(sql, `CREATE TABLE IF NOT EXISTS plan_items(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo'
  )`);
  run(sql, `CREATE TABLE IF NOT EXISTS reminders(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    at INTEGER NOT NULL,
    repeat TEXT NOT NULL DEFAULT 'none',
    days TEXT NOT NULL DEFAULT '',
    until INTEGER,
    active INTEGER NOT NULL DEFAULT 1
  )`);
  run(sql, `CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)`);
  try { run(sql, "ALTER TABLE reminders ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'"); } catch {} // миграция старых таблиц
  run(sql, `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='id')`);
  run(sql, `CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text); END`);
  run(sql, `CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text); END`);
  run(sql, `CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text); END`);
}

// ---- sessionization ----

export function currentSessionId(sql: SqlLike): number | null {
  const r = rows(sql, 'SELECT id FROM sessions WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1');
  return r.length ? Number(r[0].id) : null;
}

export function openSession(sql: SqlLike): number {
  run(sql, 'INSERT INTO sessions(started_at) VALUES (?)', Date.now());
  return currentSessionId(sql)!;
}

export function lastMessageAt(sql: SqlLike): number | null {
  const r = rows(sql, 'SELECT created_at FROM messages ORDER BY id DESC LIMIT 1');
  return r.length ? Number(r[0].created_at) : null;
}

export function insertMessage(sql: SqlLike, sessionId: number, role: string, text: string, responded: number): void {
  run(sql, 
    'INSERT INTO messages(session_id, role, text, created_at, responded) VALUES (?,?,?,?,?)',
    sessionId, role, text, Date.now(), responded,
  );
}

/** In-context tail of the current session, oldest first. */
export function tailMessages(sql: SqlLike, sessionId: number, limit: number): { role: string; text: string }[] {
  const r = rows(
    sql,
    'SELECT role, text FROM messages WHERE session_id = ? AND responded = 1 AND in_context = 1 ORDER BY id DESC LIMIT ?',
    sessionId, limit,
  );
  return r.reverse().map((x) => ({ role: String(x.role), text: String(x.text) }));
}

export function sessionMessageCount(sql: SqlLike, sessionId: number): number {
  const r = rows(sql, 'SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND in_context = 1 AND responded = 1', sessionId);
  return Number(r[0]?.n ?? 0);
}

export function oldestInContext(sql: SqlLike, sessionId: number, take: number): { id: number; role: string; text: string }[] {
  return rows(
    sql,
    'SELECT id, role, text FROM messages WHERE session_id = ? AND in_context = 1 AND responded = 1 ORDER BY id ASC LIMIT ?',
    sessionId, take,
  ).map((x) => ({ id: Number(x.id), role: String(x.role), text: String(x.text) }));
}

export function markOutOfContext(sql: SqlLike, ids: number[]): void {
  for (const id of ids) run(sql, 'UPDATE messages SET in_context = 0 WHERE id = ?', id);
}

export function unresponded(sql: SqlLike): { id: number; text: string }[] {
  return rows(sql, 'SELECT id, text FROM messages WHERE responded = 0 ORDER BY id ASC').map((x) => ({ id: Number(x.id), text: String(x.text) }));
}

export function markResponded(sql: SqlLike, ids: number[]): void {
  if (!ids.length) return;
  run(sql, `UPDATE messages SET responded = 1 WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
}

// ---- summary block ----

const SUMMARY_BUDGET = 2400;

export function getSummaryBlock(sql: SqlLike): string {
  const r = rows(sql, "SELECT value FROM meta WHERE key = 'summary_block'");
  return r.length ? String(r[0].value) : '';
}

export function appendSummary(sql: SqlLike, chunk: string): void {
  if (!rows(sql, 'SELECT 1 FROM meta WHERE key = ?', 'summary_block').length) {
    run(sql, 'INSERT INTO meta(key, value) VALUES (?, ?)', 'summary_block', '');
  }
  const old = getSummaryBlock(sql);
  const next = (old ? `${old}\n${chunk}` : chunk).slice(-SUMMARY_BUDGET);
  run(sql, "UPDATE meta SET value = ? WHERE key = 'summary_block'", next);
}

// ---- curated memory ----

export const PROFILE_BUDGET = 1500;
export const NOTES_BUDGET = 2200;

export function storeText(sql: SqlLike, target: 'profile' | 'notes'): string {
  return rows(sql, `SELECT text FROM ${target} ORDER BY id`).map((x) => `• ${x.text}`).join('\n');
}

export function storeSize(sql: SqlLike, target: 'profile' | 'notes'): number {
  return storeText(sql, target).length;
}

export function storeAdd(sql: SqlLike, target: 'profile' | 'notes', text: string): string {
  const size = storeSize(sql, target) + text.length + 2;
  const budget = target === 'profile' ? PROFILE_BUDGET : NOTES_BUDGET;
  if (size > budget) return `error: бюджет ${target} переполнен (${size}/${budget}). Удали или consolidate устаревшие записи (remove) и повтори.`;
  run(sql, `INSERT INTO ${target}(text) VALUES (?)`, text.trim());
  return `ok: добавлено в ${target} (${storeSize(sql, target)}/${budget} симв.)`;
}

export function storeRemove(sql: SqlLike, target: 'profile' | 'notes', idOrText: number | string): string {
  if (typeof idOrText === 'number') {
    run(sql, `DELETE FROM ${target} WHERE id = ?`, idOrText);
    return `ok: удалено (id ${idOrText})`;
  }
  const match = rows(sql, `SELECT id FROM ${target} WHERE text = ?`, idOrText.trim());
  if (!match.length) return `error: запись не найдена. Точный текст: ${storeText(sql, target) || '(пусто)'}`;
  run(sql, `DELETE FROM ${target} WHERE id = ?`, Number(match[0].id));
  return 'ok: удалено';
}

// ---- plan ----

export function todayPlan(sql: SqlLike): string {
  const list = rows(sql, "SELECT id, text, status FROM plan_items WHERE day = ? AND status != 'removed' ORDER BY id", todayMsk());
  if (!list.length) return '(пусто)';
  return list.map((x) => `${x.status === 'done' ? '☑' : '☐'} ${x.text} (id ${x.id})`).join('\n');
}

// ---- reminders ----

export interface Reminder {
  id: number; text: string; at: number; repeat: string; days: number[]; until: number | null; active: number; kind: string;
}

export function reminderRow(r: any): Reminder {
  return {
    id: Number(r.id), text: String(r.text), at: Number(r.at), repeat: String(r.repeat),
    days: String(r.days ?? '').split(',').filter(Boolean).map(Number), until: r.until == null ? null : Number(r.until),
    active: Number(r.active), kind: String(r.kind ?? 'text'),
  };
}

export function upcomingReminders(sql: SqlLike, limit = 6): Reminder[] {
  return rows(sql, 'SELECT * FROM reminders WHERE active = 1 AND at > ? ORDER BY at LIMIT ?', Date.now(), limit).map(reminderRow);
}

export function dueReminders(sql: SqlLike, now: number): Reminder[] {
  return rows(sql, 'SELECT * FROM reminders WHERE active = 1 AND at <= ? ORDER BY at', now).map(reminderRow);
}

export function earliestReminderAt(sql: SqlLike): number | null {
  const r = rows(sql, 'SELECT MIN(at) AS t FROM reminders WHERE active = 1');
  const t = r.length ? r[0].t : null;
  return t == null ? null : Number(t);
}

export function setReminder(sql: SqlLike, text: string, at: number, repeat: string, days: number[], until: number | null, kind: string): Reminder {
  run(sql,
    'INSERT INTO reminders(text, at, repeat, days, until, kind) VALUES (?,?,?,?,?,?)',
    text, at, repeat, days.join(','), until, kind,
  );
  const r = rows(sql, 'SELECT * FROM reminders ORDER BY id DESC LIMIT 1');
  return reminderRow(r[0]);
}

export function reminderAfterFire(sql: SqlLike, rem: Reminder, now: number): void {
  const next = nextRepeat(rem.at, rem.repeat, rem.days);
  if (next == null || (rem.until != null && next > rem.until)) {
    run(sql, 'UPDATE reminders SET active = 0 WHERE id = ?', rem.id);
  } else {
    run(sql, 'UPDATE reminders SET at = ? WHERE id = ?', next, rem.id);
  }
}

// ---- recall ----

export function recallSearch(sql: SqlLike, query: string, limit: number): string {
  const q = query.replace(/["'`()*:]/g, ' ').trim();
  if (!q) return '(пустой запрос)';
  const hits = rows(
    sql,
    `SELECT m.role AS role, m.created_at AS created_at, m.text AS text
     FROM messages_fts f JOIN messages m ON m.id = f.rowid
     WHERE messages_fts MATCH ? ORDER BY f.rank LIMIT ?`,
    q, limit,
  );
  if (!hits.length) return '(ничего не найдено)';
  return hits.map((x) => `[${x.role === 'user' ? 'пользователь' : 'бот'} ${fmtMsk(Number(x.created_at))}] ${String(x.text).slice(0, 400)}`).join('\n---\n');
}

// ---- summary call target text ----

export function sessionTranscript(sql: SqlLike, sessionId: number, limit = 100): string {
  return rows(
    sql,
    'SELECT role, text FROM messages WHERE session_id = ? AND responded = 1 ORDER BY id DESC LIMIT ?',
    sessionId, limit,
  ).reverse().map((x) => `${x.role === 'user' ? 'П' : 'Б'}: ${x.text}`).join('\n');
}

export function nowIso(): string {
  return nowMsk();
}


export { fmtMsk, nowMsk, todayMsk, parseMskDT } from './time';
