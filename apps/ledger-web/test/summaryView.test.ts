import type { SummaryGroup, TransactionSummaryDto } from '@xui/ledger-shared';
import { describe, expect, it } from 'vitest';
import { formatMoney } from '../src/lib/money.ts';
import { ACTIVITY_ROWS, activityKey, addAmounts, countText, currencyCards, isEmptySummary, mixedHomeRegions, pendingEntryCount } from '../src/lib/summaryView.ts';

const g = (x: Partial<SummaryGroup>): SummaryGroup => ({
  txnType: 'merchant_spend',
  direction: 'out',
  currency: 'HKD',
  currencyExponent: 2,
  merchantScope: 'foreign',
  transferScope: null,
  accountScope: 'foreign',
  amount: '100',
  count: 1,
  ...x,
});
const empty: TransactionSummaryDto = { from: null, to: null, transactionCount: 0, pendingTransactionCount: 0, homeRegions: [], foreign: [], undetermined: [], domestic: [], pending: [] };

describe('overview currency cards', () => {
  it('merges only groups of the same type, direction, currency and exponent — with BigInt, beyond 2^53', () => {
    const big = '999999999999999';
    const cards = currencyCards([
      g({ amount: big, count: 3, merchantScope: 'foreign', accountScope: 'foreign' }),
      g({ amount: big, count: 4, merchantScope: 'unknown', accountScope: 'domestic' }),
      g({ amount: big, count: 2, merchantScope: 'domestic', accountScope: 'foreign' }),
    ]);
    expect(cards).toHaveLength(1);
    const spend = cards[0]!.rows.find((r) => r.key === 'spend')!;
    expect(spend.amount).toBe((3n * 999999999999999n).toString()); // 2999999999999997 > 2^53, exact
    expect(spend.count).toBe(9);
    expect(spend.details).toHaveLength(3);
    expect(formatMoney(spend.amount!, 2)).toBe('29,999,999,999,999.97');
  });

  it('never merges different currencies or exponents of one currency; cards sorted by currency then exponent', () => {
    const cards = currencyCards([g({ currency: 'USD', amount: '5' }), g({ currency: 'HKD', currencyExponent: 3, amount: '7' }), g({ currency: 'HKD', amount: '11' }), g({ currency: 'JPY', currencyExponent: 0, amount: '1000' })]);
    expect(cards.map((c) => [c.currency, c.exponent, c.rows[0]!.amount])).toEqual([['HKD', 2, '11'], ['HKD', 3, '7'], ['JPY', 0, '1000'], ['USD', 2, '5']]);
  });

  it('six fixed rows; refunds, spending and the two sides of a transfer are never added to each other', () => {
    const [card] = currencyCards([
      g({ amount: '1000' }),
      g({ txnType: 'merchant_refund', direction: 'in', amount: '300' }),
      g({ txnType: 'own_transfer', direction: 'out', merchantScope: null, transferScope: 'outbound', amount: '5000' }),
      g({ txnType: 'own_transfer', direction: 'in', merchantScope: null, transferScope: 'outbound', amount: '4990' }),
    ]);
    expect(card!.rows.map((r) => [r.key, r.amount, r.count])).toEqual([
      ['spend', '1000', 1],
      ['refund', '300', 1],
      ['ownOut', '5000', 1],
      ['ownIn', '4990', 1],
      ['thirdOut', null, 0],
      ['thirdIn', null, 0],
    ]);
    expect(card!.rows.map((r) => r.key)).toEqual(ACTIVITY_ROWS.map((r) => r.key));
  });

  it('an empty row is "—", never 0; an empty block has no cards', () => {
    expect(countText(0)).toBe('—');
    expect(countText(3)).toBe('3');
    expect(currencyCards([])).toEqual([]);
    expect(isEmptySummary(empty)).toBe(true);
  });

  it('amounts are exact decimal strings only', () => {
    expect(addAmounts(['9007199254740993', '1'])).toBe('9007199254740994');
    expect(addAmounts([])).toBe('0');
    expect(() => addAmounts(['1.5'])).toThrow(RangeError);
    expect(() => addAmounts(['-1'])).toThrow(RangeError);
    expect(() => addAmounts(['1e3'])).toThrow(RangeError);
  });
});

describe('overview pending and home regions', () => {
  it('pending rows are counts of entries — there is no amount to show', () => {
    const pending: TransactionSummaryDto['pending'] = [
      { foreignStatus: 'foreign', txnType: 'own_transfer', direction: 'out', currency: 'HKD', currencyExponent: 2, count: 1 },
      { foreignStatus: 'foreign', txnType: 'own_transfer', direction: 'in', currency: 'EUR', currencyExponent: 2, count: 1 },
    ];
    expect(pendingEntryCount(pending)).toBe(2);
    for (const p of pending) expect(Object.keys(p)).not.toContain('amount');
    expect(activityKey('own_transfer', 'in')).toBe('ownIn');
    expect(activityKey('merchant_spend', 'in')).toBeNull();
  });

  it('several saved home regions are pointed out', () => {
    expect(mixedHomeRegions({ homeRegions: ['CN'] })).toBe(false);
    expect(mixedHomeRegions({ homeRegions: ['CN', 'HK'] })).toBe(true);
    expect(mixedHomeRegions({ homeRegions: [] })).toBe(false);
  });
});
