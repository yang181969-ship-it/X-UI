import type { SpendingSourceResult } from '@xui/ledger-shared';
import { describe, expect, it } from 'vitest';
import { applyEntryPrefill, mergeUntouched, spendingSourcePrefill, type EntryPrefill } from '../src/lib/prefill.ts';

const exact = (accountId: string, currency: string): SpendingSourceResult => ({ match: 'exact_currency', eventCurrency: currency, accountId, linkId: 'l1', fundingCurrency: currency, considered: [] });
const conversion = (accountId: string): SpendingSourceResult => ({
  match: 'conversion_required',
  eventCurrency: 'USD',
  accountId,
  linkId: 'l2',
  fundingCurrency: null,
  candidateCurrencies: ['HKD', 'EUR'],
  considered: [],
});
const noMatch: SpendingSourceResult = { match: 'no_match', eventCurrency: 'USD', reason: 'no_eligible_link', considered: [] };

const empty: EntryPrefill = { accountId: null, currency: null, amountText: '' };

describe('mergeUntouched', () => {
  it('fills untouched fields only', () => {
    const touched = new Set<keyof EntryPrefill>(['currency']);
    const draft: EntryPrefill = { accountId: null, currency: 'EUR', amountText: '' };
    expect(mergeUntouched(draft, touched, { accountId: 'a1', currency: 'USD', amountText: '10.00' })).toEqual({ accountId: 'a1', currency: 'EUR', amountText: '10.00' });
  });

  it('returns the same object when nothing changes (no re-render loop)', () => {
    const draft: EntryPrefill = { accountId: 'a1', currency: 'USD', amountText: '' };
    expect(mergeUntouched(draft, new Set(), { accountId: 'a1' })).toBe(draft);
    expect(mergeUntouched(draft, new Set<keyof EntryPrefill>(['accountId', 'currency', 'amountText']), { accountId: 'a2', currency: 'HKD' })).toBe(draft);
    expect(mergeUntouched(draft, new Set(), {})).toBe(draft);
  });

  it('never mutates the draft', () => {
    const draft: EntryPrefill = { ...empty };
    mergeUntouched(draft, new Set(), { accountId: 'a1' });
    expect(draft).toEqual(empty);
  });
});

describe('spendingSourcePrefill (API_SPEC §5.13)', () => {
  it('exact_currency: account, currency and the event amount as text', () => {
    expect(spendingSourcePrefill(exact('a1', 'USD'), { recordMode: 'current', eventAmount: 1000 })).toEqual({ accountId: 'a1', currency: 'USD', amountText: '10.00' });
    expect(spendingSourcePrefill(exact('a1', 'JPY'), { recordMode: 'current', eventAmount: 1500 })).toEqual({ accountId: 'a1', currency: 'JPY', amountText: '1500' });
    expect(spendingSourcePrefill(exact('a1', 'USD'), { recordMode: 'current', eventAmount: null })).toEqual({ accountId: 'a1', currency: 'USD' });
  });

  it('conversion_required: the account only; the funding currency and amount are cleared for the user to choose', () => {
    expect(spendingSourcePrefill(conversion('a2'), { recordMode: 'current', eventAmount: 1000 })).toEqual({ accountId: 'a2', currency: null, amountText: '' });
  });

  it('no_match clears the untouched fields; backfill treats every result as a reference only', () => {
    expect(spendingSourcePrefill(noMatch, { recordMode: 'current', eventAmount: 1000 })).toEqual({ accountId: null, currency: null, amountText: '' });
    expect(spendingSourcePrefill(exact('a1', 'USD'), { recordMode: 'backfill', eventAmount: 1000 })).toEqual({});
    expect(spendingSourcePrefill(conversion('a2'), { recordMode: 'backfill', eventAmount: 1000 })).toEqual({});
  });

  it('a recommendation update never overwrites touched fields', () => {
    const touched = new Set<keyof EntryPrefill>();
    // 1. First result: exact USD on a1 fills everything.
    let draft = mergeUntouched(empty, touched, spendingSourcePrefill(exact('a1', 'USD'), { recordMode: 'current', eventAmount: 1000 }));
    expect(draft).toEqual({ accountId: 'a1', currency: 'USD', amountText: '10.00' });
    // 2. The user edits the amount and picks the currency themselves.
    draft = { ...draft, amountText: '10.35', currency: 'USD' };
    touched.add('amountText');
    touched.add('currency');
    // 3. The recommendation refetches (another card): conversion on a2 — only the untouched account follows.
    draft = mergeUntouched(draft, touched, spendingSourcePrefill(conversion('a2'), { recordMode: 'current', eventAmount: 1000 }));
    expect(draft).toEqual({ accountId: 'a2', currency: 'USD', amountText: '10.35' });
    // A card without a match: only the untouched account is cleared.
    draft = mergeUntouched(draft, touched, spendingSourcePrefill(noMatch, { recordMode: 'current', eventAmount: 1000 }));
    expect(draft).toEqual({ accountId: null, currency: 'USD', amountText: '10.35' });
    // 4. The user picks the account too: further results change nothing.
    touched.add('accountId');
    const before = draft;
    draft = mergeUntouched(draft, touched, spendingSourcePrefill(exact('a3', 'EUR'), { recordMode: 'current', eventAmount: 900 }));
    expect(draft).toBe(before);
  });
  it('switching card, currency and results in a row: untouched fields always follow the latest result, never a stale one', () => {
    const touched = new Set<keyof EntryPrefill>();
    const step = (d: EntryPrefill, r: SpendingSourceResult, eventAmount: number | null) => applyEntryPrefill(d, touched, spendingSourcePrefill(r, { recordMode: 'current', eventAmount }));
    let d = step(empty, exact('hk', 'USD'), 1000); // card A, USD
    expect(d).toEqual({ accountId: 'hk', currency: 'USD', amountText: '10.00' });
    d = step(d, exact('hk', 'USD'), 1250); // the event amount changes: the untouched funding amount follows
    expect(d.amountText).toBe('12.50');
    d = step(d, conversion('hk'), 1250); // JPY event on card A: currency and amount cleared, account kept
    expect(d).toEqual({ accountId: 'hk', currency: null, amountText: '' });
    d = step(d, noMatch, 1250); // card B without links: everything untouched is cleared
    expect(d).toEqual(empty);
    d = step(d, exact('us', 'USD'), 990); // back to an exact match on another account
    expect(d).toEqual({ accountId: 'us', currency: 'USD', amountText: '9.90' });
    touched.add('currency');
    d = { ...d, currency: 'EUR' };
    d = step(d, conversion('hk'), 990); // the touched currency survives every later result
    expect(d).toEqual({ accountId: 'hk', currency: 'EUR', amountText: '' });
    // The event amount is USD: it never stands in for an EUR funding amount.
    d = step(d, exact('us', 'USD'), 990);
    expect(d).toEqual({ accountId: 'us', currency: 'EUR', amountText: '' });
    // A typed amount is never touched either.
    touched.add('amountText');
    d = { ...d, amountText: '8.80' };
    expect(step(d, exact('hk', 'USD'), 990)).toEqual({ accountId: 'hk', currency: 'EUR', amountText: '8.80' });
  });
});
