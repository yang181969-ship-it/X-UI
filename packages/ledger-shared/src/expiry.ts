/**
 * Card expiry (cards.expires_on, YYYY-MM — the "valid thru" month printed on the card). Shared by
 * the API (GET /cards filters) and the web app (tags, counters), so both classify a card the same
 * way for the same calendar day.
 *
 * Semantics (M2-B3, documented in API_SPEC §3.4):
 * - A card is usable through the LAST DAY of its expiry month, inclusive: 2028-02 runs until
 *   2028-02-29, 2027-02 until 2027-02-28.
 * - "today" is a calendar date (YYYY-MM-DD), never an instant. All arithmetic here is on calendar
 *   dates (Date.UTC on the date parts), so the result never depends on the time zone of the
 *   machine running it. The web app passes the user's local date to the API (`today=`), so the
 *   list filter and the tags on screen use the same day.
 * - daysLeft = (last day of the expiry month) − today, in whole days: 0 on the last valid day,
 *   negative once expired.
 * - Status: none (no expiry entered) · expired (daysLeft < 0) · expiring (0 ≤ daysLeft ≤ the
 *   threshold) · valid (daysLeft > the threshold). The default threshold is
 *   DEFAULT_EXPIRING_WITHIN_DAYS; GET /cards accepts another one (expiringWithinDays).
 * - Expiry is derived, never stored: it does not change the card's status (active / frozen /
 *   closed are the user's own choice), and an expired card is not "closed".
 */

export const EXPIRY_STATUSES = ['none', 'valid', 'expiring', 'expired'] as const;
export type ExpiryStatus = (typeof EXPIRY_STATUSES)[number];

/** "Expiring soon" = at most this many days left (no frozen rule existed; chosen for M2-B3). */
export const DEFAULT_EXPIRING_WITHIN_DAYS = 60;
/** Largest expiringWithinDays accepted by GET /cards (10 years). */
export const EXPIRING_WITHIN_DAYS_MAX = 3650;

const DAY_MS = 86_400_000;
const YEAR_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Epoch-day number of a YYYY-MM-DD calendar date (time-zone free), or null if it is not a real date. */
export function epochDay(date: string): number | null {
  const m = DATE.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms / DAY_MS;
}

/** Last valid day (YYYY-MM-DD) of a YYYY-MM expiry, or null if it is not a valid expiry. */
export function expiryLastDay(expiresOn: string): string | null {
  const m = YEAR_MONTH.exec(expiresOn);
  if (!m) return null;
  // Day 0 of the next month is the last day of this one (leap years included).
  return new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).toISOString().slice(0, 10);
}

/** The calendar date of an instant in the runtime's local time zone (the browser: the user's own day). */
export function localDate(at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(at.getFullYear()).padStart(4, '0')}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

/** The UTC calendar date of an instant (the API's default "today" when the client sends none). */
export function utcDate(at: number | Date): string {
  return new Date(at).toISOString().slice(0, 10);
}

export interface CardExpiry {
  status: ExpiryStatus;
  /** Last valid day, YYYY-MM-DD (null without an expiry). */
  lastDay: string | null;
  /** Days from today to the last valid day: 0 on that day, negative once expired (null without an expiry). */
  daysLeft: number | null;
}

/**
 * Classify a card's expiry on `today` (YYYY-MM-DD). A malformed expiresOn or today throws: both
 * are validated before they get here (zod on input, CHECK in the database).
 */
export function cardExpiry(expiresOn: string | null, today: string, withinDays: number = DEFAULT_EXPIRING_WITHIN_DAYS): CardExpiry {
  const now = epochDay(today);
  if (now === null) throw new RangeError(`cardExpiry: invalid date ${today}`);
  if (expiresOn === null) return { status: 'none', lastDay: null, daysLeft: null };
  const lastDay = expiryLastDay(expiresOn);
  if (lastDay === null) throw new RangeError(`cardExpiry: invalid expiry ${expiresOn}`);
  const daysLeft = epochDay(lastDay)! - now;
  const status: ExpiryStatus = daysLeft < 0 ? 'expired' : daysLeft <= withinDays ? 'expiring' : 'valid';
  return { status, lastDay, daysLeft };
}
