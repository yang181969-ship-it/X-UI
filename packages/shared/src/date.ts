/**
 * Business dates are plain calendar dates "YYYY-MM-DD" with no time zone.
 * All arithmetic here goes through UTC so DST never shifts a day.
 */

export const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const { y, m, d } = parts(s);
  return d <= daysInMonth(y, m);
}

export function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

export function fromParts(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Local "today" of the machine/browser as YYYY-MM-DD. */
export function todayIso(now = new Date()): string {
  return fromParts(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function addDays(iso: string, days: number): string {
  const { y, m, d } = parts(iso);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return fromParts(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Add months, clamping the day to the target month's length (Jan 31 + 1 → Feb 28/29). */
export function addMonths(iso: string, months: number, preferredDay?: number): string {
  const { y, m, d } = parts(iso);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fromParts(ny, nm, Math.min(preferredDay ?? d, daysInMonth(ny, nm)));
}

export function diffDays(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  return Math.round(
    (Date.UTC(pa.y, pa.m - 1, pa.d) - Date.UTC(pb.y, pb.m - 1, pb.d)) / 86_400_000,
  );
}

/** Day of week, 0 = Sunday. */
export function weekday(iso: string): number {
  const { y, m, d } = parts(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function monthStart(iso: string): string {
  const { y, m } = parts(iso);
  return fromParts(y, m, 1);
}

export function monthEnd(iso: string): string {
  const { y, m } = parts(iso);
  return fromParts(y, m, daysInMonth(y, m));
}

/** The next date on or after `from` whose day-of-month is `day` (clamped for short months). */
export function nextDayOfMonth(from: string, day: number): string {
  const { y, m, d } = parts(from);
  const thisMonth = fromParts(y, m, Math.min(day, daysInMonth(y, m)));
  if (Math.min(day, daysInMonth(y, m)) >= d) return thisMonth;
  return addMonths(fromParts(y, m, 1), 1, day);
}
