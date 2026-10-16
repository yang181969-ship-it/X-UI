import { addDays, addMonths, parts } from './date.ts';

export const RECURRENCE_FREQS = ['weekly', 'monthly', 'yearly'] as const;
export type RecurrenceFreq = (typeof RECURRENCE_FREQS)[number];

export interface Recurrence {
  freq: RecurrenceFreq;
  /** Every N weeks/months/years, N ≥ 1. */
  interval: number;
  /** First due date; also fixes the day-of-month / weekday of every later occurrence. */
  startDate: string;
  /** Optional last allowed due date (inclusive). */
  endDate?: string | null;
}

const MAX_ITERATIONS = 10_000;

/**
 * The k-th occurrence (k = 0 is startDate). Monthly/yearly occurrences are computed from the
 * anchor each time, so a bill due on the 31st lands on Feb 28 and returns to Mar 31.
 */
export function occurrenceAt(rec: Recurrence, k: number): string {
  const interval = Math.max(1, Math.trunc(rec.interval));
  switch (rec.freq) {
    case 'weekly':
      return addDays(rec.startDate, 7 * interval * k);
    case 'monthly':
      return addMonths(rec.startDate, interval * k, parts(rec.startDate).d);
    case 'yearly':
      return addMonths(rec.startDate, 12 * interval * k, parts(rec.startDate).d);
  }
}

/** All due dates within [from, to] (inclusive), honoring startDate/endDate. */
export function occurrencesBetween(rec: Recurrence, from: string, to: string): string[] {
  const out: string[] = [];
  for (let k = 0; k < MAX_ITERATIONS; k++) {
    const d = occurrenceAt(rec, k);
    if (d > to || (rec.endDate && d > rec.endDate)) break;
    if (d >= from) out.push(d);
  }
  return out;
}

/** First due date on or after `onOrAfter`, or null if the recurrence has ended. */
export function nextOccurrence(rec: Recurrence, onOrAfter: string): string | null {
  for (let k = 0; k < MAX_ITERATIONS; k++) {
    const d = occurrenceAt(rec, k);
    if (rec.endDate && d > rec.endDate) return null;
    if (d >= onOrAfter) return d;
  }
  return null;
}
