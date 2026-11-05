// M3-B3-C: POST /transactions/:id/revisions — the three kinds and their rules (API_SPEC §5.7,
// §5.7.1 – §5.7.3; DATA_MODEL §10.9, §10.10): TEST_PLAN COR-1, COR-2, COR-3, COR-5, COR-9, COR-10,
// REG-5, BF-4, BF-8, HRD-4, ISO-1 / ISO-2 (corrections), IMM (history never changes). Idempotency,
// concurrency and injected failures are in transactions-correct-writes.test.ts. Every case runs on
// libsql and on wrangler's local in-memory D1 through the real HTTP app. All data is fictional.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nid } from './m3-ledger.ts';
import { factOf, ledgerDump, newKey, ownTransfer, seedUser, spend, startEngine, type Engine, type Seed } from './transactions-kit.ts';

type Body = Record<string, unknown>;
type Json = any;

const DAY = 86_400_000;

describe.each(['libsql', 'd1'] as const)('POST /transactions/:id/revisions on %s', (engine) => {
  let e: Engine;
  beforeAll(async () => {
    e = await startEngine(engine, 'xui-v1-txn-correct-d1');
  }, 180_000);
  afterAll(async () => {
    await e?.dispose();
  });
  beforeEach(() => e.ping());
  afterEach(() => vi.restoreAllMocks());

  const made = async (s: Seed, body: Body = spend(s), key = newKey()): Promise<Json> => {
    const r = await s.post(body, key);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json;
  };
  const corrected = async (s: Seed, T: string, body: Body, key = newKey()): Promise<Json> => {
    const r = await s.correct(T, body, key);
    expect([r.status, r.res.headers.get('idempotency-replayed')], JSON.stringify(r.json)).toEqual([201, null]);
    return r.json;
  };
  const header = async (T: string) => (await e.all('SELECT * FROM transactions WHERE id = ?', T))[0]!;
  /** Every stored row of one version (event + entries) — must never change once published. */
  const versionRows = async (eventId: string) => ({
    event: await e.all('SELECT * FROM transaction_events WHERE id = ?', eventId),
    entries: await e.all('SELECT * FROM transaction_entries WHERE event_id = ? ORDER BY id', eventId),
  });
  const pending = (s: Seed, x: Body = {}) => spend(s, { entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'pending', amount: null }], ...x });
  const settle = (baseRevision: number, entries: Body[], x: Body = {}): Body => ({ kind: 'settlement', baseRevision, reason: null, entries, ...x });
  const snapshot = (baseRevision: number, x: Body): Body => ({ kind: 'snapshot_correction', baseRevision, reason: 'the snapshot was recorded wrongly', ...x });
  /** The facts of an event without what a new version always changes. */
  const facts = (ev: Json) => {
    const { eventId: _i, revision: _r, revisionKind: _k, correctionReason: _c, homeRegionSource: _h, createdAt: _t, ...rest } = ev;
    return rest;
  };

  // ================================================================== COR-1 settlement

  it('COR-1: a settlement turns the pending entry into a confirmed amount — 201, revision 2, every other field carried (facts, exponents, snapshot), version 1 unchanged; audit and a 30-day key in the batch', async () => {
    const s = await seedUser(e);
    const w = await made(s, pending(s));
    const T = w.transactionId as string;
    const v1 = await versionRows(w.eventId);
    e.t.advance(1_000);
    const now = e.t.clock.t;
    const key = newKey();
    const r = await corrected(s, T, settle(1, [{ direction: 'out', amount: 7830 }], { reason: 'statement arrived' }), key);
    expect(r).toMatchObject({ operation: 'transaction.correct', transactionId: T, txnType: 'merchant_spend', revision: 2, statusAfter: 'active', recordedAt: now, void: null });
    expect(r.event).toEqual({ ...w.event, eventId: r.eventId, revision: 2, revisionKind: 'settlement', correctionReason: 'statement arrived', homeRegionSource: 'carried', createdAt: now });
    expect(r.entries).toEqual([{ ...w.entries[0], entryId: r.entries[0].entryId, amount: 7830, amountStatus: 'confirmed', countrySource: 'carried', carriedFromEntryId: w.entries[0].entryId }]);
    expect(await header(T)).toMatchObject({ current_revision: 2, status: 'active', updated_at: now });
    expect(await versionRows(w.eventId)).toEqual(v1);
    const key0 = (await e.all('SELECT * FROM ledger_idempotency_keys WHERE user_id = ? AND key = ?', s.id, key))[0]!;
    expect(key0).toMatchObject({ operation: 'transaction.correct', transaction_id: T, result_revision: 2, result_event_id: r.eventId, response_status: 201, created_at: now, expires_at: now + 30 * DAY });
    const audit = (await e.all("SELECT * FROM audit_log WHERE user_id = ? AND action = 'transaction.correct'", s.id))[0]!;
    expect([audit.id, JSON.parse(String(audit.detail))]).toEqual([key0.audit_id, { id: T, eventId: r.eventId, revision: 2, kind: 'settlement' }]);
    // The pending original stays readable as version 1; the list and detail show version 2.
    expect((await s.api.get(`/api/transactions/${T}/revisions/1`)).json.entries[0]).toMatchObject({ amountStatus: 'pending', amount: null });
    expect((await s.api.get(`/api/transactions/${T}`)).json).toMatchObject({ currentRevision: 2, revisions: [{ revision: 1, revisionKind: 'original' }, { revision: 2, revisionKind: 'settlement', correctionReason: 'statement arrived' }] });
  });

  it('COR-1: an own transfer settles one side and keeps the other pending; only pending directions of version r can be listed; no fact can ride along; a missing Event amount (P8) is not settled', async () => {
    const s = await seedUser(e);
    const both = ownTransfer(s, {
      entries: [
        { direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'pending', amount: null },
        { direction: 'in', accountId: s.BE, currency: 'USD', amountStatus: 'pending', amount: null },
      ],
    });
    const w = await made(s, both);
    const T = w.transactionId as string;
    const r = await corrected(s, T, settle(1, [{ direction: 'in', amount: 99900 }]));
    expect(r.entries.map((en: Json) => [en.direction, en.amountStatus, en.amount, en.carriedFromEntryId])).toEqual([
      ['out', 'pending', null, w.entries[0].entryId],
      ['in', 'confirmed', 99900, w.entries[1].entryId],
    ]);
    expect(r.event.correctionReason).toBeNull();
    const before = await ledgerDump(e);
    const refused: [Body, string, unknown][] = [
      [settle(2, [{ direction: 'in', amount: 1 }]), 'VALIDATION', ['entries', 0, 'direction']], // already confirmed
      [settle(2, [{ direction: 'out', amount: 1 }, { direction: 'in', amount: 2 }]), 'VALIDATION', ['entries', 1, 'direction']],
      [settle(2, [{ direction: 'out', amount: 1 }], { occurredOn: '2026-10-01' }), 'VALIDATION', undefined],
      [settle(2, [{ direction: 'out', amount: 1, accountId: s.US }]), 'VALIDATION', undefined],
      [settle(2, [{ direction: 'out', amount: 0 }]), 'VALIDATION', undefined],
      [settle(2, []), 'VALIDATION', undefined],
    ];
    for (const [body, code, path] of refused) {
      const res = await s.correct(T, body);
      expect([res.status, res.json.code], JSON.stringify(body)).toEqual([400, code]);
      if (path) expect(res.json.details).toEqual([{ code: 'custom', path, message: expect.any(String) }]);
    }
    expect(await ledgerDump(e)).toEqual(before);
    // A spend has no 'in' entry.
    const sp = await made(s, pending(s));
    expect((await s.correct(sp.transactionId, settle(1, [{ direction: 'in', amount: 1 }]))).json.details[0].path).toEqual(['entries', 0, 'direction']);
    // P8: a third-party transfer received with an unknown Event amount keeps it unknown through a settlement.
    const inbound = await made(s, { type: 'third_party_transfer', occurredOn: '2026-10-14', eventCurrency: 'USD', eventAmount: null, transferMethod: 'swift', counterparty: { country: 'US' }, entries: [{ direction: 'in', accountId: s.HK, currency: 'USD', amountStatus: 'pending', amount: null }] });
    const settled = await corrected(s, inbound.transactionId, settle(1, [{ direction: 'in', amount: 12345 }]));
    expect([settled.event.eventAmount, settled.event.eventCurrency, settled.entries[0].amount]).toEqual([null, 'USD', 12345]);
    expect((await s.correct(inbound.transactionId, settle(2, [{ direction: 'in', amount: 1 }], { eventAmount: 1 }))).json.code).toBe('VALIDATION');
  });

  // ================================================================== COR-2 fact correction

  it('COR-2: a fact correction carries the snapshot of an account already in version r (even after the account changed), reads it for a new account, keeps the home region; reason and recordMode are required', async () => {
    const s = await seedUser(e);
    const body = spend(s);
    const w = await made(s, body);
    const T = w.transactionId as string;
    const v1 = await versionRows(w.eventId);
    // Later changes to the account and the setting must not reach the carried snapshots.
    await e.exec("UPDATE accounts SET account_country = 'SG' WHERE id = ?", s.HK);
    expect((await s.api.patch('/api/settings/profile', { homeRegion: 'HK' })).status).toBe(200);
    const r2 = await corrected(s, T, factOf(body, { merchantName: 'Corrected Store', entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 7900 }] }));
    expect(r2.event).toMatchObject({ revision: 2, revisionKind: 'fact_correction', correctionReason: 'facts were wrong', merchantName: 'Corrected Store', homeRegion: 'CN', homeRegionSource: 'carried', foreignStatus: 'foreign', classifierVersion: 1 });
    expect(r2.entries[0]).toMatchObject({ accountId: s.HK, amount: 7900, fundingAccountCountry: 'HK', countrySource: 'carried', carriedFromEntryId: w.entries[0].entryId, currencyExponent: 2 });
    // A new account: its jurisdiction at save time, not carried.
    const r3 = await corrected(s, T, factOf(body, { baseRevision: 2, merchantName: 'Corrected Store', entries: [{ direction: 'out', accountId: s.BE, currency: 'USD', amountStatus: 'confirmed', amount: 1000 }] }));
    expect(r3.entries[0]).toMatchObject({ accountId: s.BE, fundingAccountCountry: 'BE', countrySource: 'account_at_save', carriedFromEntryId: null });
    expect(r3.event).toMatchObject({ homeRegion: 'CN', homeRegionSource: 'carried' });
    expect(await versionRows(w.eventId)).toEqual(v1);
    // Required fields and the server-only / create-only ones (request-only 400s).
    for (const [x, path] of [[{ recordMode: undefined }, 'recordMode'], [{ reason: undefined }, 'reason'], [{ type: 'merchant_spend' }, ''], [{ notes: 'x' }, ''], [{ declaredHomeRegion: 'HK' }, ''], [{ homeRegion: 'HK' }, '']] as [Body, string][]) {
      const res = await s.correct(T, factOf(body, { baseRevision: 3, merchantName: 'Other', ...x }));
      expect([res.status, res.json.code], JSON.stringify(x)).toEqual([400, 'VALIDATION']);
      if (path) expect(JSON.stringify(res.json.details)).toContain(path);
    }
    expect((await header(T)).current_revision).toBe(3);
    // The classification uses the carried snapshot too: a CN-account spend at an unknown merchant is
    // undetermined; the account moving to HK afterwards (current: foreign) does not reclassify it.
    expect((await s.api.patch('/api/settings/profile', { homeRegion: 'CN' })).status).toBe(200);
    const cnBody = spend(s, { merchantCountry: null, eventCurrency: 'CNY', cardId: null, entries: [{ direction: 'out', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 100 }] });
    const cn = await made(s, cnBody);
    await e.exec("UPDATE accounts SET account_country = 'HK' WHERE id = ?", s.CN);
    const kept = await corrected(s, cn.transactionId, factOf(cnBody, { occurredTime: '07:30' }));
    expect([kept.event.foreignStatus, kept.entries[0].fundingAccountCountry, kept.entries[0].countrySource]).toEqual(['undetermined', 'CN', 'carried']);
  });

  it('COR-2: changing only the direction of an own transfer still carries both snapshots (matched by account); the stored type decides the Entry shape (400 ENTRY_SHAPE)', async () => {
    const s = await seedUser(e);
    const body = ownTransfer(s);
    const w = await made(s, body);
    const T = w.transactionId as string;
    const flipped = await corrected(s, T, factOf(body, {
      entries: [
        { direction: 'out', accountId: s.BE, currency: 'USD', amountStatus: 'confirmed', amount: 99900 },
        { direction: 'in', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 100000 },
      ],
    }));
    expect(flipped.entries.map((en: Json) => [en.direction, en.accountId, en.fundingAccountCountry, en.countrySource, en.carriedFromEntryId])).toEqual([
      ['out', s.BE, 'BE', 'carried', w.entries[1].entryId],
      ['in', s.HK, 'HK', 'carried', w.entries[0].entryId],
    ]);
    expect(flipped.event.transferScope).toBe('foreign_cross_border');
    const shape = await s.correct(T, factOf(body, { baseRevision: 2, entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 1 }, { direction: 'in', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 1 }] }));
    expect([shape.status, shape.json]).toEqual([400, { error: expect.any(String), code: 'ENTRY_SHAPE', details: { rule: 'own_entries' } }]);
    const sp = await made(s);
    const spendShape = await s.correct(sp.transactionId, factOf(spend(s), { entries: [{ direction: 'in', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 1 }] }));
    expect(spendShape.json).toMatchObject({ code: 'ENTRY_SHAPE', details: { rule: 'merchant_entries' } });
  });

  it('COR-2 / Q-B3-6: a correction that changes no frozen fact is 400 VALIDATION (path []) — whatever its reason, acknowledgement, entry order or the accounts’ current names and jurisdictions; any fact makes it a version', async () => {
    const s = await seedUser(e);
    const body = ownTransfer(s);
    const w = await made(s, body);
    const T = w.transactionId as string;
    await e.exec("UPDATE accounts SET account_country = 'SG' WHERE id = ?", s.BE);
    expect((await s.api.patch(`/api/accounts/${s.HK}`, { name: 'Renamed HK' })).status).toBe(200);
    const before = await ledgerDump(e);
    const reversed = [...(body.entries as Body[])].reverse();
    const sameFacts: Body[] = [
      factOf(body),
      factOf(body, { reason: 'another reason' }),
      factOf(body, { entries: reversed }),
      factOf(body, { entries: (body.entries as Body[]).map((en) => ({ ...en, closedCurrencyAck: true })) }),
      factOf(body, { counterparty: { name: null, country: null, institution: null, accountHint: null } }),
    ];
    for (const x of sameFacts) {
      const res = await s.correct(T, x);
      expect([res.status, res.json], JSON.stringify(x).slice(0, 80)).toEqual([400, { error: 'validation failed', code: 'VALIDATION', details: [{ code: 'custom', path: [], message: expect.any(String) }] }]);
    }
    expect(await ledgerDump(e)).toEqual(before);
    // Each single frozen fact is a change.
    const changes: Body[] = [{ recordMode: 'backfill' }, { occurredTime: '09:00' }, { postedOn: '2026-10-15' }, { transferMethod: 'fps' }, { eventAmount: 100001 }, { eventCurrency: 'HKD' }, { paymentChannelId: s.PP }];
    let r = 1;
    for (const x of changes) {
      const res = await corrected(s, T, factOf(body, { baseRevision: r, ...x }));
      expect(res.revision, JSON.stringify(x)).toBe(++r);
      body.recordMode = x.recordMode ?? body.recordMode; // keep each next correction against the latest facts
      Object.assign(body, x);
    }
    // An amount status and a counterparty hint (third party) are facts too.
    const tp = { type: 'third_party_transfer', occurredOn: '2026-10-14', eventCurrency: 'USD', eventAmount: 500, transferMethod: 'swift', counterparty: { name: 'Fictional Person', country: 'US' }, entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 520 }] };
    const t = await made(s, tp);
    await corrected(s, t.transactionId, factOf(tp, { counterparty: { name: 'Fictional Person', country: 'US', accountHint: '1234' } }));
    await corrected(s, t.transactionId, factOf(tp, { baseRevision: 2, counterparty: { name: 'Fictional Person', country: 'US', accountHint: '1234' }, entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'pending', amount: null }] }));
  });

  it('HRD-4 / BF-8: a declared home region is carried through a fact correction (also when recordMode turns to current); recordMode is kept as stated and changes only through a fact correction', async () => {
    const s = await seedUser(e);
    const body = spend(s, { recordMode: 'backfill', declaredHomeRegion: 'HK' });
    const w = await made(s, body);
    expect(w.event).toMatchObject({ homeRegion: 'HK', homeRegionSource: 'user_declared', recordMode: 'backfill' });
    const r = await corrected(s, w.transactionId, factOf(body, { recordMode: 'current', occurredTime: '09:00' }));
    expect(r.event).toMatchObject({ homeRegion: 'HK', homeRegionSource: 'carried', recordMode: 'current', occurredTime: '09:00' });
    // A settlement or snapshot correction can not change recordMode (no such field: 400).
    expect((await s.correct(w.transactionId, snapshot(2, { homeRegion: 'JP', recordMode: 'backfill' }))).json.code).toBe('VALIDATION');
    const back = await corrected(s, w.transactionId, factOf(body, { baseRevision: 2, recordMode: 'backfill', occurredTime: '09:00' }));
    expect(back.event).toMatchObject({ recordMode: 'backfill', homeRegion: 'HK' });
    // The classification follows the carried (declared) region, not the current setting (CN): an HK
    // account at a merchant of unknown country stays undetermined under HK (it would be foreign under CN).
    const unknown = spend(s, { recordMode: 'backfill', declaredHomeRegion: 'HK', merchantCountry: null });
    const u = await made(s, unknown);
    expect(u.event).toMatchObject({ homeRegion: 'HK', foreignStatus: 'undetermined' });
    expect((await corrected(s, u.transactionId, factOf(unknown, { occurredTime: '10:00' }))).event).toMatchObject({ homeRegion: 'HK', homeRegionSource: 'carried', foreignStatus: 'undetermined' });
  });

  // ================================================================== COR-3 snapshot correction (P5)

  it('COR-3: a snapshot correction sets the home region and / or an entry jurisdiction (user_corrected), reclassifies, keeps every fact and exponent; the rest is carried', async () => {
    const s = await seedUser(e);
    const w = await made(s, spend(s, { merchantCountry: 'SG' }));
    const T = w.transactionId as string;
    const v1 = await versionRows(w.eventId);
    const r2 = await corrected(s, T, snapshot(1, { homeRegion: 'SG' }));
    expect(facts(r2.event)).toEqual({ ...facts(w.event), homeRegion: 'SG', merchantScope: 'domestic', foreignStatus: 'foreign' });
    expect(r2.event).toMatchObject({ revisionKind: 'snapshot_correction', correctionReason: 'the snapshot was recorded wrongly', homeRegionSource: 'user_corrected' });
    expect(r2.entries).toEqual([{ ...w.entries[0], entryId: r2.entries[0].entryId, countrySource: 'carried', carriedFromEntryId: w.entries[0].entryId }]);
    const r3 = await corrected(s, T, snapshot(2, { entries: [{ direction: 'out', fundingAccountCountry: 'JP' }] }));
    expect(r3.event).toMatchObject({ homeRegion: 'SG', homeRegionSource: 'carried', merchantScope: 'domestic', foreignStatus: 'foreign' });
    expect(r3.entries[0]).toMatchObject({ fundingAccountCountry: 'JP', countrySource: 'user_corrected', carriedFromEntryId: r2.entries[0].entryId, amount: 7830, currencyExponent: 2 });
    expect(await versionRows(w.eventId)).toEqual(v1);
    // The same values, a missing direction, a fact riding along, no reason: refused, nothing written.
    const before = await ledgerDump(e);
    const refused: [Body, unknown][] = [
      [snapshot(3, { homeRegion: 'SG' }), ['homeRegion']],
      [snapshot(3, { entries: [{ direction: 'out', fundingAccountCountry: 'JP' }] }), ['entries', 0, 'fundingAccountCountry']],
      [snapshot(3, { entries: [{ direction: 'in', fundingAccountCountry: 'JP' }] }), ['entries', 0, 'direction']],
      [snapshot(3, { homeRegion: 'KR', merchantCountry: 'KR' }), undefined],
      [snapshot(3, { homeRegion: 'KR', reason: undefined }), undefined],
      [snapshot(3, {}), undefined],
    ];
    for (const [body, path] of refused) {
      const res = await s.correct(T, body);
      expect([res.status, res.json.code], JSON.stringify(body)).toEqual([400, 'VALIDATION']);
      if (path) expect(res.json.details).toEqual([{ code: 'custom', path, message: expect.any(String) }]);
    }
    expect(await ledgerDump(e)).toEqual(before);
    // A declared home region is corrected only this way.
    const d = await made(s, spend(s, { recordMode: 'backfill', declaredHomeRegion: 'HK' }));
    expect((await corrected(s, d.transactionId, snapshot(1, { homeRegion: 'JP' }))).event).toMatchObject({ homeRegion: 'JP', homeRegionSource: 'user_corrected', recordMode: 'backfill' });
  });

  it('REG-5: a fact or snapshot correction that would make a confirmed purely domestic version is 400 CONFIRMED_DOMESTIC with suggestion void; nothing is written', async () => {
    const s = await seedUser(e);
    const w = await made(s);
    const cnSpend = spend(s, { merchantCountry: 'HK', eventCurrency: 'CNY', cardId: null, entries: [{ direction: 'out', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 100 }] });
    const c = await made(s, cnSpend);
    const before = await ledgerDump(e);
    const domestic = { error: expect.any(String), code: 'CONFIRMED_DOMESTIC', details: { suggestion: 'void' } };
    const fact = await s.correct(w.transactionId, factOf(spend(s), { merchantCountry: 'CN', eventCurrency: 'CNY', cardId: null, entries: [{ direction: 'out', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 100 }] }));
    expect([fact.status, fact.json]).toEqual([400, domestic]);
    const snap = await s.correct(c.transactionId, snapshot(1, { homeRegion: 'HK', entries: [{ direction: 'out', fundingAccountCountry: 'HK' }] }));
    expect([snap.status, snap.json]).toEqual([400, domestic]);
    expect(await ledgerDump(e)).toEqual(before);
    // Unknown is not domestic: an unknown merchant with the home-region account is saved (undetermined).
    const u = await corrected(s, c.transactionId, factOf(cnSpend, { merchantCountry: null }));
    expect(u.event).toMatchObject({ foreignStatus: 'undetermined', merchantScope: 'unknown' });
  });

  // ================================================================== COR-5 order of the checks

  it('COR-5 / IDEM-13: 404 (another user’s, missing, unpublished) → 409 TRANSACTION_VOIDED (whatever baseRevision) → 409 REVISION_CONFLICT → the checks against version r (ENTRY_SHAPE before a foreign account’s 404)', async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    const body = spend(b);
    const wa = await made(a);
    const w = await made(b, body);
    const T = w.transactionId as string;
    const unpublished = `unpublished-${newKey()}`;
    await e.exec('INSERT INTO transactions (id, user_id, txn_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', unpublished, b.id, 'merchant_spend', 1, 1);
    const badShape = factOf(body, { entries: [{ direction: 'in', accountId: a.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 1 }] });
    const missing = await b.correct('no-such-transaction-000000', badShape);
    expect([missing.status, missing.json]).toEqual([404, { error: 'transaction not found', code: 'NOT_FOUND' }]);
    for (const id of [wa.transactionId, unpublished]) expect((await b.correct(id, badShape)).json).toEqual(missing.json);
    // Version r of b's own transaction: a stale baseRevision first, then the shape, then the foreign account.
    expect((await b.correct(T, { ...badShape, baseRevision: 4 })).json).toMatchObject({ code: 'REVISION_CONFLICT', details: { currentRevision: 1 } });
    expect((await b.correct(T, badShape)).json).toMatchObject({ code: 'ENTRY_SHAPE', details: { rule: 'merchant_entries' } });
    const foreignAccount = await b.correct(T, factOf(body, { entries: [{ direction: 'out', accountId: a.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 1 }] }));
    expect([foreignAccount.status, foreignAccount.json]).toEqual([404, { error: 'account not found', code: 'NOT_FOUND' }]);
    expect((await b.voidTx(T, { baseRevision: 1 })).status).toBe(200);
    for (const correction of [badShape, { ...badShape, baseRevision: 3 }, settle(1, [{ direction: 'out', amount: 1 }]), snapshot(9, { homeRegion: 'JP' })]) {
      const r = await b.correct(T, correction);
      expect([r.status, r.json.code, r.json.details], JSON.stringify(correction).slice(0, 60)).toEqual([409, 'TRANSACTION_VOIDED', undefined]);
    }
  });

  it('ISO-1 / ISO-2: another user’s transaction, account, card and channel are the same 404 as missing ones — no details, none of their ids, nothing written', async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    const wa = await made(a);
    const body = spend(b);
    const w = await made(b, body);
    const before = await ledgerDump(e);
    for (const correction of [factOf(spend(a)), settle(1, [{ direction: 'out', amount: 1 }]), snapshot(1, { homeRegion: 'JP' })]) {
      expect((await b.correct(wa.transactionId, correction)).json).toEqual({ error: 'transaction not found', code: 'NOT_FOUND' });
    }
    const pairs: [Body, Body][] = [
      [{ entries: [{ direction: 'out', accountId: a.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 1 }] }, { entries: [{ direction: 'out', accountId: 'no-such-account-0000000000', currency: 'HKD', amountStatus: 'confirmed', amount: 1 }] }],
      [{ cardId: a.K }, { cardId: 'no-such-card-000000000000' }],
      [{ paymentChannelId: a.PP }, { paymentChannelId: 'no-such-channel-0000000000' }],
    ];
    for (const [foreign, absent] of pairs) {
      const [x, y] = [await b.correct(w.transactionId, factOf(body, foreign)), await b.correct(w.transactionId, factOf(body, absent))];
      expect([x.status, x.json]).toEqual([404, y.json]);
      for (const id of [a.id, a.HK, a.K, a.PP]) expect(JSON.stringify(x.json)).not.toContain(id);
    }
    expect(await ledgerDump(e)).toEqual(before);
  });

  // ================================================================== COR-9 / BF-4 closed currencies

  it('COR-9 / Q-B3-3: carrying an entry in a currency closed since — settlement, snapshot and same-account same-currency fact corrections pass without a new acknowledgement; the acknowledgement is carried and normalized', async () => {
    const s = await seedUser(e);
    // A backfill in BE's closed GBP, acknowledged, amount pending.
    const body = spend(s, { cardId: null, recordMode: 'backfill', entries: [{ direction: 'out', accountId: s.BE, currency: 'GBP', amountStatus: 'pending', amount: null, closedCurrencyAck: true }] });
    const w = await made(s, body);
    const T = w.transactionId as string;
    expect(w.entries[0]).toMatchObject({ currencyStatusAtSave: 'closed', closedCurrencyAck: true });
    const r2 = await corrected(s, T, settle(1, [{ direction: 'out', amount: 500 }]));
    expect(r2.entries[0]).toMatchObject({ currencyStatusAtSave: 'closed', closedCurrencyAck: true, amount: 500 });
    // Reopened: the carried acknowledgement is normalized to false (status at save: active).
    await e.exec("UPDATE account_currencies SET status = 'active' WHERE account_id = ? AND currency = 'GBP'", s.BE);
    const r3 = await corrected(s, T, snapshot(2, { homeRegion: 'JP' }));
    expect(r3.entries[0]).toMatchObject({ currencyStatusAtSave: 'active', closedCurrencyAck: false });
    // Closed again: a current-mode fact correction on the same account and currency needs no acknowledgement.
    await e.exec("UPDATE account_currencies SET status = 'closed' WHERE account_id = ? AND currency = 'GBP'", s.BE);
    const r4 = await corrected(s, T, factOf(body, { baseRevision: 3, recordMode: 'current', entries: [{ direction: 'out', accountId: s.BE, currency: 'GBP', amountStatus: 'confirmed', amount: 510, closedCurrencyAck: false }] }));
    expect(r4.entries[0]).toMatchObject({ currencyStatusAtSave: 'closed', closedCurrencyAck: false, countrySource: 'carried', amount: 510 });
    expect(r4.event.recordMode).toBe('current');
    // A current transaction whose currency is closed afterwards: settled without acknowledgement.
    const c = await made(s, spend(s, { entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'pending', amount: null }] }));
    await e.exec("UPDATE account_currencies SET status = 'closed' WHERE account_id = ? AND currency = 'USD'", s.HK);
    expect((await corrected(s, c.transactionId, settle(1, [{ direction: 'out', amount: 1000 }]))).entries[0]).toMatchObject({ currencyStatusAtSave: 'closed', closedCurrencyAck: false });
  });

  it('BF-4 / COR-9: switching to another closed currency of the same account is no carry — current mode → 400 CURRENCY_NOT_ON_ACCOUNT (closed), backfill unacknowledged → 400 CLOSED_CURRENCY_ACK_REQUIRED, acknowledged → saved with the acknowledgement', async () => {
    const s = await seedUser(e);
    const body = spend(s, { cardId: null, entries: [{ direction: 'out', accountId: s.BE, currency: 'USD', amountStatus: 'confirmed', amount: 1000 }] });
    const w = await made(s, body);
    await e.exec("UPDATE account_currencies SET status = 'closed' WHERE account_id = ? AND currency = 'EUR'", s.BE);
    const eur = (x: Body = {}) => [{ direction: 'out', accountId: s.BE, currency: 'EUR', amountStatus: 'confirmed', amount: 900, ...x }];
    const before = await ledgerDump(e);
    expect((await s.correct(w.transactionId, factOf(body, { entries: eur() }))).json).toMatchObject({ code: 'CURRENCY_NOT_ON_ACCOUNT', details: { direction: 'out', currency: 'EUR', status: 'closed' } });
    expect((await s.correct(w.transactionId, factOf(body, { recordMode: 'backfill', entries: eur() }))).json).toMatchObject({ code: 'CLOSED_CURRENCY_ACK_REQUIRED', details: { direction: 'out' } });
    expect((await s.correct(w.transactionId, factOf(body, { entries: [{ direction: 'out', accountId: s.BE, currency: 'JPY', amountStatus: 'confirmed', amount: 1 }] }))).json).toMatchObject({ code: 'CURRENCY_NOT_ON_ACCOUNT', details: { status: null } });
    expect(await ledgerDump(e)).toEqual(before);
    const ok = await corrected(s, w.transactionId, factOf(body, { recordMode: 'backfill', entries: eur({ closedCurrencyAck: true }) }));
    expect(ok.entries[0]).toMatchObject({ currency: 'EUR', currencyStatusAtSave: 'closed', closedCurrencyAck: true, countrySource: 'carried', carriedFromEntryId: w.entries[0].entryId });
  });

  // ================================================================== IMM through the API

  it('IMM: through settlement → fact → snapshot correction → void, every published version keeps its rows exactly as written, versions stay contiguous, no unpublished residue appears (IMM-9), and each revision view is its version', async () => {
    const s = await seedUser(e);
    const body = ownTransfer(s, {
      entries: [
        { direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'pending', amount: null },
        { direction: 'in', accountId: s.BE, currency: 'USD', amountStatus: 'confirmed', amount: 99900 },
      ],
    });
    const w = await made(s, body);
    const T = w.transactionId as string;
    const written: [string, Awaited<ReturnType<typeof versionRows>>][] = [[w.eventId, await versionRows(w.eventId)]];
    const steps: Body[] = [
      settle(1, [{ direction: 'out', amount: 100000 }]),
      factOf(body, { baseRevision: 2, transferMethod: 'sepa', entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 100000 }, { direction: 'in', accountId: s.US, currency: 'USD', amountStatus: 'confirmed', amount: 99800 }] }),
      snapshot(3, { entries: [{ direction: 'in', fundingAccountCountry: 'GB' }] }),
    ];
    for (const step of steps) {
      const r = await corrected(s, T, step);
      written.push([r.eventId, await versionRows(r.eventId)]);
      for (const [id, rows] of written) expect(await versionRows(id)).toEqual(rows);
    }
    expect((await s.voidTx(T, { baseRevision: 4 })).status).toBe(200);
    for (const [id, rows] of written) expect(await versionRows(id)).toEqual(rows);
    expect((await e.all('SELECT revision FROM transaction_events WHERE transaction_id = ? ORDER BY revision', T)).map((x) => Number(x.revision))).toEqual([1, 2, 3, 4]);
    expect(await header(T)).toMatchObject({ current_revision: 4, status: 'voided' });
    const residue = await e.all(
      `SELECT (SELECT count(*) FROM transaction_events ev JOIN transactions t ON t.id = ev.transaction_id WHERE t.user_id = ? AND ev.revision > t.current_revision) AS events,
              (SELECT count(*) FROM transactions WHERE user_id = ? AND current_revision = 0) AS headers`,
      s.id, s.id,
    );
    expect(residue).toEqual([{ events: 0, headers: 0 }]);
    // The new account of version 3 was read at save time; version 4 carries it and corrects only its jurisdiction.
    const views = await Promise.all([1, 2, 3, 4].map(async (n) => (await s.api.get(`/api/transactions/${T}/revisions/${n}`)).json));
    expect(views.map((v) => [v.event.revisionKind, v.entries.map((en: Json) => `${en.direction}:${en.fundingAccountCountry}:${en.countrySource}`).join(',')])).toEqual([
      ['original', 'out:HK:account_at_save,in:BE:account_at_save'],
      ['settlement', 'out:HK:carried,in:BE:carried'],
      ['fact_correction', 'out:HK:carried,in:US:account_at_save'],
      ['snapshot_correction', 'out:HK:carried,in:GB:user_corrected'],
    ]);
    for (const [i, [id]] of written.entries()) expect(views[i].event.eventId).toBe(id);
  });

  // ================================================================== COR-10 exponents

  it('COR-10 / Q-B3-11: settlement and snapshot corrections copy the previous version’s exponents (even when they differ from the ISO table); a fact correction writes the current table’s', async () => {
    const s = await seedUser(e);
    // A published pending spend whose stored exponents (3) differ from today's ISO table (USD, HKD: 2), by raw SQL.
    const [T, E, N, now] = [nid('T'), nid('E'), nid('N'), e.t.clock.t];
    await e.exec('INSERT INTO transactions (id, user_id, txn_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', T, s.id, 'merchant_spend', now, now);
    await e.exec(
      `INSERT INTO transaction_events (id, user_id, transaction_id, txn_type, revision, revision_kind, record_mode, occurred_on, event_currency, event_amount, event_currency_exponent,
        merchant_name, merchant_country, home_region, home_region_source, merchant_scope, foreign_status, classifier_version, created_at)
       VALUES (?, ?, ?, 'merchant_spend', 1, 'original', 'current', '2026-10-14', 'USD', 1000, 3, 'Raw Store', 'US', 'CN', 'preference_at_save', 'foreign', 'foreign', 1, ?)`,
      E, s.id, T, now,
    );
    await e.exec(
      `INSERT INTO transaction_entries (id, user_id, event_id, txn_type, direction, funding_account_id, funding_currency, amount, amount_status, currency_exponent,
        funding_account_country, country_source, currency_status_at_save, closed_currency_ack, created_at)
       VALUES (?, ?, ?, 'merchant_spend', 'out', ?, 'HKD', NULL, 'pending', 3, 'HK', 'account_at_save', 'active', 0, ?)`,
      N, s.id, E, s.HK, now,
    );
    await e.exec('UPDATE transactions SET current_revision = 1, updated_at = ? WHERE id = ?', now, T);
    const st = await corrected(s, T, settle(1, [{ direction: 'out', amount: 78300 }]));
    expect([st.event.eventCurrencyExponent, st.entries[0].currencyExponent]).toEqual([3, 3]);
    const sn = await corrected(s, T, snapshot(2, { homeRegion: 'JP' }));
    expect([sn.event.eventCurrencyExponent, sn.entries[0].currencyExponent]).toEqual([3, 3]);
    const fa = await corrected(s, T, {
      kind: 'fact_correction', baseRevision: 3, reason: 'facts were wrong', recordMode: 'current', occurredOn: '2026-10-14', eventCurrency: 'USD', eventAmount: 1000,
      merchantName: 'Raw Store Corrected', merchantCountry: 'US', entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 7830 }],
    });
    expect([fa.event.eventCurrencyExponent, fa.entries[0].currencyExponent, fa.entries[0].countrySource]).toEqual([2, 2, 'carried']);
  });
});
