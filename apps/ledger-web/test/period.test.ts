import { transactionSummaryQuerySchema } from '@xui/ledger-shared';
import { describe, expect, it } from 'vitest';
import { daysInMonth, isLeapYear, localToday, parsePeriod, periodQuery, periodToParams, presetPeriod, presetRange, PERIOD_PRESETS } from '../src/lib/period.ts';

const parse = (s: string, today = '2026-11-05') => parsePeriod(new URLSearchParams(s), today);

describe('overview period presets (local calendar days, inclusive)', () => {
  it('months: month ends, leap years, January → last December', () => {
    expect(presetRange('month', '2026-11-05')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(presetRange('month', '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(presetRange('month', '2028-02-29')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(presetRange('month', '2026-12-31')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(presetRange('lastMonth', '2026-03-31')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(presetRange('lastMonth', '2024-03-01')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(presetRange('lastMonth', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('quarters and years, across year ends', () => {
    expect(presetRange('quarter', '2026-01-01')).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(presetRange('quarter', '2026-05-31')).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(presetRange('quarter', '2026-09-30')).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(presetRange('quarter', '2026-11-05')).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(presetRange('year', '2026-11-05')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(presetRange('lastYear', '2026-01-01')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    expect(presetRange('all', '2026-11-05')).toEqual({}); // no invented bounds
  });

  it('year boundary: every preset on 31 December and on the next 1 January', () => {
    const dec31 = Object.fromEntries(PERIOD_PRESETS.map((p) => [p, presetRange(p, '2025-12-31')]));
    expect(dec31).toEqual({
      month: { from: '2025-12-01', to: '2025-12-31' },
      lastMonth: { from: '2025-11-01', to: '2025-11-30' },
      quarter: { from: '2025-10-01', to: '2025-12-31' },
      year: { from: '2025-01-01', to: '2025-12-31' },
      lastYear: { from: '2024-01-01', to: '2024-12-31' },
      all: {},
    });
    const jan1 = Object.fromEntries(PERIOD_PRESETS.map((p) => [p, presetRange(p, '2026-01-01')]));
    expect(jan1).toEqual({
      month: { from: '2026-01-01', to: '2026-01-31' },
      lastMonth: { from: '2025-12-01', to: '2025-12-31' },
      quarter: { from: '2026-01-01', to: '2026-03-31' },
      year: { from: '2026-01-01', to: '2026-12-31' },
      lastYear: { from: '2025-01-01', to: '2025-12-31' },
      all: {},
    });
    // The default follows the day; a link made on 31 December opened on 1 January keeps its dates (custom).
    expect(parse('', '2025-12-31')).toEqual({ kind: 'year', from: '2025-01-01', to: '2025-12-31' });
    expect(parse('', '2026-01-01')).toEqual({ kind: 'year', from: '2026-01-01', to: '2026-12-31' });
    expect(parse('period=year&from=2025-01-01&to=2025-12-31', '2026-01-01')).toEqual({ kind: 'custom', from: '2025-01-01', to: '2025-12-31' });
  });

  it('quarter switches and month ends on both sides of each boundary', () => {
    const q = (today: string) => presetRange('quarter', today);
    expect([q('2025-03-31'), q('2025-04-01')]).toEqual([{ from: '2025-01-01', to: '2025-03-31' }, { from: '2025-04-01', to: '2025-06-30' }]);
    expect([q('2025-06-30'), q('2025-07-01')]).toEqual([{ from: '2025-04-01', to: '2025-06-30' }, { from: '2025-07-01', to: '2025-09-30' }]);
    expect([q('2025-09-30'), q('2025-10-01')]).toEqual([{ from: '2025-07-01', to: '2025-09-30' }, { from: '2025-10-01', to: '2025-12-31' }]);
    for (const [today, to] of [['2025-04-30', '2025-04-30'], ['2025-05-31', '2025-05-31'], ['2024-02-29', '2024-02-29'], ['2100-02-10', '2100-02-28'], ['2000-02-10', '2000-02-29']] as const) {
      expect(presetRange('month', today).to, today).toBe(to);
    }
  });

  it('leap-year rule and month lengths', () => {
    expect([1900, 2000, 2024, 2026, 2100].map(isLeapYear)).toEqual([false, true, true, false, false]);
    expect(Array.from({ length: 12 }, (_, i) => daysInMonth(2024, i + 1))).toEqual([31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
  });

  it('every preset range is a valid summary query (the API accepts it)', () => {
    for (const today of ['2026-01-01', '2026-02-28', '2028-02-29', '2026-12-31']) {
      for (const p of PERIOD_PRESETS) expect(transactionSummaryQuerySchema.safeParse(periodQuery(presetPeriod(p, today))).success, `${p} ${today}`).toBe(true);
    }
  });

  it('localToday is the local calendar date, not the UTC one', () => {
    expect(localToday(new Date(2026, 0, 1, 0, 30))).toBe('2026-01-01');
    expect(localToday(new Date(2025, 11, 31, 23, 59))).toBe('2025-12-31');
    expect(() => presetRange('month', '2026-02-30')).toThrow(RangeError);
  });
});

describe('overview period in the URL', () => {
  it('no parameters → this year (the default)', () => {
    expect(parse('')).toEqual({ kind: 'year', from: '2026-01-01', to: '2026-12-31' });
  });

  it('round-trips every preset and a custom range', () => {
    for (const p of PERIOD_PRESETS) {
      const period = presetPeriod(p, '2026-11-05');
      expect(parse(periodToParams(period).toString())).toEqual(period);
    }
    const custom = { kind: 'custom' as const, from: '2026-03-15', to: '2026-04-15' };
    expect(periodToParams(custom).toString()).toBe('period=custom&from=2026-03-15&to=2026-04-15');
    expect(parse('period=custom&from=2026-03-15&to=2026-04-15')).toEqual(custom);
    expect(periodToParams({ kind: 'all' }).toString()).toBe('period=all');
  });

  it('a stale preset link keeps its dates as a custom range; dates without a name are custom', () => {
    expect(parse('period=month&from=2026-10-01&to=2026-10-31')).toEqual({ kind: 'custom', from: '2026-10-01', to: '2026-10-31' });
    expect(parse('from=2026-01-01&to=2026-12-31')).toEqual({ kind: 'custom', from: '2026-01-01', to: '2026-12-31' });
    expect(parse('period=custom&from=2026-05-01')).toEqual({ kind: 'custom', from: '2026-05-01' });
    expect(parse('period=quarter')).toEqual({ kind: 'quarter', from: '2026-10-01', to: '2026-12-31' });
  });

  it('drops what the API would refuse: impossible dates, reversed ranges, unknown names', () => {
    expect(parse('period=custom&from=2026-02-30&to=2026-03-01')).toEqual({ kind: 'custom', to: '2026-03-01' });
    expect(parse('from=2026-05-01&to=2026-04-01')).toEqual({ kind: 'year', from: '2026-01-01', to: '2026-12-31' });
    expect(parse('period=decade')).toEqual({ kind: 'year', from: '2026-01-01', to: '2026-12-31' });
    expect(parse('period=all&from=2026-01-01&to=2026-01-31')).toEqual({ kind: 'all' });
    expect(periodQuery({ kind: 'all' })).toEqual({});
  });
});
