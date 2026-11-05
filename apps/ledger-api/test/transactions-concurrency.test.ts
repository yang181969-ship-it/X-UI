// M3-B3-D: concurrency of the correction and void routes through the real HTTP app (TEST_PLAN §5.16
// CC-3, CC-6, and the fact-correction versions of CC-4, CC-7, CC-8, CC-9; DATA_MODEL §10.10). Races
// are real (Promise.all) or forced with batchHooks (a request started or a source changed between
// another request's checks and its batch). Nothing in the server serializes requests: every outcome
// here is decided by the database — gate G, the key's primary key, the S1 / S3 conditions and the
// publish triggers. Every case runs on libsql and on wrangler's local in-memory D1. Fictional data.
import { classify, requestHashV1, transactionCorrectionSchema } from '@xui/ledger-shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMessages } from '../src/lib/dbErrors.ts';
import {
  batchHooks,
  entryRows,
  factOf,
  INTERNAL,
  keyRow,
  ledgerDump,
  newKey,
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
type Json = any;
type Reply = Awaited<ReturnType<Seed['correct']>>;

const TTL = 30 * 86_400_000;

describe.each(['libsql', 'd1'] as const)('correction and void concurrency through HTTP on %s', (engine) => {
  let e: Engine;
  beforeAll(async () => {
    e = await startEngine(engine, 'xui-v1-txn-concurrency-d1');
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
  const header = async (T: string) => (await e.all('SELECT * FROM transactions WHERE id = ?', T))[0]!;
  const revisionsOf = async (T: string) => (await e.all('SELECT revision FROM transaction_events WHERE transaction_id = ? ORDER BY revision', T)).map((r) => Number(r.revision));
  const audits = async (userId: string, action: string) => (await e.all('SELECT detail FROM audit_log WHERE user_id = ? AND action = ? ORDER BY rowid', userId, action)).map((r) => JSON.parse(String(r.detail)));
  const keyCount = async (userId: string, operation: string) => Number((await e.all('SELECT count(*) AS n FROM ledger_idempotency_keys WHERE user_id = ? AND operation = ?', userId, operation))[0]!.n);
  const settle = (baseRevision: number, entries: Body[]): Body => ({ kind: 'settlement', baseRevision, reason: null, entries });
  const snapshot = (baseRevision: number, x: Body): Body => ({ kind: 'snapshot_correction', baseRevision, reason: 'recorded wrongly', ...x });
  const pendingTransfer = (s: Seed) =>
    ownTransfer(s, {
      entries: [
        { direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'pending', amount: null },
        { direction: 'in', accountId: s.BE, currency: 'USD', amountStatus: 'pending', amount: null },
      ],
    });
  const conflictOf = (currentRevision: number) => ({ error: expect.any(String), code: 'REVISION_CONFLICT', details: { currentRevision } });
  const VOIDED = { error: expect.any(String), code: 'TRANSACTION_VOIDED' };
  /** Bound parameters of every statement of one batch (to compare two attempts). */
  const paramsOf = (batch: readonly unknown[]) => batch.flatMap((st) => (st as { toSQL: () => { params: unknown[] } }).toSQL().params);
  const ID = /^[0-9a-hjkmnp-tv-z]{26}$/;

  /** Every published version of the user: its stored classification is the one its own saved snapshots give (CC-4). */
  const classificationHolds = async (userId: string) => {
    const events = await e.all('SELECT ev.* FROM transaction_events ev JOIN transactions t ON t.id = ev.transaction_id WHERE ev.user_id = ? AND ev.revision <= t.current_revision', userId);
    for (const ev of events) {
      const c = classify({
        txnType: ev.txn_type as never,
        homeRegion: String(ev.home_region),
        merchantCountry: ev.merchant_country as string | null,
        counterpartyCountry: ev.counterparty_country as string | null,
        entries: (await entryRows(e, String(ev.id))).map((en) => ({ direction: en.direction as never, fundingAccountCountry: String(en.funding_account_country) })),
      });
      expect([ev.merchant_scope, ev.transfer_scope, ev.foreign_status], String(ev.id)).toEqual([c.merchantScope, c.transferScope, c.foreignStatus]);
    }
    return events.length;
  };
  /** Nothing unpublished anywhere (IMM-9). */
  const noResidue = async (userId: string) =>
    expect(
      await e.all(
        `SELECT (SELECT count(*) FROM transaction_events ev JOIN transactions t ON t.id = ev.transaction_id WHERE t.user_id = ? AND ev.revision > t.current_revision) AS events,
                (SELECT count(*) FROM transactions WHERE user_id = ? AND current_revision = 0) AS headers,
                (SELECT count(*) FROM transaction_entries en LEFT JOIN transaction_events ev ON ev.id = en.event_id WHERE en.user_id = ? AND ev.id IS NULL) AS orphans`,
        userId, userId, userId,
      ),
    ).toEqual([{ events: 0, headers: 0, orphans: 0 }]);

  // ================================================================== CC-3: corrections against corrections

  it('CC-3: a settlement, a fact and a snapshot correction on one baseRevision with three keys at once — one 201, two 409 REVISION_CONFLICT; the losers stored no key and then run once on the new base; versions 1 … 4, no gap', async () => {
    const s = await seedUser(e);
    const body = pendingTransfer(s);
    const T = (await made(s, body)).transactionId as string;
    const kinds = ['settlement', 'fact_correction', 'snapshot_correction'] as const;
    const make = (kind: (typeof kinds)[number], base: number) =>
      kind === 'settlement' ? settle(base, [{ direction: 'out', amount: 100000 }]) : kind === 'fact_correction' ? factOf(body, { baseRevision: base, transferMethod: 'fps' }) : snapshot(base, { homeRegion: 'JP' });
    const keys = kinds.map(() => newKey());
    const rs = await Promise.all(kinds.map((k, i) => s.correct(T, make(k, 1), keys[i])));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    for (const r of rs.filter((x) => x.status === 409)) expect(r.json).toEqual(conflictOf(2));
    expect(await revisionsOf(T)).toEqual([1, 2]);
    const losers = kinds.flatMap((k, i) => (rs[i]!.status === 409 ? [[k, keys[i]!] as const] : []));
    for (const [, key] of losers) expect(await keyRow(e, s.id, key)).toBeUndefined();
    for (const [kind, key] of losers) {
      const base = Number((await header(T)).current_revision);
      const r = await s.correct(T, make(kind, base), key);
      expect([r.status, r.json.revision, r.json.event?.revisionKind], kind).toEqual([201, base + 1, kind]);
    }
    expect(await revisionsOf(T)).toEqual([1, 2, 3, 4]);
    expect(await header(T)).toMatchObject({ current_revision: 4, status: 'active' });
    expect((await audits(s.id, 'transaction.correct')).map((d) => d.revision)).toEqual([2, 3, 4]);
    expect(await keyCount(s.id, 'transaction.correct')).toBe(3);
    await noResidue(s.id);
  });

  it('CC-3: five rounds of two concurrent corrections on the current base — each round exactly one 201 and one 409 REVISION_CONFLICT { currentRevision: r+1 }; revisions 1 … 6 with no gap and one audit per version', async () => {
    const s = await seedUser(e);
    const body = spend(s);
    const T = (await made(s, body)).transactionId as string;
    const names: string[] = [];
    for (let r = 1; r <= 5; r++) {
      const rs = await Promise.all(['A', 'B'].map((side) => s.correct(T, factOf(body, { baseRevision: r, merchantName: `${side}${r}` }))));
      expect(rs.map((x) => x.status).sort(), `round ${r}`).toEqual([201, 409]);
      expect(rs.find((x) => x.status === 409)!.json).toEqual(conflictOf(r + 1));
      const won = rs.find((x) => x.status === 201)!.json;
      expect(won.revision).toBe(r + 1);
      names.push(won.event.merchantName);
    }
    expect(await revisionsOf(T)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await e.all('SELECT merchant_name FROM transaction_events WHERE transaction_id = ? AND revision > 1 ORDER BY revision', T)).map((x) => x.merchant_name)).toEqual(names);
    expect((await audits(s.id, 'transaction.correct')).map((d) => d.revision)).toEqual([2, 3, 4, 5, 6]);
    await noResidue(s.id);
  });

  // ================================================================== CC-3 / CC-6: corrections against voids

  it('CC-3 / CC-6: a void, a fact and a snapshot correction on one baseRevision at once — the void first: both corrections 409 TRANSACTION_VOIDED, no version; a correction first: the void and the other correction 409 REVISION_CONFLICT', async () => {
    const s = await seedUser(e);
    const body = spend(s);
    for (let i = 0; i < 6; i++) {
      const T = (await made(s, body)).transactionId as string;
      const [v, f, n] = await Promise.all([s.voidTx(T, { baseRevision: 1 }), s.correct(T, factOf(body, { merchantName: 'Race' })), s.correct(T, snapshot(1, { homeRegion: 'JP' }))]);
      if (v.status === 200) {
        expect([f.json, n.json]).toEqual([VOIDED, VOIDED]);
        expect(await revisionsOf(T)).toEqual([1]);
        expect(await header(T)).toMatchObject({ status: 'voided', current_revision: 1 });
      } else {
        expect(v.json).toEqual(conflictOf(2));
        expect([f.status, n.status].sort()).toEqual([201, 409]);
        expect([f, n].find((x) => x.status === 409)!.json).toEqual(conflictOf(2));
        expect(await revisionsOf(T)).toEqual([1, 2]);
        expect(await header(T)).toMatchObject({ status: 'active', current_revision: 2 });
      }
    }
    const corrections = (await audits(s.id, 'transaction.correct')).length;
    const voids = (await audits(s.id, 'transaction.void')).length;
    expect(corrections + voids).toBe(6);
    expect([await keyCount(s.id, 'transaction.correct'), await keyCount(s.id, 'transaction.void')]).toEqual([corrections, voids]);
    await noResidue(s.id);
  }, 120_000);

  it('CC-6: one key for a correction and a void of the same transaction, both past the key lookup — the one that commits first wins, the other writes nothing and is 409 IDEMPOTENCY_CONFLICT naming the winner’s operation', async () => {
    const s = await seedUser(e);
    const body = spend(s);
    for (const winner of ['transaction.void', 'transaction.correct'] as const) {
      const T = (await made(s, body)).transactionId as string;
      const key = newKey();
      const doVoid = () => s.voidTx(T, { baseRevision: 1 }, key);
      const doCorrect = () => s.correct(T, factOf(body, { merchantName: 'Shared key' }), key);
      let won: Promise<Reply> | undefined;
      // The loser has passed its lookup and checks; the winner starts and commits before the loser's batch.
      const spy = batchHooks(e, [{ before: async () => { won = winner === 'transaction.void' ? doVoid() : doCorrect(); await won; } }]);
      const lost = await (winner === 'transaction.void' ? doCorrect() : doVoid());
      const w = await won!;
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.settledResults.map((r) => r.type)).toEqual(['fulfilled', 'fulfilled']); // gate G: the loser's batch wrote nothing, no error
      spy.mockRestore();
      expect(w.status, winner).toBe(winner === 'transaction.void' ? 200 : 201);
      expect([lost.status, lost.json], winner).toEqual([409, { error: expect.any(String), code: 'IDEMPOTENCY_CONFLICT', details: { operation: winner, transactionId: T } }]);
      expect(await revisionsOf(T)).toEqual(winner === 'transaction.void' ? [1] : [1, 2]);
      expect(await header(T)).toMatchObject({ status: winner === 'transaction.void' ? 'voided' : 'active' });
      expect(await keyRow(e, s.id, key)).toMatchObject({ operation: winner, transaction_id: T });
    }
    expect([(await audits(s.id, 'transaction.void')).length, (await audits(s.id, 'transaction.correct')).length]).toEqual([1, 1]);
    await noResidue(s.id);
  });

  it('CC-6: one key for writes on two different transactions (void + void, correct + correct, void + correct), both past the key lookup — gate G lets only the first write anything; the other changes neither transaction and is 409 IDEMPOTENCY_CONFLICT', async () => {
    const s = await seedUser(e);
    const body = spend(s);
    type Op = (T: string, key: string) => Promise<Reply>;
    const voidOp: Op = (T, key) => s.voidTx(T, { baseRevision: 1 }, key);
    const correctOp: Op = (T, key) => s.correct(T, factOf(body, { merchantName: 'One key, two transactions' }), key);
    const pairs: [string, Op, Op, string][] = [
      ['void + void', voidOp, voidOp, 'transaction.void'],
      ['correct + correct', correctOp, correctOp, 'transaction.correct'],
      ['void + correct', correctOp, voidOp, 'transaction.void'],
    ];
    for (const [what, loserOp, winnerOp, winnerOperation] of pairs) {
      const [T1, T2] = [(await made(s, body)).transactionId as string, (await made(s, body)).transactionId as string];
      const key = newKey();
      let won: Promise<Reply> | undefined;
      const spy = batchHooks(e, [{ before: async () => { won = winnerOp(T2, key); await won; } }]);
      const lost = await loserOp(T1, key);
      const w = await won!;
      spy.mockRestore();
      expect(w.status, what).toBeLessThan(300);
      expect([lost.status, lost.json], what).toEqual([409, { error: expect.any(String), code: 'IDEMPOTENCY_CONFLICT', details: { operation: winnerOperation, transactionId: T2 } }]);
      expect(await header(T1), what).toMatchObject({ status: 'active', current_revision: 1, voided_op_id: null });
      expect(await revisionsOf(T1), what).toEqual([1]);
    }
    expect([(await audits(s.id, 'transaction.void')).length, (await audits(s.id, 'transaction.correct')).length]).toEqual([2, 1]);
    await noResidue(s.id);
  });

  it('CC-6: notes and a correction through HTTP do not affect each other — notes between the correction’s checks and batch, a correction between the notes’ checks and write, and both at once', async () => {
    const s = await seedUser(e);
    const body = spend(s, { notes: 'first' });
    const T = (await made(s, body)).transactionId as string;
    const key = newKey();
    let spy = batchHooks(e, [{ before: () => s.notes(T, { notes: 'in between' }) }]);
    const c1 = await s.correctBytes(T, factOf(body, { merchantName: 'Corrected' }), key);
    spy.mockRestore();
    expect(c1.status).toBe(201);
    expect(await header(T)).toMatchObject({ notes: 'in between', current_revision: 2 });
    expect(c1.text).not.toMatch(/in between|first/);
    spy = batchHooks(e, [{ before: () => s.correct(T, factOf(body, { baseRevision: 2, merchantName: 'Again' })) }]);
    expect((await s.notes(T, { notes: 'after' })).status).toBe(200);
    spy.mockRestore();
    expect(await header(T)).toMatchObject({ notes: 'after', current_revision: 3 });
    const [n, c] = await Promise.all([s.notes(T, { notes: 'together' }), s.correct(T, factOf(body, { baseRevision: 3, merchantName: 'Third' }))]);
    expect([n.status, c.status]).toEqual([200, 201]);
    expect(await header(T)).toMatchObject({ notes: 'together', current_revision: 4 });
    // The correction's replay never shows notes.
    const replay = await s.correctBytes(T, factOf(body, { merchantName: 'Corrected' }), key);
    expect([replay.status, Buffer.from(replay.bytes).equals(Buffer.from(c1.bytes))]).toEqual([201, true]);
  });

  // ================================================================== CC-4: snapshot sources of a fact correction

  it('CC-4 (fact correction): the home-region setting changing after the checks has no effect (carried); a new account’s jurisdiction change that keeps the classification is saved as read without a retry; one that makes it domestic ends in 400 CONFIRMED_DOMESTIC', async () => {
    const s = await seedUser(e);
    const body = spend(s);
    const T = (await made(s, body)).transactionId as string;
    // ① The setting moves CN → US (a US merchant would read domestic): the version carries CN.
    let spy = batchHooks(e, [{ before: () => s.api.patch('/api/settings/profile', { homeRegion: 'US' }) }]);
    const r1 = await s.correct(T, factOf(body, { merchantName: 'Region raced' }));
    expect(r1.status, JSON.stringify(r1.json)).toBe(201);
    expect(spy.mock.settledResults.map((r) => r.type)).toEqual(['fulfilled', 'fulfilled']); // the correction and the PATCH; no retry
    expect(r1.json.event).toMatchObject({ homeRegion: 'CN', homeRegionSource: 'carried', merchantScope: 'foreign', foreignStatus: 'foreign' });
    spy.mockRestore();
    await s.api.patch('/api/settings/profile', { homeRegion: 'CN' });

    // ② A new account (US) re-registered as SG after the checks: still foreign → no retry, the snapshot is the value at save.
    spy = batchHooks(e, [{ before: () => e.exec("UPDATE accounts SET account_country = 'SG' WHERE id = ?", s.US) }]);
    const r2 = await s.correct(T, factOf(body, { baseRevision: 2, entries: [{ direction: 'out', accountId: s.US, currency: 'USD', amountStatus: 'confirmed', amount: 1000 }] }));
    expect(r2.status, JSON.stringify(r2.json)).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r2.json.entries[0]).toMatchObject({ fundingAccountCountry: 'SG', countrySource: 'account_at_save' });
    spy.mockRestore();
    await e.exec("UPDATE accounts SET account_country = 'US' WHERE id = ?", s.US);

    // ③ A new account turning CN after the checks makes a CN-merchant version purely domestic: C6
    //    refuses (not the row CHECK), the change is confirmed, the retry's own checks give the 400.
    const t2 = (await made(s, body)).transactionId as string;
    const before = await ledgerDump(e);
    spy = batchHooks(e, [{ before: () => e.exec("UPDATE accounts SET account_country = 'CN' WHERE id = ?", s.US) }]);
    const key = newKey();
    const r3 = await s.correct(t2, factOf(body, { merchantCountry: 'CN', cardId: null, entries: [{ direction: 'out', accountId: s.US, currency: 'USD', amountStatus: 'confirmed', amount: 1000 }] }), key);
    expect([r3.status, r3.json.code, r3.json.details]).toEqual([400, 'CONFIRMED_DOMESTIC', { suggestion: 'void' }]);
    expect(spy).toHaveBeenCalledTimes(1);
    const refusal = spy.mock.settledResults[0]!;
    expect(refusal.type).toBe('rejected');
    expect(dbMessages(refusal.value).join(' | ')).toMatch(/LEDGER_CLASSIFICATION:/);
    expect(dbMessages(refusal.value).join(' | ')).not.toMatch(/CHECK constraint failed/);
    spy.mockRestore();
    expect(await ledgerDump(e)).toEqual(before);
    expect(await keyRow(e, s.id, key)).toBeUndefined();
    await e.exec("UPDATE accounts SET account_country = 'US' WHERE id = ?", s.US);
    expect(await classificationHolds(s.id)).toBe(4);
  });

  // ================================================================== CC-7: currency status of a fact correction

  it('CC-7 (fact correction): reopened during an acknowledged backfill → 201, ack 0; closed during an acknowledged backfill → 201, closed, ack 1; both without a retry', async () => {
    const s = await seedUser(e);
    const body = spend(s, { cardId: null, entries: [{ direction: 'out', accountId: s.BE, currency: 'USD', amountStatus: 'confirmed', amount: 900 }] });
    const T = (await made(s, body)).transactionId as string;
    const to = (currency: string) => factOf(body, { recordMode: 'backfill', entries: [{ direction: 'out', accountId: s.BE, currency, amountStatus: 'confirmed', amount: 900, closedCurrencyAck: true }] });
    // GBP is closed at the checks, active at save.
    let spy = batchHooks(e, [{ before: () => e.exec("UPDATE account_currencies SET status = 'active' WHERE account_id = ? AND currency = 'GBP'", s.BE) }]);
    const reopened = await s.correct(T, to('GBP'));
    expect(reopened.status, JSON.stringify(reopened.json)).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(reopened.json.entries[0]).toMatchObject({ currency: 'GBP', currencyStatusAtSave: 'active', closedCurrencyAck: false });
    expect((await entryRows(e, reopened.json.eventId))[0]).toMatchObject({ currency_status_at_save: 'active', closed_currency_ack: 0 });
    spy.mockRestore();
    // EUR is active at the checks, closed at save: the acknowledgement (a permission) now applies.
    spy = batchHooks(e, [{ before: () => e.exec("UPDATE account_currencies SET status = 'closed' WHERE account_id = ? AND currency = 'EUR'", s.BE) }]);
    const closed = await s.correct(T, { ...to('EUR'), baseRevision: 2 });
    expect(closed.status, JSON.stringify(closed.json)).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await entryRows(e, closed.json.eventId))[0]).toMatchObject({ funding_currency: 'EUR', currency_status_at_save: 'closed', closed_currency_ack: 1 });
    spy.mockRestore();
  });

  it('CC-7 / CC-8 (fact correction): a currency closed during the attempt and reopened before the re-read looks unchanged — 500 after one attempt, nothing written; the same key then saves once', async () => {
    const s = await seedUser(e);
    const body = spend(s);
    const T = (await made(s, body)).transactionId as string;
    const correction = factOf(body, { entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 1000 }] });
    const key = newKey();
    const before = await ledgerDump(e);
    const spy = batchHooks(e, [
      {
        before: () => e.exec("UPDATE account_currencies SET status = 'closed' WHERE account_id = ? AND currency = 'USD'", s.HK),
        after: () => e.exec("UPDATE account_currencies SET status = 'active' WHERE account_id = ? AND currency = 'USD'", s.HK),
      },
    ]);
    const r = await quietly(() => s.correct(T, correction, key));
    expect([r.status, r.json]).toEqual([500, INTERNAL]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(dbMessages(spy.mock.settledResults[0]!.value).join(' | ')).toMatch(/LEDGER_CLOSED_CURRENCY:/);
    spy.mockRestore();
    expect(await ledgerDump(e)).toEqual(before);
    const ok = await s.correct(T, correction, key);
    expect([ok.status, ok.res.headers.get('idempotency-replayed'), ok.json.entries[0].currencyStatusAtSave]).toEqual([201, null, 'active']);
  });

  // ================================================================== CC-8: the controlled retry of a fact correction

  it('CC-8 (fact correction): a source changed once → exactly two batches; the second uses the first attempt’s key, hash and time with new ids; nothing of the first attempt is stored', async () => {
    const s = await seedUser(e);
    const T = (await made(s)).transactionId as string;
    const correction = factOf(spend(s), { merchantCountry: null, eventCurrency: 'CNY', cardId: null, entries: [{ direction: 'out', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 100 }] });
    const key = newKey();
    const attempts: unknown[][] = [];
    const spy = batchHooks(e, [
      { before: () => e.exec("UPDATE accounts SET account_country = 'HK' WHERE id = ?", s.CN), transform: (b) => (attempts.push(paramsOf(b)), b) },
      { transform: (b) => (attempts.push(paramsOf(b)), b) },
    ]);
    const r = await s.correct(T, correction, key);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.settledResults.map((x) => x.type)).toEqual(['rejected', 'fulfilled']);
    spy.mockRestore();
    const [first, second] = attempts as [unknown[], unknown[]];
    const hash = await requestHashV1('transaction.correct', T, transactionCorrectionSchema.parse(correction));
    const k = (await keyRow(e, s.id, key))!;
    expect(k).toMatchObject({ request_hash: hash, hash_version: 1, expires_at: Number(k.created_at) + TTL });
    for (const p of [first, second]) expect(p).toEqual(expect.arrayContaining([key, hash, Number(k.created_at), Number(k.created_at) + TTL]));
    // The first attempt's event, entry, op and audit ids: not reused, and stored nowhere.
    const firstOnly = first.filter((p): p is string => typeof p === 'string' && ID.test(p) && !second.includes(p));
    expect(firstOnly.length).toBeGreaterThanOrEqual(4);
    const dump = JSON.stringify(await ledgerDump(e));
    for (const id of firstOnly) expect(dump.includes(id), id).toBe(false);
    expect(dump.includes(r.json.eventId)).toBe(true);
    expect([await revisionsOf(T), (await audits(s.id, 'transaction.correct')).length, await keyCount(s.id, 'transaction.correct')]).toEqual([[1, 2], 1, 1]);
    await e.exec("UPDATE accounts SET account_country = 'CN' WHERE id = ?", s.CN);
  });

  it('CC-8 (fact correction): a request with the same key committed while the first attempt was failing — the same request: replay; a different request: 409 IDEMPOTENCY_CONFLICT; no second attempt either way', async () => {
    const s = await seedUser(e);
    const body = spend(s);
    const unknownCN = (x: Body = {}) => factOf(body, { merchantCountry: null, eventCurrency: 'CNY', cardId: null, entries: [{ direction: 'out', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 100 }], ...x });
    for (const same of [true, false]) {
      const T = (await made(s, body)).transactionId as string;
      const key = newKey();
      let other: Reply | undefined;
      const spy = batchHooks(e, [
        {
          before: () => e.exec("UPDATE accounts SET account_country = 'HK' WHERE id = ?", s.CN),
          // After C6 refused the first attempt and before the route looks again: a request with this key commits.
          after: async () => {
            other = await s.correct(T, same ? unknownCN() : unknownCN({ merchantName: 'Other request' }), key);
          },
        },
      ]);
      const r = await s.correct(T, unknownCN(), key);
      expect(spy).toHaveBeenCalledTimes(2); // the first attempt and the other request — no second attempt
      spy.mockRestore();
      expect(other!.status).toBe(201);
      if (same) {
        expect([r.status, r.res.headers.get('idempotency-replayed')]).toEqual([201, 'true']);
        expect(r.json).toEqual(other!.json);
      } else {
        expect([r.status, r.json]).toEqual([409, { error: expect.any(String), code: 'IDEMPOTENCY_CONFLICT', details: { operation: 'transaction.correct', transactionId: T } }]);
      }
      expect(await revisionsOf(T)).toEqual([1, 2]);
      await e.exec("UPDATE accounts SET account_country = 'CN' WHERE id = ?", s.CN);
    }
    expect((await audits(s.id, 'transaction.correct')).length).toBe(2);
  });

  it('CC-8: an outcome-unknown failure (connection lost before any answer) of a correction or a void — 500, no retry, nothing written; the same key then runs exactly once', async () => {
    const s = await seedUser(e);
    const body = spend(s);
    const T = (await made(s, body)).transactionId as string;
    const ops: [string, (key: string) => Promise<Reply>, number][] = [
      ['correct', (key) => s.correct(T, factOf(body, { merchantName: 'Unknown outcome' }), key), 201],
      ['void', (key) => s.voidTx(T, { baseRevision: 2 }, key), 200],
    ];
    for (const [op, run, status] of ops) {
      const key = newKey();
      const before = await ledgerDump(e);
      const spy = batchHooks(e, [{ replace: async () => { throw new TypeError('fetch failed: other side closed'); } }]);
      const r = await quietly(() => run(key));
      expect([r.status, r.json], op).toEqual([500, INTERNAL]);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      expect(await ledgerDump(e)).toEqual(before);
      const ok = await run(key);
      expect([ok.status, ok.res.headers.get('idempotency-replayed')], op).toEqual([status, null]);
      const again = await run(key);
      expect([again.status, again.res.headers.get('idempotency-replayed')], op).toEqual([status, 'true']);
    }
    expect(await revisionsOf(T)).toEqual([1, 2]);
    expect([(await audits(s.id, 'transaction.correct')).length, (await audits(s.id, 'transaction.void')).length]).toEqual([1, 1]);
  });

  // ================================================================== CC-9: which sources a fact correction reads

  it('CC-9: the same account with a switched currency is carried — its jurisdiction changing after the checks is not read (no retry); in an own transfer only the new account’s change retries', async () => {
    const s = await seedUser(e);
    const body = spend(s);
    const T = (await made(s, body)).transactionId as string;
    let spy = batchHooks(e, [{ before: () => e.exec("UPDATE accounts SET account_country = 'SG' WHERE id = ?", s.HK) }]);
    const switched = await s.correct(T, factOf(body, { entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 1000 }] }));
    expect(switched.status, JSON.stringify(switched.json)).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(switched.json.entries[0]).toMatchObject({ currency: 'USD', fundingAccountCountry: 'HK', countrySource: 'carried' });
    spy.mockRestore();
    await e.exec("UPDATE accounts SET account_country = 'HK' WHERE id = ?", s.HK);

    // HK → BE becomes HK → US (new); after the checks HK (carried) turns CN and US turns HK.
    const transfer = ownTransfer(s);
    const t2 = (await made(s, transfer)).transactionId as string;
    const key = newKey();
    spy = batchHooks(e, [{ before: async () => { await e.exec("UPDATE accounts SET account_country = 'CN' WHERE id = ?", s.HK); await e.exec("UPDATE accounts SET account_country = 'HK' WHERE id = ?", s.US); } }]);
    const correction = factOf(transfer, { entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 100000 }, { direction: 'in', accountId: s.US, currency: 'USD', amountStatus: 'confirmed', amount: 99900 }] });
    const r = await s.correct(t2, correction, key);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(r.json.entries.map((en: Json) => [en.direction, en.fundingAccountCountry, en.countrySource])).toEqual([
      ['out', 'HK', 'carried'],
      ['in', 'HK', 'account_at_save'],
    ]);
    expect((await keyRow(e, s.id, key))!.request_hash).toBe(await requestHashV1('transaction.correct', t2, transactionCorrectionSchema.parse(correction)));
    spy.mockRestore();
    await e.exec("UPDATE accounts SET account_country = 'HK' WHERE id = ?", s.HK);
    await e.exec("UPDATE accounts SET account_country = 'US' WHERE id = ?", s.US);
    expect(await classificationHolds(s.id)).toBe(4);
  });

  it('CC-8 / CC-9: only the sources the new version reads count — LEDGER_CLASSIFICATION while only a carried account’s jurisdiction changed, LEDGER_CLOSED_CURRENCY while only a carried same-currency entry’s currency closed → 500 after one batch', async () => {
    const s = await seedUser(e);
    const transfer = ownTransfer(s);
    // out HK · USD carried (same account, same currency); in BE → US (new account).
    const correction = factOf(transfer, { entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 100000 }, { direction: 'in', accountId: s.US, currency: 'USD', amountStatus: 'confirmed', amount: 99900 }] });
    const changes: [string, string, () => Promise<unknown>, () => Promise<unknown>][] = [
      ['LEDGER_CLASSIFICATION', 'carried account re-registered',
        () => e.exec("UPDATE accounts SET account_country = 'SG' WHERE id = ?", s.HK), () => e.exec("UPDATE accounts SET account_country = 'HK' WHERE id = ?", s.HK)],
      ['LEDGER_CLOSED_CURRENCY', 'carried currency closed',
        () => e.exec("UPDATE account_currencies SET status = 'closed' WHERE account_id = ? AND currency = 'USD'", s.HK), () => e.exec("UPDATE account_currencies SET status = 'active' WHERE account_id = ? AND currency = 'USD'", s.HK)],
    ];
    for (const [code, what, change, undo] of changes) {
      const T = (await made(s, transfer)).transactionId as string;
      const before = await ledgerDump(e);
      const spy = batchHooks(e, [{ before: change }]);
      const r = await raising(e, 'transaction_entries', 'INSERT', null, `${code}: injected`, () => s.correct(T, correction));
      expect([r.status, r.json], what).toEqual([500, INTERNAL]);
      expect(spy, what).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      await undo();
      expect(await ledgerDump(e), what).toEqual(before);
    }
  });

  it('CC-7 / CC-9: a settlement and a snapshot correction carry their currencies — closing or reopening one between the checks and the batch never fails or retries; the status at save is read', async () => {
    const s = await seedUser(e);
    const T = (await made(s, ownTransfer(s, { entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'pending', amount: null }, { direction: 'in', accountId: s.BE, currency: 'USD', amountStatus: 'confirmed', amount: 99900 }] }))).transactionId as string;
    let spy = batchHooks(e, [{ before: () => e.exec("UPDATE account_currencies SET status = 'closed' WHERE account_id = ? AND currency = 'USD'", s.HK) }]);
    const settled = await s.correct(T, settle(1, [{ direction: 'out', amount: 100000 }]));
    expect(settled.status, JSON.stringify(settled.json)).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(settled.json.entries[0]).toMatchObject({ currencyStatusAtSave: 'closed', closedCurrencyAck: false });
    spy.mockRestore();
    spy = batchHooks(e, [{ before: () => e.exec("UPDATE account_currencies SET status = 'active' WHERE account_id = ? AND currency = 'USD'", s.HK) }]);
    const corrected = await s.correct(T, snapshot(2, { homeRegion: 'JP' }));
    expect(corrected.status, JSON.stringify(corrected.json)).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(corrected.json.entries[0]).toMatchObject({ currencyStatusAtSave: 'active' });
    spy.mockRestore();
  });
});
