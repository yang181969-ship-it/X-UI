// M3 write chains on the database (DATA_MODEL §10.10; TEST_PLAN IMM-7, IMM-9, IDEM-6 – IDEM-8, RTY,
// FI §5.15, CC §5.16, MUT §5.17), run unchanged on libsql (openV1Db) and local D1 (workerd,
// persist: false, remoteBindings: false — no remote D1).
//
// The chains are the test kit's (m3-ledger.ts): the three financial writes built exactly as §10.10
// prescribes, without the routes of M3-B2. What is verified here is what the database guarantees
// for them — the key row is inserted last and only when every step reached its final state, one
// batch is all or nothing, the same key never writes twice, versions advance one at a time under
// races — and that each trigger, index and chain condition is load-bearing (mutations).
import { createHash } from 'node:crypto';
import { classify, type ClassificationInput } from '@xui/ledger-shared';
import { and, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ledgerIdempotencyKeys, users } from '../src/db/schema.ts';
import {
  correctChain,
  count,
  createChain,
  createInput,
  d1Engine,
  enRow,
  errorText,
  evRow,
  freshIds,
  ins,
  KEY_TTL_MS,
  ledgerCounts,
  ledgerDump,
  libsqlEngine,
  newKey,
  nid,
  one,
  publishRaw,
  rawTxn,
  seedUser,
  spendFacts,
  steps,
  transferFacts,
  TS,
  voidChain,
  type CorrectIn,
  type CreateIn,
  type Engine,
  type Seed,
  type VoidIn,
} from './m3-ledger.ts';

const engines: Partial<Record<'libsql' | 'd1', Engine>> = {};
beforeAll(async () => {
  engines.libsql = await libsqlEngine();
  engines.d1 = await d1Engine('xui-m3-chains');
}, 180_000);
afterAll(async () => {
  await engines.d1?.dispose();
  await engines.libsql?.dispose();
});

async function rejection(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (err === null) expect.fail('expected the database to refuse the batch, but it succeeded');
  return errorText(err);
}
const raises = async (p: Promise<unknown>, code: string | RegExp) => expect(await rejection(p)).toMatch(typeof code === 'string' ? new RegExp(`\\b${code}\\b`) : code);
const KEY_NOT_NULL = /NOT NULL constraint failed: ledger_idempotency_keys\.(result_revision|result_event_id|audit_id)/;
const DAY = 86_400_000;

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const createIn = (s: Seed, x: Partial<CreateIn> = {}) => createInput(s, hash, x);
const pendingHK = (s: Seed) => [{ id: nid('N'), direction: 'out' as const, accountId: s.HK, currency: 'HKD', amount: null, amountStatus: 'pending' as const, exponent: 2, closedCurrencyAck: false }];
function correctIn(s: Seed, c: { T: string; facts: CreateIn['facts']; classification: CreateIn['classification']; entries: CreateIn['entries'] }, x: Partial<CorrectIn> = {}): CorrectIn {
  const key = x.key ?? newKey();
  return {
    u: s.u, T: c.T, E: nid('E'), O: nid('O'), A: nid('A'), now: TS + 100, ip: '10.0.0.2', key, requestHash: hash(key), hashVersion: 1,
    baseRevision: 1, kind: 'fact_correction', reason: 'correction', facts: c.facts, correctedHomeRegion: null, classification: c.classification,
    entries: c.entries.map((en) => ({ ...en, id: nid('N'), carriedFromEntryId: en.id })), ...x,
  };
}
function voidIn(s: Seed, T: string, x: Partial<VoidIn> = {}): VoidIn {
  const key = x.key ?? newKey();
  return { u: s.u, T, now: TS + 200, ip: '10.0.0.3', baseRevision: 1, reason: null, O: nid('O'), A: nid('A'), key, requestHash: hash(key), hashVersion: 1, ...x };
}
/** A retry of the same request: same key and hash, new ids (the route generates them per attempt). */
const again = <T extends { O: string; A: string }>(x: T): T => {
  const y = { ...x, O: nid('O'), A: nid('A') } as T & { E?: string; entries?: CreateIn['entries'] };
  if ('E' in y) y.E = nid('E');
  if (y.entries) y.entries = y.entries.map((en) => ({ ...en, id: nid('N') }));
  return y as T;
};
const run = {
  create: (e: Engine, x: CreateIn) => e.db.batch(steps(createChain(e.db, x))),
  correct: (e: Engine, x: CorrectIn) => e.db.batch(steps(correctChain(e.db, x))),
  void: (e: Engine, x: VoidIn) => e.db.batch(steps(voidChain(e.db, x))),
};
const keyRow = (e: Engine, u: string, key: string) => e.all('SELECT * FROM ledger_idempotency_keys WHERE user_id = ? AND key = ?', [u, key]).then((r) => r[0]);
const header = (e: Engine, T: string) => one(e, 'SELECT status, current_revision, voided_op_id FROM transactions WHERE id = ?', [T]);

// ================================================================== once per engine

describe.each(['libsql', 'd1'] as const)('M3 write chains on %s', (name) => {
  const e = () => engines[name]!;
  beforeEach(async () => {
    await e().ping();
  });

  describe('the three chains commit whole, key row last and complete', () => {
    it('create: header, version 1, entries, publish, audit and a permanent 201 key in one batch', async () => {
      const s = await seedUser(e());
      const c = createIn(s);
      await run.create(e(), c);
      expect(await header(e(), c.T)).toEqual({ status: 'active', current_revision: 1, voided_op_id: null });
      expect(await keyRow(e(), s.u, c.key)).toMatchObject({ operation: 'transaction.create', op_id: c.O, transaction_id: c.T, result_revision: 1, result_event_id: c.E, audit_id: c.A, response_status: 201, expires_at: null });
      const audit = await one(e(), 'SELECT user_id, action, detail, ip FROM audit_log WHERE id = ?', [c.A]);
      expect({ ...audit, detail: JSON.parse(String(audit.detail)) }).toEqual({ user_id: s.u, action: 'transaction.create', detail: { id: c.T, eventId: c.E, revision: 1 }, ip: '10.0.0.1' });
      expect(await ledgerCounts(e(), s.u)).toEqual({ transactions: 1, transaction_events: 1, transaction_entries: 1, ledger_idempotency_keys: 1, audit: 1 });
    });

    it('correct (all three kinds): r → r+1 each time, snapshots carried unless corrected; 201 keys kept 30 days', async () => {
      const s = await seedUser(e());
      const c = createIn(s, { entries: pendingHK(s) });
      await run.create(e(), c);
      // Settings and account country change afterwards: carried snapshots do not follow (M3-2, M3-3).
      await ins(e(), 'user_preferences', { user_id: s.u, home_region: 'SG', created_at: TS, updated_at: TS });
      await e().run("UPDATE accounts SET account_country = 'SG' WHERE id = ?", [s.HK]);
      // settlement: pending → confirmed.
      const st = correctIn(s, c, { kind: 'settlement', reason: null, entries: [{ ...c.entries[0]!, id: nid('N'), amount: 7830, amountStatus: 'confirmed', carriedFromEntryId: c.entries[0]!.id }] });
      await run.correct(e(), st);
      // fact_correction: the same account (carried, still HK) plus nothing else changed but the amount; then a new account (current country).
      const fc = correctIn(s, { ...c, entries: st.entries }, { baseRevision: 2, facts: spendFacts({ cardId: s.K, eventAmount: 1200 }), entries: [{ ...st.entries[0]!, id: nid('N'), amount: 9400, carriedFromEntryId: st.entries[0]!.id }] });
      await run.correct(e(), fc);
      const fc2 = correctIn(s, { ...c, entries: fc.entries }, { baseRevision: 3, facts: fc.facts, entries: [{ id: nid('N'), direction: 'out', accountId: s.BE, currency: 'USD', amount: 1200, amountStatus: 'confirmed', exponent: 2, closedCurrencyAck: false }] });
      await run.correct(e(), fc2);
      // snapshot_correction: home region and the entry's jurisdiction; classification re-derived.
      const sc = correctIn(s, { ...c, entries: fc2.entries }, {
        baseRevision: 4, kind: 'snapshot_correction', reason: 'home region was HK then', facts: fc.facts, correctedHomeRegion: 'HK',
        entries: [{ ...fc2.entries[0]!, id: nid('N'), carriedFromEntryId: fc2.entries[0]!.id, correctedCountry: 'HK' }],
        classification: classifyAs('merchant_spend', 'HK', 'US', [{ direction: 'out', fundingAccountCountry: 'HK' }]),
      });
      await run.correct(e(), sc);
      const versions = await e().all(
        `SELECT ev.revision, ev.revision_kind, ev.home_region, ev.home_region_source, en.funding_account_id, en.funding_account_country, en.country_source, en.amount, ev.foreign_status
         FROM transaction_events ev JOIN transaction_entries en ON en.event_id = ev.id WHERE ev.transaction_id = ? ORDER BY ev.revision`,
        [c.T],
      );
      expect(versions).toEqual([
        { revision: 1, revision_kind: 'original', home_region: 'CN', home_region_source: 'preference_at_save', funding_account_id: s.HK, funding_account_country: 'HK', country_source: 'account_at_save', amount: null, foreign_status: 'foreign' },
        { revision: 2, revision_kind: 'settlement', home_region: 'CN', home_region_source: 'carried', funding_account_id: s.HK, funding_account_country: 'HK', country_source: 'carried', amount: 7830, foreign_status: 'foreign' },
        { revision: 3, revision_kind: 'fact_correction', home_region: 'CN', home_region_source: 'carried', funding_account_id: s.HK, funding_account_country: 'HK', country_source: 'carried', amount: 9400, foreign_status: 'foreign' },
        { revision: 4, revision_kind: 'fact_correction', home_region: 'CN', home_region_source: 'carried', funding_account_id: s.BE, funding_account_country: 'BE', country_source: 'account_at_save', amount: 1200, foreign_status: 'foreign' },
        { revision: 5, revision_kind: 'snapshot_correction', home_region: 'HK', home_region_source: 'user_corrected', funding_account_id: s.BE, funding_account_country: 'HK', country_source: 'user_corrected', amount: 1200, foreign_status: 'foreign' },
      ]);
      for (const x of [st, fc, fc2, sc]) {
        expect(await keyRow(e(), s.u, x.key)).toMatchObject({ operation: 'transaction.correct', result_event_id: x.E, response_status: 201, expires_at: x.now + KEY_TTL_MS });
        const a = await one(e(), 'SELECT detail FROM audit_log WHERE id = ?', [x.A]);
        expect(JSON.parse(String(a.detail))).toEqual({ id: c.T, eventId: x.E, revision: x.baseRevision + 1, kind: x.kind });
      }
    });

    it('void: once, 200 key pointing at the version that was current; afterwards neither correct nor void writes', async () => {
      const s = await seedUser(e());
      const c = createIn(s);
      await run.create(e(), c);
      const v = voidIn(s, c.T, { reason: 'duplicate' });
      await run.void(e(), v);
      expect(await one(e(), 'SELECT status, current_revision, voided_at, void_reason, voided_op_id FROM transactions WHERE id = ?', [c.T])).toEqual({ status: 'voided', current_revision: 1, voided_at: v.now, void_reason: 'duplicate', voided_op_id: v.O });
      expect(await keyRow(e(), s.u, v.key)).toMatchObject({ operation: 'transaction.void', op_id: v.O, result_revision: 1, result_event_id: c.E, audit_id: v.A, response_status: 200, expires_at: v.now + KEY_TTL_MS });
      expect(JSON.parse(String((await one(e(), 'SELECT detail FROM audit_log WHERE id = ?', [v.A])).detail))).toEqual({ id: c.T, eventId: c.E, revision: 1 });
      const before = await ledgerDump(e());
      await raises(run.void(e(), voidIn(s, c.T)), KEY_NOT_NULL);
      await raises(run.correct(e(), correctIn(s, c)), KEY_NOT_NULL);
      expect(await ledgerDump(e())).toEqual(before);
      // Notes still change on a voided transaction (P9) — outside any chain.
      await e().run("UPDATE transactions SET notes = 'kept', updated_at = ? WHERE id = ?", [TS + 300, c.T]);
    });
  });

  describe('IMM-7 a step that did not reach its final state rolls the whole batch back', () => {
    const DROP: Record<string, string[]> = {
      create: ['S1', 'S2', 'S3', 'S4', 'S5'],
      correct: ['S1', 'S2', 'S3', 'S4'],
      void: ['S1', 'S2'],
    };
    for (const [op, stepsToDrop] of Object.entries(DROP)) {
      for (const step of stepsToDrop) {
        it(`${op} without ${step}: key row NOT NULL fails; nothing of the batch remains`, async () => {
          const s = await seedUser(e());
          const base = createIn(s);
          let chain: Record<string, unknown>;
          if (op === 'create') chain = createChain(e().db, base);
          else {
            await run.create(e(), base);
            chain = op === 'correct' ? correctChain(e().db, correctIn(s, base)) : voidChain(e().db, voidIn(s, base.T));
          }
          const before = await ledgerDump(e());
          const { [step]: _dropped, ...rest } = chain;
          await raises(e().db.batch(steps(rest as never)), op === 'create' && step === 'S1' ? /FOREIGN KEY constraint failed|NOT NULL constraint failed: ledger_idempotency_keys/ : KEY_NOT_NULL);
          expect(await ledgerDump(e())).toEqual(before);
        });
      }
    }

    it('an entry that writes nothing (another user’s account) fails the publish condition — nothing remains', async () => {
      const s = await seedUser(e());
      const other = await seedUser(e());
      const before = await ledgerDump(e());
      await raises(run.create(e(), createIn(s, { entries: [{ ...createIn(s).entries[0]!, accountId: other.HK }] })), KEY_NOT_NULL);
      const own = createIn(s, {
        txnType: 'own_transfer', facts: transferFacts('self'), classification: { merchantScope: null, transferScope: 'foreign_cross_border', foreignStatus: 'foreign' },
        entries: [
          { id: nid('N'), direction: 'out', accountId: s.HK, currency: 'HKD', amount: 100, amountStatus: 'confirmed', exponent: 2, closedCurrencyAck: false },
          { id: nid('N'), direction: 'in', accountId: s.BE, currency: 'JPY', amount: 100, amountStatus: 'confirmed', exponent: 0, closedCurrencyAck: false },
        ],
      });
      await raises(run.create(e(), own), KEY_NOT_NULL); // BE holds no JPY: the second entry writes nothing
      expect(await ledgerDump(e())).toEqual(before);
    });
  });

  describe('idempotency (IDEM-5, IDEM-6, IDEM-7, RTY)', () => {
    it('the same key again writes nothing — same request or not; the stored hash tells the route to replay or answer 409', async () => {
      const s = await seedUser(e());
      const c = createIn(s);
      await run.create(e(), c);
      const after = await ledgerDump(e());
      await run.create(e(), freshIds(c)); // RTY-1: committed, response lost, retried
      const other = { ...freshIds(c), requestHash: hash('different body'), notes: 'different' };
      await run.create(e(), other);
      expect(await ledgerDump(e())).toEqual(after);
      const k = await keyRow(e(), s.u, c.key);
      expect(k).toMatchObject({ op_id: c.O, request_hash: c.requestHash });
      expect(k!.request_hash).not.toBe(other.requestHash);
      // Keys are per user: another user's identical key is independent (ISO-5).
      const t = await seedUser(e());
      const tc = createIn(t, { key: c.key });
      await run.create(e(), tc);
      expect(await count(e(), 'transactions', 'user_id = ?', [t.u])).toBe(1);
      // Correct and void retries are no-ops as well (RTY-2, RTY-3).
      const cr = correctIn(s, c);
      await run.correct(e(), cr);
      const vd = voidIn(s, c.T, { baseRevision: 2 });
      await run.void(e(), vd);
      const settled = await ledgerDump(e());
      await run.correct(e(), again(cr));
      await run.void(e(), again(vd));
      expect(await ledgerDump(e())).toEqual(settled);
      expect(await count(e(), 'audit_log', "user_id = ? AND action = 'transaction.void'", [s.u])).toBe(1);
    });

    it('IDEM-6 / RTY-4: a failed request stores no key; the same key then runs exactly once', async () => {
      const s = await seedUser(e());
      const bad = createIn(s, { entries: [{ ...createIn(s).entries[0]!, amount: 78.3 }] });
      await raises(run.create(e(), bad), /CHECK constraint failed: transaction_entries_amount_ck/);
      expect(await keyRow(e(), s.u, bad.key)).toBeUndefined();
      const fixed = { ...freshIds(bad), entries: [{ ...bad.entries[0]!, id: nid('N'), amount: 7830 }] };
      await run.create(e(), fixed);
      await run.create(e(), freshIds(fixed));
      expect(await ledgerCounts(e(), s.u)).toEqual({ transactions: 1, transaction_events: 1, transaction_entries: 1, ledger_idempotency_keys: 1, audit: 1 });
      // A stale base revision is a failure too (409 at the route): no key, and the right base then works with the same key.
      const cr = correctIn(s, fixed, { baseRevision: 2 });
      await raises(run.correct(e(), cr), KEY_NOT_NULL);
      expect(await keyRow(e(), s.u, cr.key)).toBeUndefined();
      await run.correct(e(), { ...again(cr), baseRevision: 1 });
      expect((await header(e(), fixed.T)).current_revision).toBe(2);
    });

    it('IDEM-7: every key row is complete and points at a published version of its transaction and at its audit record', async () => {
      const rows = await e().all(
        `SELECT k.operation, k.result_revision, t.current_revision, t.status, ev.revision AS ev_revision, ev.transaction_id = k.transaction_id AS same_txn, a.id IS NOT NULL AS has_audit, a.action
         FROM ledger_idempotency_keys k
         JOIN transactions t ON t.id = k.transaction_id AND t.user_id = k.user_id
         JOIN transaction_events ev ON ev.id = k.result_event_id AND ev.user_id = k.user_id
         LEFT JOIN audit_log a ON a.id = k.audit_id`,
      );
      expect(rows.length).toBeGreaterThan(10);
      for (const r of rows) {
        expect(r.result_revision).toBe(r.ev_revision);
        expect(Number(r.result_revision)).toBeLessThanOrEqual(Number(r.current_revision));
        expect(r.same_txn).toBe(1);
        expect(r.has_audit).toBe(1);
        expect(r.action).toBe(r.operation);
      }
      for (const col of ['operation', 'request_hash', 'hash_version', 'op_id', 'transaction_id', 'result_revision', 'result_event_id', 'audit_id', 'response_status', 'created_at']) {
        expect(await count(e(), 'ledger_idempotency_keys', `${col} IS NULL`), col).toBe(0);
      }
    });

    it('IDEM-8: S0 deletes only this user’s expired correct / void keys; create keys stay; an expired key cannot write twice', async () => {
      const a = await seedUser(e());
      const b = await seedUser(e());
      const ca = createIn(a);
      await run.create(e(), ca);
      const cra = correctIn(a, ca, { now: TS + 5 });
      await run.correct(e(), cra);
      const ca2 = createIn(a, { now: TS + 6 });
      await run.create(e(), ca2);
      const crLate = correctIn(a, ca2, { now: TS + 10 * DAY }); // expires TS + 40 days
      await run.correct(e(), crLate);
      const va = voidIn(a, ca.T, { now: TS + 7, baseRevision: 2 });
      await run.void(e(), va);
      const cb = createIn(b);
      await run.create(e(), cb);
      const crb = correctIn(b, cb, { now: TS + 5 });
      await run.correct(e(), crb);
      const keysOf = async (u: string) => (await e().all('SELECT key FROM ledger_idempotency_keys WHERE user_id = ? ORDER BY key', [u])).map((r) => String(r.key));
      const bKeys = await keysOf(b.u);
      // 31 days later user a writes again: its S0 runs.
      const later = createIn(a, { now: TS + 31 * DAY });
      await run.create(e(), later);
      expect(await keysOf(a.u)).toEqual([ca.key, ca2.key, crLate.key, later.key].sort());
      expect(await keysOf(b.u)).toEqual(bKeys);
      // The expired keys' requests again: the version has moved on / the transaction is voided — nothing is written (409 at the route).
      const before = await ledgerDump(e());
      await raises(run.correct(e(), again({ ...cra, now: TS + 32 * DAY })), KEY_NOT_NULL);
      await raises(run.void(e(), again({ ...va, now: TS + 32 * DAY })), KEY_NOT_NULL);
      expect(await ledgerDump(e())).toEqual(before);
      // A create key can never be deleted while its user exists.
      await raises(e().run('DELETE FROM ledger_idempotency_keys WHERE user_id = ? AND key = ?', [a.u, ca.key]), 'LEDGER_NO_DELETE');
    });
  });

  describe('ISO B2 contract: through the chains, another user’s reference and a missing one are indistinguishable', () => {
    /**
     * The chains select every owned parent with user_id = the caller (accounts, account currencies,
     * carried entries, the transaction itself), so a foreign or missing parent writes zero rows and
     * the batch ends in the key-row NOT NULL failure; card / channel ids are bound values checked by
     * their composite foreign keys. No LEDGER_* trigger ever sees such a row. B2 never maps either
     * failure by itself (DATA_MODEL §10.10, TEST_PLAN ISO-6 / ISO-7): it re-reads as the caller →
     * 404 / 409 / 400, and a failure the re-read can't explain is a generic 500.
     */
    const outcome = async (p: Promise<unknown>) => {
      const msg = await rejection(p);
      return KEY_NOT_NULL.test(msg) ? 'KEY_NOT_NULL' : /FOREIGN KEY constraint failed/.test(msg) ? 'FOREIGN_KEY' : msg;
    };

    it('create / correct / void with b’s or nonexistent account, currency, card, channel, carried entry or transaction', async () => {
      const a = await seedUser(e());
      const b = await seedUser(e());
      const bc = createIn(b);
      await run.create(e(), bc);
      const ac = createIn(a);
      await run.create(e(), ac);
      const before = await ledgerDump(e());
      const entry = (x: Partial<CreateIn['entries'][number]>) => [{ ...ac.entries[0]!, id: nid('N'), ...x }];
      const pairs: [string, () => Promise<unknown>, () => Promise<unknown>, string][] = [
        ['account', () => run.create(e(), createIn(a, { entries: entry({ accountId: b.HK }) })), () => run.create(e(), createIn(a, { entries: entry({ accountId: 'no-such-account' }) })), 'KEY_NOT_NULL'],
        ['currency', () => run.create(e(), createIn(a, { entries: entry({ accountId: a.BE, currency: 'HKD' }) })), () => run.create(e(), createIn(a, { entries: entry({ accountId: a.BE, currency: 'JPY' }) })), 'KEY_NOT_NULL'],
        ['card', () => run.create(e(), createIn(a, { facts: spendFacts({ cardId: b.K }) })), () => run.create(e(), createIn(a, { facts: spendFacts({ cardId: 'no-such-card' }) })), 'FOREIGN_KEY'],
        ['channel', () => run.create(e(), createIn(a, { facts: spendFacts({ paymentChannelId: b.PP }) })), () => run.create(e(), createIn(a, { facts: spendFacts({ paymentChannelId: 'no-such-channel' }) })), 'FOREIGN_KEY'],
        ['carried entry', () => run.correct(e(), correctIn(a, ac, { entries: [{ ...ac.entries[0]!, id: nid('N'), carriedFromEntryId: bc.entries[0]!.id }] })), () => run.correct(e(), correctIn(a, ac, { entries: [{ ...ac.entries[0]!, id: nid('N'), carriedFromEntryId: 'no-such-entry' }] })), 'KEY_NOT_NULL'],
        ['correct: transaction', () => run.correct(e(), correctIn(a, { ...ac, T: bc.T })), () => run.correct(e(), correctIn(a, { ...ac, T: 'no-such-txn' })), 'KEY_NOT_NULL'],
        ['void: transaction', () => run.void(e(), voidIn(a, bc.T)), () => run.void(e(), voidIn(a, 'no-such-txn')), 'KEY_NOT_NULL'],
      ];
      for (const [ref, foreign, missing, expected] of pairs) {
        const f = await outcome(foreign());
        expect(f, ref).toBe(expected);
        expect(await outcome(missing()), ref).toBe(f);
        for (const id of [b.u, b.HK, b.BE, b.K, b.PP, bc.T, bc.E, bc.entries[0]!.id]) expect(errorText(await rejection(foreign())), ref).not.toContain(id);
      }
      expect(await ledgerDump(e())).toEqual(before);
    });
  });

  describe('FI injected failure at every step: nothing remains; the same key then succeeds once', () => {
    it('S0 (expired-key cleanup) failing rolls the whole create back, the expired key included', async () => {
      const s = await seedUser(e());
      const c = createIn(s);
      await run.create(e(), c);
      await run.correct(e(), correctIn(s, c, { now: TS + 5 }));
      const later = createIn(s, { now: TS + 31 * DAY });
      const before = await ledgerDump(e());
      await e().run(`CREATE TRIGGER test_inject BEFORE DELETE ON ledger_idempotency_keys WHEN OLD.user_id = '${s.u}' BEGIN SELECT RAISE(ABORT, 'TEST_INJECTED_FAILURE'); END`);
      try {
        await raises(run.create(e(), later), 'TEST_INJECTED_FAILURE');
      } finally {
        await e().run('DROP TRIGGER IF EXISTS test_inject');
      }
      expect(await ledgerDump(e())).toEqual(before);
      expect(await count(e(), 'ledger_idempotency_keys', "user_id = ? AND operation = 'transaction.correct'", [s.u])).toBe(1);
      await run.create(e(), freshIds(later));
      expect(await count(e(), 'ledger_idempotency_keys', "user_id = ? AND operation = 'transaction.correct'", [s.u])).toBe(0);
      expect(await count(e(), 'transactions', 'user_id = ?', [s.u])).toBe(2);
    });

    const inject = (table: string, timing: string, cond: string) => `CREATE TRIGGER test_inject ${timing} ON ${table} WHEN ${cond} BEGIN SELECT RAISE(ABORT, 'TEST_INJECTED_FAILURE'); END`;
    async function injected(trigger: string, attempt: () => Promise<unknown>, retry: () => Promise<unknown>) {
      const before = await ledgerDump(e());
      await e().run(trigger);
      try {
        await raises(attempt(), 'TEST_INJECTED_FAILURE');
      } finally {
        await e().run('DROP TRIGGER IF EXISTS test_inject');
      }
      expect(await ledgerDump(e())).toEqual(before);
      await retry();
      const done = await ledgerDump(e());
      await retry();
      expect(await ledgerDump(e())).toEqual(done);
    }

    it('create: header, event, each entry, publish, audit, key row', async () => {
      const s = await seedUser(e());
      const two = () =>
        createIn(s, {
          txnType: 'own_transfer', facts: transferFacts('self'), classification: { merchantScope: null, transferScope: 'foreign_cross_border', foreignStatus: 'foreign' },
          entries: [
            { id: nid('N'), direction: 'out', accountId: s.HK, currency: 'HKD', amount: 783000, amountStatus: 'confirmed', exponent: 2, closedCurrencyAck: false },
            { id: nid('N'), direction: 'in', accountId: s.BE, currency: 'USD', amount: 99850, amountStatus: 'confirmed', exponent: 2, closedCurrencyAck: false },
          ],
        });
      const points: [string, (x: CreateIn) => string][] = [
        ['header', (x) => inject('transactions', 'BEFORE INSERT', `NEW.id = '${x.T}'`)],
        ['event', (x) => inject('transaction_events', 'BEFORE INSERT', `NEW.id = '${x.E}'`)],
        ['entry 1', (x) => inject('transaction_entries', 'BEFORE INSERT', `NEW.id = '${x.entries[0]!.id}'`)],
        ['entry 2', (x) => inject('transaction_entries', 'BEFORE INSERT', `NEW.id = '${x.entries[1]!.id}'`)],
        ['publish', (x) => inject('transactions', 'BEFORE UPDATE OF current_revision', `NEW.id = '${x.T}'`)],
        ['audit', (x) => inject('audit_log', 'BEFORE INSERT', `NEW.id = '${x.A}'`)],
        ['key row', (x) => inject('ledger_idempotency_keys', 'BEFORE INSERT', `NEW.key = '${x.key}'`)],
      ];
      for (const [, trig] of points) {
        const x = two();
        await injected(trig(x), () => run.create(e(), x), () => run.create(e(), freshIds(x)));
      }
      expect(await count(e(), 'transactions', 'user_id = ?', [s.u])).toBe(points.length);
      expect(await count(e(), 'audit_log', 'user_id = ?', [s.u])).toBe(points.length);
    });

    it('correct (settlement, fact_correction, snapshot_correction): event, entry, publish, audit, key row', async () => {
      const s = await seedUser(e());
      const kinds: ((c: CreateIn) => CorrectIn)[] = [
        (c) => correctIn(s, c, { kind: 'settlement', reason: null, entries: [{ ...c.entries[0]!, id: nid('N'), amount: 7830, amountStatus: 'confirmed', carriedFromEntryId: c.entries[0]!.id }] }),
        (c) => correctIn(s, c, { facts: spendFacts({ cardId: s.K, occurredOn: '2026-10-19' }) }),
        (c) => correctIn(s, c, { kind: 'snapshot_correction', reason: 'r', correctedHomeRegion: 'HK', classification: classifyAs('merchant_spend', 'HK', 'US', [{ direction: 'out', fundingAccountCountry: 'HK' }]) }),
      ];
      const points: [string, (x: CorrectIn) => string][] = [
        ['event', (x) => inject('transaction_events', 'BEFORE INSERT', `NEW.id = '${x.E}'`)],
        ['entry', (x) => inject('transaction_entries', 'BEFORE INSERT', `NEW.id = '${x.entries[0]!.id}'`)],
        ['publish', (x) => inject('transactions', 'BEFORE UPDATE OF current_revision', `NEW.id = '${x.T}'`)],
        ['audit', (x) => inject('audit_log', 'BEFORE INSERT', `NEW.id = '${x.A}'`)],
        ['key row', (x) => inject('ledger_idempotency_keys', 'BEFORE INSERT', `NEW.key = '${x.key}'`)],
      ];
      for (const make of kinds) {
        for (const [, trig] of points) {
          const c = createIn(s, { entries: pendingHK(s) });
          await run.create(e(), c);
          const x = make(c);
          await injected(trig(x), () => run.correct(e(), x), () => run.correct(e(), again(x)));
          expect((await header(e(), c.T)).current_revision).toBe(2);
        }
      }
    });

    it('void: header update, audit, key row', async () => {
      const s = await seedUser(e());
      const points: [string, (x: VoidIn) => string][] = [
        ['header', (x) => inject('transactions', 'BEFORE UPDATE OF status', `NEW.id = '${x.T}'`)],
        ['audit', (x) => inject('audit_log', 'BEFORE INSERT', `NEW.id = '${x.A}'`)],
        ['key row', (x) => inject('ledger_idempotency_keys', 'BEFORE INSERT', `NEW.key = '${x.key}'`)],
      ];
      for (const [, trig] of points) {
        const c = createIn(s);
        await run.create(e(), c);
        const x = voidIn(s, c.T);
        await injected(trig(x), () => run.void(e(), x), () => run.void(e(), again(x)));
        expect((await header(e(), c.T)).status).toBe('voided');
        expect(await count(e(), 'audit_log', "action = 'transaction.void' AND detail LIKE ?", [`%${c.T}%`])).toBe(1);
      }
    });
  });

  describe('CC concurrency (both engines serialize writers)', () => {
    it('CC-1 / CC-2: concurrent requests with one key — one transaction, one audit, one key row', async () => {
      const s = await seedUser(e());
      const c = createIn(s);
      const results = await Promise.allSettled([run.create(e(), freshIds(c)), run.create(e(), freshIds(c)), run.create(e(), { ...freshIds(c), requestHash: hash('other'), notes: 'other' })]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
      expect(await ledgerCounts(e(), s.u)).toEqual({ transactions: 1, transaction_events: 1, transaction_entries: 1, ledger_idempotency_keys: 1, audit: 1 });
    });

    it('CC-3: corrections on the same base — exactly one wins; correct vs void — exactly one wins; versions stay contiguous', async () => {
      const s = await seedUser(e());
      const c = createIn(s);
      await run.create(e(), c);
      const r1 = await Promise.allSettled([run.correct(e(), correctIn(s, c)), run.correct(e(), correctIn(s, c)), run.correct(e(), correctIn(s, c))]);
      expect(r1.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of r1.filter((x) => x.status === 'rejected')) expect(errorText((r as PromiseRejectedResult).reason)).toMatch(KEY_NOT_NULL);
      expect((await e().all('SELECT revision FROM transaction_events WHERE transaction_id = ? ORDER BY revision', [c.T])).map((r) => r.revision)).toEqual([1, 2]);
      const latest = await e().all('SELECT id FROM transaction_entries WHERE event_id = (SELECT id FROM transaction_events WHERE transaction_id = ? AND revision = 2)', [c.T]);
      const next = correctIn(s, { ...c, entries: c.entries.map((en) => ({ ...en, id: String(latest[0]!.id) })) }, { baseRevision: 2 });
      const r2 = await Promise.allSettled([run.void(e(), voidIn(s, c.T, { baseRevision: 2 })), run.correct(e(), next)]);
      expect(r2.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const h = await header(e(), c.T);
      expect(h.status === 'voided' ? h.current_revision : h.current_revision).toBe(h.status === 'voided' ? 2 : 3);
      expect(await count(e(), 'audit_log', "user_id = ? AND action IN ('transaction.correct', 'transaction.void')", [s.u])).toBe(2);
    });

    it('CC-6: notes and a correction do not affect each other', async () => {
      const s = await seedUser(e());
      const c = createIn(s, { notes: 'first' });
      await run.create(e(), c);
      await Promise.all([e().run("UPDATE transactions SET notes = 'second', updated_at = ? WHERE id = ?", [TS + 50, c.T]), run.correct(e(), correctIn(s, c))]);
      expect(await one(e(), 'SELECT notes, current_revision FROM transactions WHERE id = ?', [c.T])).toEqual({ notes: 'second', current_revision: 2 });
    });
  });

  describe('IMM-9 no unpublished residue', () => {
    const RESIDUE = `SELECT (SELECT count(*) FROM transactions t WHERE t.user_id = ?1 AND t.current_revision = 0)
                          + (SELECT count(*) FROM transaction_events ev JOIN transactions t ON t.id = ev.transaction_id WHERE ev.user_id = ?1 AND ev.revision > t.current_revision) AS n`;
    it('users written only through the chains (including all failures above) have none; the check finds raw-SQL residue', async () => {
      const chainUsers = (await e().all('SELECT DISTINCT user_id FROM ledger_idempotency_keys')).map((r) => String(r.user_id));
      expect(chainUsers.length).toBeGreaterThan(5);
      for (const u of chainUsers) expect(Number((await one(e(), RESIDUE, [u])).n), u).toBe(0);
      const s = await seedUser(e());
      await rawTxn(e(), s, 'merchant_spend', { publish: false });
      expect(Number((await one(e(), RESIDUE, [s.u])).n)).toBe(2);
    });
  });

  // ---------------------------------------------------------------- MUT (TEST_PLAN §5.17)

  describe('MUT every trigger, key index and chain condition is load-bearing', () => {
    /**
     * Replace the triggers of one table for the duration of `body`: `mutate` gets every trigger of
     * that table (rowid order) and returns the list to install (drop, rewrite or keep); afterwards
     * the original list is re-created in its original order and compared with what it was.
     */
    async function withTriggers(table: string, mutate: (list: { name: string; sql: string }[]) => { name: string; sql: string }[], body: () => Promise<void>) {
      const original = (await e().all("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY rowid", [table])).map((r) => ({ name: String(r.name), sql: String(r.sql) }));
      const swap = async (from: { name: string }[], to: { sql: string }[]) => {
        for (const t of from) await e().run(`DROP TRIGGER IF EXISTS ${t.name}`);
        for (const t of to) await e().run(t.sql);
      };
      const mutated = mutate(original);
      await swap(original, mutated);
      try {
        await body();
      } finally {
        await swap(mutated, original);
      }
      expect((await e().all("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY rowid", [table])).map((r) => ({ name: String(r.name), sql: String(r.sql) }))).toEqual(original);
    }
    const without = (name: string) => (list: { name: string; sql: string }[]) => list.filter((t) => t.name !== name);
    const rewrite = (name: string, f: (sql: string) => string) => (list: { name: string; sql: string }[]) =>
      list.map((t) => {
        if (t.name !== name) return t;
        const next = f(t.sql);
        expect(next, `${name} mutation applied`).not.toBe(t.sql);
        return { name, sql: next };
      });
    /** Under the mutation the violation goes through (or fails with another code); restored, it is refused again. */
    async function detected(table: string, mutate: Parameters<typeof withTriggers>[1], code: string, violate: () => Promise<unknown>) {
      await withTriggers(table, mutate, async () => {
        const outcome = await violate().then(
          () => 'accepted',
          (err: unknown) => errorText(err),
        );
        expect(outcome, 'mutation must change the outcome').not.toMatch(new RegExp(`\\b${code}\\b`));
      });
      await raises(violate(), code);
    }

    /** One violation per trigger (each builds its own fresh rows, so it can run twice). */
    const VIOLATIONS: Record<string, [table: string, code: string, violate: (s: Seed) => Promise<unknown>]> = {
      tx_insert_guard: ['transactions', 'LEDGER_HEADER_INSERT', (s) => ins(e(), 'transactions', { id: nid('T'), user_id: s.u, txn_type: 'merchant_spend', current_revision: 1, created_at: TS, updated_at: TS })],
      tx_update_guard: ['transactions', 'LEDGER_REVISION_ORDER', async (s) => e().run('UPDATE transactions SET current_revision = 3 WHERE id = ?', [(await rawTxn(e(), s, 'merchant_spend')).T])],
      tx_publish_entry_count: ['transactions', 'LEDGER_ENTRY_COUNT', async (s) => publishRaw(e(), (await rawTxn(e(), s, 'merchant_spend', { entries: [], publish: false })).T, 1)],
      tx_publish_own_shape: ['transactions', 'LEDGER_OWN_TRANSFER_SHAPE', async (s) => publishRaw(e(), (await rawTxn(e(), s, 'own_transfer', { ev: { transfer_scope: 'foreign_to_unknown' }, publish: false })).T, 1)],
      tx_publish_event_amount: ['transactions', 'LEDGER_EVENT_AMOUNT', async (s) => publishRaw(e(), (await rawTxn(e(), s, 'third_party_transfer', { ev: { event_amount: null, counterparty_country: 'US' }, publish: false })).T, 1)],
      tx_publish_classification: ['transactions', 'LEDGER_CLASSIFICATION', async (s) => publishRaw(e(), (await rawTxn(e(), s, 'merchant_spend', { ev: { foreign_status: 'undetermined' }, publish: false })).T, 1)],
      tx_publish_domestic: [
        'transactions',
        'LEDGER_CONFIRMED_DOMESTIC',
        async (s) => publishRaw(e(), (await rawTxn(e(), s, 'merchant_spend', { ev: { merchant_country: 'CN', merchant_scope: 'domestic', foreign_status: 'domestic' }, entries: [{ funding_account_id: s.CN, funding_currency: 'CNY', funding_account_country: 'CN' }], publish: false })).T, 1),
      ],
      tx_no_delete: ['transactions', 'LEDGER_NO_DELETE', async (s) => {
        const T = nid('T');
        await ins(e(), 'transactions', { id: T, user_id: s.u, txn_type: 'merchant_spend', created_at: TS, updated_at: TS });
        return e().run('DELETE FROM transactions WHERE id = ?', [T]);
      }],
      ev_immutable: ['transaction_events', 'LEDGER_IMMUTABLE', async (s) => e().run("UPDATE transaction_events SET correction_reason = 'x' WHERE id = ?", [(await rawTxn(e(), s, 'merchant_spend')).E])],
      ev_insert_order: ['transaction_events', 'LEDGER_REVISION_ORDER', async (s) => {
        const { T } = await rawTxn(e(), s, 'merchant_spend');
        await e().run("UPDATE transactions SET status = 'voided', voided_at = 1, voided_op_id = 'o' WHERE id = ?", [T]);
        return ins(e(), 'transaction_events', evRow(s, T, nid('E'), 'merchant_spend', { revision: 2, revision_kind: 'fact_correction', correction_reason: 'r', home_region_source: 'carried' }));
      }],
      ev_snapshot_source: ['transaction_events', 'LEDGER_SNAPSHOT_SOURCE', async (s) => {
        const T = nid('T');
        await ins(e(), 'transactions', { id: T, user_id: s.u, txn_type: 'merchant_spend', created_at: TS, updated_at: TS });
        return ins(e(), 'transaction_events', evRow(s, T, nid('E'), 'merchant_spend', { home_region: 'HK' }));
      }],
      ev_kind_guard: ['transaction_events', 'LEDGER_REVISION_KIND', async (s) => {
        const { T } = await rawTxn(e(), s, 'merchant_spend');
        return ins(e(), 'transaction_events', evRow(s, T, nid('E'), 'merchant_spend', { revision: 2, revision_kind: 'settlement', home_region_source: 'carried', occurred_on: '2026-10-19' }));
      }],
      ev_no_delete: ['transaction_events', 'LEDGER_NO_DELETE', async (s) => e().run('DELETE FROM transaction_events WHERE id = ?', [(await rawTxn(e(), s, 'merchant_spend', { entries: [], publish: false })).E])],
      en_immutable: ['transaction_entries', 'LEDGER_IMMUTABLE', async (s) => e().run('UPDATE transaction_entries SET amount = 1 WHERE id = ?', [(await rawTxn(e(), s, 'merchant_spend')).N[0]])],
      en_insert_open: ['transaction_entries', 'LEDGER_IMMUTABLE', async (s) => {
        const t = await rawTxn(e(), s, 'own_transfer', { ev: { counterparty_country: 'US' } });
        return ins(e(), 'transaction_entries', enRow(s, t.E, 'own_transfer', { direction: 'in', funding_account_id: s.BE, funding_currency: 'USD', funding_account_country: 'BE' }));
      }],
      en_snapshot_source: ['transaction_entries', 'LEDGER_SNAPSHOT_SOURCE', async (s) => ins(e(), 'transaction_entries', enRow(s, (await rawTxn(e(), s, 'merchant_spend', { entries: [], publish: false })).E, 'merchant_spend', { funding_account_country: 'GB' }))],
      en_kind_guard: ['transaction_entries', 'LEDGER_REVISION_KIND', async (s) => {
        const { T, N } = await rawTxn(e(), s, 'merchant_spend');
        const E2 = nid('E');
        await ins(e(), 'transaction_events', evRow(s, T, E2, 'merchant_spend', { revision: 2, revision_kind: 'settlement', home_region_source: 'carried' }));
        return ins(e(), 'transaction_entries', enRow(s, E2, 'merchant_spend', { carried_from_entry_id: N[0], country_source: 'carried', amount: 1 }));
      }],
      en_closed_currency: ['transaction_entries', 'LEDGER_CLOSED_CURRENCY', async (s) =>
        ins(e(), 'transaction_entries', enRow(s, (await rawTxn(e(), s, 'merchant_spend', { entries: [], publish: false })).E, 'merchant_spend', { funding_account_id: s.BE, funding_currency: 'GBP', funding_account_country: 'BE', currency_status_at_save: 'closed' }))],
      en_no_delete: ['transaction_entries', 'LEDGER_NO_DELETE', async (s) => e().run('DELETE FROM transaction_entries WHERE id = ?', [(await rawTxn(e(), s, 'merchant_spend', { publish: false })).N[0]])],
      key_immutable: ['ledger_idempotency_keys', 'LEDGER_KEY_IMMUTABLE', async (s) => {
        const c = createIn(s);
        await run.create(e(), c);
        return e().run("UPDATE ledger_idempotency_keys SET op_id = 'x' WHERE user_id = ? AND key = ?", [s.u, c.key]);
      }],
      key_create_no_delete: ['ledger_idempotency_keys', 'LEDGER_NO_DELETE', async (s) => {
        const c = createIn(s);
        await run.create(e(), c);
        return e().run('DELETE FROM ledger_idempotency_keys WHERE user_id = ? AND key = ?', [s.u, c.key]);
      }],
    };

    it('covers all 21 triggers', async () => {
      const names = (await e().all("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('transactions', 'transaction_events', 'transaction_entries', 'ledger_idempotency_keys')")).map((r) => String(r.name)).sort();
      expect(Object.keys(VIOLATIONS).sort()).toEqual(names);
    });
    for (const n of Object.keys(VIOLATIONS)) {
      it(`removing ${n} lets its violation through`, async () => {
        const [table, code, violate] = VIOLATIONS[n]!;
        const s = await seedUser(e());
        await detected(table, without(n), code, () => violate(s));
      });
    }

    it('tx_update_guard code order: swapping the identity and voided checks changes the code (IMM-2)', async () => {
      const s = await seedUser(e());
      const voidedTypeChange = async () => {
        const { T } = await rawTxn(e(), s, 'merchant_spend');
        await e().run("UPDATE transactions SET status = 'voided', voided_at = 1, voided_op_id = 'o' WHERE id = ?", [T]);
        return e().run("UPDATE transactions SET txn_type = 'merchant_refund', current_revision = 9 WHERE id = ?", [T]);
      };
      const swapBranches = (q: string) => {
        const a = q.indexOf('    WHEN NEW.`id` IS NOT OLD.`id`');
        const b = q.indexOf("    WHEN OLD.`status` = 'voided'");
        const c = q.indexOf('    WHEN NOT (');
        expect(a > 0 && b > a && c > b).toBe(true);
        return q.slice(0, a) + q.slice(b, c) + q.slice(a, b) + q.slice(c);
      };
      await withTriggers('transactions', rewrite('tx_update_guard', swapBranches), async () => {
        await raises(voidedTypeChange(), 'LEDGER_VOIDED');
      });
      await raises(voidedTypeChange(), 'LEDGER_HEADER_IMMUTABLE');
    });

    it('publish triggers WHEN: removing it (keeping OF current_revision) or making them unconditional makes non-publish updates run C2–C7 (IMM-11)', async () => {
      const s = await seedUser(e());
      // A published version that breaks C2 and C7 (built with the publish checks removed).
      const bad = await rawTxn(e(), s, 'merchant_spend', { ev: { merchant_country: 'CN', merchant_scope: 'domestic', foreign_status: 'domestic' }, entries: [], publish: false });
      await withTriggers('transactions', (list) => list.filter((t) => !t.name.startsWith('tx_publish_')), () => publishRaw(e(), bad.T, 1));
      const noWhen = (q: string) => q.replace(/FOR EACH ROW WHEN[\s\S]*?\nBEGIN/, 'FOR EACH ROW\nBEGIN');
      const unconditional = (q: string) => noWhen(q).replace('BEFORE UPDATE OF `current_revision` ON', 'BEFORE UPDATE ON');
      const all = (f: (q: string) => string) => (list: { name: string; sql: string }[]) => list.map((t) => (t.name.startsWith('tx_publish_') ? { name: t.name, sql: f(t.sql) } : t));
      const notesWithSameRevision = () => e().run("UPDATE transactions SET notes = 'x', current_revision = current_revision WHERE id = ?", [bad.T]);
      const notesOnly = () => e().run("UPDATE transactions SET notes = 'y' WHERE id = ?", [bad.T]);
      await withTriggers('transactions', all(noWhen), async () => {
        await raises(notesWithSameRevision(), /LEDGER_ENTRY_COUNT|LEDGER_CONFIRMED_DOMESTIC/);
      });
      await withTriggers('transactions', all(unconditional), async () => {
        await raises(notesOnly(), /LEDGER_ENTRY_COUNT|LEDGER_CONFIRMED_DOMESTIC/);
      });
      await notesWithSameRevision();
      await notesOnly();
    });

    it('en_snapshot_source matching by direction + account (instead of account) lets a direction flip re-read the account country', async () => {
      const s = await seedUser(e());
      const flipNotCarried = async () => {
        const c = createIn(s, {
          txnType: 'third_party_transfer', facts: transferFacts('third_party', { counterpartyCountry: 'US' }),
          classification: { merchantScope: null, transferScope: 'foreign_cross_border', foreignStatus: 'foreign' },
          entries: [{ id: nid('N'), direction: 'out', accountId: s.BE, currency: 'USD', amount: 1000, amountStatus: 'confirmed', exponent: 2, closedCurrencyAck: false }],
        });
        await run.create(e(), c);
        return run.correct(e(), correctIn(s, c, { entries: [{ ...c.entries[0]!, id: nid('N'), direction: 'in', carriedFromEntryId: null }] }));
      };
      const byDirection = (q: string) => q.replace('JOIN `transaction_entries` c ON c.`event_id` = ce.`id`', 'JOIN `transaction_entries` c ON c.`event_id` = ce.`id` AND c.`direction` = NEW.`direction`');
      await detected('transaction_entries', rewrite('en_snapshot_source', byDirection), 'LEDGER_SNAPSHOT_SOURCE', flipNotCarried);
    });

    it('key indexes: dropping one inside a batch lets its duplicate in (the batch is then rolled back, index restored)', async () => {
      const s = await seedUser(e());
      const lit = (r: Record<string, unknown>) =>
        `INSERT INTO transaction_entries (${Object.keys(r).join(', ')}) VALUES (${Object.values(r).map((v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v)}'`)).join(', ')})`;
      const cases: [string, string, () => Promise<Record<string, unknown>>][] = [
        ['transaction_entries_single_uq', 'transaction_entries.event_id', async () => enRow(s, (await rawTxn(e(), s, 'third_party_transfer', { ev: { counterparty_country: 'US' }, publish: false })).E, 'third_party_transfer', { direction: 'in', funding_account_id: s.BE, funding_currency: 'USD', funding_account_country: 'BE' })],
        ['transaction_entries_event_direction_uq', 'transaction_entries.event_id, transaction_entries.direction', async () => enRow(s, (await rawTxn(e(), s, 'own_transfer', { publish: false })).E, 'own_transfer', { funding_account_id: s.BE, funding_currency: 'USD', funding_account_country: 'BE' })],
        ['transaction_entries_event_account_uq', 'transaction_entries.event_id, transaction_entries.funding_account_id', async () => enRow(s, (await rawTxn(e(), s, 'own_transfer', { publish: false })).E, 'own_transfer', { direction: 'in', funding_currency: 'USD' })],
      ];
      for (const [index, target, dup] of cases) {
        const ixSql = String((await one(e(), 'SELECT sql FROM sqlite_master WHERE name = ?', [index])).sql);
        const row = await dup();
        expect(await rejection(e().batchSql([lit(row)]))).toMatch(new RegExp(`UNIQUE constraint failed: ${target.replace(/\./g, '\\.')}(?![\\w.,])`));
        // Mutated: the duplicate goes in; the deliberate last statement fails and rolls everything back.
        expect(await rejection(e().batchSql([`DROP INDEX ${index}`, lit(row), "INSERT INTO users (id) VALUES ('rollback-marker')"]))).toMatch(/NOT NULL constraint failed: users\./);
        expect(String((await one(e(), 'SELECT sql FROM sqlite_master WHERE name = ?', [index])).sql)).toBe(ixSql);
      }
    });

    it('chain: without gate G the same key fails (key primary key) instead of writing nothing; without the entry count a missing entry is caught later by C2', async () => {
      const s = await seedUser(e());
      const c = createIn(s);
      await run.create(e(), c);
      await run.create(e(), freshIds(c)); // intact: a no-op
      const before = await ledgerDump(e());
      await raises(e().db.batch(steps(createChain(e().db, freshIds(c), { noGate: true }))), /UNIQUE constraint failed: ledger_idempotency_keys\.user_id, ledger_idempotency_keys\.key/);
      expect(await ledgerDump(e())).toEqual(before);
      const other = await seedUser(e());
      const missing = createIn(s, { entries: [{ ...c.entries[0]!, id: nid('N'), accountId: other.HK }] });
      await raises(run.create(e(), missing), KEY_NOT_NULL);
      await raises(e().db.batch(steps(createChain(e().db, freshIds(missing), { noEntryCount: true }))), 'LEDGER_ENTRY_COUNT');
      expect(await ledgerDump(e())).toEqual(before);
    });

    it('S0: without its user_id or expires_at conditions it would delete other users’ or unexpired keys (IDEM-8 catches both)', async () => {
      const a = await seedUser(e());
      const b = await seedUser(e());
      for (const s of [a, b]) {
        const c = createIn(s);
        await run.create(e(), c);
        await run.correct(e(), correctIn(s, c, { now: TS + 5 }));
      }
      // An unexpired correction key of a (expires 40 days after TS).
      const c2 = createIn(a);
      await run.create(e(), c2);
      await run.correct(e(), correctIn(a, c2, { now: TS + 10 * DAY }));
      const now = TS + 31 * DAY;
      const k = ledgerIdempotencyKeys;
      const keys = async (u: string) => (await e().all('SELECT operation, expires_at FROM ledger_idempotency_keys WHERE user_id = ? ORDER BY created_at', [u])).map((r) => `${r.operation}@${r.expires_at}`);
      const aBefore = await keys(a.u);
      const bBefore = await keys(b.u);
      // Intact S0 of a: only a's expired correction key goes.
      await e().db.batch([e().db.delete(k).where(and(eq(k.userId, a.u), isNotNull(k.expiresAt), lte(k.expiresAt, now)))]);
      expect(await keys(a.u)).toEqual(aBefore.filter((x) => x !== `transaction.correct@${TS + 5 + KEY_TTL_MS}`));
      expect(await keys(b.u)).toEqual(bBefore);
      // Mutant without user_id: b's expired key goes too — IDEM-8's "other users untouched" fails.
      await e().db.batch([e().db.delete(k).where(and(isNotNull(k.expiresAt), lte(k.expiresAt, now)))]);
      expect(await keys(b.u)).not.toEqual(bBefore);
      // Mutant without expires_at <= now: a's unexpired correction key goes — IDEM-8's "kept until expiry" fails.
      const aNow = await keys(a.u);
      await e().db.batch([e().db.delete(k).where(and(eq(k.userId, a.u), isNotNull(k.expiresAt)))]);
      expect(await keys(a.u)).not.toEqual(aNow);
      expect(await keys(a.u)).toEqual(aNow.filter((x) => x.startsWith('transaction.create@')));
    });

    it('key-row result subqueries: each column alone requires this operation’s own new row; removing one condition is masked by the others, removing all is detected', async () => {
      const s = await seedUser(e());
      const c = createIn(s);
      await run.create(e(), c);
      await run.void(e(), voidIn(s, c.T));
      const before = await ledgerDump(e());
      const second = voidIn(s, c.T); // a second void with another key: S1 changes nothing
      const k = ledgerIdempotencyKeys;
      const mutatedKey = (cond: { revision: boolean; event: boolean; audit: boolean }) =>
        e().db.insert(k).select(
          e()
            .db.select({
              userId: users.id,
              key: sql`${second.key}`.as('key'),
              operation: sql`'transaction.void'`.as('operation'),
              requestHash: sql`${second.requestHash}`.as('request_hash'),
              hashVersion: sql`1`.as('hash_version'),
              opId: sql`${second.O}`.as('op_id'),
              transactionId: sql`${second.T}`.as('transaction_id'),
              resultRevision: (cond.revision
                ? sql`(SELECT current_revision FROM transactions WHERE id = ${second.T} AND user_id = ${s.u} AND voided_op_id = ${second.O})`
                : sql`(SELECT current_revision FROM transactions WHERE id = ${second.T} AND user_id = ${s.u})`
              ).as('result_revision'),
              resultEventId: (cond.event
                ? sql`(SELECT e.id FROM transactions t JOIN transaction_events e ON e.transaction_id = t.id AND e.revision = t.current_revision WHERE t.id = ${second.T} AND t.voided_op_id = ${second.O})`
                : sql`(SELECT e.id FROM transactions t JOIN transaction_events e ON e.transaction_id = t.id AND e.revision = t.current_revision WHERE t.id = ${second.T})`
              ).as('result_event_id'),
              auditId: (cond.audit ? sql`(SELECT id FROM audit_log WHERE id = ${second.A})` : sql`(SELECT id FROM audit_log WHERE user_id = ${s.u} ORDER BY created_at DESC LIMIT 1)`).as('audit_id'),
              responseStatus: sql`200`.as('response_status'),
              createdAt: sql`${second.now}`.as('created_at'),
              expiresAt: sql`${second.now + KEY_TTL_MS}`.as('expires_at'),
            })
            .from(users)
            .where(eq(users.id, s.u)),
        );
      const chain = voidChain(e().db, second);
      const withKey = (cond: { revision: boolean; event: boolean; audit: boolean }) => e().db.batch([chain.S0, chain.S1, chain.S2, mutatedKey(cond)]);
      for (const one_ of [{ revision: false, event: true, audit: true }, { revision: true, event: false, audit: true }, { revision: true, event: true, audit: false }]) {
        await raises(withKey(one_), KEY_NOT_NULL); // masked: another column is still NULL
      }
      await withKey({ revision: false, event: false, audit: false }); // detected: a key row now claims someone else's result
      expect(await count(e(), 'ledger_idempotency_keys', 'user_id = ? AND key = ?', [s.u, second.key])).toBe(1);
      expect((await ledgerDump(e())).ledger_idempotency_keys!.length).toBe(before.ledger_idempotency_keys!.length + 1);
    });

    it('classify(): treating an unknown side as a country (no null guard) disagrees with the SQL classifier, which refuses it', async () => {
      const s = await seedUser(e());
      const mutant = (input: ClassificationInput) => {
        const r = classify(input);
        if (r.transferScope === null) return r;
        const out = input.entries.find((x) => x.direction === 'out')?.fundingAccountCountry ?? input.counterpartyCountry;
        const inn = input.entries.find((x) => x.direction === 'in')?.fundingAccountCountry ?? input.counterpartyCountry;
        const h = input.homeRegion;
        return { ...r, foreignStatus: out !== h || inn !== h ? ('foreign' as const) : ('domestic' as const) };
      };
      // CN → unknown third party: v1 says undetermined; the mutant says foreign.
      const input: ClassificationInput = { txnType: 'third_party_transfer', homeRegion: 'CN', merchantCountry: null, counterpartyCountry: null, entries: [{ direction: 'out', fundingAccountCountry: 'CN' }] };
      const good = classify(input);
      const bad = mutant(input);
      expect(bad.foreignStatus).not.toBe(good.foreignStatus);
      const attempt = async (c: typeof good) =>
        publishRaw(e(), (await rawTxn(e(), s, 'third_party_transfer', { ev: { counterparty_country: null, transfer_scope: c.transferScope, foreign_status: c.foreignStatus }, entries: [{ funding_account_id: s.CN, funding_currency: 'CNY', funding_account_country: 'CN' }], publish: false })).T, 1);
      await attempt(good);
      await raises(attempt(bad), 'LEDGER_CLASSIFICATION');
    });

    it('C6 in SQL: dropping "IS NOT NULL AND" before <> is an equivalent mutant (NULL <> H is NULL, never true, in CASE WHEN)', async () => {
      const s = await seedUser(e());
      const strip = (q: string) => q.replace(/\(x\.(\w) IS NOT NULL AND x\.\1 <> x\.h\)/g, '(x.$1 <> x.h)');
      const combos: [string | null, string | null][] = [['CN', null], ['HK', null], [null, 'CN'], [null, 'HK'], ['CN', 'HK'], ['HK', 'CN']];
      await withTriggers('transactions', rewrite('tx_publish_classification', strip), async () => {
        for (const [f, t] of combos) {
          const input: ClassificationInput =
            f !== null
              ? { txnType: 'third_party_transfer', homeRegion: 'CN', merchantCountry: null, counterpartyCountry: t, entries: [{ direction: 'out', fundingAccountCountry: f }] }
              : { txnType: 'third_party_transfer', homeRegion: 'CN', merchantCountry: null, counterpartyCountry: null, entries: [{ direction: 'in', fundingAccountCountry: t! }] };
          const c = classify(input);
          const side = (f ?? t)!;
          const a = side === 'CN' ? { id: s.CN, cur: 'CNY' } : { id: s.HK, cur: 'HKD' };
          const tx = await rawTxn(e(), s, 'third_party_transfer', {
            ev: { counterparty_country: f !== null ? t : null, transfer_scope: c.transferScope, foreign_status: c.foreignStatus },
            entries: [{ direction: f !== null ? 'out' : 'in', funding_account_id: a.id, funding_currency: a.cur, funding_account_country: side }],
            publish: false,
          });
          await publishRaw(e(), tx.T, 1); // same verdicts as the guarded form
        }
      });
    });
  });
});

/** classify() for a version of the seed user's shapes. */
function classifyAs(txnType: 'merchant_spend', homeRegion: string, merchantCountry: string | null, entries: ClassificationInput['entries']) {
  const c = classify({ txnType, homeRegion, merchantCountry, counterpartyCountry: null, entries });
  return { merchantScope: c.merchantScope, transferScope: c.transferScope, foreignStatus: c.foreignStatus };
}
