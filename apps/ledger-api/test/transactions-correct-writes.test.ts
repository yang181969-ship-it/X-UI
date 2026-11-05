// M3-B3-C: POST /transactions/:id/revisions as a financial write — idempotency and replay across
// versions (API_SPEC §5.0.3; TEST_PLAN IDEM-1/4/5/6/11/12/13/14, RTY-2), injected failures (FI),
// concurrency (CC-3, CC-6 with a void, CC-9 the controlled retry of a fact correction) and the
// database-error / HTTP-error boundary (ISO-6, ISO-7). Every case runs on libsql and on wrangler's
// local in-memory D1 through the real HTTP app. All data is fictional.
import { requestHashV1, transactionCorrectionSchema } from '@xui/ledger-shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  batchHooks,
  counts,
  driverError,
  factOf,
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

type Body = Record<string, unknown>;
type Json = any;

const DAY = 86_400_000;
const TTL = 30 * DAY;

describe.each(['libsql', 'd1'] as const)('POST /transactions/:id/revisions — idempotency, failures and concurrency on %s', (engine) => {
  let e: Engine;
  let realNow: () => number;
  beforeAll(async () => {
    e = await startEngine(engine, 'xui-v1-txn-correct-writes-d1');
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
  const corrected = async (s: Seed, T: string, body: Body, key = newKey()): Promise<Json> => {
    const r = await s.correct(T, body, key);
    expect([r.status, r.res.headers.get('idempotency-replayed')], JSON.stringify(r.json)).toEqual([201, null]);
    return r.json;
  };
  const header = async (T: string) => (await e.all('SELECT * FROM transactions WHERE id = ?', T))[0]!;
  const revisionsOf = async (T: string) => (await e.all('SELECT revision FROM transaction_events WHERE transaction_id = ? ORDER BY revision', T)).map((r) => Number(r.revision));
  const correctAudits = (userId: string) => e.all("SELECT * FROM audit_log WHERE user_id = ? AND action = 'transaction.correct' ORDER BY rowid", userId);
  const settle = (baseRevision: number, entries: Body[], x: Body = {}): Body => ({ kind: 'settlement', baseRevision, reason: null, entries, ...x });
  const snapshot = (baseRevision: number, x: Body): Body => ({ kind: 'snapshot_correction', baseRevision, reason: 'recorded wrongly', ...x });
  const expectNoLeak = (json: unknown) => expect(JSON.stringify(json)).not.toMatch(LEAKS);
  const at = async (s: Seed, t: number) => {
    e.t.clock.t = Math.max(e.t.clock.t, t - 60_000);
    await s.relogin();
    expect(t).toBeGreaterThanOrEqual(e.t.clock.t);
    e.t.clock.t = t;
  };
  /** An own transfer with both sides pending (for settlements). */
  const pendingTransfer = (s: Seed) =>
    ownTransfer(s, {
      entries: [
        { direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'pending', amount: null },
        { direction: 'in', accountId: s.BE, currency: 'USD', amountStatus: 'pending', amount: null },
      ],
    });
  /** A CN-account spend at a merchant of unknown country: undetermined while the account is CN. */
  const unknownMerchant = (s: Seed) => factOf(spend(s), { merchantCountry: null, eventCurrency: 'CNY', cardId: null, entries: [{ direction: 'out', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 100 }] });

  // ================================================================== the key (IDEM-1, IDEM-5, IDEM-11, IDEM-13)

  it('IDEM-1: a correction without a key is 400 IDEMPOTENCY_KEY_REQUIRED, with a malformed one IDEMPOTENCY_KEY_INVALID — before the body; nothing written', async () => {
    const s = await seedUser(e);
    const T = (await made(s)).transactionId;
    const before = await ledgerDump(e);
    for (const body of [snapshot(1, { homeRegion: 'JP' }), { junk: true }]) {
      expect((await s.correct(T, body, null)).json.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      for (const bad of ['a'.repeat(15), 'a'.repeat(65), 'has space 0123456789']) expect((await s.correct(T, body, bad)).json.code).toBe('IDEMPOTENCY_KEY_INVALID');
    }
    expect(await ledgerDump(e)).toEqual(before);
  });

  it('IDEM-5 / IDEM-11 / IDEM-13: a used key with any other correction, kind, base or transaction is 409 with only the caller’s data; normalized-equal bodies replay; request-only errors (missing recordMode, sensitive reason) are their own 400; a shape error after the key is the 409', async () => {
    const s = await seedUser(e);
    const body = ownTransfer(s);
    const [w, w2] = [await made(s, body), await made(s, body)];
    const T = w.transactionId as string;
    const key = newKey();
    const fact = factOf(body, { transferMethod: 'fps' });
    const first = await corrected(s, T, fact, key);
    expect((await keyRow(e, s.id, key))!.request_hash).toBe(await requestHashV1('transaction.correct', T, transactionCorrectionSchema.parse(fact)));
    // Same request, keys and entries reversed, defaults spelled out: a replay.
    const reordered = Object.fromEntries(Object.entries({ ...fact, entries: [...(fact.entries as Body[])].reverse().map((en) => ({ ...en, closedCurrencyAck: false })), occurredTime: null, postedOn: null }).reverse());
    const again = await s.correct(T, reordered, key);
    expect([again.status, again.res.headers.get('idempotency-replayed')]).toEqual([201, 'true']);
    expect(again.json).toEqual(first);
    const before = await ledgerDump(e);
    const conflict = { operation: 'transaction.correct', transactionId: T };
    const others: [string, Body][] = [
      [T, { ...fact, reason: 'another reason' }],
      [T, { ...fact, baseRevision: 2 }],
      [T, snapshot(1, { homeRegion: 'JP' })],
      [w2.transactionId, fact],
      ['no-such-transaction-000000', fact],
      // Shape errors depend on the stored type: judged after the key → the caller's 409.
      [T, factOf(body, { entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 1 }, { direction: 'out', accountId: s.BE, currency: 'USD', amountStatus: 'confirmed', amount: 1 }] })],
    ];
    for (const [id, other] of others) {
      const r = await s.correct(id, other, key);
      expect([r.status, r.json.code, r.json.details], JSON.stringify(other).slice(0, 60)).toEqual([409, 'IDEMPOTENCY_CONFLICT', conflict]);
    }
    expect((await s.correct(T, { ...fact, recordMode: undefined }, key)).json.code).toBe('VALIDATION');
    expect((await s.correct(T, { ...fact, reason: 'card 4111 1111 1111 1111' }, key)).json.code).toBe('SENSITIVE_DATA');
    expect((await s.correct(T, { ...fact, occurredOn: '2099-01-01' }, key)).json.code).toBe('VALIDATION');
    // The same correction key for a void or a create, and a create key for a correction.
    expect((await s.voidTx(T, { baseRevision: 2 }, key)).json).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', details: conflict });
    expect((await s.post(body, key)).json).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', details: conflict });
    expect(await ledgerDump(e)).toEqual(before);
  });

  // ================================================================== replay across versions (IDEM-3, IDEM-4)

  it('IDEM-4 across versions: create r1 → correct r2 → correct r3 → notes, names and statuses change → void: every key still replays its own first bytes (201 / 201 / 200), never the current state', async () => {
    const s = await seedUser(e);
    const body = spend(s, { paymentChannelId: s.PP });
    const ck = newKey();
    const create = await s.postBytes(body, ck);
    expect(create.status).toBe(201);
    const T = JSON.parse(create.text).transactionId as string;
    const k2 = newKey();
    const c2 = await s.correctBytes(T, factOf(body, { merchantName: 'Second' }), k2);
    expect([c2.status, c2.res.headers.get('idempotency-replayed')]).toEqual([201, null]);
    expect(JSON.parse(c2.text)).toMatchObject({ operation: 'transaction.correct', revision: 2, statusAfter: 'active', void: null });
    // ① the create after r2.
    const sameBytes = (a: { bytes: Uint8Array }, b: { bytes: Uint8Array }) => Buffer.from(a.bytes).equals(Buffer.from(b.bytes));
    const r1 = await s.postBytes(body, ck);
    expect([r1.status, r1.res.headers.get('idempotency-replayed'), sameBytes(r1, create)]).toEqual([201, 'true', true]);
    // ② r2's key after r3.
    const k3 = newKey();
    const c3 = await s.correctBytes(T, factOf(body, { baseRevision: 2, merchantName: 'Third' }), k3);
    expect(c3.status).toBe(201);
    const r2 = await s.correctBytes(T, factOf(body, { merchantName: 'Second' }), k2);
    expect([r2.status, r2.res.headers.get('idempotency-replayed'), sameBytes(r2, c2)]).toEqual([201, 'true', true]);
    // ④ notes, account name, card status, channel name change; the clock moves (within 30 days).
    expect((await s.notes(T, { notes: 'later notes' })).status).toBe(200);
    expect((await s.api.patch(`/api/accounts/${s.HK}`, { name: 'Renamed HK' })).status).toBe(200);
    expect((await s.api.patch(`/api/cards/${s.K}`, { status: 'closed' })).status).toBe(200);
    expect((await s.api.patch(`/api/payment-channels/${s.PP}`, { name: `Renamed ${k2}` })).status).toBe(200);
    e.t.advance(DAY);
    const r2b = await s.correctBytes(T, factOf(body, { merchantName: 'Second' }), k2);
    expect(sameBytes(r2b, c2)).toBe(true);
    // ③ after a void: each key its own first result.
    const vk = newKey();
    const v = await s.voidBytes(T, { baseRevision: 3 }, vk);
    expect(v.status).toBe(200);
    const dump = await ledgerDump(e);
    const finals = [[await s.postBytes(body, ck), create, 201], [await s.correctBytes(T, factOf(body, { merchantName: 'Second' }), k2), c2, 201], [await s.correctBytes(T, factOf(body, { baseRevision: 2, merchantName: 'Third' }), k3), c3, 201], [await s.voidBytes(T, { baseRevision: 3 }, vk), v, 200]] as const;
    for (const [replay, original, status] of finals) {
      expect([replay.status, replay.res.headers.get('idempotency-replayed'), sameBytes(replay, original)]).toEqual([status, 'true', true]);
    }
    expect(JSON.parse(c2.text).event.merchantName).toBe('Second');
    expect(c2.text).not.toMatch(/later notes|Renamed|currentRevision/);
    // No replay wrote anything.
    expect(await ledgerDump(e)).toEqual(dump);
    expect(await revisionsOf(T)).toEqual([1, 2, 3]);
    expect(await correctAudits(s.id)).toHaveLength(2);
  });

  it('IDEM-4: the replay of a settlement and of a snapshot correction is the first result’s bytes too', async () => {
    const s = await seedUser(e);
    const T = (await made(s, pendingTransfer(s))).transactionId as string;
    for (const [body, n] of [[settle(1, [{ direction: 'out', amount: 100000 }]), 2], [snapshot(2, { homeRegion: 'JP' }), 3]] as const) {
      const key = newKey();
      const first = await s.correctBytes(T, body, key);
      expect(first.status).toBe(201);
      const again = await s.correctBytes(T, body, key);
      expect([again.status, again.res.headers.get('idempotency-replayed'), Buffer.from(again.bytes).equals(Buffer.from(first.bytes))]).toEqual([201, 'true', true]);
      expect(JSON.parse(first.text).revision).toBe(n);
    }
  });

  // ================================================================== failures keep no key (IDEM-6, IDEM-12)

  it('IDEM-6: a correction that failed (404, 409 REVISION_CONFLICT, 400 no change, 400 CONFIRMED_DOMESTIC, injected 500) stores no key; the same key then runs exactly once', async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    const body = spend(a);
    const T = (await made(a, body)).transactionId as string;
    const foreign = (await made(b)).transactionId;
    const key = newKey();
    expect((await a.correct(foreign, factOf(body), key)).status).toBe(404);
    expect((await a.correct(T, factOf(body, { baseRevision: 2, merchantName: 'x' }), key)).json.code).toBe('REVISION_CONFLICT');
    expect((await a.correct(T, factOf(body), key)).json.code).toBe('VALIDATION');
    expect((await a.correct(T, factOf(body, { merchantCountry: 'CN', eventCurrency: 'CNY', cardId: null, entries: [{ direction: 'out', accountId: a.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 1 }] }), key)).json.code).toBe('CONFIRMED_DOMESTIC');
    const injected = await raising(e, 'transaction_events', 'INSERT', null, 'TEST_INJECTED_FAILURE', () => a.correct(T, factOf(body, { merchantName: 'Fixed' }), key));
    expect([injected.status, injected.json]).toEqual([500, INTERNAL]);
    expect(await keyRow(e, a.id, key)).toBeUndefined();
    await corrected(a, T, factOf(body, { merchantName: 'Fixed' }), key);
    expect(await revisionsOf(T)).toEqual([1, 2]);
  });

  it('IDEM-12 / IDEM-14: an unknown hash_version is a 500 only on a live key; a correction key replays until expires_at and is no key from then on — the original request is 409 REVISION_CONFLICT', async () => {
    const s = await seedUser(e);
    const body = spend(s);
    const [w1, w2] = [await made(s, body), await made(s, body)];
    const live = newKey();
    const now = e.t.clock.t;
    const rawKey = (key: string, hv: number, createdAt: number, expiresAt: number) =>
      e.exec(
        'INSERT INTO ledger_idempotency_keys (user_id, key, operation, request_hash, hash_version, op_id, transaction_id, result_revision, result_event_id, audit_id, response_status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 201, ?, ?)',
        s.id, key, 'transaction.correct', 'c'.repeat(64), hv, `op-${key}`, w1.transactionId, w1.eventId, `audit-${key}`, createdAt, expiresAt,
      );
    await rawKey(live, 99, now, now + TTL);
    const r = await quietly(() => s.correct(w1.transactionId, factOf(body, { merchantName: 'x' }), live));
    expect([r.status, r.json]).toEqual([500, INTERNAL]);
    const old = newKey();
    await rawKey(old, 99, now - TTL - 10, now - 10);
    await corrected(s, w2.transactionId, factOf(body, { merchantName: 'y' }), old);
    expect(await keyRow(e, s.id, old)).toMatchObject({ hash_version: 1, transaction_id: w2.transactionId });

    const key = newKey();
    const fact = factOf(body, { merchantName: 'Expiring' });
    const first = await s.correctBytes(w1.transactionId, fact, key);
    expect(first.status).toBe(201);
    const expiresAt = Number((await keyRow(e, s.id, key))!.expires_at);
    expect(expiresAt).toBe(e.t.clock.t + TTL);
    await at(s, expiresAt - 1);
    const last = await s.correctBytes(w1.transactionId, fact, key);
    expect([last.status, last.res.headers.get('idempotency-replayed'), last.text === first.text]).toEqual([201, 'true', true]);
    e.t.clock.t = expiresAt;
    const original = await s.correct(w1.transactionId, fact, key);
    expect([original.status, original.json.code, original.json.details, original.res.headers.get('idempotency-replayed')]).toEqual([409, 'REVISION_CONFLICT', { currentRevision: 2 }, null]);
    expect(await revisionsOf(w1.transactionId)).toEqual([1, 2]);
  });

  // ================================================================== lost responses (RTY-2), injected failures (FI)

  it('RTY-2: the correction committed but the response was lost — 500, no re-run; the same key replays 201; exactly one new version and one audit', async () => {
    const s = await seedUser(e);
    const body = spend(s);
    const T = (await made(s, body)).transactionId as string;
    const key = newKey();
    const fact = factOf(body, { merchantName: 'Lost response' });
    const spy = batchHooks(e, [{ after: async (err) => { if (!err) throw new Error('fetch failed: socket hang up'); } }]);
    const lost = await quietly(() => s.correct(T, fact, key));
    expect([lost.status, lost.json]).toEqual([500, INTERNAL]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    const retry = await s.correct(T, fact, key);
    expect([retry.status, retry.res.headers.get('idempotency-replayed')]).toEqual([201, 'true']);
    expect(retry.json).toMatchObject({ revision: 2, event: { merchantName: 'Lost response' } });
    expect(await revisionsOf(T)).toEqual([1, 2]);
    expect(await correctAudits(s.id)).toHaveLength(1);
  });

  it('FI: for each kind, an injected failure at S0, the new event, each entry, the publish, the audit or the key row is a generic 500 with the database unchanged; the same key then corrects once', async () => {
    const s = await seedUser(e);
    const body = pendingTransfer(s);
    const kinds: [string, Body][] = [
      ['settlement', settle(1, [{ direction: 'out', amount: 100000 }])],
      ['fact_correction', factOf(body, { transferMethod: 'fps' })],
      ['snapshot_correction', snapshot(1, { homeRegion: 'JP' })],
    ];
    const steps: [string, string, 'INSERT' | 'UPDATE' | 'DELETE', string | null][] = [
      ['S0', 'ledger_idempotency_keys', 'DELETE', null],
      ['S1', 'transaction_events', 'INSERT', null],
      ['S2 out', 'transaction_entries', 'INSERT', "NEW.direction = 'out'"],
      ['S2 in', 'transaction_entries', 'INSERT', "NEW.direction = 'in'"],
      ['S3', 'transactions', 'UPDATE', null],
      ['S4', 'audit_log', 'INSERT', "NEW.action = 'transaction.correct'"],
      ['S5', 'ledger_idempotency_keys', 'INSERT', null],
    ];
    for (const [kind, correction] of kinds) {
      for (const [step, table, event, when] of steps) {
        const w = await made(s, body);
        if (step === 'S0') {
          const now = e.t.clock.t;
          await e.exec(
            'INSERT INTO ledger_idempotency_keys (user_id, key, operation, request_hash, hash_version, op_id, transaction_id, result_revision, result_event_id, audit_id, response_status, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?, ?, 201, ?, ?)',
            s.id, newKey(), 'transaction.correct', 'd'.repeat(64), `op-old-${newKey()}`, w.transactionId, w.eventId, 'audit-old', now - TTL - 10, now - 10,
          );
        }
        const key = newKey();
        const before = await ledgerDump(e);
        const r = await raising(e, table, event, when, 'TEST_INJECTED_FAILURE', () => s.correct(w.transactionId, correction, key));
        expect([r.status, r.json], `${kind} ${step}`).toEqual([500, INTERNAL]);
        expect(await ledgerDump(e), `${kind} ${step}`).toEqual(before);
        const retry = await s.correct(w.transactionId, correction, key);
        expect([retry.status, retry.res.headers.get('idempotency-replayed')], `${kind} ${step}`).toEqual([201, null]);
        expect(await revisionsOf(w.transactionId)).toEqual([1, 2]);
      }
    }
    expect(await correctAudits(s.id)).toHaveLength(kinds.length * steps.length);
  }, 120_000);

  // ================================================================== concurrency (CC-3, CC-6)

  it('CC-3: two corrections on one baseRevision with different keys — at once and with both past the checks — one 201, one 409 REVISION_CONFLICT; versions stay contiguous', async () => {
    const s = await seedUser(e);
    const body = spend(s);
    const T1 = (await made(s, body)).transactionId as string;
    const rs = await Promise.all([s.correct(T1, factOf(body, { merchantName: 'A' })), s.correct(T1, snapshot(1, { homeRegion: 'JP' }))]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(rs.find((r) => r.status === 409)!.json).toMatchObject({ code: 'REVISION_CONFLICT', details: { currentRevision: 2 } });
    expect(await revisionsOf(T1)).toEqual([1, 2]);
    const T2 = (await made(s, body)).transactionId as string;
    let second: Promise<Awaited<ReturnType<Seed['correct']>>> | undefined;
    const spy = batchHooks(e, [{ before: async () => { second = s.correct(T2, factOf(body, { merchantName: 'B' })); await new Promise((r) => setTimeout(r, 50)); } }]);
    const first = await s.correct(T2, factOf(body, { merchantName: 'A' }));
    const other = await second!;
    expect(spy).toHaveBeenCalledTimes(2);
    expect([first.status, other.status].sort()).toEqual([201, 409]);
    expect([first, other].find((r) => r.status === 409)!.json).toEqual({ error: expect.any(String), code: 'REVISION_CONFLICT', details: { currentRevision: 2 } });
    expect(spy.mock.settledResults.map((r) => r.type).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await revisionsOf(T2)).toEqual([1, 2]);
    expect(await correctAudits(s.id)).toHaveLength(2);
  });

  it('CC-3: a correction and a void on one baseRevision, both past the checks — the void first: 409 TRANSACTION_VOIDED; the correction first: the void is 409 REVISION_CONFLICT', async () => {
    const s = await seedUser(e);
    const body = spend(s);
    for (const first of ['void', 'correct'] as const) {
      const T = (await made(s, body)).transactionId as string;
      const doVoid = () => s.voidTx(T, { baseRevision: 1 });
      const doCorrect = () => s.correct(T, factOf(body, { merchantName: 'Race' }));
      let winner: Promise<{ status: number; json: Json }> | undefined;
      // The loser's batch waits until the winner (started inside the hook) has committed.
      const spy = batchHooks(e, [{ before: async () => { winner = first === 'void' ? doVoid() : doCorrect(); await winner; } }]);
      const loser = await (first === 'void' ? doCorrect() : doVoid());
      const won = await winner!;
      spy.mockRestore();
      expect(won.status).toBe(first === 'void' ? 200 : 201);
      expect([loser.status, loser.json.code], first).toEqual([409, first === 'void' ? 'TRANSACTION_VOIDED' : 'REVISION_CONFLICT']);
      expect(await revisionsOf(T)).toEqual(first === 'void' ? [1] : [1, 2]);
      expect((await header(T)).status).toBe(first === 'void' ? 'voided' : 'active');
    }
  });

  it('CC: one key, the same correction twice at once (also both past the lookup) → one 201 and one replay; one version, one audit, one key row', async () => {
    const s = await seedUser(e);
    const body = spend(s);
    const T = (await made(s, body)).transactionId as string;
    const key = newKey();
    let second: Promise<Awaited<ReturnType<Seed['correct']>>> | undefined;
    const spy = batchHooks(e, [{ before: async () => { second = s.correct(T, factOf(body, { merchantName: 'Once' }), key); await new Promise((r) => setTimeout(r, 50)); } }]);
    const first = await s.correct(T, factOf(body, { merchantName: 'Once' }), key);
    const other = await second!;
    expect(spy).toHaveBeenCalledTimes(2);
    expect([first.status, other.status]).toEqual([201, 201]);
    expect([first.res.headers.get('idempotency-replayed'), other.res.headers.get('idempotency-replayed')].filter(Boolean)).toEqual(['true']);
    expect(first.json).toEqual(other.json);
    expect(await revisionsOf(T)).toEqual([1, 2]);
    expect(await correctAudits(s.id)).toHaveLength(1);
    expect(await counts(e, s.id)).toMatchObject({ ledger_idempotency_keys: 2 });
  });

  // ================================================================== the controlled retry (CC-9, Q-B3-8)

  it('CC-9: a new account’s jurisdiction changes after the checks and changes the classification → one retry with the same key, hash and time saves the new snapshot; a carried account’s change needs none', async () => {
    const s = await seedUser(e);
    const T = (await made(s)).transactionId as string;
    const key = newKey();
    let spy = batchHooks(e, [{ before: () => e.exec("UPDATE accounts SET account_country = 'HK' WHERE id = ?", s.CN) }]);
    const r = await s.correct(T, unknownMerchant(s), key);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(r.json.event).toMatchObject({ foreignStatus: 'foreign', merchantScope: 'unknown' });
    expect(r.json.entries[0]).toMatchObject({ fundingAccountCountry: 'HK', countrySource: 'account_at_save' });
    expect((await keyRow(e, s.id, key))!.request_hash).toBe(await requestHashV1('transaction.correct', T, transactionCorrectionSchema.parse(unknownMerchant(s))));
    expect(await revisionsOf(T)).toEqual([1, 2]);
    expect(await correctAudits(s.id)).toHaveLength(1);
    spy.mockRestore();
    // The account is now carried (in version 2): its later change is not read, no retry.
    spy = batchHooks(e, [{ before: () => e.exec("UPDATE accounts SET account_country = 'CN' WHERE id = ?", s.CN) }]);
    const carried = await s.correct(T, { ...unknownMerchant(s), baseRevision: 2, occurredTime: '08:00' });
    expect([carried.status, carried.json.entries?.[0]?.fundingAccountCountry]).toEqual([201, 'HK']);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('CC-9: a currency closed after the checks (new account / switched currency) → retry → 400 CURRENCY_NOT_ON_ACCOUNT; a carried same-currency entry is not affected; a second change → 409 CONCURRENT_CHANGE', async () => {
    const s = await seedUser(e);
    const body = spend(s);
    const T = (await made(s, body)).transactionId as string;
    let spy = batchHooks(e, [{ before: () => e.exec("UPDATE account_currencies SET status = 'closed' WHERE account_id = ? AND currency = 'USD'", s.HK) }]);
    const switched = await s.correct(T, factOf(body, { entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 1000 }] }));
    expect([switched.status, switched.json.code, switched.json.details]).toEqual([400, 'CURRENCY_NOT_ON_ACCOUNT', { direction: 'out', currency: 'USD', status: 'closed' }]);
    expect(spy).toHaveBeenCalledTimes(1); // the retry's own checks refuse before writing
    spy.mockRestore();
    // A carried same-currency entry (BE · EUR, not the account's default): closing EUR after the checks is no conflict.
    const eurBody = spend(s, { cardId: null, entries: [{ direction: 'out', accountId: s.BE, currency: 'EUR', amountStatus: 'confirmed', amount: 900 }] });
    const eurT = (await made(s, eurBody)).transactionId as string;
    spy = batchHooks(e, [{ before: () => e.exec("UPDATE account_currencies SET status = 'closed' WHERE account_id = ? AND currency = 'EUR'", s.BE) }]);
    const same = await s.correct(eurT, factOf(eurBody, { merchantName: 'Still EUR' }));
    expect([same.status, same.json.entries?.[0]?.currencyStatusAtSave]).toEqual([201, 'closed']);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    // Changed twice: CONCURRENT_CHANGE, nothing written, the same key then works.
    const key = newKey();
    const t2 = (await made(s)).transactionId as string;
    spy = batchHooks(e, [
      { before: () => e.exec("UPDATE accounts SET account_country = 'HK' WHERE id = ?", s.CN) },
      { before: () => e.exec("UPDATE accounts SET account_country = 'CN' WHERE id = ?", s.CN) },
    ]);
    const twice = await s.correct(t2, unknownMerchant(s), key);
    expect([twice.status, twice.json.code]).toEqual([409, 'CONCURRENT_CHANGE']);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
    expect(await revisionsOf(t2)).toEqual([1]);
    expect((await s.correct(t2, unknownMerchant(s), key)).json.event?.foreignStatus).toBe('undetermined');
  });

  it('CC-9: LEDGER_CLASSIFICATION / LEDGER_CLOSED_CURRENCY without a changed source — and any LEDGER_* in a settlement or snapshot correction — are a generic 500 after one attempt', async () => {
    const s = await seedUser(e);
    const body = pendingTransfer(s);
    const T = (await made(s, body)).transactionId as string;
    const cases: Body[] = [factOf(body, { transferMethod: 'fps' }), settle(1, [{ direction: 'out', amount: 1 }]), snapshot(1, { homeRegion: 'JP' })];
    for (const correction of cases) {
      for (const code of ['LEDGER_CLASSIFICATION', 'LEDGER_CLOSED_CURRENCY']) {
        const spy = batchHooks(e, []);
        const before = await ledgerDump(e);
        const r = await raising(e, 'transaction_entries', 'INSERT', null, `${code}: injected`, () => s.correct(T, correction));
        expect([r.status, r.json], `${correction.kind} ${code}`).toEqual([500, INTERNAL]);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(await ledgerDump(e)).toEqual(before);
        spy.mockRestore();
      }
    }
  });

  it('one server time per request: a correction (also with a controlled retry) reads the clock once beyond the session check; the version, audit and key row share it', async () => {
    const s = await seedUser(e);
    const T = (await made(s)).transactionId as string;
    const session = await (async () => {
      let n = 0;
      e.t.deps.now = () => (n++, e.t.clock.t);
      await s.api.get(`/api/transactions/${T}`);
      return n;
    })();
    let reads = 0;
    e.t.deps.now = () => (reads++, e.t.clock.t);
    const spy = batchHooks(e, [{ before: () => e.exec("UPDATE accounts SET account_country = 'HK' WHERE id = ?", s.CN) }]);
    const key = newKey();
    const r = await s.correct(T, unknownMerchant(s), key);
    expect([r.status, spy.mock.calls.length]).toEqual([201, 2]);
    expect(reads).toBe(session + 1);
    const k = (await keyRow(e, s.id, key))!;
    const [audit] = await correctAudits(s.id);
    expect([r.json.event.createdAt, r.json.recordedAt, k.created_at, audit!.created_at, (await header(T)).updated_at]).toEqual(Array(5).fill(k.created_at));
    expect(k.expires_at).toBe(Number(k.created_at) + TTL);
  });

  // ================================================================== the database-error / HTTP-error boundary (ISO-7)

  it('ISO-7 ①: voided, corrected, a new account deleted or its currency removed between the checks and the batch → re-read as the caller → 409 / 404 / 400, same bodies as before writing', async () => {
    const s = await seedUser(e);
    const body = spend(s);
    const extra = async (currencies: Body[]) => (await s.api.post('/api/accounts', { institutionId: s.I, name: `Spare ${newKey()}`, accountType: 'bank', accountCountry: 'SG', currencies })).json.id as string;
    const missingAccount = (await s.correct((await made(s, body)).transactionId, factOf(body, { entries: [{ direction: 'out', accountId: 'no-such-account-0000000000', currency: 'SGD', amountStatus: 'confirmed', amount: 1 }] }))).json;
    const a1 = await extra([{ code: 'SGD', isDefault: true }]);
    const a2 = await extra([{ code: 'SGD', isDefault: true }, { code: 'USD' }]);
    const cases: [string, (T: string) => Promise<unknown>, (T: string) => Body, unknown][] = [
      ['voided', (T) => voidTxn(e, s, T), () => factOf(body, { merchantName: 'x' }), { error: expect.any(String), code: 'TRANSACTION_VOIDED' }],
      ['corrected', (T) => s.correct(T, snapshot(1, { homeRegion: 'JP' })), () => factOf(body, { merchantName: 'x' }), { error: expect.any(String), code: 'REVISION_CONFLICT', details: { currentRevision: 2 } }],
      ['account deleted', () => e.exec('DELETE FROM accounts WHERE id = ?', a1), () => factOf(body, { entries: [{ direction: 'out', accountId: a1, currency: 'SGD', amountStatus: 'confirmed', amount: 1 }] }), missingAccount],
      ['currency removed', () => e.exec("DELETE FROM account_currencies WHERE account_id = ? AND currency = 'USD'", a2), () => factOf(body, { entries: [{ direction: 'out', accountId: a2, currency: 'USD', amountStatus: 'confirmed', amount: 1 }] }),
        { error: expect.any(String), code: 'CURRENCY_NOT_ON_ACCOUNT', details: { direction: 'out', currency: 'USD', status: null } }],
    ];
    for (const [what, change, correction, expected] of cases) {
      const T = (await made(s, body)).transactionId as string;
      const key = newKey();
      const spy = batchHooks(e, [{ before: () => change(T) }]);
      const r = await s.correct(T, correction(T), key);
      spy.mockRestore();
      expect(r.json, what).toEqual(expected);
      expect(await keyRow(e, s.id, key), what).toBeUndefined();
    }
  });

  it('ISO-7 ② / ③: an incomplete key row or foreign-key failure that re-reading cannot explain, a guard error the server never triggers, CHECK and other UNIQUE → generic 500, nothing written, no database words', async () => {
    const s = await seedUser(e);
    const body = spend(s);
    const T = (await made(s, body)).transactionId as string;
    for (const [message, extended] of [['FOREIGN KEY constraint failed', 'SQLITE_CONSTRAINT_FOREIGNKEY'], ['NOT NULL constraint failed: ledger_idempotency_keys.result_event_id', 'SQLITE_CONSTRAINT_NOTNULL']]) {
      const spy = batchHooks(e, [{ replace: async () => { throw driverError(e.name, message!, extended!); } }]);
      const r = await quietly(() => s.correct(T, factOf(body, { merchantName: 'x' })));
      expect([r.status, r.json], message).toEqual([500, INTERNAL]);
      spy.mockRestore();
    }
    const codes = ['LEDGER_SNAPSHOT_SOURCE', 'LEDGER_REVISION_KIND', 'LEDGER_REVISION_ORDER', 'LEDGER_ENTRY_COUNT', 'LEDGER_EVENT_AMOUNT', 'LEDGER_CONFIRMED_DOMESTIC', 'LEDGER_IMMUTABLE', 'LEDGER_VOIDED', 'LEDGER_KEY_IMMUTABLE'];
    const messages = [...codes.map((c) => `${c}: injected`), 'CHECK constraint failed: transaction_events_merchant_scope_rule_ck', 'UNIQUE constraint failed: transaction_events.transaction_id, transaction_events.revision'];
    const spy = batchHooks(e, []);
    const before = await ledgerDump(e);
    for (const message of messages) {
      const r = await raising(e, 'transaction_events', 'INSERT', null, message, () => s.correct(T, factOf(body, { merchantName: 'x' })));
      expect([r.status, r.json], message).toEqual([500, INTERNAL]);
      expectNoLeak(r.json);
    }
    expect(spy).toHaveBeenCalledTimes(messages.length);
    expect(await ledgerDump(e)).toEqual(before);
  });
});
