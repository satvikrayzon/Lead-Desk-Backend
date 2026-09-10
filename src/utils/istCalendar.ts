/** India business calendar helpers (Asia/Kolkata). */

const IST = 'Asia/Kolkata';

/** YYYY-MM-DD in IST for a given instant. */
export function dateKeyIst(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
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
