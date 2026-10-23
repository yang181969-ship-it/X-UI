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

/**
 * Optional local wall-clock time of a transaction, "HH:mm" (24 h). It only describes the moment
 * on the business date (occurredAt) and is never used to shift that date.
 */
export const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isTimeOfDay(s: string): boolean {
  return TIME_OF_DAY_RE.test(s);
}

/**
 * A typed time as "HH:mm", or null if it isn't one: "9:05", "0905", "905", "09.05" and "09：05"
 * all give "09:05"; a valid "HH:mm" comes back unchanged. Pure string work — no Date is involved,
 * so neither the current day nor any time zone (DST gaps included) can change the result.
 */
export function parseTimeOfDay(input: string): string | null {
  const s = input.trim().replace(/[：.．]/g, ':');
  const m = /^(\d{1,2}):(\d{2})$/.exec(s) ?? /^(\d{1,2})(\d{2})$/.exec(s);
  if (!m) return null;
  const hhmm = `${m[1]!.padStart(2, '0')}:${m[2]}`;
  return isTimeOfDay(hhmm) ? hhmm : null;
}

/** Region/City style IANA names ("Asia/Shanghai", "America/Argentina/Buenos_Aires", "UTC"); no "+08:00" offsets. */
const TIME_ZONE_NAME_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

/**
 * An IANA time zone known to this runtime as it should be stored, or null if it isn't one.
 * Only the letter case is corrected ("asia/shanghai" → "Asia/Shanghai"): the runtime's own
 * canonical name can be an old alias (V8 turns "Asia/Kolkata" into "Asia/Calcutta"), so a
 * valid name is otherwise kept exactly as chosen.
 */
export function normalizeTimeZone(tz: string): string | null {
  if (tz.length > 64 || !TIME_ZONE_NAME_RE.test(tz)) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return resolved.toLowerCase() === tz.toLowerCase() ? resolved : tz;
}
