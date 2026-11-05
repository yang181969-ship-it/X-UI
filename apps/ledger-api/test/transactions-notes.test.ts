// M3-B3-B.1: PATCH /transactions/:id/notes (API_SPEC §5.9, P9) — TEST_PLAN COR-7, IDEM-2, ISO-1
// (notes), CC (notes with a void / a correction). Notes are no transaction fact: no version, no
// idempotency key, no audit. Every case runs on libsql and on wrangler's local in-memory D1 through
// the real HTTP app. Corrections come from the M3-B1 test chain (no correction route before M3-B3-C).
// All data is fictional.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { client } from './helpers.ts';
import { batchHooks, factCorrection, ledgerDump, newKey, seedUser, spend, startEngine, type Engine, type Seed } from './transactions-kit.ts';

type Json = any;

describe.each(['libsql', 'd1'] as const)('PATCH /transactions/:id/notes on %s', (engine) => {
  let e: Engine;
  beforeAll(async () => {
    e = await startEngine(engine, 'xui-v1-txn-notes-d1');
  }, 180_000);
  afterAll(async () => {
    await e?.dispose();
  });
  beforeEach(() => e.ping());
  afterEach(() => vi.restoreAllMocks());

  const made = async (s: Seed, notes: string | null = null): Promise<Json> => {
    const r = await s.post(spend(s, { notes }));
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json;
  };
  const header = async (T: string) => (await e.all('SELECT * FROM transactions WHERE id = ?', T))[0]!;
  /** Everything but the header's notes / updated_at: versions, entries, keys, audit. */
  const facts = async (T: string) => {
    const d = await ledgerDump(e);
    return { ...d, transactions: d.transactions!.map((h) => (h.id === T ? { ...h, notes: '·', updated_at: '·' } : h)) };
  };

  it('COR-7: a PATCH changes only the header’s notes and updated_at — no version, no event, entry, key or audit; null clears, "" is kept, the same value is written again', async () => {
    const s = await seedUser(e);
    const w = await made(s, 'first');
    const T = w.transactionId as string;
    const before = await facts(T);
    const steps: [string | null, string | null][] = [['second', 'second'], ['second', 'second'], ['', ''], [null, null], ['  spaced  ', '  spaced  ']];
    for (const [notes, stored] of steps) {
      e.t.advance(1_000);
      const r = await s.notes(T, { notes });
      expect([r.status, r.json], JSON.stringify(notes)).toEqual([200, { id: T, notes: stored, updatedAt: e.t.clock.t }]);
      expect(await header(T)).toMatchObject({ notes: stored, updated_at: e.t.clock.t, current_revision: 1, status: 'active' });
    }
    expect(await facts(T)).toEqual(before);
    // The detail shows the notes; the create's replay never does (immutable write result).
    expect((await s.api.get(`/api/transactions/${T}`)).json).toMatchObject({ notes: '  spaced  ', currentRevision: 1, revisions: [{ revision: 1 }] });
  });

  it('COR-7: a voided transaction’s notes still change; the void stays as it was', async () => {
    const s = await seedUser(e);
    const T = (await made(s)).transactionId as string;
    expect((await s.voidTx(T, { baseRevision: 1, reason: 'duplicate' })).status).toBe(200);
    const h = await header(T);
    e.t.advance(1_000);
    const r = await s.notes(T, { notes: 'why it was voided' });
    expect(r.json).toEqual({ id: T, notes: 'why it was voided', updatedAt: e.t.clock.t });
    expect(await header(T)).toEqual({ ...h, notes: 'why it was voided', updated_at: e.t.clock.t });
  });

  it('IDEM-2: no Idempotency-Key is needed, and any key header — valid or malformed — is neither read nor stored', async () => {
    const s = await seedUser(e);
    const T = (await made(s)).transactionId as string;
    const keys = async () => e.all('SELECT key FROM ledger_idempotency_keys WHERE user_id = ? ORDER BY key', s.id);
    const before = await keys();
    const valid = newKey();
    for (const headers of [{}, { 'idempotency-key': valid }, { 'idempotency-key': 'x' }, { 'idempotency-key': '' }] as Record<string, string>[]) {
      expect((await s.notes(T, { notes: JSON.stringify(headers) }, headers)).status).toBe(200);
    }
    expect(await keys()).toEqual(before);
    // The valid key is still free for a financial write.
    expect((await s.voidTx(T, { baseRevision: 1 }, valid)).res.headers.get('idempotency-replayed')).toBeNull();
  });

  it('validation: the body is strict — notes must be present, a string ≤ 1000 or null; sensitive text is refused without echoing it; nothing written', async () => {
    const s = await seedUser(e);
    const T = (await made(s, 'kept')).transactionId as string;
    const before = await ledgerDump(e);
    const cases: [unknown, string][] = [
      [{}, 'VALIDATION'],
      [{ notes: 'ok', status: 'voided' }, 'VALIDATION'],
      [{ notes: 'ok', revision: 2 }, 'VALIDATION'],
      [{ notes: 5 }, 'VALIDATION'],
      [{ notes: 'x'.repeat(1001) }, 'VALIDATION'],
      [[], 'VALIDATION'],
      [{ notes: 'card 4111 1111 1111 1111' }, 'SENSITIVE_DATA'],
    ];
    for (const [body, code] of cases) {
      const r = await s.notes(T, body);
      expect([r.status, r.json.code], JSON.stringify(body).slice(0, 40)).toEqual([400, code]);
      expect(JSON.stringify(r.json)).not.toContain('4111');
    }
    const broken = await s.api.req('PATCH', `/api/transactions/${T}/notes`, undefined, { 'content-type': 'application/json' });
    expect([broken.status, broken.json.code]).toEqual([400, 'BAD_JSON']);
    expect((await s.notes(T, { notes: 'x'.repeat(1000) })).status).toBe(200);
    expect({ ...(await ledgerDump(e)), transactions: [] }).toEqual({ ...before, transactions: [] });
  });

  it('ISO-1 / auth: another user’s, a missing and an unpublished transaction are the same 404, nothing written; no session → 401, no CSRF header → 403', async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    const T = (await made(a, 'mine')).transactionId as string;
    const unpublished = `unpublished-${newKey()}`;
    await e.exec('INSERT INTO transactions (id, user_id, txn_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', unpublished, b.id, 'merchant_spend', 1, 1);
    const before = await ledgerDump(e);
    const missing = await b.notes('no-such-transaction-000000', { notes: 'x' });
    expect([missing.status, missing.json]).toEqual([404, { error: 'transaction not found', code: 'NOT_FOUND' }]);
    for (const id of [T, unpublished]) expect((await b.notes(id, { notes: 'x' })).json).toEqual(missing.json);
    expect((await client(e.t).req('PATCH', `/api/transactions/${T}/notes`, { notes: 'x' })).status).toBe(401);
    const cookie = [...a.api.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    expect((await a.api.req('PATCH', `/api/transactions/${T}/notes`, { notes: 'x' }, { cookie, 'x-xui-csrf': '' })).status).toBe(403);
    expect(await ledgerDump(e)).toEqual(before);
    expect((await header(T)).notes).toBe('mine');
  });

  it('CC: notes and a void do not affect each other — at once, and with the notes written between the void’s checks and its batch', async () => {
    const s = await seedUser(e);
    const T1 = (await made(s)).transactionId as string;
    const [n, v] = await Promise.all([s.notes(T1, { notes: 'concurrent' }), s.voidTx(T1, { baseRevision: 1 })]);
    expect([n.status, v.status]).toEqual([200, 200]);
    expect(await header(T1)).toMatchObject({ notes: 'concurrent', status: 'voided', current_revision: 1 });
    const T2 = (await made(s)).transactionId as string;
    const spy = batchHooks(e, [{ before: () => s.notes(T2, { notes: 'in between' }) }]);
    const r = await s.voidTx(T2, { baseRevision: 1 });
    expect(r.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2); // the notes PATCH is a batch too
    expect(await header(T2)).toMatchObject({ notes: 'in between', status: 'voided', current_revision: 1 });
  });

  it('CC: notes and a correction do not affect each other — the notes write keeps the version, the version keeps the notes', async () => {
    const s = await seedUser(e);
    const T = (await made(s, 'before')).transactionId as string;
    const spy = batchHooks(e, [{ before: () => factCorrection(e, s, T, { merchantName: 'Corrected' }) }]);
    const r = await s.notes(T, { notes: 'after' });
    expect(r.status).toBe(200);
    spy.mockRestore();
    expect(await header(T)).toMatchObject({ notes: 'after', current_revision: 2, status: 'active' });
    await factCorrection(e, s, T, { merchantName: 'Corrected again' });
    expect(await header(T)).toMatchObject({ notes: 'after', current_revision: 3 });
  });
});
