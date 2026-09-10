/** India business calendar helpers (Asia/Kolkata). */

const IST = 'Asia/Kolkata';
const HAS_TZ_RE = /([zZ]|[+-]\d{2}:?\d{2})$/;
const NAIVE_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/;

/** YYYY-MM-DD in IST for a given instant. */
export function dateKeyIst(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** 0 = Sunday … 6 = Saturday for the IST calendar day of `d`. */
export function weekdayIst(d: Date): number {
  const key = dateKeyIst(d);
  const [y, m, day] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day, 12)).getUTCDay();
}

export function isSundayIst(d: Date): boolean {
  return weekdayIst(d) === 0;
}

/** Instant of 00:00:00.000 IST on the IST calendar day of `d`. */
export function startOfIstDay(d = new Date()): Date {
  const key = dateKeyIst(d);
  return new Date(`${key}T00:00:00+05:30`);
}

export function daysAgoIst(n: number, from = new Date()): Date {
  const start = startOfIstDay(from);
  start.setTime(start.getTime() - n * 24 * 60 * 60 * 1000);
  return start;
}

/**
 * Parse client timestamps. Flutter's `DateTime.toIso8601String()` for local
 * times omits the offset (e.g. `2026-09-09T16:51:00.000`). On a UTC server
 * `new Date(...)` treats that as UTC and shifts the call by +5:30.
 * Timezone-less ISO strings are therefore interpreted as IST wall clock.
 */
export function parseClientDateTime(raw: string): Date {
  const s = raw.trim();
  if (!s) return new Date(Number.NaN);

  if (HAS_TZ_RE.test(s)) {
    return new Date(s);
  }

  if (NAIVE_ISO_RE.test(s)) {
    return new Date(`${s}+05:30`);
  }

  // Date-only (YYYY-MM-DD) is calendar day in IST.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(`${s}T00:00:00+05:30`);
  }

  return new Date(s);
}

/** Calendar day (follow-up schedule) → 00:00 IST on that day. */
export function parseClientCalendarDate(raw: string): Date {
  const d = parseClientDateTime(raw);
  if (Number.isNaN(d.getTime())) return d;
  const key = dateKeyIst(d);
  return new Date(`${key}T00:00:00+05:30`);
}
