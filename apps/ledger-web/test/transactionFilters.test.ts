import { transactionListQuerySchema } from '@xui/ledger-shared';
import { describe, expect, it } from 'vitest';
import { activeFilterCount, applyQuickView, filtersToParams, filtersToQuery, parseFilters, quickViewOf } from '../src/lib/transactionFilters.ts';

const parse = (s: string) => parseFilters(new URLSearchParams(s));

describe('list filters in the URL', () => {
  it('round-trips every filter', () => {
    const s = 'from=2026-10-01&to=2026-10-31&type=own_transfer&foreignStatus=undetermined&amountStatus=pending&recordMode=backfill&status=all&accountId=a1&cardId=c1&channelId=p1&currency=HKD&q=contoso+cafe&limit=20';
    const f = parse(s);
    expect(f).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
      type: 'own_transfer',
      foreignStatus: 'undetermined',
      amountStatus: 'pending',
      recordMode: 'backfill',
      status: 'all',
      accountId: 'a1',
      cardId: 'c1',
      channelId: 'p1',
      currency: 'HKD',
      q: 'contoso cafe',
      limit: 20,
    });
    expect(filtersToParams(f).toString()).toBe(s);
  });

  it('drops values the API would refuse (never sends a 400-causing query)', () => {
    expect(parse('from=2026-13-01&type=salary&foreignStatus=domestic&amountStatus=x&recordMode=y&status=active&currency=XXX&limit=0&q=++')).toEqual({});
    expect(parse('limit=101')).toEqual({});
    expect(parse('accountId=has%20space')).toEqual({});
    // from after to: the end is dropped.
    expect(parse('from=2026-10-31&to=2026-10-01')).toEqual({ from: '2026-10-31' });
  });

  it('builds a query the shared list schema accepts, active by default', () => {
    for (const s of ['', 'status=voided&q=x', 'from=2026-10-01&to=2026-10-31&currency=USD&limit=2', 'foreignStatus=foreign&amountStatus=pending&recordMode=current']) {
      const q = filtersToQuery(parse(s));
      expect(transactionListQuerySchema.safeParse(q).success).toBe(true);
    }
    expect(filtersToQuery({})).toEqual({ status: 'active' });
    expect(filtersToQuery({ limit: 2 })).toEqual({ status: 'active', limit: '2' });
  });

  it('quick views: all / pending / voided, keeping the other filters', () => {
    expect(quickViewOf({})).toBe('all');
    expect(quickViewOf({ amountStatus: 'pending' })).toBe('pending');
    expect(quickViewOf({ status: 'voided' })).toBe('voided');
    expect(quickViewOf({ status: 'all' })).toBeNull();
    expect(quickViewOf({ amountStatus: 'confirmed' })).toBeNull();
    const base = { type: 'merchant_spend' as const, status: 'all' as const, amountStatus: 'confirmed' as const };
    expect(applyQuickView(base, 'pending')).toEqual({ type: 'merchant_spend', amountStatus: 'pending' });
    expect(applyQuickView(base, 'voided')).toEqual({ type: 'merchant_spend', status: 'voided' });
    expect(applyQuickView(base, 'all')).toEqual({ type: 'merchant_spend' });
  });

  it('counts the drawer filters (not the search text or page size)', () => {
    expect(activeFilterCount({ q: 'x', limit: 5 })).toBe(0);
    expect(activeFilterCount({ from: '2026-10-01', to: '2026-10-02', type: 'merchant_spend', currency: 'USD' })).toBe(3);
  });
});
