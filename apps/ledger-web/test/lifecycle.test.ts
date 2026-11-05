import { canonicalRequestV1, type EntryFacts, type EventFacts, type TransactionEntryDto } from '@xui/ledger-shared';
import { describe, expect, it } from 'vitest';
import { buildSettlementRequest, buildSnapshotRequest, buildVoidRequest, diffVersions, pendingEntries, previewSnapshotClassification, snapshotChanges } from '../src/lib/lifecycle.ts';

const entry = (over: Partial<TransactionEntryDto>): TransactionEntryDto => ({
  entryId: `e-${over.direction ?? 'out'}`,
  direction: 'out',
  accountId: 'hk',
  currency: 'HKD',
  currencyExponent: 2,
  amount: null,
  amountStatus: 'pending',
  fundingAccountCountry: 'HK',
  countrySource: 'account_at_save',
  currencyStatusAtSave: 'active',
  closedCurrencyAck: false,
  carriedFromEntryId: null,
  account: { id: 'hk', name: 'HK account', accountCountry: 'HK', status: 'active' },
  ...over,
});
const event = (over: Partial<EventFacts> = {}): EventFacts => ({
  eventId: 'ev1',
  revision: 1,
  revisionKind: 'original',
  correctionReason: null,
  recordMode: 'current',
  occurredOn: '2026-10-20',
  occurredTime: null,
  postedOn: null,
  eventCurrency: 'USD',
  eventAmount: 1000,
  eventCurrencyExponent: 2,
  merchantName: 'Contoso',
  merchantCountry: 'US',
  cardId: null,
  paymentChannelId: null,
  transferMethod: null,
  counterparty: null,
  homeRegion: 'CN',
  homeRegionSource: 'preference_at_save',
  merchantScope: 'foreign',
  transferScope: null,
  foreignStatus: 'foreign',
  classifierVersion: 1,
  createdAt: 1,
  ...over,
});

describe('settlement', () => {
  const own = [entry({ direction: 'out' }), entry({ direction: 'in', entryId: 'e-in', accountId: 'us', currency: 'USD', fundingAccountCountry: 'US', account: { id: 'us', name: 'US', accountCountry: 'US', status: 'active' } })];

  it('only pending entries can be settled; a confirmed one is never offered', () => {
    expect(pendingEntries([entry({ amountStatus: 'confirmed', amount: 5 }), entry({ direction: 'in' })]).map((e) => e.direction)).toEqual(['in']);
    const r = buildSettlementRequest([entry({ amountStatus: 'confirmed', amount: 5 })], { out: { selected: true, amountText: '9' } }, { baseRevision: 1, reason: '' });
    expect(r).toEqual({ ok: false, issues: [{ field: 'form', code: 'noneSelected' }] });
  });

  it('one side of a two-sided pending own transfer', () => {
    const r = buildSettlementRequest(own, { out: { selected: true, amountText: '1000.5' }, in: { selected: false, amountText: '' } }, { baseRevision: 3, reason: '  ' });
    expect(r).toEqual({ ok: true, body: { kind: 'settlement', baseRevision: 3, reason: null, entries: [{ direction: 'out', amount: 100050 }] } });
  });

  it('both sides; amounts parsed with each entry’s SAVED exponent', () => {
    const jpy = [entry({ direction: 'out', currency: 'JPY', currencyExponent: 0 }), entry({ direction: 'in', entryId: 'e-in', currency: 'BHD', currencyExponent: 3 })];
    const r = buildSettlementRequest(jpy, { out: { selected: true, amountText: '1500' }, in: { selected: true, amountText: '1.234' } }, { baseRevision: 1, reason: '对账单到了' });
    expect(r.ok && r.body.entries).toEqual([
      { direction: 'out', amount: 1500 },
      { direction: 'in', amount: 1234 },
    ]);
    expect(r.ok && r.body.reason).toBe('对账单到了');
    expect(buildSettlementRequest(jpy, { out: { selected: true, amountText: '1500.5' } }, { baseRevision: 1, reason: '' })).toEqual({ ok: false, issues: [{ field: 'entry.out.amount', code: 'scale' }] });
  });

  it('a closed currency carried on the same account needs no acknowledgement (nothing to send for it)', () => {
    const closed = [entry({ currency: 'EUR', currencyStatusAtSave: 'closed', closedCurrencyAck: true })];
    const r = buildSettlementRequest(closed, { out: { selected: true, amountText: '18.40' } }, { baseRevision: 2, reason: '' });
    expect(r).toEqual({ ok: true, body: { kind: 'settlement', baseRevision: 2, reason: null, entries: [{ direction: 'out', amount: 1840 }] } });
  });

  it('empty or bad amounts and sensitive reasons are reported', () => {
    expect(buildSettlementRequest(own, { out: { selected: true, amountText: '' } }, { baseRevision: 1, reason: '' })).toEqual({ ok: false, issues: [{ field: 'entry.out.amount', code: 'empty' }] });
    expect(buildSettlementRequest(own, { out: { selected: true, amountText: '0' } }, { baseRevision: 1, reason: '' })).toEqual({ ok: false, issues: [{ field: 'entry.out.amount', code: 'zero' }] });
    const s = buildSettlementRequest(own, { out: { selected: true, amountText: '1' } }, { baseRevision: 1, reason: '4111 1111 1111 1111' });
    expect(s).toEqual({ ok: false, issues: [{ field: 'reason', code: 'sensitive', detail: 'card_number' }] });
  });

  it('a rebase is new content (a new key)', () => {
    const a = buildSettlementRequest(own, { out: { selected: true, amountText: '1' } }, { baseRevision: 1, reason: '' });
    const b = buildSettlementRequest(own, { out: { selected: true, amountText: '1' } }, { baseRevision: 2, reason: '' });
    expect(a.ok && b.ok && canonicalRequestV1('transaction.correct', 't', a.body) !== canonicalRequestV1('transaction.correct', 't', b.body)).toBe(true);
  });
});

describe('snapshot correction', () => {
  const entries = [entry({ amountStatus: 'confirmed', amount: 7830 })];
  it('only changed values are sent; nothing changed is refused before sending', () => {
    expect(snapshotChanges(event(), entries, { homeRegion: 'CN', countries: { out: 'HK' } })).toEqual({ homeRegion: null, entries: [] });
    expect(buildSnapshotRequest(event(), entries, { homeRegion: 'CN', countries: {} }, { baseRevision: 1, reason: 'x' })).toEqual({ ok: false, issues: [{ field: 'form', code: 'noSnapshotChange' }] });
    const r = buildSnapshotRequest(event(), entries, { homeRegion: 'HK', countries: { out: 'SG' } }, { baseRevision: 2, reason: ' 当时记录错了 ' });
    expect(r).toEqual({ ok: true, body: { kind: 'snapshot_correction', baseRevision: 2, reason: '当时记录错了', homeRegion: 'HK', entries: [{ direction: 'out', fundingAccountCountry: 'SG' }] } });
  });

  it('the reason is required', () => {
    expect(buildSnapshotRequest(event(), entries, { homeRegion: 'HK', countries: {} }, { baseRevision: 1, reason: '  ' })).toEqual({ ok: false, issues: [{ field: 'reason', code: 'required' }] });
  });

  it('the preview runs the shared classify(): a home region equal to every side is confirmed domestic', () => {
    // HK account at a US merchant, home CN → foreign. Home HK: still foreign (merchant US).
    expect(previewSnapshotClassification('merchant_spend', event(), entries, { homeRegion: 'HK', countries: {} })).toMatchObject({ foreignStatus: 'foreign', merchantScope: 'foreign' });
    // HK account at an HK merchant: home HK → confirmed domestic (the server will refuse it).
    expect(previewSnapshotClassification('merchant_spend', event({ merchantCountry: 'HK' }), entries, { homeRegion: 'HK', countries: {} })).toMatchObject({ foreignStatus: 'domestic', merchantScope: 'domestic' });
    // The account's jurisdiction snapshot corrected to CN at an unknown merchant: undetermined.
    expect(previewSnapshotClassification('merchant_spend', event({ merchantCountry: null }), entries, { homeRegion: null, countries: { out: 'CN' } })).toMatchObject({ foreignStatus: 'undetermined', merchantScope: 'unknown' });
    // A transfer: the counterparty side comes from the saved counterparty.
    const transfer = event({ merchantCountry: null, merchantName: null, merchantScope: null, transferScope: 'outbound', counterparty: { kind: 'third_party', name: 'N', country: 'GB', institution: null, accountHint: null } });
    expect(previewSnapshotClassification('third_party_transfer', transfer, [entry({ fundingAccountCountry: 'CN' })], { homeRegion: null, countries: {} })).toMatchObject({ transferScope: 'outbound', foreignStatus: 'foreign' });
  });
});

describe('void', () => {
  it('needs the explicit confirmation; the reason is optional', () => {
    expect(buildVoidRequest({ baseRevision: 2, reason: '', confirmed: false })).toEqual({ ok: false, issues: [{ field: 'confirm', code: 'required' }] });
    expect(buildVoidRequest({ baseRevision: 2, reason: ' ', confirmed: true })).toEqual({ ok: true, body: { baseRevision: 2, reason: null } });
    expect(buildVoidRequest({ baseRevision: 2, reason: '重复记录', confirmed: true })).toEqual({ ok: true, body: { baseRevision: 2, reason: '重复记录' } });
    expect(buildVoidRequest({ baseRevision: 2, reason: 'x'.repeat(201), confirmed: true }).ok).toBe(false);
  });
});

describe('what changed between two versions', () => {
  it('lists the changed facts and entries, nothing else', () => {
    const base = { revision: 1, event: event(), entries: [entry({ amountStatus: 'confirmed', amount: 7830 })] };
    const current = { revision: 2, event: event({ revision: 2, occurredOn: '2026-10-21', merchantName: 'Contoso Ltd' }), entries: [entry({ amountStatus: 'confirmed', amount: 7850 })] };
    expect(diffVersions(base, current)).toEqual([
      { field: 'occurredOn', before: '2026-10-20', after: '2026-10-21' },
      { field: 'merchant', before: 'Contoso', after: 'Contoso Ltd' },
      { field: 'entry.out', before: 'HK account · HKD 78.30 · HK', after: 'HK account · HKD 78.50 · HK' },
    ]);
    expect(diffVersions(base, { ...base, revision: 2 })).toEqual([]);
  });

  it('a pending amount and a snapshot change are shown', () => {
    const base = { revision: 1, event: event(), entries: [entry({})] };
    const current = { revision: 2, event: event({ homeRegion: 'HK' }), entries: [entry({ fundingAccountCountry: 'SG' })] };
    expect(diffVersions(base, current)).toEqual([
      { field: 'homeRegion', before: 'CN', after: 'HK' },
      { field: 'entry.out', before: 'HK account · HKD … · HK', after: 'HK account · HKD … · SG' },
    ]);
  });
});

export type { EntryFacts };
