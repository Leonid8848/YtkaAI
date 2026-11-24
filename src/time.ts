// Europe/Moscow: fixed UTC+3, no DST.
const OFFSET_MIN = 180;

const WD_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const p2 = (n: number) => String(n).padStart(2, '0');

export interface MskParts { y: number; mo: number; d: number; h: number; mi: number; wd: number }

export function mskParts(ms: number): MskParts {
  const d = new Date(ms + OFFSET_MIN * 60000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), wd: d.getUTCDay() };
}

export function fromMsk(y: number, mo: number, d: number, h: number, mi: number): number {
  return Date.UTC(y, mo - 1, d, h, mi) - OFFSET_MIN * 60000;
}

export function fmtMsk(ms: number): string {
  const p = mskParts(ms);
  return `${p2(p.d)}.${p2(p.mo)}.${p.y} ${p2(p.h)}:${p2(p.mi)} МСК`;
}

export function nowMsk(): string {
  const p = mskParts(Date.now());
  return `${WD_RU[p.wd]}, ${p2(p.d)}.${p2(p.mo)}.${p.y} ${p2(p.h)}:${p2(p.mi)} МСК`;
}

export function todayMsk(): string {
  const p = mskParts(Date.now());
  return `${p.y}-${p2(p.mo)}-${p2(p.d)}`;
}

/** "YYYY-MM-DD HH:MM" (Moscow local) -> epoch ms; day-only "YYYY-MM-DD" -> midnight. */
export function parseMskDT(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s.trim());
  if (!m) return null;
  return fromMsk(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0));
}

/** days convention: 1=Пн ... 7=Вс (as told to the model). */
export function nextRepeat(at: number, repeat: string, days: number[]): number | null {
  if (repeat === 'none') return null;
  const p = mskParts(at);
  const base = fromMsk(p.y, p.mo, p.d, p.h, p.mi);
  if (repeat === 'daily') return base + 86400000;
  if (repeat === 'weekly') {
    const set = new Set(days.map((d) => (d === 7 ? 0 : d)));
    for (let i = 1; i <= 7; i++) {
      const t = base + i * 86400000;
      if (set.has(mskParts(t).wd)) return t;
    }
    return base + 7 * 86400000;
  }
  return null;
}
