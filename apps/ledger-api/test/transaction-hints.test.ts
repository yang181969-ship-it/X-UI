// @xui/ledger-shared transactionHints() (API_SPEC §5.13, M3-B4-A Q3): the non-blocking hints the
// web app shows while a transaction is entered. A pure function of current data; it never decides
// anything the API decides (shape, currencies, classification) and never changes a request.
import { TRANSACTION_HINT_CODES, transactionHints, type HintAccount, type HintCard, type TransactionHintInput } from '@xui/ledger-shared';
import { describe, expect, it } from 'vitest';

const account = (over: Partial<HintAccount> = {}): HintAccount => ({
  id: 'acc-1',
  status: 'active',
  currencies: [
    { currency: 'HKD', status: 'active' },
    { currency: 'EUR', status: 'closed' },
  ],
  ...over,
});
const card = (over: Partial<HintCard> = {}): HintCard => ({ id: 'card-1', status: 'active', expiresOn: '2027-06', links: [{ accountId: 'acc-1', status: 'active' }], ...over });
const input = (over: Partial<TransactionHintInput> = {}): TransactionHintInput => ({
  occurredOn: '2026-10-20',
  entries: [{ direction: 'out', account: account(), currency: 'HKD' }],
  card: null,
  channel: null,
  ...over,
});

describe('transactionHints', () => {
  it('no hint for an active account, an active currency, a valid linked card and an active channel', () => {
    expect(transactionHints(input({ card: card(), channel: { id: 'ch-1', status: 'active' } }))).toEqual([]);
  });

  it('nothing chosen yet: no hints', () => {
    expect(transactionHints({ occurredOn: null, entries: [{ direction: 'out', account: null, currency: null }], card: null, channel: null })).toEqual([]);
  });

  it('frozen and closed accounts, per entry direction', () => {
    expect(transactionHints(input({ entries: [{ direction: 'out', account: account({ status: 'frozen' }), currency: 'HKD' }] }))).toEqual([{ code: 'account_frozen', direction: 'out' }]);
    expect(
      transactionHints(
        input({
          entries: [
            { direction: 'out', account: account({ status: 'closed' }), currency: 'HKD' },
            { direction: 'in', account: account({ id: 'acc-2', status: 'frozen' }), currency: 'HKD' },
          ],
        }),
      ),
    ).toEqual([
      { code: 'account_closed', direction: 'out' },
      { code: 'account_frozen', direction: 'in' },
    ]);
  });

  it('a closed currency of the account (an unregistered one is not a hint: the form never offers it)', () => {
    expect(transactionHints(input({ entries: [{ direction: 'in', account: account(), currency: 'EUR' }] }))).toEqual([{ code: 'currency_closed', direction: 'in', currency: 'EUR' }]);
    expect(transactionHints(input({ entries: [{ direction: 'in', account: account(), currency: 'JPY' }] }))).toEqual([]);
  });

  it('frozen and deactivated cards', () => {
    expect(transactionHints(input({ card: card({ status: 'frozen' }) }))).toEqual([{ code: 'card_frozen' }]);
    expect(transactionHints(input({ card: card({ status: 'closed' }) }))).toEqual([{ code: 'card_closed' }]);
  });

  it('a card expired on the occurrence date (last day of the expiry month still valid)', () => {
    expect(transactionHints(input({ occurredOn: '2027-06-30', card: card({ expiresOn: '2027-06' }) }))).toEqual([]);
    expect(transactionHints(input({ occurredOn: '2027-07-01', card: card({ expiresOn: '2027-06' }) }))).toEqual([{ code: 'card_expired', lastDay: '2027-06-30' }]);
    expect(transactionHints(input({ occurredOn: '2024-03-01', card: card({ expiresOn: '2024-02' }) }))).toEqual([{ code: 'card_expired', lastDay: '2024-02-29' }]);
    // No expiry, no date or a malformed date: no expiry hint.
    expect(transactionHints(input({ occurredOn: '2099-01-01', card: card({ expiresOn: null }) }))).toEqual([]);
    expect(transactionHints(input({ occurredOn: null, card: card({ expiresOn: '2020-01' }) }))).toEqual([]);
    expect(transactionHints(input({ occurredOn: '2026-02-30', card: card({ expiresOn: '2020-01' }) }))).toEqual([]);
  });

  it('no active link between the card and the entry account (suspended and ended links do not count)', () => {
    expect(transactionHints(input({ card: card({ links: [] }) }))).toEqual([{ code: 'card_no_active_link', direction: 'out' }]);
    expect(transactionHints(input({ card: card({ links: [{ accountId: 'acc-1', status: 'suspended' }] }) }))).toEqual([{ code: 'card_no_active_link', direction: 'out' }]);
    expect(transactionHints(input({ card: card({ links: [{ accountId: 'acc-1', status: 'ended' }, { accountId: 'acc-9', status: 'active' }] }) }))).toEqual([
      { code: 'card_no_active_link', direction: 'out' },
    ]);
    expect(transactionHints(input({ card: card({ links: [{ accountId: 'acc-1', status: 'ended' }, { accountId: 'acc-1', status: 'active' }] }) }))).toEqual([]);
    // No account chosen yet: nothing to compare.
    expect(transactionHints(input({ entries: [{ direction: 'out', account: null, currency: null }], card: card({ links: [] }) }))).toEqual([]);
  });

  it('an archived channel', () => {
    expect(transactionHints(input({ channel: { id: 'ch-1', status: 'archived' } }))).toEqual([{ code: 'channel_archived' }]);
  });

  it('several hints in a fixed order: entries (account, currency, link), card, channel', () => {
    const hints = transactionHints({
      occurredOn: '2026-10-20',
      entries: [{ direction: 'out', account: account({ status: 'closed' }), currency: 'EUR' }],
      card: card({ status: 'closed', expiresOn: '2026-09', links: [] }),
      channel: { id: 'ch-1', status: 'archived' },
    });
    expect(hints.map((h) => h.code)).toEqual(['account_closed', 'currency_closed', 'card_no_active_link', 'card_closed', 'card_expired', 'channel_archived']);
    expect(new Set(hints.map((h) => h.code)).size).toBe(hints.length);
    for (const h of hints) expect(TRANSACTION_HINT_CODES).toContain(h.code);
  });

  it('a backfill dated before today: a reminder that the backfill is the user’s declaration (never for a current one, today or later)', () => {
    expect(transactionHints(input({ recordMode: 'backfill', today: '2026-11-05', occurredOn: '2026-10-20' }))).toEqual([{ code: 'backfill_past_date', occurredOn: '2026-10-20' }]);
    expect(transactionHints(input({ recordMode: 'backfill', today: '2026-11-05', occurredOn: '2026-11-05' }))).toEqual([]);
    expect(transactionHints(input({ recordMode: 'backfill', today: '2026-11-05', occurredOn: '2026-11-06' }))).toEqual([]);
    expect(transactionHints(input({ recordMode: 'current', today: '2026-11-05', occurredOn: '2020-01-01' }))).toEqual([]);
    expect(transactionHints(input({ recordMode: 'backfill', occurredOn: '2020-01-01' }))).toEqual([]); // no today given
    expect(transactionHints(input({ recordMode: 'backfill', today: '2026-11-05', occurredOn: null }))).toEqual([]);
    // It comes first and sits next to the others.
    const hints = transactionHints(input({ recordMode: 'backfill', today: '2026-11-05', occurredOn: '2026-01-01', channel: { id: 'ch', status: 'archived' } }));
    expect(hints.map((h) => h.code)).toEqual(['backfill_past_date', 'channel_archived']);
  });

  it('is pure: the input is never changed and the same input gives the same hints', () => {
    const i = input({ card: card({ status: 'frozen', links: [] }), channel: { id: 'ch-1', status: 'archived' } });
    const snapshot = JSON.stringify(i);
    expect(transactionHints(i)).toEqual(transactionHints(i));
    expect(JSON.stringify(i)).toBe(snapshot);
  });
});
