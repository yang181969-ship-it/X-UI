import { isoDateSchema } from '@xui/ledger-shared';

/**
 * The overview's period (M3-B5-B): presets and a custom range as `from` / `to` — inclusive local
 * calendar dates compared with each transaction's occurredOn (PRODUCT_SPEC §7.7, API_SPEC §5.10).
 * Everything here is plain YYYY-MM-DD text arithmetic on calendar days: no Date in UTC, no time of
 * day, no time zone conversion of transaction dates. "Today" is injected (the browser's local
 * calendar date, from localToday()).
 *
 * Presets use whole calendar periods: "this year" is 1 January – 31 December. occurredOn can be at
 * most the day after today (API_SPEC §5.0.2), so this equals the year to date and still includes a
 * transaction dated tomorrow. "All" has no bounds at all (no invented far-future date).
 *
 * URL (so a refresh, a shared link and back / forward restore it): `period` names the choice;
 * `from` / `to` carry the range itself for every bounded choice. No parameters = the default (this
 * year). A range that no longer matches its preset (a "this month" link opened next month) is shown
 * as a custom range with the dates the link carries.
 */

export const PERIOD_PRESETS = ['month', 'lastMonth', 'quarter', 'year', 'lastYear', 'all'] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];
export type PeriodKind = PeriodPreset | 'custom';
export const DEFAULT_PERIOD: PeriodPreset = 'year';

export interface Period {
  kind: PeriodKind;
  /** Inclusive bounds (YYYY-MM-DD); absent = unbounded on that side. */
  from?: string;
  to?: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const ymd = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

/** The browser's local calendar date (not UTC). */
export function localToday(now: Date = new Date()): string {
  return ymd(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export function daysInMonth(y: number, m: number): number {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
}

export const isDay = (v: string | null | undefined): v is string => typeof v === 'string' && isoDateSchema.safeParse(v).success;

function parts(today: string): [number, number] {
  if (!isDay(today)) throw new RangeError(`not a calendar date: ${today}`);
  return [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
}

const monthRange = (y: number, m: number) => ({ from: ymd(y, m, 1), to: ymd(y, m, daysInMonth(y, m)) });

/** The inclusive range of a preset around `today`; "all" has none. */
export function presetRange(preset: PeriodPreset, today: string): { from?: string; to?: string } {
  const [y, m] = parts(today);
  switch (preset) {
    case 'month':
      return monthRange(y, m);
    case 'lastMonth':
      return m === 1 ? monthRange(y - 1, 12) : monthRange(y, m - 1);
    case 'quarter': {
      const first = Math.floor((m - 1) / 3) * 3 + 1;
      return { from: ymd(y, first, 1), to: ymd(y, first + 2, daysInMonth(y, first + 2)) };
    }
    case 'year':
      return { from: ymd(y, 1, 1), to: ymd(y, 12, 31) };
    case 'lastYear':
      return { from: ymd(y - 1, 1, 1), to: ymd(y - 1, 12, 31) };
    case 'all':
      return {};
  }
}

export function presetPeriod(preset: PeriodPreset, today: string): Period {
  return { kind: preset, ...presetRange(preset, today) };
}

const isPreset = (v: string | null): v is PeriodPreset => v !== null && (PERIOD_PRESETS as readonly string[]).includes(v);

/** The period a URL describes (see the module comment); invalid values fall back to the default. */
export function parsePeriod(params: URLSearchParams, today: string): Period {
  const kind = params.get('period');
  let from = params.get('from') ?? undefined;
  let to = params.get('to') ?? undefined;
  if (!isDay(from)) from = undefined;
  if (!isDay(to)) to = undefined;
  if (from && to && from > to) [from, to] = [undefined, undefined];
  if (kind === 'all') return { kind: 'all' };
  if (from || to) {
    if (isPreset(kind)) {
      const p = presetRange(kind, today);
      if (p.from === from && p.to === to) return { kind, from, to };
    }
    return { kind: 'custom', ...(from && { from }), ...(to && { to }) };
  }
  if (isPreset(kind)) return presetPeriod(kind, today);
  return presetPeriod(DEFAULT_PERIOD, today);
}

/** Search params for a period (in a fixed order). The default period is written out too, so links are explicit. */
export function periodToParams(p: Period): URLSearchParams {
  const out = new URLSearchParams();
  out.set('period', p.kind);
  if (p.kind !== 'all') {
    if (p.from) out.set('from', p.from);
    if (p.to) out.set('to', p.to);
  }
  return out;
}

/** The summary / list query bounds of a period. */
export function periodQuery(p: Period): { from?: string; to?: string } {
  return { ...(p.from && { from: p.from }), ...(p.to && { to: p.to }) };
}
