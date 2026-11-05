// M3-B3-B.1: POST /transactions/:id/void (API_SPEC §5.8; DATA_MODEL §10.10 "作废") and the logical
// expiry of correct / void keys (API_SPEC §5.0.3, DATA_MODEL §10.5) — TEST_PLAN COR-5 (void),
// COR-6, IDEM-1/4/5/6/8/12/13/14 (void), RTY-3, FI (void), CC (void), ISO-1/3/6/7 (void), DEL-1
// after a void, IDEM-3 after a void. Every case runs on libsql and on wrangler's local in-memory D1
// through the real HTTP app. Corrections (r → r+1) come from the M3-B1 test chain: no correction
// route before M3-B3-C. All data is fictional.
import { requestHashV1, transactionVoidSchema } from '@xui/ledger-shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  batchHooks,
  counts,
  driverError,
  factCorrection,
  INTERNAL,
  keyRow,
  LEAKS,
  ledgerDump,
  newKey,
  ownTransfer,
  quietly,
  raising,
  seedUser,
  spend,
  startEngine,
  voidTxn,
  type Engine,
  type Seed,
} from './transactions-kit.ts';
import { errorText } from './m3-ledger.ts';

type Body = Record<string, unknown>;
type Json = any;

const DAY = 86_400_000;
const TTL = 30 * DAY;
const WRITE_RESULT_KEYS = ['entries', 'event', 'eventId', 'operation', 'recordedAt', 'revision', 'statusAfter', 'transactionId', 'txnType', 'void'];

describe.each(['libsql', 'd1'] as const)('POST /transactions/:id/void on %s', (engine) => {
  let e: Engine;
  let realNow: () => number;
  beforeAll(async () => {
    e = await startEngine(engine, 'xui-v1-txn-void-d1');
    realNow = e.t.deps.now;
  }, 180_000);
  afterAll(async () => {
    await e?.dispose();
  });
  beforeEach(() => e.ping());
  afterEach(() => {
    vi.restoreAllMocks();
    e.t.deps.now = realNow;
  });

  const made = async (s: Seed, body: Body = spend(s), key = newKey()): Promise<Json> => {
    const r = await s.post(body, key);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json;
  };
  const voided = async (s: Seed, T: string, baseRevision = 1, reason: string | null = null, key = newKey()) => {
    const r = await s.voidTx(T, { baseRevision, reason }, key);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r;
  };
  const header = async (T: string) => (await e.all('SELECT * FROM transactions WHERE id = ?', T))[0]!;
  const versions = (T: string) => e.all('SELECT * FROM transaction_events WHERE transaction_id = ? ORDER BY revision', T);
  const entriesOf = (T: string) => e.all('SELECT en.* FROM transaction_entries en JOIN transaction_events ev ON ev.id = en.event_id WHERE ev.transaction_id = ? ORDER BY en.id', T);
  const voidAudits = (userId: string) => e.all("SELECT * FROM audit_log WHERE user_id = ? AND action = 'transaction.void' ORDER BY rowid", userId);
  const expectNoLeak = (json: unknown) => expect(JSON.stringify(json)).not.toMatch(LEAKS);
  /** Move the clock to `t` (never backwards) with a fresh session for `s` (sessions idle out after 7 days). */
  const at = async (s: Seed, t: number) => {
    e.t.clock.t = Math.max(e.t.clock.t, t - 60_000);
    await s.relogin();
    expect(t).toBeGreaterThanOrEqual(e.t.clock.t);
    e.t.clock.t = t;
  };
  /** A logically expired void key row of `s` (raw SQL, as a 30-day-old void would have left it). */
  const expiredVoidKey = async (s: Seed, w: Json, key: string, hashVersion = 1) => {
    const now = e.t.clock.t;
    await e.exec(
      'INSERT INTO ledger_idempotency_keys (user_id, key, operation, request_hash, hash_version, op_id, transaction_id, result_revision, result_event_id, audit_id, response_status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 200, ?, ?)',
      s.id, key, 'transaction.void', 'a'.repeat(64), hashVersion, `op-old-${key}`, w.transactionId, w.eventId, `audit-old-${key}`, now - TTL - 10, now - 10,
    );
  };

  // ================================================================== the void itself (COR-6)

  it('COR-6: 200 with the TransactionWriteResult of the version that was current; the header is voided once; no event, entry or revision is added; audit and a 30-day key row in the same batch', async () => {
    const s = await seedUser(e);
    const w = await made(s, ownTransfer(s, { notes: 'keep me' }));
    const T = w.transactionId as string;
    const [evBefore, enBefore] = [await versions(T), await entriesOf(T)];
    e.t.advance(5_000);
    const now = e.t.clock.t;
    const key = newKey();
    const body = { baseRevision: 1, reason: 'entered twice' };
    const r = await s.voidTx(T, body, key);
    expect([r.status, r.res.headers.get('idempotency-replayed')]).toEqual([200, null]);
    expect(Object.keys(r.json).sort()).toEqual(WRITE_RESULT_KEYS);
    expect(r.json).toEqual({
      operation: 'transaction.void', transactionId: T, txnType: 'own_transfer', revision: 1, eventId: w.eventId, statusAfter: 'voided',
      recordedAt: now, event: w.event, entries: w.entries, void: { voidedAt: now, reason: 'entered twice' },
    });
    // Only the header changed: no version, the same events and entries, current_revision kept.
    const h = await header(T);
    expect(h).toMatchObject({ status: 'voided', current_revision: 1, voided_at: now, void_reason: 'entered twice', updated_at: now, notes: 'keep me' });
    expect([await versions(T), await entriesOf(T)]).toEqual([evBefore, enBefore]);
    // The audit and the key row were written by the same batch, tied to this request's op id.
    const audits = await voidAudits(s.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ created_at: now });
    expect(JSON.parse(String(audits[0]!.detail))).toEqual({ id: T, eventId: w.eventId, revision: 1 });
    expect(await keyRow(e, s.id, key)).toEqual({
      user_id: s.id, key, operation: 'transaction.void', request_hash: await requestHashV1('transaction.void', T, transactionVoidSchema.parse(body)), hash_version: 1,
      op_id: h.voided_op_id, transaction_id: T, result_revision: 1, result_event_id: w.eventId, audit_id: audits[0]!.id, response_status: 200, created_at: now, expires_at: now + TTL,
    });
    // Reads: the detail shows the void, the default list hides it, status=voided lists it.
    const d = (await s.api.get(`/api/transactions/${T}`)).json;
    expect(d).toMatchObject({ status: 'voided', currentRevision: 1, voidedAt: now, voidReason: 'entered twice', notes: 'keep me', event: { revision: 1 } });
    expect(d.revisions).toHaveLength(1);
    expect((await s.api.get('/api/transactions')).json.items).toEqual([]);
    expect((await s.api.get('/api/transactions?status=voided')).json.items.map((i: Json) => i.id)).toEqual([T]);
    // reason is optional.
    const w2 = await made(s);
    expect((await s.voidTx(w2.transactionId, { baseRevision: 1 })).json.void).toEqual({ voidedAt: e.t.clock.t, reason: null });
  });

  it('COR-6: a corrected transaction is voided at its current version; every published version stays readable; nothing can correct or void it afterwards, its notes still change', async () => {
    const s = await seedUser(e);
    const w = await made(s);
    const T = w.transactionId as string;
    const v2 = await factCorrection(e, s, T, { merchantName: 'Corrected Store' });
    // COR-5: the caller's revision is stale → 409 with the current revision, nothing written.
    const before = await ledgerDump(e);
    const stale = await s.voidTx(T, { baseRevision: 1, reason: null });
    expect([stale.status, stale.json]).toEqual([409, { error: expect.any(String), code: 'REVISION_CONFLICT', details: { currentRevision: 2 } }]);
    expect(await ledgerDump(e)).toEqual(before);
    const r = await voided(s, T, 2);
    expect(r.json).toMatchObject({ revision: 2, eventId: v2.eventId, event: { revision: 2, revisionKind: 'fact_correction', merchantName: 'Corrected Store' } });
    expect((await header(T)).current_revision).toBe(2);
    expect(await versions(T)).toHaveLength(2);
    for (const n of [1, 2]) expect((await s.api.get(`/api/transactions/${T}/revisions/${n}`)).status).toBe(200);
    // Terminal: a correction chain on it writes nothing (its S1 only selects an active transaction) and
    // its incomplete key row rolls it back; the route answers 409 before any batch.
    expect(await factCorrection(e, s, T, { merchantName: 'Again' }).then(() => 'written', (err) => errorText(err))).toMatch(/NOT NULL constraint failed: ledger_idempotency_keys\.result_/);
    expect(await versions(T)).toHaveLength(2);
    expect((await s.voidTx(T, { baseRevision: 2 })).json.code).toBe('TRANSACTION_VOIDED');
    expect((await s.notes(T, { notes: 'after the void' })).status).toBe(200);
  });

  it('COR-5 / Q-B3-4 and the check order: 404 for another user’s, a missing and an unpublished transaction (same body) → 409 TRANSACTION_VOIDED, whatever baseRevision → 409 REVISION_CONFLICT; request-only checks come first', async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    const wa = await made(a);
    const w = await made(b);
    const T = w.transactionId as string;
    const unpublished = `unpublished-${newKey()}`;
    await e.exec('INSERT INTO transactions (id, user_id, txn_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', unpublished, b.id, 'merchant_spend', 1, 1);
    const missing = await b.voidTx('no-such-transaction-000000', { baseRevision: 1 });
    expect([missing.status, missing.json]).toEqual([404, { error: 'transaction not found', code: 'NOT_FOUND' }]);
    for (const id of [wa.transactionId, unpublished]) expect((await b.voidTx(id, { baseRevision: 1 })).json).toEqual(missing.json);
    expect((await b.voidTx(T, { baseRevision: 3 })).json).toMatchObject({ code: 'REVISION_CONFLICT', details: { currentRevision: 1 } });
    await voided(b, T);
    // Voided wins over a stale baseRevision (terminal: refreshing cannot help).
    for (const baseRevision of [1, 2, 99]) {
      const r = await b.voidTx(T, { baseRevision });
      expect([r.status, r.json.code, r.json.details], String(baseRevision)).toEqual([409, 'TRANSACTION_VOIDED', undefined]);
    }
    // Checks of the request alone come before anything that reads the database (a missing id too).
    const before = await ledgerDump(e);
    const bad: [unknown, string][] = [
      [{}, 'VALIDATION'],
      [{ baseRevision: 0 }, 'VALIDATION'],
      [{ baseRevision: 1.5 }, 'VALIDATION'],
      [{ baseRevision: '1' }, 'VALIDATION'],
      [{ baseRevision: 1, reason: '' }, 'VALIDATION'],
      [{ baseRevision: 1, reason: 'x'.repeat(201) }, 'VALIDATION'],
      [{ baseRevision: 1, status: 'voided' }, 'VALIDATION'],
      [{ baseRevision: 1, reason: 'card 4111 1111 1111 1111' }, 'SENSITIVE_DATA'],
    ];
    for (const [body, code] of bad) {
      for (const id of ['no-such-transaction-000000', T]) {
        const r = await b.voidTx(id, body as Body);
        expect([r.status, r.json.code], JSON.stringify(body)).toEqual([400, code]);
        expectNoLeak(r.json);
      }
    }
    const broken = await b.api.req('POST', `/api/transactions/${T}/void`, undefined, { 'idempotency-key': newKey(), 'content-type': 'application/json' });
    expect([broken.status, broken.json.code]).toEqual([400, 'BAD_JSON']);
    expect(await ledgerDump(e)).toEqual(before);
  });

  // ================================================================== the key (IDEM-1, IDEM-5, IDEM-13)

  it('IDEM-1: a void without a key is 400 IDEMPOTENCY_KEY_REQUIRED, with a malformed one IDEMPOTENCY_KEY_INVALID — before the body; nothing written', async () => {
    const s = await seedUser(e);
    const T = (await made(s)).transactionId;
    const before = await ledgerDump(e);
    for (const body of [{ baseRevision: 1 }, { junk: true }]) {
      expect((await s.voidTx(T, body, null)).json.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect((await s.voidTx(T, body, '')).json.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      for (const bad of ['a'.repeat(15), 'a'.repeat(65), 'has space 0123456789', 'dotted.key.0123456789']) {
        const r = await s.voidTx(T, body, bad);
        expect([r.status, r.json.code], bad).toEqual([400, 'IDEMPOTENCY_KEY_INVALID']);
      }
    }
    expect(await ledgerDump(e)).toEqual(before);
    expect((await header(T)).status).toBe('active');
  });

  it('IDEM-5 / IDEM-13: one key space per user for every operation — a used key with a different void, transaction or operation is 409 with only the caller’s data; request-only errors still come first', async () => {
    const s = await seedUser(e);
    const [w1, w2] = [await made(s), await made(s)];
    const createKey = newKey();
    const w3 = await made(s, spend(s), createKey);
    const key = newKey();
    await voided(s, w1.transactionId, 1, 'first', key);
    const before = await ledgerDump(e);
    const conflict = { operation: 'transaction.void', transactionId: w1.transactionId };
    for (const [T, body] of [
      [w1.transactionId, { baseRevision: 1, reason: 'second' }],
      [w1.transactionId, { baseRevision: 1 }],
      [w1.transactionId, { baseRevision: 2, reason: 'first' }],
      [w2.transactionId, { baseRevision: 1, reason: 'first' }],
      ['no-such-transaction-000000', { baseRevision: 1, reason: 'first' }],
    ] as [string, Body][]) {
      const r = await s.voidTx(T, body, key);
      expect([r.status, r.json.code, r.json.details], JSON.stringify([T, body])).toEqual([409, 'IDEMPOTENCY_CONFLICT', conflict]);
    }
    // The same void key for a create, and a create key for a void.
    expect((await s.post(spend(s), key)).json).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', details: conflict });
    expect((await s.voidTx(w3.transactionId, { baseRevision: 1 }, createKey)).json).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', details: { operation: 'transaction.create', transactionId: w3.transactionId } });
    // Errors of the request alone are its own 400, never the 409.
    expect((await s.voidTx(w1.transactionId, { baseRevision: 1, reason: 'pin 1234 cvv 123 4111111111111111' }, key)).json.code).toBe('SENSITIVE_DATA');
    expect((await s.voidTx(w1.transactionId, { baseRevision: 1, reason: 'first', extra: 1 }, key)).json.code).toBe('VALIDATION');
    expect(await ledgerDump(e)).toEqual(before);
    expect((await header(w2.transactionId)).status).toBe('active');
  });

  // ================================================================== replay (IDEM-4, IDEM-3 after a void)

  it('IDEM-4: a void replays as 200 with Idempotency-Replayed: true and the exact bytes of the first response — also after notes, names and the clock change; normalized-equal bodies are the same request', async () => {
    const s = await seedUser(e);
    const T = (await made(s, spend(s, { paymentChannelId: s.PP }))).transactionId;
    const key = newKey();
    const body = { reason: 'duplicate', baseRevision: 1 };
    const first = await s.voidBytes(T, body, key);
    expect([first.status, first.res.headers.get('idempotency-replayed')]).toEqual([200, null]);
    const dump = await ledgerDump(e);
    const replays = [await s.voidBytes(T, body, key), await s.voidBytes(T, { baseRevision: 1, reason: 'duplicate' }, key)];
    expect((await s.notes(T, { notes: 'changed after the void' })).status).toBe(200);
    expect((await s.api.patch(`/api/accounts/${s.HK}`, { name: 'Renamed account', status: 'closed' })).status).toBe(200);
    expect((await s.api.patch(`/api/cards/${s.K}`, { name: 'Renamed card' })).status).toBe(200);
    expect((await s.api.patch(`/api/payment-channels/${s.PP}`, { name: `Renamed wallet ${key}`, status: 'archived' })).status).toBe(200);
    e.t.advance(DAY);
    replays.push(await s.voidBytes(T, body, key));
    for (const r of replays) {
      expect([r.status, r.res.headers.get('idempotency-replayed')]).toEqual([200, 'true']);
      expect(Buffer.from(r.bytes).equals(Buffer.from(first.bytes))).toBe(true);
    }
    expect(first.text).not.toMatch(/notes|Renamed|currentRevision/);
    // No replay wrote anything (only the notes PATCH touched the header).
    expect({ ...(await ledgerDump(e)), transactions: [] }).toEqual({ ...dump, transactions: [] });
  });

  it('IDEM-3 after a void: the create still replays the exact bytes of its first response (revision 1, statusAfter active, void null)', async () => {
    const s = await seedUser(e);
    const key = newKey();
    const first = await s.postBytes(spend(s), key);
    expect(first.status).toBe(201);
    const T = JSON.parse(first.text).transactionId;
    await voided(s, T, 1, 'gone');
    const again = await s.postBytes(spend(s), key);
    expect([again.status, again.res.headers.get('idempotency-replayed')]).toEqual([201, 'true']);
    expect(Buffer.from(again.bytes).equals(Buffer.from(first.bytes))).toBe(true);
    expect(JSON.parse(again.text)).toMatchObject({ operation: 'transaction.create', statusAfter: 'active', void: null, revision: 1 });
  });

  // ================================================================== failures keep no key (IDEM-6, IDEM-12)

  it('IDEM-6: a void that failed (404, 409 REVISION_CONFLICT, injected 500) stores no key; the same key then runs exactly once', async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    const T = (await made(a)).transactionId;
    const foreign = (await made(b)).transactionId;
    const key = newKey();
    expect((await a.voidTx(foreign, { baseRevision: 1 }, key)).status).toBe(404);
    expect((await a.voidTx(T, { baseRevision: 2 }, key)).status).toBe(409);
    const injected = await raising(e, 'transactions', 'UPDATE', null, 'TEST_INJECTED_FAILURE', () => a.voidTx(T, { baseRevision: 1 }, key));
    expect([injected.status, injected.json]).toEqual([500, INTERNAL]);
    expect(await keyRow(e, a.id, key)).toBeUndefined();
    expect(await voidAudits(a.id)).toEqual([]);
    const ok = await a.voidTx(T, { baseRevision: 1 }, key);
    expect([ok.status, ok.res.headers.get('idempotency-replayed')]).toEqual([200, null]);
    expect(await voidAudits(a.id)).toHaveLength(1);
    expect((await header(foreign)).status).toBe('active');
  });

  it('IDEM-12: an unknown hash_version is a generic 500 only on a live key — an expired one is no key at all', async () => {
    const s = await seedUser(e);
    const [w1, w2] = [await made(s), await made(s)];
    const live = newKey();
    // A live void key row as a future server version would have written it (raw SQL).
    const now = e.t.clock.t;
    await e.exec(
      'INSERT INTO ledger_idempotency_keys (user_id, key, operation, request_hash, hash_version, op_id, transaction_id, result_revision, result_event_id, audit_id, response_status, created_at, expires_at) VALUES (?, ?, ?, ?, 99, ?, ?, 1, ?, ?, 200, ?, ?)',
      s.id, live, 'transaction.void', 'b'.repeat(64), 'op-future', w1.transactionId, w1.eventId, 'audit-future', now, now + TTL,
    );
    const before = await ledgerDump(e);
    for (const body of [{ baseRevision: 1 }, { baseRevision: 1, reason: 'other' }]) {
      const r = await quietly(() => s.voidTx(w1.transactionId, body, live));
      expect([r.status, r.json, r.res.headers.get('idempotency-replayed')]).toEqual([500, INTERNAL, null]);
    }
    expect(await ledgerDump(e)).toEqual(before);
    // The same unknown version on an expired row: ignored, the void runs, S0 replaces the row.
    const old = newKey();
    await expiredVoidKey(s, w1, old, 99);
    const r = await s.voidTx(w2.transactionId, { baseRevision: 1 }, old);
    expect([r.status, r.res.headers.get('idempotency-replayed')]).toEqual([200, null]);
    expect(await keyRow(e, s.id, old)).toMatchObject({ hash_version: 1, transaction_id: w2.transactionId, created_at: e.t.clock.t });
  });

  // ================================================================== logical expiry (IDEM-14, IDEM-8)

  it('IDEM-14 / Q-B3-2: a void key replays until expires_at; at expires_at exactly it is no key — the original request is 409 TRANSACTION_VOIDED (never a replay, never IDEMPOTENCY_CONFLICT), another request runs once; create keys never expire', async () => {
    const s = await seedUser(e);
    const createKey = newKey();
    const w1 = await made(s, spend(s), createKey);
    const w2 = await made(s);
    const key = newKey();
    const body = { baseRevision: 1, reason: 'expiry' };
    const first = await s.voidBytes(w1.transactionId, body, key);
    expect(first.status).toBe(200);
    const row = (await keyRow(e, s.id, key))!;
    const expiresAt = Number(row.expires_at);
    expect(expiresAt).toBe(Number(row.created_at) + TTL);

    // One millisecond before: still the first result.
    await at(s, expiresAt - 1);
    const lastReplay = await s.voidBytes(w1.transactionId, body, key);
    expect([lastReplay.status, lastReplay.res.headers.get('idempotency-replayed')]).toEqual([200, 'true']);
    expect(lastReplay.text).toBe(first.text);

    // At expires_at (no other write happened: the row is still in the table) the key is gone.
    e.t.clock.t = expiresAt;
    const dump = await ledgerDump(e);
    const original = await s.voidTx(w1.transactionId, body, key);
    expect([original.status, original.json.code, original.res.headers.get('idempotency-replayed')]).toEqual([409, 'TRANSACTION_VOIDED', null]);
    // A different request on the expired key is no conflict either: it is judged on its own.
    const other = await s.voidTx(w1.transactionId, { baseRevision: 7 }, key);
    expect([other.status, other.json.code]).toEqual([409, 'TRANSACTION_VOIDED']);
    expect(await ledgerDump(e)).toEqual(dump); // refused before writing: the old row is still there
    expect(await keyRow(e, s.id, key)).toEqual(row);

    // A new valid request with the expired key runs once; its S0 removed the old row.
    const reuse = await s.voidTx(w2.transactionId, { baseRevision: 1 }, key);
    expect([reuse.status, reuse.res.headers.get('idempotency-replayed')]).toEqual([200, null]);
    expect(await e.all('SELECT transaction_id, operation, created_at, expires_at FROM ledger_idempotency_keys WHERE user_id = ? AND key = ?', s.id, key)).toEqual([
      { transaction_id: w2.transactionId, operation: 'transaction.void', created_at: expiresAt, expires_at: expiresAt + TTL },
    ]);
    expect(await voidAudits(s.id)).toHaveLength(2);

    // The create key of w1, 31 days on: still replayed.
    await at(s, expiresAt + DAY);
    const createReplay = await s.post(spend(s), createKey);
    expect([createReplay.status, createReplay.res.headers.get('idempotency-replayed'), createReplay.json.transactionId]).toEqual([201, 'true', w1.transactionId]);
  });

  it('IDEM-14: if an expired row survived the batch (S0 taken out by a test double), gate G stops the write and the route answers 500 — not a replay, not a conflict; the same request then runs once', async () => {
    const s = await seedUser(e);
    const [w1, w2] = [await made(s), await made(s)];
    const key = newKey();
    await expiredVoidKey(s, w1, key);
    const before = await ledgerDump(e);
    const spy = batchHooks(e, [{ transform: (batch) => batch.slice(1) }]);
    const r = await quietly(() => s.voidTx(w2.transactionId, { baseRevision: 1 }, key));
    expect([r.status, r.json, r.res.headers.get('idempotency-replayed')]).toEqual([500, INTERNAL, null]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.settledResults[0]!.type).toBe('fulfilled'); // gate G closed: nothing written, no error
    spy.mockRestore();
    expect(await ledgerDump(e)).toEqual(before);
    const ok = await s.voidTx(w2.transactionId, { baseRevision: 1 }, key);
    expect([ok.status, ok.res.headers.get('idempotency-replayed')]).toEqual([200, null]);
  });

  it('IDEM-8: 31 days on, the next write of the user deletes only its own expired void keys (S0); create keys stay; the original void again is 409 TRANSACTION_VOIDED with nothing written', async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    const createKey = newKey();
    const wa = await made(a, spend(a), createKey);
    const wb = await made(b);
    const [ka, kb] = [newKey(), newKey()];
    await voided(a, wa.transactionId, 1, null, ka);
    await voided(b, wb.transactionId, 1, null, kb);
    const t0 = e.t.clock.t;
    await at(a, t0 + 31 * DAY);
    expect((await keyRow(e, a.id, ka))).toBeDefined(); // not deleted until a writes
    await made(a); // a's write: its S0 runs
    expect(await keyRow(e, a.id, ka)).toBeUndefined();
    expect(await keyRow(e, b.id, kb)).toBeDefined(); // another user's expired key is untouched
    expect(await keyRow(e, a.id, createKey)).toBeDefined();
    const before = await ledgerDump(e);
    const again = await a.voidTx(wa.transactionId, { baseRevision: 1, reason: null }, ka);
    expect([again.status, again.json.code]).toEqual([409, 'TRANSACTION_VOIDED']);
    expect(await ledgerDump(e)).toEqual(before);
    expect(await e.exec('DELETE FROM ledger_idempotency_keys WHERE user_id = ? AND key = ?', a.id, createKey).then(() => 'deleted', (err) => errorText(err))).toMatch(/LEDGER_NO_DELETE/);
  });

  it('one server time per request: the void, its audit, its key row (created_at, expires_at) and the S0 condition share it; so do a create’s rows', async () => {
    const s = await seedUser(e);
    const w = await made(s);
    // Every later read of the clock would see a different millisecond.
    e.t.deps.now = () => ++e.t.clock.t;
    const key = newKey();
    const r = await s.voidTx(w.transactionId, { baseRevision: 1 }, key);
    expect(r.status).toBe(200);
    const h = await header(w.transactionId);
    const k = (await keyRow(e, s.id, key))!;
    const [audit] = await voidAudits(s.id);
    expect([h.updated_at, k.created_at, audit!.created_at, r.json.recordedAt, r.json.void.voidedAt]).toEqual([h.voided_at, h.voided_at, h.voided_at, h.voided_at, h.voided_at]);
    expect(k.expires_at).toBe(Number(h.voided_at) + TTL);
    const ck = newKey();
    const c = await s.post(spend(s), ck);
    expect(c.status).toBe(201);
    const created = (await keyRow(e, s.id, ck))!.created_at;
    const ch = await header(c.json.transactionId);
    expect([ch.created_at, ch.updated_at, c.json.event.createdAt, c.json.recordedAt]).toEqual([created, created, created, created]);
  });

  it('one server time per request: a void, a create (with and without the controlled retry) and a notes PATCH each read the clock exactly once beyond what the session check of any request reads', async () => {
    const s = await seedUser(e);
    const [w1, w2] = [await made(s), await made(s)];
    let reads = 0;
    e.t.deps.now = () => {
      reads++;
      return e.t.clock.t; // a still clock: no session touch in between
    };
    const readsOf = async (fn: () => Promise<{ status: number }>, status: number) => {
      reads = 0;
      expect((await fn()).status).toBe(status);
      return reads;
    };
    const session = await readsOf(() => s.api.get(`/api/transactions/${w1.transactionId}`), 200);
    expect(await readsOf(() => s.voidTx(w1.transactionId, { baseRevision: 1 }), 200)).toBe(session + 1);
    expect(await readsOf(() => s.voidTx(w1.transactionId, { baseRevision: 1 }), 409)).toBe(session + 1);
    expect(await readsOf(() => s.post(spend(s)), 201)).toBe(session + 1);
    expect(await readsOf(() => s.notes(w2.transactionId, { notes: 'x' }), 200)).toBe(session + 1);
    // The controlled retry (a source changed after the checks) reuses the request's time.
    const unknownMerchant = spend(s, { merchantCountry: null, eventCurrency: 'CNY', cardId: null, entries: [{ direction: 'out', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 100 }] });
    const spy = batchHooks(e, [{ before: () => e.exec("UPDATE accounts SET account_country = 'HK' WHERE id = ?", s.CN) }]);
    expect(await readsOf(() => s.post(unknownMerchant), 201)).toBe(session + 1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  // ================================================================== lost responses (RTY-3) and injected failures (FI)

  it('RTY-3: the void committed but the response was lost — 500, no re-run; the same key replays 200; one transaction.void audit', async () => {
    const s = await seedUser(e);
    const T = (await made(s)).transactionId;
    const key = newKey();
    const spy = batchHooks(e, [{ after: async (err) => { if (!err) throw new Error('fetch failed: socket hang up'); } }]);
    const lost = await quietly(() => s.voidTx(T, { baseRevision: 1, reason: 'lost' }, key));
    expect([lost.status, lost.json]).toEqual([500, INTERNAL]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect((await header(T)).status).toBe('voided');
    const retry = await s.voidTx(T, { baseRevision: 1, reason: 'lost' }, key);
    expect([retry.status, retry.res.headers.get('idempotency-replayed')]).toEqual([200, 'true']);
    expect(retry.json).toMatchObject({ transactionId: T, statusAfter: 'voided', void: { reason: 'lost' } });
    expect(await voidAudits(s.id)).toHaveLength(1);
    expect(Number((await e.all("SELECT count(*) AS n FROM ledger_idempotency_keys WHERE user_id = ? AND operation = 'transaction.void'", s.id))[0]!.n)).toBe(1);
  });

  it('FI: an injected failure at S0 (expired-key cleanup), S1 (header), S2 (audit) or S3 (key row) is a generic 500 with the database unchanged; the same key then voids once', async () => {
    const s = await seedUser(e);
    const steps: [string, string, 'INSERT' | 'UPDATE' | 'DELETE', string | null][] = [
      ['S0', 'ledger_idempotency_keys', 'DELETE', null],
      ['S1', 'transactions', 'UPDATE', null],
      ['S2', 'audit_log', 'INSERT', "NEW.action = 'transaction.void'"],
      ['S3', 'ledger_idempotency_keys', 'INSERT', null],
    ];
    for (const [step, table, event, when] of steps) {
      const w = await made(s);
      if (step === 'S0') await expiredVoidKey(s, w, newKey());
      const key = newKey();
      const before = await ledgerDump(e);
      const r = await raising(e, table, event, when, 'TEST_INJECTED_FAILURE', () => s.voidTx(w.transactionId, { baseRevision: 1 }, key));
      expect([r.status, r.json], step).toEqual([500, INTERNAL]);
      expect(await ledgerDump(e), step).toEqual(before);
      const retry = await s.voidTx(w.transactionId, { baseRevision: 1 }, key);
      expect([retry.status, retry.res.headers.get('idempotency-replayed')], step).toEqual([200, null]);
    }
    expect(await voidAudits(s.id)).toHaveLength(steps.length);
  });

  // ================================================================== concurrency

  it('CC: one key, the same void twice at once → one 200 and one replay; one key, two different voids → one 200 and one 409 IDEMPOTENCY_CONFLICT', async () => {
    const s = await seedUser(e);
    const [w1, w2] = [await made(s), await made(s)];
    const key = newKey();
    const rs = await Promise.all([s.voidTx(w1.transactionId, { baseRevision: 1 }, key), s.voidTx(w1.transactionId, { baseRevision: 1 }, key)]);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    expect(rs.map((r) => r.res.headers.get('idempotency-replayed')).sort()).toEqual(['true', null].sort());
    expect(rs[0]!.json).toEqual(rs[1]!.json);
    expect(await voidAudits(s.id)).toHaveLength(1);
    const w3 = await made(s);
    const key2 = newKey();
    const [x, y] = await Promise.all([s.voidTx(w2.transactionId, { baseRevision: 1 }, key2), s.voidTx(w3.transactionId, { baseRevision: 1 }, key2)]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect([x, y].find((r) => r.status === 409)!.json.code).toBe('IDEMPOTENCY_CONFLICT');
    expect([(await header(w2.transactionId)).status, (await header(w3.transactionId)).status].sort()).toEqual(['active', 'voided']);
  });

  it('CC with a forced overlap and one key: both requests pass the key lookup and the checks; gate G makes the later batch write nothing (no error) and the stored result answers it as a replay', async () => {
    const s = await seedUser(e);
    const T = (await made(s)).transactionId;
    const key = newKey();
    let second: Promise<Awaited<ReturnType<Seed['voidTx']>>> | undefined;
    const spy = batchHooks(e, [{ before: async () => { second = s.voidTx(T, { baseRevision: 1 }, key); await new Promise((r) => setTimeout(r, 50)); } }]);
    const first = await s.voidTx(T, { baseRevision: 1 }, key);
    const other = await second!;
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.settledResults.map((r) => r.type)).toEqual(['fulfilled', 'fulfilled']);
    expect([first.status, other.status]).toEqual([200, 200]);
    expect([first.res.headers.get('idempotency-replayed'), other.res.headers.get('idempotency-replayed')].filter(Boolean)).toEqual(['true']);
    expect(first.json).toEqual(other.json);
    expect(await voidAudits(s.id)).toHaveLength(1);
    expect(await counts(e, s.id)).toMatchObject({ ledger_idempotency_keys: 2, audit: 2 }); // create + void each
  });

  it('CC: two voids of one transaction with different keys, also when both passed the checks — the database lets one through, the other is 409 TRANSACTION_VOIDED; one audit, one key row', async () => {
    const s = await seedUser(e);
    const T1 = (await made(s)).transactionId;
    const rs = await Promise.all([s.voidTx(T1, { baseRevision: 1 }), s.voidTx(T1, { baseRevision: 1 })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(rs.find((r) => r.status === 409)!.json.code).toBe('TRANSACTION_VOIDED');
    // Forced overlap: the second request passes its checks while the first waits before its batch.
    const T2 = (await made(s)).transactionId;
    let second: Promise<Awaited<ReturnType<Seed['voidTx']>>> | undefined;
    const spy = batchHooks(e, [{ before: async () => { second = s.voidTx(T2, { baseRevision: 1 }); await new Promise((r) => setTimeout(r, 50)); } }]);
    const first = await s.voidTx(T2, { baseRevision: 1 });
    const other = await second!;
    expect(spy).toHaveBeenCalledTimes(2);
    expect([first.status, other.status].sort()).toEqual([200, 409]);
    expect([first, other].find((r) => r.status === 409)!.json).toEqual({ error: expect.any(String), code: 'TRANSACTION_VOIDED' });
    // The loser's batch was refused by its incomplete key row (S1 voided nothing), then re-read.
    expect(spy.mock.settledResults.map((r) => r.type).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await voidAudits(s.id)).toHaveLength(2);
    expect(Number((await e.all("SELECT count(*) AS n FROM ledger_idempotency_keys WHERE user_id = ? AND operation = 'transaction.void'", s.id))[0]!.n)).toBe(2);
  });

  it('ISO-7 ①: the transaction is voided or corrected between the checks and the batch → re-read as the caller → 409 TRANSACTION_VOIDED / REVISION_CONFLICT; nothing of this request written', async () => {
    const s = await seedUser(e);
    for (const [what, change, expected] of [
      ['voided meanwhile', (T: string) => voidTxn(e, s, T), { code: 'TRANSACTION_VOIDED' }],
      ['corrected meanwhile', (T: string) => factCorrection(e, s, T, { merchantName: 'Meanwhile' }), { code: 'REVISION_CONFLICT', details: { currentRevision: 2 } }],
    ] as const) {
      const T = (await made(s)).transactionId;
      const key = newKey();
      const spy = batchHooks(e, [{ before: () => change(T) }]);
      const r = await s.voidTx(T, { baseRevision: 1 }, key);
      expect([r.status, r.json], what).toEqual([409, { error: expect.any(String), ...expected }]);
      expect(spy).toHaveBeenCalledTimes(2); // the change's own batch, then this request's (refused)
      spy.mockRestore();
      expect(await keyRow(e, s.id, key)).toBeUndefined();
    }
    // Only the test chain's own void wrote an audit (and its own key row) — nothing of the refused requests.
    expect(await voidAudits(s.id)).toHaveLength(1);
  });

  it('ISO-7 ② / ③: an incomplete key row or foreign-key failure re-reading cannot explain, any LEDGER_* (CLASSIFICATION / CLOSED_CURRENCY included: a void has no retry), CHECK and other UNIQUE → generic 500, one attempt, nothing written', async () => {
    const s = await seedUser(e);
    const T = (await made(s)).transactionId;
    for (const [message, extended] of [['FOREIGN KEY constraint failed', 'SQLITE_CONSTRAINT_FOREIGNKEY'], ['NOT NULL constraint failed: ledger_idempotency_keys.audit_id', 'SQLITE_CONSTRAINT_NOTNULL']]) {
      const spy = batchHooks(e, [{ replace: async () => { throw driverError(e.name, message!, extended!); } }]);
      const r = await quietly(() => s.voidTx(T, { baseRevision: 1 }));
      expect([r.status, r.json], message).toEqual([500, INTERNAL]);
      spy.mockRestore();
    }
    const codes = [
      'LEDGER_CLASSIFICATION', 'LEDGER_CLOSED_CURRENCY', 'LEDGER_SNAPSHOT_SOURCE', 'LEDGER_HEADER_IMMUTABLE', 'LEDGER_VOIDED', 'LEDGER_REVISION_ORDER',
      'LEDGER_CONFIRMED_DOMESTIC', 'LEDGER_IMMUTABLE', 'LEDGER_KEY_IMMUTABLE', 'LEDGER_NO_DELETE',
    ];
    const messages = [...codes.map((c) => `${c}: injected`), 'CHECK constraint failed: transactions_voided_at_ck', 'UNIQUE constraint failed: transactions.id'];
    const spy = batchHooks(e, []);
    const before = await ledgerDump(e);
    for (const message of messages) {
      const r = await raising(e, 'transactions', 'UPDATE', null, message, () => s.voidTx(T, { baseRevision: 1 }));
      expect([r.status, r.json], message).toEqual([500, INTERNAL]);
      expectNoLeak(r.json);
    }
    expect(spy).toHaveBeenCalledTimes(messages.length); // never retried
    expect(await ledgerDump(e)).toEqual(before);
  });

  // ================================================================== isolation (ISO-1, ISO-3, ISO-6)

  it('ISO-1 / ISO-3 / ISO-6: another user’s transaction — active or voided — is the same 404 as a missing one, no details, nothing written; keys are per user', async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    const [active, gone] = [await made(a), await made(a)];
    const aKey = newKey();
    await voided(a, gone.transactionId, 1, null, aKey);
    const before = await ledgerDump(e);
    const missing = await b.voidTx('no-such-transaction-000000', { baseRevision: 1 });
    for (const T of [active.transactionId, gone.transactionId]) {
      for (const body of [{ baseRevision: 1 }, { baseRevision: 5 }]) {
        const r = await b.voidTx(T, body);
        expect([r.status, r.json]).toEqual([404, missing.json]);
        for (const id of [a.id, T, active.eventId]) expect(JSON.stringify(r.json)).not.toContain(id);
      }
    }
    // a's key, used by b for b's request on a's transaction: b has no such key → b's own 404.
    expect((await b.voidTx(gone.transactionId, { baseRevision: 1 }, aKey)).json).toEqual(missing.json);
    expect(await ledgerDump(e)).toEqual(before);
    // The same key string for b's own void: an independent write, not a's replay.
    const wb = await made(b);
    const own = await b.voidTx(wb.transactionId, { baseRevision: 1 }, aKey);
    expect([own.status, own.res.headers.get('idempotency-replayed'), own.json.transactionId]).toEqual([200, null, wb.transactionId]);
    expect((await header(active.transactionId)).status).toBe('active');
  });

  // ================================================================== history references (DEL-1 after a void)

  it('DEL-1: after a void through the API, the account, its currency, the card and the channel are still referenced — 409 IN_USE / CURRENCY_IN_USE', async () => {
    const s = await seedUser(e);
    const w = await made(s, spend(s, { paymentChannelId: s.PP }));
    await voided(s, w.transactionId);
    const account = await s.api.del(`/api/accounts/${s.HK}`);
    expect([account.status, account.json.code, account.json.details.references.transactions]).toEqual([409, 'IN_USE', 1]);
    const currency = await s.api.req('PUT', `/api/accounts/${s.HK}/currencies`, { currencies: [{ code: 'USD', isDefault: true }] });
    expect([currency.status, currency.json.code, currency.json.details.currencies]).toEqual([409, 'CURRENCY_IN_USE', ['HKD']]);
    expect((await s.api.del(`/api/cards/${s.K}`)).json).toMatchObject({ code: 'IN_USE', details: { references: { transactions: 1 } } });
    expect((await s.api.del(`/api/payment-channels/${s.PP}`)).json).toMatchObject({ code: 'IN_USE', details: { references: { transactions: 1 } } });
    expect((await counts(e, s.id)).transactions).toBe(1);
  });
});
