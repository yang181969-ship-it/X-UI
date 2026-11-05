import { canonicalRequestV1, factCorrectionSchema, IDEMPOTENCY_KEY_HEADER, type EntryFacts, type EventFacts } from '@xui/ledger-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { updateTransactionNotes } from '../src/api/transactions.ts';
import { listPendingWrites, preparePendingWrite, slotOf, syncPendingWrite, type StorageLike } from '../src/lib/pendingWrite.ts';
import { buildFactCorrectionRequest, draftFromFactBody, draftFromVersion, issuesFromServer, UNKNOWN_REGION, type CurrencyStatusLookup } from '../src/lib/txnDraft.ts';

const NOW = Date.UTC(2026, 10, 5, 12);
// hk: HKD / USD active, EUR closed; us: USD.
const table: Record<string, Record<string, 'active' | 'closed'>> = { hk: { HKD: 'active', USD: 'active', EUR: 'closed' }, us: { USD: 'active' } };
const currencyStatus: CurrencyStatusLookup = (a, c) => (table[a] ? (table[a]![c] ?? null) : undefined);

const event = (over: Partial<EventFacts> = {}): EventFacts => ({
  eventId: 'ev',
  revision: 2,
  revisionKind: 'original',
  correctionReason: null,
  recordMode: 'backfill',
  occurredOn: '2026-10-20',
  occurredTime: '14:05',
  postedOn: null,
  eventCurrency: 'USD',
  eventAmount: 1000,
  eventCurrencyExponent: 2,
  merchantName: 'Contoso',
  merchantCountry: 'US',
  cardId: 'card-1',
  paymentChannelId: null,
  transferMethod: null,
  counterparty: null,
  homeRegion: 'HK',
  homeRegionSource: 'user_declared',
  merchantScope: 'foreign',
  transferScope: null,
  foreignStatus: 'foreign',
  classifierVersion: 1,
  createdAt: 1,
  ...over,
});
const savedEntry = (over: Partial<EntryFacts> = {}): EntryFacts => ({
  entryId: 'e1',
  direction: 'out',
  accountId: 'hk',
  currency: 'EUR',
  currencyExponent: 2,
  amount: 1840,
  amountStatus: 'confirmed',
  fundingAccountCountry: 'HK',
  countrySource: 'account_at_save',
  currencyStatusAtSave: 'closed',
  closedCurrencyAck: true,
  carriedFromEntryId: null,
  ...over,
});
const entries = [savedEntry()];
const carried = (a: string, c: string) => entries.some((e) => e.accountId === a && e.currency === c);
const ctx = (over = {}) => ({ now: NOW, currencyStatus, carried, baseRevision: 2, reason: '金额录错', ...over });

describe('fact correction request', () => {
  it('starts from the saved version; no type, declaredHomeRegion or notes; recordMode always explicit (a backfill stays a backfill)', () => {
    const d = draftFromVersion('merchant_spend', event(), entries);
    const r = buildFactCorrectionRequest({ ...d, entries: { ...d.entries, out: { ...d.entries.out, amountText: '18.50' } } }, ctx());
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.body).toMatchObject({ kind: 'fact_correction', baseRevision: 2, reason: '金额录错', recordMode: 'backfill', merchantCountry: 'US', cardId: 'card-1', occurredTime: '14:05' });
    expect(r.body).not.toHaveProperty('type');
    expect(r.body).not.toHaveProperty('declaredHomeRegion');
    expect(r.body).not.toHaveProperty('notes');
    expect(r.body.entries).toEqual([{ direction: 'out', accountId: 'hk', currency: 'EUR', amountStatus: 'confirmed', amount: 1850, closedCurrencyAck: false }]);
    expect(factCorrectionSchema.parse(r.body)).toEqual(r.body);
  });

  it('the reason is required and scanned', () => {
    const d = draftFromVersion('merchant_spend', event(), entries);
    expect(buildFactCorrectionRequest(d, ctx({ reason: '  ' }))).toEqual({ ok: false, issues: [{ field: 'reason', code: 'required' }] });
    expect(buildFactCorrectionRequest(d, ctx({ reason: 'CVV 123' }))).toEqual({ ok: false, issues: [{ field: 'reason', code: 'sensitive', detail: 'secret_code' }] });
  });

  it('a same-account same-currency closed currency is a lawful carry-over in any mode; a new use of it follows the create rules', () => {
    const d = draftFromVersion('merchant_spend', event({ recordMode: 'current' }), entries);
    expect(buildFactCorrectionRequest(d, ctx()).ok).toBe(true); // carried EUR on hk, current mode, no ack
    const otherAccount = { ...d, entries: { ...d.entries, out: { ...d.entries.out, accountId: 'us', currency: 'USD' } } };
    expect(buildFactCorrectionRequest(otherAccount, ctx()).ok).toBe(true); // a new account: its snapshot is read when saved
    const notCarried = buildFactCorrectionRequest({ ...d, entries: { ...d.entries, out: { ...d.entries.out, accountId: 'hk', currency: 'EUR' } } }, ctx({ carried: () => false }));
    expect(notCarried).toEqual({ ok: false, issues: [{ field: 'entry.out.currency', code: 'closedCurrencyCurrent' }] });
  });

  it('a rebase changes the request (new key); an unchanged draft builds the same request (same key)', () => {
    const d = draftFromVersion('merchant_spend', event(), entries);
    const a = buildFactCorrectionRequest(d, ctx());
    const b = buildFactCorrectionRequest(d, ctx());
    const c = buildFactCorrectionRequest(d, ctx({ baseRevision: 3 }));
    if (!a.ok || !b.ok || !c.ok) throw new Error('build');
    expect(canonicalRequestV1('transaction.correct', 't1', a.body)).toBe(canonicalRequestV1('transaction.correct', 't1', b.body));
    expect(canonicalRequestV1('transaction.correct', 't1', c.body)).not.toBe(canonicalRequestV1('transaction.correct', 't1', a.body));
  });

  it('a restored correction body rebuilds exactly the same request', () => {
    const d = draftFromVersion('merchant_spend', event({ merchantCountry: null }), entries);
    expect(d.merchantCountry).toBe(UNKNOWN_REGION);
    const a = buildFactCorrectionRequest({ ...d, occurredOn: '2026-10-19' }, ctx());
    if (!a.ok) throw new Error('build');
    const again = buildFactCorrectionRequest(draftFromFactBody(a.body, 'merchant_spend'), ctx());
    expect(again.ok && canonicalRequestV1('transaction.correct', 't1', again.body)).toBe(canonicalRequestV1('transaction.correct', 't1', a.body));
  });

  it('a two-registered-sides own transfer drops the DTO’s empty counterparty object', () => {
    const own = event({ merchantName: null, merchantCountry: null, cardId: null, merchantScope: null, transferScope: 'foreign_cross_border', eventCurrency: 'HKD', eventAmount: 100000, counterparty: { kind: 'self', name: null, country: null, institution: null, accountHint: null } });
    const two = [savedEntry({ currency: 'HKD', amount: 100000, currencyStatusAtSave: 'active', closedCurrencyAck: false }), savedEntry({ entryId: 'e2', direction: 'in', accountId: 'us', currency: 'USD', amount: 12800, fundingAccountCountry: 'US', currencyStatusAtSave: 'active', closedCurrencyAck: false })];
    const r = buildFactCorrectionRequest(draftFromVersion('own_transfer', own, two), ctx({ carried: () => true }));
    expect(r.ok && r.body.counterparty).toBeNull();
    expect(r.ok && r.body.entries.length).toBe(2);
  });

  it('the server’s "no fact changed" (VALIDATION on the whole request) and other answers map back', () => {
    expect(issuesFromServer({ status: 400, code: 'VALIDATION', details: [{ code: 'custom', path: [], message: 'the correction does not change any fact' }] }, { entries: [] }, true)).toEqual([{ field: 'form', code: 'noChange' }]);
    expect(issuesFromServer({ status: 400, code: 'VALIDATION', details: [{ path: [], message: 'x' }] }, { entries: [] }, false)).toEqual([{ field: 'form', code: 'invalid', detail: 'x' }]);
    expect(issuesFromServer({ status: 400, code: 'VALIDATION', details: [{ path: ['entries', 0, 'direction'], message: 'not pending' }] }, { entries: [{ direction: 'in' }] }, true)).toEqual([{ field: 'entry.in.direction', code: 'invalid', detail: 'not pending' }]);
    expect(issuesFromServer({ status: 400, code: 'CONFIRMED_DOMESTIC', details: { suggestion: 'void' } }, { entries: [] }, true)).toEqual([{ field: 'form', code: 'confirmedDomestic' }]);
    expect(issuesFromServer({ status: 400, code: 'SENSITIVE_DATA', details: { fields: [{ field: 'reason', kind: 'card_number' }] } }, { entries: [] }, true)).toEqual([{ field: 'reason', code: 'sensitive', detail: 'card_number' }]);
  });
});

class MemoryStorage implements StorageLike {
  map = new Map<string, string>();
  getItem = (k: string) => this.map.get(k) ?? null;
  setItem = (k: string, v: string) => void this.map.set(k, v);
  removeItem = (k: string) => void this.map.delete(k);
  key = (i: number) => [...this.map.keys()][i] ?? null;
  get length() {
    return this.map.size;
  }
}

describe('pending writes are isolated by operation and transaction', () => {
  it('create, correct and void of different transactions never share a key or a stored record', () => {
    const storage = new MemoryStorage();
    let n = 0;
    const deps = { now: () => 1, uuid: () => `key-${String(++n).padStart(16, '0')}` };
    const make = (operation: 'transaction.create' | 'transaction.correct' | 'transaction.void', transactionId: string | null, body: unknown) => {
      const r = preparePendingWrite(null, { userId: 'u1', operation, transactionId, body }, deps);
      if (!r.ok) throw new Error('locked');
      return { ...r.pending, state: 'unknown' as const };
    };
    const voidBody = { baseRevision: 1, reason: null };
    const writes = [make('transaction.create', null, { a: 1 }), make('transaction.correct', 't1', { kind: 'settlement' }), make('transaction.void', 't1', voidBody), make('transaction.void', 't2', voidBody)];
    for (const w of writes) syncPendingWrite(storage, 'u1', slotOf(w.operation, w.transactionId), w);
    expect(storage.length).toBe(4);
    expect(new Set(writes.map((w) => w.key)).size).toBe(4);
    expect(listPendingWrites(storage, 'u1').map((w) => `${w.operation}:${w.transactionId}`)).toEqual(['transaction.create:null', 'transaction.correct:t1', 'transaction.void:t1', 'transaction.void:t2']);
    // The same void body for another transaction is another request (the path id is hashed).
    expect(canonicalRequestV1('transaction.void', 't1', voidBody)).not.toBe(canonicalRequestV1('transaction.void', 't2', voidBody));
    // A void prepared after an unknown correction of the same transaction is not locked by it.
    expect(preparePendingWrite(writes[2]!, { userId: 'u1', operation: 'transaction.void', transactionId: 't1', body: { baseRevision: 2, reason: null } }, deps)).toMatchObject({ ok: false, reason: 'unknown_outcome' });
    expect(preparePendingWrite(writes[1]!, { userId: 'u1', operation: 'transaction.void', transactionId: 't1', body: voidBody }, deps).ok).toBe(true);
  });
});

describe('notes stay apart from financial writes', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('PATCH /notes carries no Idempotency-Key and stores nothing', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ id: 't1', notes: 'x', updatedAt: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    await updateTransactionNotes('t1', 'x');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/transactions/t1/notes');
    expect(calls[0]!.init.method).toBe('PATCH');
    expect((calls[0]!.init.headers as Record<string, string>)[IDEMPOTENCY_KEY_HEADER]).toBeUndefined();
    expect(calls[0]!.init.body).toBe(JSON.stringify({ notes: 'x' }));
  });
});
