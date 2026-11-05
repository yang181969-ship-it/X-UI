// M3-B3-D: the life of correction and void keys through HTTP on a controlled clock (TEST_PLAN IDEM-8,
// IDEM-14; API_SPEC §5.0.3; DATA_MODEL §10.5): replay inside the 30 days, 1 ms before expires_at, at
// it and after; expired rows that are still stored (no write of the user yet) and the S0 that removes
// them; reuse of an expired key; create keys that never expire; per-user cleanup with the same key
// strings; and a committed write whose response was lost. Lookup, S0 and gate G use the request's
// one `now` and the same boundary (expires_at <= now). libsql and local D1. Fictional data.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchHooks, factOf, INTERNAL, keyRow, ledgerDump, newKey, quietly, seedUser, spend, startEngine, type Engine, type Seed } from './transactions-kit.ts';

type Body = Record<string, unknown>;
type Json = any;

const DAY = 86_400_000;
const TTL = 30 * DAY;

describe.each(['libsql', 'd1'] as const)('IDEM-8: the 30-day life of correction and void keys on %s', (engine) => {
  let e: Engine;
  beforeAll(async () => {
    e = await startEngine(engine, 'xui-v1-txn-lifecycle-d1');
  }, 180_000);
  afterAll(async () => {
    await e?.dispose();
  });
  beforeEach(() => e.ping());
  afterEach(() => vi.restoreAllMocks());

  const made = async (s: Seed, key = newKey()): Promise<Json> => {
    const r = await s.postBytes(spend(s), key);
    expect(r.status, r.text).toBe(201);
    return { ...JSON.parse(r.text), first: r };
  };
  const sameBytes = (a: { bytes: Uint8Array }, b: { bytes: Uint8Array }) => Buffer.from(a.bytes).equals(Buffer.from(b.bytes));
  const replayed = (r: { status: number; res: Response }) => [r.status, r.res.headers.get('idempotency-replayed')];
  /** Move the clock forward to t: after a jump of days, sessions idle for 7 days are gone, so sign everyone in again just before t. */
  const at = async (users: Seed[], t: number) => {
    if (t - e.t.clock.t > DAY) {
      e.t.clock.t = t - 600_000;
      for (const u of users) await u.relogin();
    }
    expect(t).toBeGreaterThanOrEqual(e.t.clock.t);
    e.t.clock.t = t;
  };
  const keysOf = async (userId: string) =>
    e.all('SELECT key, operation, transaction_id, created_at, expires_at FROM ledger_idempotency_keys WHERE user_id = ? ORDER BY created_at, key', userId);
  const revisionsOf = async (T: string) => (await e.all('SELECT revision FROM transaction_events WHERE transaction_id = ? ORDER BY revision', T)).map((r) => Number(r.revision));
  const auditCount = async (userId: string, action: string) => Number((await e.all('SELECT count(*) AS n FROM audit_log WHERE user_id = ? AND action = ?', userId, action))[0]!.n);

  it('one correction key and one void key from first write to reuse: replay inside and 1 ms before expires_at, no key at and after it (409 from the transaction’s state, nothing written, rows still stored), cleaned by the user’s next write, reused once; create keys forever; another user’s same key strings untouched', async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    const [ck1, ck2, ck3] = [newKey(), newKey(), newKey()];
    const [A1, A2, A3] = [await made(a, ck1), await made(a, ck2), await made(a, ck3)];
    const [B1, B2] = [await made(b), await made(b)];
    const [kC, kV] = [newKey(), newKey()];
    const fact = (x: Body = {}) => factOf(spend(a), { merchantName: 'Within 30 days', ...x });
    const t0 = e.t.clock.t;
    const c = await a.correctBytes(A1.transactionId, fact(), kC);
    const v = await a.voidBytes(A2.transactionId, { baseRevision: 1, reason: 'duplicate' }, kV);
    // b uses the very same key strings (keys are per user).
    const bc = await b.correctBytes(B1.transactionId, factOf(spend(b), { merchantName: 'B' }), kC);
    const bv = await b.voidBytes(B2.transactionId, { baseRevision: 1 }, kV);
    for (const r of [c, bc]) expect(r.status).toBe(201);
    for (const r of [v, bv]) expect(r.status).toBe(200);
    const expiresAt = t0 + TTL;
    for (const [u, k] of [[a, kC], [a, kV], [b, kC], [b, kV]] as const) expect(await keyRow(e, u.id, k)).toMatchObject({ created_at: t0, expires_at: expiresAt });

    // ① Inside the 30 days and 1 ms before expires_at: the first bytes, nothing written.
    for (const t of [t0 + DAY, expiresAt - 1]) {
      await at([a, b], t);
      const dump = await ledgerDump(e);
      const rc = await a.correctBytes(A1.transactionId, fact(), kC);
      const rv = await a.voidBytes(A2.transactionId, { baseRevision: 1, reason: 'duplicate' }, kV);
      expect([...replayed(rc), sameBytes(rc, c), ...replayed(rv), sameBytes(rv, v)], `t0 + ${t - t0}`).toEqual([201, 'true', true, 200, 'true', true]);
      expect(await ledgerDump(e)).toEqual(dump);
    }
    // Still live at expires_at − 1: a different request with the key is a conflict, not a new write.
    const live = await a.correct(A3.transactionId, fact(), kC);
    expect([live.status, live.json.code, live.json.details]).toEqual([409, 'IDEMPOTENCY_CONFLICT', { operation: 'transaction.correct', transactionId: A1.transactionId }]);

    // ② At expires_at exactly (and after), before any other write of a: no key. The original requests
    //    are judged on the transaction as it is now; refused before writing, so the rows stay stored.
    for (const t of [expiresAt, expiresAt + DAY]) {
      await at([a, b], t);
      const dump = await ledgerDump(e);
      const oc = await a.correct(A1.transactionId, fact(), kC);
      expect([oc.status, oc.json.code, oc.json.details, oc.res.headers.get('idempotency-replayed')]).toEqual([409, 'REVISION_CONFLICT', { currentRevision: 2 }, null]);
      const ov = await a.voidTx(A2.transactionId, { baseRevision: 1, reason: 'duplicate' }, kV);
      expect([ov.status, ov.json.code, ov.res.headers.get('idempotency-replayed')]).toEqual([409, 'TRANSACTION_VOIDED', null]);
      expect(await ledgerDump(e)).toEqual(dump);
      expect((await keysOf(a.id)).filter((k) => k.expires_at !== null)).toHaveLength(2);
    }
    expect(await revisionsOf(A1.transactionId)).toEqual([1, 2]);
    expect([await auditCount(a.id, 'transaction.correct'), await auditCount(a.id, 'transaction.void')]).toEqual([1, 1]);

    // ③ A different valid request with the expired correction key: runs once; its own S0 removes
    //    both of a's expired rows (the void key too), never b's or a create key.
    const now = e.t.clock.t;
    const reuse = await a.correct(A3.transactionId, fact({ merchantName: 'After expiry' }), kC);
    expect(replayed(reuse)).toEqual([201, null]);
    expect(await keysOf(a.id)).toEqual(
      [
        { key: ck1, operation: 'transaction.create', transaction_id: A1.transactionId, created_at: expect.any(Number), expires_at: null },
        { key: ck2, operation: 'transaction.create', transaction_id: A2.transactionId, created_at: expect.any(Number), expires_at: null },
        { key: ck3, operation: 'transaction.create', transaction_id: A3.transactionId, created_at: expect.any(Number), expires_at: null },
        { key: kC, operation: 'transaction.correct', transaction_id: A3.transactionId, created_at: now, expires_at: now + TTL },
      ].sort((x, y) => Number(x.created_at) - Number(y.created_at) || x.key.localeCompare(y.key)),
    );
    expect((await keysOf(b.id)).filter((k) => k.expires_at !== null).map((k) => k.key).sort()).toEqual([kC, kV].sort());
    // The cleaned void key is free: a new void with it runs once, then replays.
    const v2 = await a.voidBytes(A3.transactionId, { baseRevision: 2 }, kV);
    expect(replayed(v2)).toEqual([200, null]);
    const v2r = await a.voidBytes(A3.transactionId, { baseRevision: 2 }, kV);
    expect([...replayed(v2r), sameBytes(v2r, v2)]).toEqual([200, 'true', true]);
    // The new correction key replays its own (new) result.
    const reuseReplay = await a.correct(A3.transactionId, fact({ merchantName: 'After expiry' }), kC);
    expect([...replayed(reuseReplay), reuseReplay.json]).toEqual([201, 'true', reuse.json]);

    // ④ b has not written since: its expired rows are still stored and still no key; b's next write cleans them.
    const ob = await b.correct(B1.transactionId, factOf(spend(b), { merchantName: 'B' }), kC);
    expect([ob.status, ob.json.code]).toEqual([409, 'REVISION_CONFLICT']);
    expect((await keysOf(b.id)).filter((k) => k.expires_at !== null)).toHaveLength(2);
    await made(b);
    expect((await keysOf(b.id)).filter((k) => k.expires_at !== null)).toEqual([]);
    expect((await keysOf(b.id)).filter((k) => k.operation === 'transaction.create')).toHaveLength(3);

    // ⑤ The create keys, 31 days and more after their writes: the exact first bytes, forever.
    for (const [w, k] of [[A1, ck1], [A2, ck2], [A3, ck3]] as const) {
      const r = await a.postBytes(spend(a), k);
      expect([...replayed(r), sameBytes(r, w.first)]).toEqual([201, 'true', true]);
    }
  }, 120_000);

  it('S0, gate G and the lookup agree on the boundary: at T a write removes exactly the keys with expires_at <= T; a key 1 ms younger stays and still replays; with S0 taken out of the batch gate G stops a reuse (500, nothing written)', async () => {
    const s = await seedUser(e);
    const [w1, w2, w3] = [await made(s), await made(s), await made(s)];
    const [k1, k2] = [newKey(), newKey()];
    const t0 = e.t.clock.t;
    const c1 = await s.correctBytes(w1.transactionId, factOf(spend(s), { merchantName: 'k1' }), k1);
    e.t.clock.t = t0 + 1;
    const c2 = await s.correctBytes(w2.transactionId, factOf(spend(s), { merchantName: 'k2' }), k2);
    expect([c1.status, c2.status]).toEqual([201, 201]);

    await at([s], t0 + TTL);
    // k1 is expired: taking it out of the batch's S0 leaves the row, so gate G is closed → 500, nothing written.
    const before = await ledgerDump(e);
    const spy = batchHooks(e, [{ transform: (batch) => batch.slice(1) }]);
    const blocked = await quietly(() => s.correct(w3.transactionId, factOf(spend(s), { merchantName: 'reuse' }), k1));
    expect([blocked.status, blocked.json, blocked.res.headers.get('idempotency-replayed')]).toEqual([500, INTERNAL, null]);
    expect(spy.mock.settledResults.map((r) => r.type)).toEqual(['fulfilled']);
    spy.mockRestore();
    expect(await ledgerDump(e)).toEqual(before);

    // Any write of the user at T (here a create) removes k1 (expires_at = T) but not k2 (T + 1).
    await made(s);
    expect(await keyRow(e, s.id, k1)).toBeUndefined();
    expect(await keyRow(e, s.id, k2)).toMatchObject({ expires_at: t0 + 1 + TTL });
    const r2 = await s.correctBytes(w2.transactionId, factOf(spend(s), { merchantName: 'k2' }), k2);
    expect([...replayed(r2), sameBytes(r2, c2)]).toEqual([201, 'true', true]);
    // One millisecond later k2 is no key either; the reuse of k1 now runs once.
    e.t.clock.t = t0 + 1 + TTL;
    const o2 = await s.correct(w2.transactionId, factOf(spend(s), { merchantName: 'k2' }), k2);
    expect([o2.status, o2.json.code]).toEqual([409, 'REVISION_CONFLICT']);
    const reuse = await s.correct(w3.transactionId, factOf(spend(s), { merchantName: 'reuse' }), k1);
    expect(replayed(reuse)).toEqual([201, null]);
    expect(await keyRow(e, s.id, k2)).toBeUndefined(); // the reuse's own S0
  });

  it('committed but the response was lost: within 30 days the same key recovers the first result (replay, nothing written twice); at expires_at the same request learns the outcome as 409 REVISION_CONFLICT / TRANSACTION_VOIDED', async () => {
    const s = await seedUser(e);
    const [w1, w2] = [await made(s), await made(s)];
    const [kC, kV] = [newKey(), newKey()];
    const correction = factOf(spend(s), { merchantName: 'Lost response' });
    const lose = () => batchHooks(e, [{ after: async (err) => { if (!err) throw new Error('fetch failed: socket hang up'); } }]);
    const t0 = e.t.clock.t;
    let spy = lose();
    const lc = await quietly(() => s.correct(w1.transactionId, correction, kC));
    spy.mockRestore();
    spy = lose();
    const lv = await quietly(() => s.voidTx(w2.transactionId, { baseRevision: 1 }, kV));
    spy.mockRestore();
    expect([lc.status, lc.json, lv.status, lv.json]).toEqual([500, INTERNAL, 500, INTERNAL]);

    const first = { c: await s.correctBytes(w1.transactionId, correction, kC), v: await s.voidBytes(w2.transactionId, { baseRevision: 1 }, kV) };
    expect([...replayed(first.c), ...replayed(first.v)]).toEqual([201, 'true', 200, 'true']);
    expect(JSON.parse(first.c.text)).toMatchObject({ revision: 2, event: { merchantName: 'Lost response', createdAt: t0 } });
    expect(JSON.parse(first.v.text)).toMatchObject({ statusAfter: 'voided', void: { voidedAt: t0 } });
    await at([s], t0 + TTL - 1);
    const late = { c: await s.correctBytes(w1.transactionId, correction, kC), v: await s.voidBytes(w2.transactionId, { baseRevision: 1 }, kV) };
    expect([sameBytes(late.c, first.c), sameBytes(late.v, first.v)]).toEqual([true, true]);

    e.t.clock.t = t0 + TTL;
    const gone = { c: await s.correct(w1.transactionId, correction, kC), v: await s.voidTx(w2.transactionId, { baseRevision: 1 }, kV) };
    expect([gone.c.status, gone.c.json.code, gone.c.json.details, gone.v.status, gone.v.json.code]).toEqual([409, 'REVISION_CONFLICT', { currentRevision: 2 }, 409, 'TRANSACTION_VOIDED']);
    expect(await revisionsOf(w1.transactionId)).toEqual([1, 2]);
    expect([await auditCount(s.id, 'transaction.correct'), await auditCount(s.id, 'transaction.void')]).toEqual([1, 1]);
  });
});
