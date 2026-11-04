// M3-B2-B.1: POST /transactions — route-level idempotency, lost responses, concurrency, the
// controlled retry and the database-error / HTTP-error boundary (API_SPEC §5.0.3, §5.1; DATA_MODEL
// §10.10; TEST_PLAN IDEM-1/3/5/6/9/10/11/12, RTY-1/4, CC-1/2/4/7/8, FI, ISO-7). Every case runs on
// libsql and on wrangler's local in-memory D1 through the real HTTP app. All data is fictional.
import { REQUEST_HASHERS, requestHashV1, transactionCreateSchema, type RequestHasher } from '@xui/ledger-shared';
import { DrizzleQueryError } from 'drizzle-orm';
import { inspect } from 'node:util';
import { dbMessages as driverMessages } from '../src/lib/dbErrors.ts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  batchHooks,
  counts,
  driverError,
  entryRows,
  INTERNAL,
  keyRow,
  LEAKS,
  ledgerDump,
  newKey,
  NONE,
  ONE_SPEND,
  ownTransfer,
  quietly,
  raising,
  seedUser,
  spend,
  startEngine,
  type Engine,
  type Seed,
} from './transactions-kit.ts';

type Body = Record<string, unknown>;

describe.each(['libsql', 'd1'] as const)('POST /transactions idempotency and failures on %s', (engine) => {
  let e: Engine;
  beforeAll(async () => {
    e = await startEngine(engine, 'xui-v1-txn-idem-d1');
  }, 180_000);
  afterAll(async () => {
    await e?.dispose();
  });
  beforeEach(() => e.ping());
  afterEach(() => {
    vi.restoreAllMocks();
    delete e.t.deps.requestHash;
  });

  const expectNoLeak = (json: unknown) => expect(JSON.stringify(json)).not.toMatch(LEAKS);

  // ================================================================== the key (IDEM-1, IDEM-11)

  it('IDEM-1: a missing key is 400 IDEMPOTENCY_KEY_REQUIRED, a malformed one IDEMPOTENCY_KEY_INVALID — checked before the body; nothing written', async () => {
    const s = await seedUser(e);
    expect((await s.post(spend(s), null)).json.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await s.post({ junk: true }, null)).json.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await s.post(spend(s), '')).json.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    for (const bad of ['a'.repeat(15), 'a'.repeat(65), 'has space 0123456789', 'dotted.key.0123456789', 'plus+key+0123456789']) {
      const r = await s.post(spend(s), bad);
      expect([r.status, r.json.code], bad).toEqual([400, 'IDEMPOTENCY_KEY_INVALID']);
    }
    for (const good of ['a'.repeat(16), 'Z'.repeat(64)]) expect((await s.post(spend(s), good)).status).toBe(201);
    expect((await counts(e, s.id)).transactions).toBe(2);
  });

  it('IDEM-11 / Q1: checks of the request alone come before the key lookup; a valid different request with a used key is 409', async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    const key = newKey();
    const first = await a.post(spend(a), key);
    expect(first.status).toBe(201);
    const before = await ledgerDump(e);
    const tomorrow2 = new Date(e.t.clock.t + 2 * 86_400_000).toISOString().slice(0, 10);
    const cases: [Body, number, string][] = [
      [spend(a, { entries: [] }), 400, 'ENTRY_SHAPE'],
      [spend(a, { occurredOn: tomorrow2 }), 400, 'VALIDATION'],
      [spend(a, { unknownField: 1 }), 400, 'VALIDATION'],
      [spend(a, { merchantName: 'Shop 4111 1111 1111 1111' }), 400, 'SENSITIVE_DATA'],
      [spend(a, { eventAmount: 1001 }), 409, 'IDEMPOTENCY_CONFLICT'],
      // Lookup comes before ownership: a used key with another user's account is the caller's own 409.
      [spend(a, { cardId: null, entries: [{ direction: 'out', accountId: b.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 1 }] }), 409, 'IDEMPOTENCY_CONFLICT'],
    ];
    for (const [body, status, code] of cases) {
      const r = await a.post(body, key);
      expect([r.status, r.json.code], code).toEqual([status, code]);
      if (code === 'IDEMPOTENCY_CONFLICT') expect(r.json.details).toEqual({ operation: 'transaction.create', transactionId: first.json.transactionId });
    }
    // A fresh key: the shape problem is reported before the foreign account's 404.
    const shape = await a.post(spend(a, { cardId: null, entries: [{ direction: 'in', accountId: b.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 1 }] }));
    expect(shape.json.code).toBe('ENTRY_SHAPE');
    const notFound = await a.post(spend(a, { cardId: null, entries: [{ direction: 'out', accountId: b.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 1 }] }));
    expect(notFound.json.code).toBe('NOT_FOUND');
    expect(await ledgerDump(e)).toEqual(before);
  });

  // ================================================================== replay (IDEM-3, IDEM-5, IDEM-10)

  it('IDEM-3: a replay is 201 with Idempotency-Replayed: true and the exact response bytes of the first write — for the same and the normalized-equal request, also after the transaction’s mutable data and every name change', async () => {
    const s = await seedUser(e);
    const bodies = [ownTransfer(s, { notes: 'first notes' }), spend(s, { paymentChannelId: s.PP, notes: 'first notes' })];
    for (const body of bodies) {
      const key = newKey();
      const first = await s.postBytes(body, key);
      expect(first.status, first.text).toBe(201);
      expect(first.res.headers.get('idempotency-replayed')).toBeNull();
      const T = (JSON.parse(first.text) as { transactionId: string }).transactionId;
      const after = await counts(e, s.id);
      const asWritten = await ledgerDump(e);
      // The same request, and the same request normalized differently: keys and entries in reverse
      // order, omitted optional fields spelled out as null, the recordMode default written out.
      const reordered = Object.fromEntries(
        Object.entries({ ...body, entries: [...(body.entries as unknown[])].reverse(), occurredTime: body.occurredTime ?? null, postedOn: null, recordMode: 'current' }).reverse(),
      );
      const replays = [await s.postBytes(body, key), await s.postBytes(reordered, key)];
      // Mutable data of the transaction and of everything it names changes; the replay must not:
      // the header's notes (form ① of tx_update_guard, the only header change before M3-B3), the
      // account / card / channel names and statuses, an account's jurisdiction, the clock.
      await e.exec("UPDATE transactions SET notes = 'changed notes', updated_at = updated_at + 1 WHERE id = ?", T);
      expect((await s.api.patch(`/api/accounts/${s.HK}`, { name: 'Renamed account', status: 'frozen' })).status).toBe(200);
      await e.exec("UPDATE accounts SET account_country = 'SG' WHERE id = ?", s.BE);
      expect((await s.api.patch(`/api/cards/${s.K}`, { name: 'Renamed card', status: 'closed' })).status).toBe(200);
      expect((await s.api.patch(`/api/payment-channels/${s.PP}`, { name: `Renamed wallet ${key}`, status: 'archived' })).status).toBe(200);
      e.t.advance(60_000);
      replays.push(await s.postBytes(body, key));
      for (const r of replays) {
        expect([r.status, r.res.headers.get('idempotency-replayed')]).toEqual([201, 'true']);
        // The exact bytes, compared without parsing.
        expect(Buffer.from(r.bytes).equals(Buffer.from(first.bytes))).toBe(true);
        expect(r.text).toBe(first.text);
      }
      expect(first.text).not.toMatch(/notes|Renamed|currentRevision|"status"/);
      expect(JSON.parse(first.text)).toMatchObject({ revision: 1, statusAfter: 'active' });
      // No transaction, event, entry, audit or key row was added by any replay.
      expect(await counts(e, s.id)).toEqual(after);
      const now = await ledgerDump(e);
      expect({ ...now, transactions: [] }).toEqual({ ...asWritten, transactions: [] });
    }
  });

  it('IDEM-5 / IDEM-10: key order, entry order, omitted optional fields and explicit nulls are the same request; any value change is a 409 with only the caller’s data', async () => {
    const s = await seedUser(e);
    const key = newKey();
    const body = ownTransfer(s);
    const first = await s.post(body, key);
    // Reversed keys and entries, explicit nulls for omitted fields, recordMode default spelled out.
    const reordered = Object.fromEntries(Object.entries({ ...body, entries: [...(body.entries as unknown[])].reverse(), occurredTime: null, postedOn: null, notes: null, recordMode: 'current' }).reverse());
    const same = await s.post(reordered, key);
    expect([same.status, same.res.headers.get('idempotency-replayed')]).toEqual([201, 'true']);
    expect(same.json).toEqual(first.json);
    const variants: Body[] = [
      { ...body, eventAmount: 100001 },
      { ...body, occurredTime: '00:00' },
      { ...body, notes: 'a note' },
      { ...body, recordMode: 'backfill' },
      { ...body, entries: [(body.entries as Body[])[0], { ...(body.entries as Body[])[1], amount: 99901 }] },
    ];
    for (const v of variants) {
      const r = await s.post(v, key);
      expect([r.status, r.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
      expect(r.json.details).toEqual({ operation: 'transaction.create', transactionId: first.json.transactionId });
    }
    expect((await counts(e, s.id)).transactions).toBe(1);
    expect((await keyRow(e, s.id, key))!.request_hash).toBe(await requestHashV1('transaction.create', null, transactionCreateSchema.parse(body)));
  });

  it('IDEM-9: a stored key is compared with the hasher of its own hash_version — a v2 key still replays after the server is back on v1', async () => {
    const s = await seedUser(e);
    const v2: RequestHasher = async (op, id, body) => (await requestHashV1(op, id, { v2: true, body })).replace(/^./, 'f');
    e.t.deps.requestHash = { version: 2, hashers: { ...REQUEST_HASHERS, 2: v2 } };
    const key = newKey();
    const body = spend(s);
    const first = await s.post(body, key);
    expect(first.status).toBe(201);
    const row = await keyRow(e, s.id, key);
    expect(row).toMatchObject({ hash_version: 2, request_hash: await v2('transaction.create', null, transactionCreateSchema.parse(body)) });
    // Back on v1 (which knows v2): same request → replay, not a conflict; different → conflict.
    e.t.deps.requestHash = { version: 1, hashers: { ...REQUEST_HASHERS, 2: v2 } };
    const again = await s.post(body, key);
    expect([again.status, again.res.headers.get('idempotency-replayed')]).toEqual([201, 'true']);
    expect(again.json).toEqual(first.json);
    expect((await s.post({ ...body, eventAmount: 2 }, key)).json.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await counts(e, s.id)).transactions).toBe(1);
  });

  it('IDEM-12 / Q9: a key row with a hash_version the server does not know is a generic 500 — neither replay nor conflict, nothing written', async () => {
    const s = await seedUser(e);
    const key = newKey();
    const first = await s.post(spend(s), key);
    // A key row as a future server version would have written it (raw SQL; the row is immutable afterwards).
    const k2 = newKey();
    const row = (await keyRow(e, s.id, key))!;
    await e.exec(
      'INSERT INTO ledger_idempotency_keys (user_id, key, operation, request_hash, hash_version, op_id, transaction_id, result_revision, result_event_id, audit_id, response_status, created_at, expires_at) VALUES (?, ?, ?, ?, 99, ?, ?, ?, ?, ?, 201, ?, NULL)',
      s.id, k2, 'transaction.create', 'a'.repeat(64), 'op-future', first.json.transactionId, 1, first.json.eventId, row.audit_id, row.created_at,
    );
    const before = await ledgerDump(e);
    for (const body of [spend(s), spend(s, { eventAmount: 5 })]) {
      const r = await quietly(() => s.post(body, k2));
      expect([r.status, r.json]).toEqual([500, INTERNAL]);
      expect(r.res.headers.get('idempotency-replayed')).toBeNull();
    }
    expect(await ledgerDump(e)).toEqual(before);
  });

  // ================================================================== failures keep no key (IDEM-6, RTY-4, FI)

  it('IDEM-6 / RTY-4: a request that failed (400, 404, injected 500) stores no key; the same key then runs exactly once', async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    const key = newKey();
    expect((await a.post(spend(a, { merchantCountry: 'CN', eventCurrency: 'CNY', cardId: null, entries: [{ direction: 'out', accountId: a.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 1 }] }), key)).status).toBe(400);
    expect((await a.post(spend(a, { cardId: b.K }), key)).status).toBe(404);
    const injected = await raising(e, 'transactions', 'UPDATE', null, 'TEST_INJECTED_FAILURE', () => a.post(spend(a), key));
    expect([injected.status, injected.json]).toEqual([500, INTERNAL]);
    expect(await counts(e, a.id)).toEqual(NONE);
    const ok = await a.post(spend(a), key);
    expect([ok.status, ok.res.headers.get('idempotency-replayed')]).toEqual([201, null]);
    expect(await counts(e, a.id)).toEqual(ONE_SPEND);
  });

  it('FI: an injected failure at any step (header, event, each entry, publish, audit, key row) is a generic 500 and leaves the database unchanged; the same key then succeeds once', async () => {
    const s = await seedUser(e);
    const steps: [string, 'INSERT' | 'UPDATE', string | null][] = [
      ['transactions', 'INSERT', null],
      ['transaction_events', 'INSERT', null],
      ['transaction_entries', 'INSERT', "NEW.direction = 'out'"],
      ['transaction_entries', 'INSERT', "NEW.direction = 'in'"],
      ['transactions', 'UPDATE', null],
      ['audit_log', 'INSERT', "NEW.action = 'transaction.create'"],
      ['ledger_idempotency_keys', 'INSERT', null],
    ];
    for (const [table, event, when] of steps) {
      const key = newKey();
      const before = await ledgerDump(e);
      const r = await raising(e, table, event, when, 'TEST_INJECTED_FAILURE', () => s.post(ownTransfer(s), key));
      expect([r.status, r.json], `${table} ${when}`).toEqual([500, INTERNAL]);
      expect(await ledgerDump(e)).toEqual(before);
      const retry = await s.post(ownTransfer(s), key);
      expect(retry.status).toBe(201);
      expect(retry.res.headers.get('idempotency-replayed')).toBeNull();
    }
    expect((await counts(e, s.id)).transactions).toBe(steps.length);
  });

  // ================================================================== lost responses (RTY-1)

  it('RTY-1: committed but the response was lost (outcome unknown) — 500, no server-side re-run; the retry with the same key replays the first result', async () => {
    const s = await seedUser(e);
    const key = newKey();
    const lost = new Error('fetch failed: socket hang up');
    const spy = batchHooks(e, [{ after: async (err) => { if (!err) throw lost; } }]);
    const r = await quietly(() => s.post(spend(s), key));
    expect([r.status, r.json]).toEqual([500, INTERNAL]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    // It did commit: one transaction, one audit, one key row.
    expect(await counts(e, s.id)).toEqual(ONE_SPEND);
    const k = (await keyRow(e, s.id, key))!;
    const retry = await s.post(spend(s), key);
    expect([retry.status, retry.res.headers.get('idempotency-replayed')]).toEqual([201, 'true']);
    expect(retry.json).toMatchObject({ transactionId: k.transaction_id, eventId: k.result_event_id, revision: 1 });
    expect(await counts(e, s.id)).toEqual(ONE_SPEND);
  });

  // ================================================================== concurrency (CC-1, CC-2)

  it('CC-1 / CC-2: concurrent requests with one key — the same request: one write and one replay; different requests: one 201 and one 409', async () => {
    const s = await seedUser(e);
    const key = newKey();
    const rs = await Promise.all([s.post(spend(s), key), s.post(spend(s), key)]);
    expect(rs.map((r) => r.status)).toEqual([201, 201]);
    expect(rs.map((r) => r.res.headers.get('idempotency-replayed')).sort()).toEqual(['true', null].sort());
    expect(rs[0]!.json).toEqual(rs[1]!.json);
    expect(await counts(e, s.id)).toEqual(ONE_SPEND);

    const key2 = newKey();
    const [x, y] = await Promise.all([s.post(spend(s), key2), s.post(spend(s, { eventAmount: 1234 }), key2)]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect([x, y].find((r) => r.status === 409)!.json.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await counts(e, s.id)).transactions).toBe(2);
  });

  it('CC-1 with a forced overlap: both requests pass the key lookup, the database serializes them — gate G turns the second batch into a replay', async () => {
    const s = await seedUser(e);
    const key = newKey();
    let second: Promise<Awaited<ReturnType<Seed['post']>>> | undefined;
    // The first request's batch starts only after the second request has looked the key up too.
    const spy = batchHooks(e, [{ before: async () => { second = s.post(spend(s), key); await new Promise((r) => setTimeout(r, 50)); } }]);
    const first = await s.post(spend(s), key);
    const other = await second!;
    expect(spy).toHaveBeenCalledTimes(2);
    // Gate G makes the later batch write nothing (no error); without it the key's primary key would refuse it.
    expect(spy.mock.settledResults.map((r) => r.type)).toEqual(['fulfilled', 'fulfilled']);
    expect([first.status, other.status]).toEqual([201, 201]);
    expect([first.res.headers.get('idempotency-replayed'), other.res.headers.get('idempotency-replayed')].filter(Boolean)).toEqual(['true']);
    expect(first.json).toEqual(other.json);
    expect(await counts(e, s.id)).toEqual(ONE_SPEND);
  });

  // ================================================================== the controlled retry (CC-4, CC-7, CC-8)

  /** A CN-account spend at a merchant of unknown country: undetermined while the account is CN. */
  const unknownMerchant = (s: Seed) => spend(s, { merchantCountry: null, eventCurrency: 'CNY', cardId: null, entries: [{ direction: 'out', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 100 }] });

  it('CC-4: the account jurisdiction changes after the checks and changes the classification — C6 refuses, the source change is confirmed, one retry saves the new snapshot', async () => {
    const s = await seedUser(e);
    const key = newKey();
    const spy = batchHooks(e, [{ before: () => e.exec("UPDATE accounts SET account_country = 'HK' WHERE id = ?", s.CN) }]);
    const r = await s.post(unknownMerchant(s), key);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(r.json.event).toMatchObject({ foreignStatus: 'foreign', merchantScope: 'unknown' });
    expect(r.json.entries[0].fundingAccountCountry).toBe('HK');
    expect(await counts(e, s.id)).toEqual(ONE_SPEND);
    // Same key and hash as the first attempt; nothing of the first attempt remains.
    expect((await keyRow(e, s.id, key))!.request_hash).toBe(await requestHashV1('transaction.create', null, transactionCreateSchema.parse(unknownMerchant(s))));
    expect(Number((await e.all('SELECT count(*) AS n FROM audit_log WHERE user_id = ? AND action = ?', s.id, 'transaction.create'))[0]!.n)).toBe(1);
  });

  it('CC-4: a change that does not change the classification needs no retry (the snapshot is the value at save time); one that makes it domestic ends in 400 CONFIRMED_DOMESTIC', async () => {
    const s = await seedUser(e);
    let spy = batchHooks(e, [{ before: () => e.exec("UPDATE accounts SET account_country = 'SG' WHERE id = ?", s.HK) }]);
    const r = await s.post(spend(s));
    expect(r.status).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.json.entries[0].fundingAccountCountry).toBe('SG');
    spy.mockRestore();

    // A home-region change (CN → GB) that flips only the merchant side: still foreign (HK account),
    // so no retry — and merchant_scope follows the stored home region (row CHECK), not the checks' value.
    spy = batchHooks(e, [{ before: () => s.api.patch('/api/settings/profile', { homeRegion: 'GB' }) }]);
    const flipped = await s.post(spend(s, { merchantCountry: 'GB' }));
    expect(flipped.status, JSON.stringify(flipped.json)).toBe(201);
    expect(spy).toHaveBeenCalledTimes(2); // the transaction batch and the settings PATCH
    // No batch failed: the legitimate region change produced no false row-CHECK failure.
    expect(spy.mock.settledResults.map((r) => r.type)).toEqual(['fulfilled', 'fulfilled']);
    expect(flipped.json.event).toMatchObject({ homeRegion: 'GB', merchantCountry: 'GB', merchantScope: 'domestic', foreignStatus: 'foreign' });
    // Stored: home_region and merchant_scope from the same statement's snapshot.
    expect(await e.all('SELECT home_region, home_region_source, merchant_country, merchant_scope, foreign_status FROM transaction_events WHERE id = ?', flipped.json.eventId)).toEqual([
      { home_region: 'GB', home_region_source: 'preference_at_save', merchant_country: 'GB', merchant_scope: 'domestic', foreign_status: 'foreign' },
    ]);
    spy.mockRestore();
    await s.api.patch('/api/settings/profile', { homeRegion: 'CN' });

    // A home-region change: CN → SG with a SG account at a SG merchant would be domestic.
    await e.exec("UPDATE accounts SET account_country = 'SG' WHERE id = ?", s.US);
    spy = batchHooks(e, [{ before: () => s.api.patch('/api/settings/profile', { homeRegion: 'SG' }) }]);
    const before = await counts(e, s.id);
    const d = await s.post(spend(s, { merchantCountry: 'SG', cardId: null, entries: [{ direction: 'out', accountId: s.US, currency: 'USD', amountStatus: 'confirmed', amount: 1 }] }));
    expect([d.status, d.json.code]).toEqual([400, 'CONFIRMED_DOMESTIC']);
    expect(spy).toHaveBeenCalledTimes(2); // the settings PATCH is the other batch call
    // The transaction batch was refused by C6 (foreign_status re-derived from the stored snapshots),
    // not by the merchant_scope row CHECK; the retry's own checks then refused the domestic version.
    const refusal = spy.mock.settledResults[0]!;
    expect(refusal.type).toBe('rejected');
    expect(driverMessages(refusal.value).join(' | ')).toMatch(/LEDGER_CLASSIFICATION:/);
    expect(driverMessages(refusal.value).join(' | ')).not.toMatch(/CHECK constraint failed/);
    expect(await counts(e, s.id)).toEqual(before);
  });

  it('CC-7: a currency closed after the checks → retry → 400 CURRENCY_NOT_ON_ACCOUNT (closed); reopened during an acknowledged backfill → saved with ack 0; removed → 400 (status null)', async () => {
    const s = await seedUser(e);
    let spy = batchHooks(e, [{ before: () => e.exec("UPDATE account_currencies SET status = 'closed' WHERE account_id = ? AND currency = 'USD'", s.HK) }]);
    const closed = await s.post(spend(s, { entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 1000 }] }));
    expect([closed.status, closed.json.code, closed.json.details]).toEqual([400, 'CURRENCY_NOT_ON_ACCOUNT', { direction: 'out', currency: 'USD', status: 'closed' }]);
    expect(spy).toHaveBeenCalledTimes(1); // the retry's own checks refuse before writing
    spy.mockRestore();

    spy = batchHooks(e, [{ before: () => e.exec("UPDATE account_currencies SET status = 'active' WHERE account_id = ? AND currency = 'GBP'", s.BE) }]);
    const reopened = await s.post(spend(s, { cardId: null, recordMode: 'backfill', entries: [{ direction: 'out', accountId: s.BE, currency: 'GBP', amountStatus: 'confirmed', amount: 1, closedCurrencyAck: true }] }));
    expect(reopened.status, JSON.stringify(reopened.json)).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await entryRows(e, reopened.json.eventId))[0]).toMatchObject({ currency_status_at_save: 'active', closed_currency_ack: 0 });
    spy.mockRestore();

    spy = batchHooks(e, [{ before: () => e.exec("DELETE FROM account_currencies WHERE account_id = ? AND currency = 'EUR'", s.BE) }]);
    const removed = await s.post(spend(s, { cardId: null, entries: [{ direction: 'out', accountId: s.BE, currency: 'EUR', amountStatus: 'confirmed', amount: 1 }] }));
    expect([removed.status, removed.json.code, removed.json.details]).toEqual([400, 'CURRENCY_NOT_ON_ACCOUNT', { direction: 'out', currency: 'EUR', status: null }]);
    expect((await counts(e, s.id)).transactions).toBe(1);
  });

  it('CC-8: LEDGER_CLASSIFICATION / LEDGER_CLOSED_CURRENCY without a changed source are a generic 500 — no retry, never CONCURRENT_CHANGE', async () => {
    const s = await seedUser(e);
    for (const code of ['LEDGER_CLASSIFICATION', 'LEDGER_CLOSED_CURRENCY']) {
      const spy = batchHooks(e, []);
      const before = await ledgerDump(e);
      const r = await raising(e, 'transaction_entries', 'INSERT', null, `${code}: injected`, () => s.post(spend(s)));
      expect([r.status, r.json], code).toEqual([500, INTERNAL]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await ledgerDump(e)).toEqual(before);
      spy.mockRestore();
    }
  });

  it('CC-8: a source that changes again during the retry → 409 CONCURRENT_CHANGE, nothing written; the same key then works', async () => {
    const s = await seedUser(e);
    const key = newKey();
    const spy = batchHooks(e, [
      { before: () => e.exec("UPDATE accounts SET account_country = 'HK' WHERE id = ?", s.CN) },
      { before: () => e.exec("UPDATE accounts SET account_country = 'CN' WHERE id = ?", s.CN) },
    ]);
    const r = await s.post(unknownMerchant(s), key);
    expect([r.status, r.json.code, r.json.details]).toEqual([409, 'CONCURRENT_CHANGE', undefined]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await counts(e, s.id)).toEqual(NONE);
    spy.mockRestore();
    const again = await s.post(unknownMerchant(s), key);
    expect([again.status, again.json.event?.foreignStatus]).toEqual([201, 'undetermined']);
  });

  it('CC-8: a request with the same key committed while the first attempt was failing — the retry is not written, the stored result answers', async () => {
    const s = await seedUser(e);
    const key = newKey();
    let other: Awaited<ReturnType<Seed['post']>> | undefined;
    const spy = batchHooks(e, [
      {
        before: () => e.exec("UPDATE accounts SET account_country = 'HK' WHERE id = ?", s.CN),
        // After the first attempt failed (C6) and before the route looks again: the same request commits.
        after: async () => {
          other = await s.post(unknownMerchant(s), key);
        },
      },
    ]);
    const r = await s.post(unknownMerchant(s), key);
    expect(other!.status).toBe(201);
    expect([r.status, r.res.headers.get('idempotency-replayed')]).toEqual([201, 'true']);
    expect(r.json).toEqual(other!.json);
    expect(spy).toHaveBeenCalledTimes(2); // the first attempt and the other request — no second attempt
    expect(await counts(e, s.id)).toEqual(ONE_SPEND);
  });

  // ================================================================== the database-error / HTTP-error boundary (ISO-7)

  it('ISO-7 ①: the card, channel or account deleted, or the currency removed, between the checks and the batch → re-read as the caller → 404 / 400, same bodies as before writing', async () => {
    const s = await seedUser(e);
    const reference = {
      card: (await s.post(spend(s, { cardId: 'no-such-card-000000000000' }))).json,
      channel: (await s.post(spend(s, { paymentChannelId: 'no-such-channel-0000000000' }))).json,
      account: (await s.post(spend(s, { cardId: null, entries: [{ direction: 'out', accountId: 'no-such-account-0000000000', currency: 'HKD', amountStatus: 'confirmed', amount: 1 }] }))).json,
    };
    const extraCard = (await s.api.post('/api/cards', { issuerInstitutionId: s.I, name: 'Spare', network: 'visa', cardType: 'debit', last4: '1111', issuingCountry: 'BE' })).json.card.id;
    const extraChannel = (await s.api.post('/api/payment-channels', { name: 'Spare wallet', channelType: 'other' })).json.id;
    const extraAccount = (await s.api.post('/api/accounts', { institutionId: s.I, name: 'Spare account', accountType: 'bank', accountCountry: 'SG', currencies: [{ code: 'SGD', isDefault: true }, { code: 'USD' }] })).json.id;
    const cases: [string, () => Promise<unknown>, Body, unknown][] = [
      ['card', () => e.exec('DELETE FROM cards WHERE id = ?', extraCard), spend(s, { cardId: extraCard }), reference.card],
      ['channel', () => e.exec('DELETE FROM payment_channels WHERE id = ?', extraChannel), spend(s, { paymentChannelId: extraChannel }), reference.channel],
      ['currency', () => e.exec("DELETE FROM account_currencies WHERE account_id = ? AND currency = 'USD'", extraAccount),
        spend(s, { cardId: null, entries: [{ direction: 'out', accountId: extraAccount, currency: 'USD', amountStatus: 'confirmed', amount: 1 }] }),
        { error: expect.any(String), code: 'CURRENCY_NOT_ON_ACCOUNT', details: { direction: 'out', currency: 'USD', status: null } }],
      ['account', () => e.exec('DELETE FROM accounts WHERE id = ?', extraAccount),
        spend(s, { cardId: null, entries: [{ direction: 'out', accountId: extraAccount, currency: 'SGD', amountStatus: 'confirmed', amount: 1 }] }), reference.account],
    ];
    for (const [what, remove, body, expected] of cases) {
      const before = await ledgerDump(e);
      const spy = batchHooks(e, [{ before: remove }]);
      const r = await s.post(body);
      expect(r.json, what).toEqual(expected);
      expect(spy, what).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      expect(await ledgerDump(e), what).toEqual(before);
    }
  });

  it('ISO-7 ②: a foreign-key failure or an incomplete key row that re-reading cannot explain is a generic 500 — never a 404 by itself', async () => {
    const s = await seedUser(e);
    // Errors of this engine's verified driver shape (lib/dbErrors.ts): explained by nothing → 500.
    for (const [message, extended] of [['FOREIGN KEY constraint failed', 'SQLITE_CONSTRAINT_FOREIGNKEY'], ['NOT NULL constraint failed: ledger_idempotency_keys.result_revision', 'SQLITE_CONSTRAINT_NOTNULL']]) {
      const spy = batchHooks(e, [{ replace: async () => { throw driverError(e.name, message!, extended!); } }]);
      const r = await quietly(() => s.post(spend(s, { paymentChannelId: s.PP })));
      expect([r.status, r.json], message).toEqual([500, INTERNAL]);
      spy.mockRestore();
    }
    // Only the driver's own messages count, never drizzle's wrapper that repeats the bound values: a
    // foreign-key failure whose parameters spell "LEDGER_CLASSIFICATION:" is still a foreign-key
    // failure (re-read → the card is gone → 404), not a retry candidate (which would be a 500 here).
    const spare = (await s.api.post('/api/cards', { issuerInstitutionId: s.I, name: 'Spare', network: 'visa', cardType: 'debit', last4: '2222', issuingCountry: 'BE' })).json.card.id;
    const spy = batchHooks(e, [
      {
        replace: async () => {
          await e.exec('DELETE FROM cards WHERE id = ?', spare);
          throw new DrizzleQueryError('insert into "transaction_events" …', ['LEDGER_CLASSIFICATION: spoofed'], driverError(e.name, 'FOREIGN KEY constraint failed', 'SQLITE_CONSTRAINT_FOREIGNKEY'));
        },
      },
    ]);
    const r = await s.post(spend(s, { cardId: spare, merchantName: 'LEDGER_CLASSIFICATION: spoofed' }));
    expect([r.status, r.json.code, r.json.error]).toEqual([404, 'NOT_FOUND', 'card not found']);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    // An error of no verified driver shape (a plain Error spelling a constraint) is never classified:
    // even with the card gone it is not re-read into a 404, it is an unexplained 500.
    const spare2 = (await s.api.post('/api/cards', { issuerInstitutionId: s.I, name: 'Spare 2', network: 'visa', cardType: 'debit', last4: '3333', issuingCountry: 'BE' })).json.card.id;
    const plain = batchHooks(e, [{ replace: async () => { await e.exec('DELETE FROM cards WHERE id = ?', spare2); throw new Error('FOREIGN KEY constraint failed'); } }]);
    const u = await quietly(() => s.post(spend(s, { cardId: spare2 })));
    expect([u.status, u.json]).toEqual([500, INTERNAL]);
    plain.mockRestore();
    expect(await counts(e, s.id)).toEqual(NONE);
  });

  it('ISO-7 ③ / Q2: LEDGER_SNAPSHOT_SOURCE, every guard the server never triggers, CHECK and other UNIQUE failures are a generic 500 with nothing written', async () => {
    const s = await seedUser(e);
    const unreachable = [
      'LEDGER_SNAPSHOT_SOURCE', 'LEDGER_HEADER_INSERT', 'LEDGER_HEADER_IMMUTABLE', 'LEDGER_VOIDED', 'LEDGER_REVISION_ORDER', 'LEDGER_ENTRY_COUNT',
      'LEDGER_OWN_TRANSFER_SHAPE', 'LEDGER_EVENT_AMOUNT', 'LEDGER_CONFIRMED_DOMESTIC', 'LEDGER_IMMUTABLE', 'LEDGER_REVISION_KIND', 'LEDGER_KEY_IMMUTABLE', 'LEDGER_NO_DELETE',
    ];
    const messages = [...unreachable.map((c) => `${c}: injected`), 'CHECK constraint failed: transaction_entries_ack_closed_ck', 'UNIQUE constraint failed: transaction_entries.event_id, transaction_entries.direction'];
    const spy = batchHooks(e, []);
    const before = await ledgerDump(e);
    for (const message of messages) {
      const r = await raising(e, 'transaction_events', 'INSERT', null, message, () => s.post(spend(s)));
      expect([r.status, r.json], message).toEqual([500, INTERNAL]);
      expectNoLeak(r.json);
    }
    expect(spy).toHaveBeenCalledTimes(messages.length); // never retried
    expect(await ledgerDump(e)).toEqual(before);
  });

  it('ISO-7: a 500 caused by a wrapped statement logs no SQL text and no bound values (user data) on the server either', async () => {
    const s = await seedUser(e);
    const logged: string[] = [];
    // What the console would actually print (util.inspect shows an error's cause chain).
    const log = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 10 }))).join(' ')));
    const spy = batchHooks(e, [
      {
        replace: async () => {
          throw new DrizzleQueryError('insert into "transaction_events" ("merchant_name", "event_amount") values (?, ?)', ['Fictional Secret Shop', 987654321], driverError(e.name, 'CHECK constraint failed: x_ck', 'SQLITE_CONSTRAINT_CHECK'));
        },
      },
    ]);
    const r = await s.post(spend(s, { merchantName: 'Fictional Secret Shop', eventAmount: 987654321 }));
    spy.mockRestore();
    log.mockRestore();
    expect([r.status, r.json]).toEqual([500, INTERNAL]);
    const text = logged.join('\n');
    expect(text).toContain('[api] unhandled error');
    expect(text).toContain('(query and bound values withheld)');
    expect(text).toContain('CHECK constraint failed: x_ck');
    for (const s2 of ['Fictional Secret Shop', '987654321', 'insert into', 'params:']) expect(text).not.toContain(s2);
  });

  it('ISO-7 ④: no 4xx / 5xx answer carries a database word, a table name or another user’s id', async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    const answers = [
      await a.post(spend(a, { cardId: b.K })),
      await a.post(spend(a, { paymentChannelId: b.PP })),
      await a.post(spend(a, { cardId: null, entries: [{ direction: 'out', accountId: b.BE, currency: 'GBP', amountStatus: 'confirmed', amount: 1 }] })),
      await a.post(spend(a, { cardId: null, entries: [{ direction: 'out', accountId: a.HK, currency: 'JPY', amountStatus: 'confirmed', amount: 1 }] })),
      await a.post(spend(a, { merchantCountry: 'CN', cardId: null, eventCurrency: 'CNY', entries: [{ direction: 'out', accountId: a.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 1 }], recordMode: 'backfill', declaredHomeRegion: 'CN' })),
      await a.post(spend(a, { cardId: null, entries: [{ direction: 'out', accountId: a.BE, currency: 'GBP', amountStatus: 'confirmed', amount: 1 }], recordMode: 'backfill' })),
    ];
    for (const r of answers) {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expectNoLeak(r.json);
      for (const id of [b.id, b.HK, b.BE, b.K, b.PP]) expect(JSON.stringify(r.json)).not.toContain(id);
    }
  });
});
