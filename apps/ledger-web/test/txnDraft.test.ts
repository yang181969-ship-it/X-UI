import { canonicalRequestV1, latestOccurredOn, transactionCreateSchema, transactionShapeProblem, type TransactionCreate } from '@xui/ledger-shared';
import { describe, expect, it } from 'vitest';
import {
  buildCreateRequest,
  draftDirections,
  draftFromBody,
  emptyDraft,
  fieldOfPath,
  issuesFromServer,
  UNKNOWN_REGION,
  type CurrencyStatusLookup,
  type TxnDraft,
} from '../src/lib/txnDraft.ts';

const NOW = Date.UTC(2026, 10, 5, 12);
const TODAY = '2026-11-05';
// HK account: HKD / USD active, EUR closed; US account: USD; CN account: CNY.
const currencies: Record<string, Record<string, 'active' | 'closed'>> = { hk: { HKD: 'active', USD: 'active', EUR: 'closed' }, us: { USD: 'active' }, cn: { CNY: 'active' } };
const currencyStatus: CurrencyStatusLookup = (a, c) => (currencies[a] ? (currencies[a]![c] ?? null) : undefined);
const build = (d: TxnDraft) => buildCreateRequest(d, { now: NOW, currencyStatus });

const entry = (accountId: string, currency: string, amountText: string, over = {}) => ({ accountId, currency, pending: false, amountText, closedAck: false, ...over });

function spend(): TxnDraft {
  const d = emptyDraft('merchant_spend', '2026-10-20');
  return { ...d, occurredTime: '14:05', eventCurrency: 'USD', eventAmountText: '10.00', merchantName: ' Contoso Cafe ', merchantCountry: 'US', cardId: 'card-1', entries: { ...d.entries, out: entry('hk', 'HKD', '78.30') } };
}

function ok(d: TxnDraft): TransactionCreate {
  const r = build(d);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  // Always a body the shared schema accepts as it is, with no Entry-shape problem.
  expect(transactionCreateSchema.parse(r.body)).toEqual(r.body);
  expect(transactionShapeProblem(r.body)).toBeNull();
  return r.body;
}
const issues = (d: TxnDraft) => {
  const r = build(d);
  return r.ok ? [] : r.issues.map((i) => `${i.field}:${i.code}${i.detail ? `:${i.detail}` : ''}`);
};

describe('four transaction types → the parsed request', () => {
  it('merchant spend: one out entry, merchant fields, card; amounts as minor units', () => {
    const b = ok(spend());
    expect(b).toMatchObject({
      type: 'merchant_spend',
      recordMode: 'current',
      declaredHomeRegion: null,
      occurredOn: '2026-10-20',
      occurredTime: '14:05',
      eventCurrency: 'USD',
      eventAmount: 1000,
      merchantName: 'Contoso Cafe',
      merchantCountry: 'US',
      cardId: 'card-1',
      transferMethod: null,
      counterparty: null,
      notes: null,
    });
    expect(b.entries).toEqual([{ direction: 'out', accountId: 'hk', currency: 'HKD', amountStatus: 'confirmed', amount: 7830, closedCurrencyAck: false }]);
  });

  it('merchant refund: the same structure with one in entry', () => {
    const d = spend();
    const b = ok({ ...d, type: 'merchant_refund', entries: { out: entry('cn', 'CNY', '1'), in: entry('hk', 'USD', '10') } });
    expect(b.entries).toEqual([{ direction: 'in', accountId: 'hk', currency: 'USD', amountStatus: 'confirmed', amount: 1000, closedCurrencyAck: false }]);
    expect(draftDirections({ type: 'merchant_refund', ownMode: 'both', direction: 'out' })).toEqual(['in']);
  });

  it('merchant country unknown is sent as null (saved as undetermined by the server, never as domestic)', () => {
    expect(ok({ ...spend(), merchantCountry: UNKNOWN_REGION }).merchantCountry).toBeNull();
    expect(issues({ ...spend(), merchantCountry: null })).toEqual(['merchantCountry:regionRequired']);
  });

  it('own transfer, both sides registered: two entries, cross-currency, no counterparty, no card or merchant', () => {
    const d = emptyDraft('own_transfer', '2026-10-20');
    const b = ok({
      ...d,
      eventCurrency: 'HKD',
      eventAmountText: '1000',
      transferMethod: 'swift',
      merchantName: 'ignored',
      merchantCountry: 'US',
      cardId: 'card-1',
      counterparty: { name: 'ignored', country: 'SG', institution: '', accountHint: '' },
      entries: { out: entry('hk', 'HKD', '1000.00'), in: entry('us', 'USD', '128') },
    });
    expect(b).toMatchObject({ counterparty: null, cardId: null, merchantName: null, merchantCountry: null, paymentChannelId: null, transferMethod: 'swift', eventAmount: 100000 });
    expect(b.entries.map((e) => [e.direction, e.accountId, e.currency, e.amount])).toEqual([
      ['out', 'hk', 'HKD', 100000],
      ['in', 'us', 'USD', 12800],
    ]);
    expect(issues({ ...d, eventCurrency: 'HKD', eventAmountText: '1', entries: { out: entry('hk', 'HKD', '1'), in: entry('hk', 'USD', '1') } })).toEqual(['entry.in.accountId:sameAccount']);
  });

  it('own transfer, one side unregistered: one entry and the other side’s jurisdiction is required (never unknown)', () => {
    const d = { ...emptyDraft('own_transfer', '2026-10-20'), ownMode: 'one' as const, direction: 'in' as const, eventCurrency: 'USD', eventAmountText: '50' };
    const withEntry = { ...d, entries: { ...d.entries, in: entry('us', 'USD', '49.5') } };
    expect(issues(withEntry)).toEqual(['counterparty.country:required']);
    expect(issues({ ...withEntry, counterparty: { ...d.counterparty, country: UNKNOWN_REGION } })).toEqual(['counterparty.country:required']);
    const b = ok({ ...withEntry, counterparty: { name: ' My SG account ', country: 'SG', institution: '', accountHint: '12ab' } });
    expect(b.entries).toEqual([{ direction: 'in', accountId: 'us', currency: 'USD', amountStatus: 'confirmed', amount: 4950, closedCurrencyAck: false }]);
    expect(b.counterparty).toEqual({ name: 'My SG account', country: 'SG', institution: null, accountHint: '12ab' });
  });

  it('third-party transfer out: event amount required; counterparty country may be explicitly unknown', () => {
    const d = { ...emptyDraft('third_party_transfer', '2026-10-20'), direction: 'out' as const, entries: { out: entry('hk', 'HKD', '500'), in: entry('us', 'USD', '1') } };
    expect(issues({ ...d, counterparty: { ...d.counterparty, country: UNKNOWN_REGION } })).toEqual(['eventCurrency:required', 'eventAmount:empty']);
    const b = ok({ ...d, eventCurrency: 'HKD', eventAmountText: '480', counterparty: { name: 'Northwind', country: UNKNOWN_REGION, institution: 'Bank X', accountHint: '' } });
    expect(b.entries).toHaveLength(1);
    expect(b.counterparty).toEqual({ name: 'Northwind', country: null, institution: 'Bank X', accountHint: null });
    expect(issues({ ...d, eventCurrency: 'HKD', eventAmountText: '480' })).toEqual(['counterparty.country:regionRequired']);
  });

  it('third-party transfer in: the sender’s amount may be unknown (P8) — only when ticked, only for incoming', () => {
    const d = { ...emptyDraft('third_party_transfer', '2026-10-20'), direction: 'in' as const, counterparty: { name: 'Northwind', country: 'GB', institution: '', accountHint: '' }, entries: { out: entry('hk', 'HKD', '1'), in: entry('us', 'USD', '50') } };
    expect(issues(d)).toEqual(['eventCurrency:required', 'eventAmount:empty']);
    const b = ok({ ...d, eventAmountUnknown: true });
    expect(b).toMatchObject({ eventAmount: null, eventCurrency: null });
    expect(ok({ ...d, eventAmountUnknown: true, eventCurrency: 'GBP' })).toMatchObject({ eventAmount: null, eventCurrency: 'GBP' });
    // Ticking "unknown" means nothing for an outgoing transfer.
    expect(issues({ ...d, direction: 'out', eventAmountUnknown: true, entries: { ...d.entries, out: entry('hk', 'HKD', '1') } })).toEqual(['eventCurrency:required', 'eventAmount:empty']);
  });
});

describe('amounts, dates, currencies and text', () => {
  it('amount problems by field (format, scale, zero, range, empty)', () => {
    const d = spend();
    expect(issues({ ...d, eventAmountText: '10.001' })).toEqual(['eventAmount:scale']);
    expect(issues({ ...d, eventAmountText: '1,000' })).toEqual(['eventAmount:format']);
    expect(issues({ ...d, entries: { ...d.entries, out: entry('hk', 'HKD', '0') } })).toEqual(['entry.out.amount:zero']);
    expect(issues({ ...d, entries: { ...d.entries, out: entry('hk', 'HKD', '10000000000000') } })).toEqual(['entry.out.amount:range']);
    expect(issues({ ...d, entries: { ...d.entries, out: entry('hk', 'HKD', '') } })).toEqual(['entry.out.amount:empty']);
    expect(issues({ ...d, eventCurrency: 'JPY', eventAmountText: '1500.5' })).toEqual(['eventAmount:scale']);
  });

  it('a pending entry has no amount (never estimated)', () => {
    const d = spend();
    const b = ok({ ...d, entries: { ...d.entries, out: entry('hk', 'HKD', 'whatever', { pending: true }) } });
    expect(b.entries[0]).toMatchObject({ amountStatus: 'pending', amount: null });
  });

  it('required account and currency', () => {
    const d = spend();
    expect(issues({ ...d, entries: { ...d.entries, out: { ...entry('hk', 'HKD', '1'), accountId: null, currency: null } } })).toEqual(['entry.out.accountId:required', 'entry.out.currency:required']);
  });

  it('occurredOn: required, at most latestOccurredOn; postedOn not before it; time HH:MM', () => {
    const d = spend();
    expect(issues({ ...d, occurredOn: null })).toEqual(['occurredOn:required']);
    expect(issues({ ...d, occurredOn: latestOccurredOn(NOW) })).toEqual([]);
    const after = new Date(Date.parse(`${latestOccurredOn(NOW)}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    expect(issues({ ...d, occurredOn: after })).toEqual(['occurredOn:tooLate']);
    expect(issues({ ...d, postedOn: '2026-10-19' })).toEqual(['postedOn:postedBefore']);
    expect(ok({ ...d, postedOn: '2026-10-20' }).postedOn).toBe('2026-10-20');
    expect(issues({ ...d, occurredTime: '25:00' })[0]).toMatch(/^occurredTime:invalid/);
  });

  it('only registered currencies; closed ones never in a current transaction; confirmed per entry in a backfill (P7)', () => {
    const d = spend();
    expect(issues({ ...d, entries: { ...d.entries, out: entry('hk', 'JPY', '1') } })).toEqual(['entry.out.currency:notRegistered']);
    expect(issues({ ...d, entries: { ...d.entries, out: entry('hk', 'EUR', '1') } })).toEqual(['entry.out.currency:closedCurrencyCurrent']);
    const bf = { ...d, recordMode: 'backfill' as const, entries: { ...d.entries, out: entry('hk', 'EUR', '1') } };
    expect(issues(bf)).toEqual(['entry.out.closedAck:ackRequired']);
    const acked = ok({ ...bf, entries: { ...bf.entries, out: entry('hk', 'EUR', '1', { closedAck: true }) } });
    expect(acked.entries[0]!.closedCurrencyAck).toBe(true);
    // The permission is not sent for an active currency or in current mode, even if the box was ticked before.
    expect(ok({ ...bf, entries: { ...bf.entries, out: entry('hk', 'HKD', '1', { closedAck: true }) } }).entries[0]!.closedCurrencyAck).toBe(false);
  });

  it('declaredHomeRegion only in a backfill', () => {
    expect(ok({ ...spend(), declaredHomeRegion: 'HK' }).declaredHomeRegion).toBeNull();
    expect(ok({ ...spend(), recordMode: 'backfill', declaredHomeRegion: 'HK' })).toMatchObject({ recordMode: 'backfill', declaredHomeRegion: 'HK' });
  });

  it('sensitive text is refused before sending (shared scanSensitive), by request field name', () => {
    const d = spend();
    expect(issues({ ...d, notes: 'card 4111 1111 1111 1111' })).toEqual(['notes:sensitive:card_number']);
    expect(issues({ ...d, merchantName: 'CVV 123' })).toEqual(['merchantName:sensitive:secret_code']);
    const t = { ...emptyDraft('third_party_transfer', '2026-10-20'), eventCurrency: 'HKD', eventAmountText: '1', entries: { out: entry('hk', 'HKD', '1'), in: entry('us', 'USD', '1') } };
    expect(issues({ ...t, counterparty: { name: '4111111111111111', country: 'GB', institution: '', accountHint: '' } })).toEqual(['counterparty.name:sensitive:card_number']);
  });

  it('schema problems map back to the field (entry index → direction)', () => {
    const t = { ...emptyDraft('third_party_transfer', '2026-10-20'), eventCurrency: 'HKD', eventAmountText: '1', entries: { out: entry('hk', 'HKD', '1'), in: entry('us', 'USD', '1') } };
    expect(issues({ ...t, counterparty: { name: '', country: 'GB', institution: '', accountHint: '12345' } })).toHaveLength(1);
    expect(issues({ ...t, counterparty: { name: '', country: 'GB', institution: '', accountHint: '12345' } })[0]).toMatch(/^counterparty\.accountHint:invalid/);
    expect(fieldOfPath(['entries', 1, 'amount'], [{ direction: 'out' }, { direction: 'in' }])).toBe('entry.in.amount');
    expect(fieldOfPath([], [])).toBe('form');
    expect(fieldOfPath(['counterparty'], [])).toBe('counterparty.country');
  });
});

describe('the request is stable', () => {
  it('building the same draft twice gives the same canonical request (same key on resubmit)', () => {
    const a = ok(spend());
    const b = ok(spend());
    expect(canonicalRequestV1('transaction.create', null, a)).toBe(canonicalRequestV1('transaction.create', null, b));
    expect(canonicalRequestV1('transaction.create', null, ok({ ...spend(), eventAmountText: '10.01' }))).not.toBe(canonicalRequestV1('transaction.create', null, a));
  });

  it('draftFromBody round-trips every type (a restored request is shown exactly as it is resent)', () => {
    const own = emptyDraft('own_transfer', '2026-10-20');
    const third = emptyDraft('third_party_transfer', '2026-10-21');
    const bodies = [
      ok(spend()),
      ok({ ...spend(), recordMode: 'backfill', declaredHomeRegion: 'HK', merchantCountry: UNKNOWN_REGION, notes: 'x', entries: { ...spend().entries, out: entry('hk', 'EUR', '1.5', { closedAck: true }) } }),
      ok({ ...spend(), type: 'merchant_refund', entries: { out: entry('hk', 'HKD', '1'), in: entry('hk', 'HKD', '1', { pending: true }) } }),
      ok({ ...own, eventCurrency: 'HKD', eventAmountText: '1000', transferMethod: 'fps', entries: { out: entry('hk', 'HKD', '1000'), in: entry('us', 'USD', '128') } }),
      ok({ ...own, ownMode: 'one', direction: 'out', eventCurrency: 'HKD', eventAmountText: '5', counterparty: { name: '', country: 'SG', institution: 'Bank', accountHint: '9' }, entries: { ...own.entries, out: entry('hk', 'HKD', '5') } }),
      ok({ ...third, direction: 'in', eventAmountUnknown: true, counterparty: { name: 'N', country: UNKNOWN_REGION, institution: '', accountHint: '' }, entries: { ...third.entries, in: entry('us', 'USD', '50') } }),
    ];
    for (const body of bodies) {
      const again = ok(draftFromBody(body));
      expect(canonicalRequestV1('transaction.create', null, again)).toBe(canonicalRequestV1('transaction.create', null, body));
    }
  });
});

describe('definitive server answers → fields', () => {
  const body = ok({ ...emptyDraft('own_transfer', TODAY), eventCurrency: 'HKD', eventAmountText: '1', entries: { out: entry('hk', 'HKD', '1'), in: entry('us', 'USD', '1') } });
  it('maps VALIDATION paths, SENSITIVE_DATA fields, currency and ack errors by direction', () => {
    expect(issuesFromServer({ status: 400, code: 'VALIDATION', details: [{ path: ['entries', 1, 'amount'], message: 'bad' }] }, body)).toEqual([{ field: 'entry.in.amount', code: 'invalid', detail: 'bad' }]);
    expect(issuesFromServer({ status: 400, code: 'VALIDATION', details: [{ path: ['occurredOn'], message: 'late' }] }, body)).toEqual([{ field: 'occurredOn', code: 'invalid', detail: 'late' }]);
    expect(issuesFromServer({ status: 400, code: 'SENSITIVE_DATA', details: { fields: [{ field: 'notes', kind: 'card_number' }] } }, body)).toEqual([{ field: 'notes', code: 'sensitive', detail: 'card_number' }]);
    expect(issuesFromServer({ status: 400, code: 'CURRENCY_NOT_ON_ACCOUNT', details: { direction: 'in', currency: 'USD', status: null } }, body)).toEqual([{ field: 'entry.in.currency', code: 'notRegistered' }]);
    expect(issuesFromServer({ status: 400, code: 'CURRENCY_NOT_ON_ACCOUNT', details: { direction: 'out', currency: 'HKD', status: 'closed' } }, body)).toEqual([{ field: 'entry.out.currency', code: 'closedCurrencyCurrent' }]);
    expect(issuesFromServer({ status: 400, code: 'CLOSED_CURRENCY_ACK_REQUIRED', details: { direction: 'out' } }, body)).toEqual([{ field: 'entry.out.closedAck', code: 'ackRequired' }]);
    expect(issuesFromServer({ status: 400, code: 'ENTRY_SHAPE', details: { rule: 'own_entries' } }, body)).toEqual([{ field: 'form', code: 'shape', detail: 'own_entries' }]);
    expect(issuesFromServer({ status: 400, code: 'CONFIRMED_DOMESTIC' }, body)).toEqual([{ field: 'form', code: 'confirmedDomestic' }]);
  });

  it('answers that are not about fields are left to the caller', () => {
    for (const code of ['NOT_FOUND', 'IDEMPOTENCY_CONFLICT', 'CONCURRENT_CHANGE', 'INTERNAL']) expect(issuesFromServer({ status: 409, code }, body)).toBeNull();
  });
});
