// M3-B3-D: history integrity across operations through the real HTTP app (TEST_PLAN §5.8 IMM, IDEM-3 /
// IDEM-4, §5.15 FI, DEL-1; DATA_MODEL §10.9 – §10.11): one transaction through create → settlement →
// fact correction → snapshot correction → fact correction → void → notes, with master data changed
// afterwards; injected failures at every step of a fact correction on new accounts, of a create and
// of a void, with the raw response bytes of each retry and its replay; and the delete protection of
// objects only older versions still use. libsql and local D1. All data is fictional.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMessages } from '../src/lib/dbErrors.ts';
import { nid } from './m3-ledger.ts';
import { entryRows, factOf, INTERNAL, keyRow, ledgerDump, newKey, ownTransfer, raising, seedUser, spend, startEngine, type Engine, type Seed } from './transactions-kit.ts';

type Body = Record<string, unknown>;
type Json = any;
type Bytes = Awaited<ReturnType<Seed['postBytes']>>;

const TTL = 30 * 86_400_000;

describe.each(['libsql', 'd1'] as const)('history integrity across operations on %s', (engine) => {
  let e: Engine;
  beforeAll(async () => {
    e = await startEngine(engine, 'xui-v1-txn-history-d1');
  }, 180_000);
  afterAll(async () => {
    await e?.dispose();
  });
  beforeEach(() => e.ping());
  afterEach(() => vi.restoreAllMocks());

  const sameBytes = (a: { bytes: Uint8Array }, b: { bytes: Uint8Array }) => Buffer.from(a.bytes).equals(Buffer.from(b.bytes));
  const header = async (T: string) => (await e.all('SELECT * FROM transactions WHERE id = ?', T))[0]!;
  const revisionsOf = async (T: string) => (await e.all('SELECT revision FROM transaction_events WHERE transaction_id = ? ORDER BY revision', T)).map((r) => Number(r.revision));
  /** A version as stored: its event row and its entry rows. */
  const versionRows = async (eventId: string) => ({ event: await e.all('SELECT * FROM transaction_events WHERE id = ?', eventId), entries: await entryRows(e, eventId) });
  const sqlError = (sql: string, ...args: unknown[]) =>
    e.exec(sql, ...args).then(
      () => 'no error',
      (err: unknown) => dbMessages(err).join(' | ') || String(err),
    );
  const ok = (r: Bytes, status: number) => {
    expect([r.status, r.res.headers.get('idempotency-replayed')], r.text).toEqual([status, null]);
    return JSON.parse(r.text) as Json;
  };
  const withoutAccounts = (view: Json) => ({ ...view, entries: view.entries.map(({ account: _a, ...rest }: Json) => rest) });

  // ================================================================== one transaction through every operation

  it('create → settlement → fact → snapshot → fact → void → notes, then master data changes: every published version keeps its rows, versions 1 … 5 without a gap, a void adds none, nothing unpublished is visible, every key replays its own first bytes', async () => {
    const s = await seedUser(e);
    const body = ownTransfer(s, {
      entries: [
        { direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'pending', amount: null },
        { direction: 'in', accountId: s.BE, currency: 'USD', amountStatus: 'confirmed', amount: 99900 },
      ],
      notes: 'created',
    });
    const ops: { key: string; send: (key: string) => Promise<Bytes>; first?: Bytes; status: number }[] = [];
    const run = async (status: number, send: (key: string) => Promise<Bytes>) => {
      const op: (typeof ops)[number] = { key: newKey(), send, status };
      op.first = await send(op.key);
      ops.push(op);
      return ok(op.first, status);
    };
    const w = await run(201, (k) => s.postBytes(body, k));
    const T = w.transactionId as string;
    const written: [string, Awaited<ReturnType<typeof versionRows>>][] = [[w.eventId, await versionRows(w.eventId)]];
    const steps: Body[] = [
      { kind: 'settlement', baseRevision: 1, reason: null, entries: [{ direction: 'out', amount: 100000 }] },
      factOf(body, { baseRevision: 2, transferMethod: 'sepa', entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 100000 }, { direction: 'in', accountId: s.US, currency: 'USD', amountStatus: 'confirmed', amount: 99800 }] }),
      { kind: 'snapshot_correction', baseRevision: 3, reason: 'the receiving account is registered in GB', entries: [{ direction: 'in', fundingAccountCountry: 'GB' }] },
      factOf(body, { baseRevision: 4, transferMethod: 'sepa', occurredTime: '09:30', entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 100000 }, { direction: 'in', accountId: s.US, currency: 'USD', amountStatus: 'confirmed', amount: 99700 }] }),
    ];
    for (const [i, step] of steps.entries()) {
      const r = await run(201, (k) => s.correctBytes(T, step, k));
      expect([r.revision, r.event.revisionKind]).toEqual([i + 2, step.kind]);
      written.push([r.eventId, await versionRows(r.eventId)]);
      for (const [id, rows] of written) expect(await versionRows(id), `after revision ${i + 2}`).toEqual(rows);
    }
    const views = await Promise.all([1, 2, 3, 4, 5].map(async (n) => (await s.api.get(`/api/transactions/${T}/revisions/${n}`)).json));
    // The second fact correction carried the US account's corrected jurisdiction (GB) — as a carried snapshot.
    expect(views.map((v: Json) => v.entries.map((en: Json) => `${en.direction}:${en.fundingAccountCountry}:${en.countrySource}`).join(','))).toEqual([
      'out:HK:account_at_save,in:BE:account_at_save',
      'out:HK:carried,in:BE:carried',
      'out:HK:carried,in:US:account_at_save',
      'out:HK:carried,in:GB:user_corrected',
      'out:HK:carried,in:GB:carried',
    ]);
    // Every entry from version 2 on was carried from the entry of the same account in the version before it.
    const chain = await e.all(
      `SELECT ev.revision AS r, en.funding_account_id AS account, src_ev.revision AS from_r, src.funding_account_id AS from_account
         FROM transaction_entries en JOIN transaction_events ev ON ev.id = en.event_id
         LEFT JOIN transaction_entries src ON src.id = en.carried_from_entry_id LEFT JOIN transaction_events src_ev ON src_ev.id = src.event_id
        WHERE ev.transaction_id = ? ORDER BY ev.revision, en.direction DESC`,
      T,
    );
    for (const c of chain) if (c.from_r !== null) expect([c.from_r, c.from_account]).toEqual([Number(c.r) - 1, c.account]);
    expect(chain.filter((c) => c.from_r === null).map((c) => [Number(c.r), c.account])).toEqual([[1, s.HK], [1, s.BE], [3, s.US]]);

    // The void: no version, every row as it was.
    const v = await run(200, (k) => s.voidBytes(T, { baseRevision: 5, reason: 'recorded twice' }, k));
    expect([v.revision, v.statusAfter, v.eventId]).toEqual([5, 'voided', written[4]![0]]);
    expect(await revisionsOf(T)).toEqual([1, 2, 3, 4, 5]);
    expect(await header(T)).toMatchObject({ current_revision: 5, status: 'voided' });
    expect((await s.notes(T, { notes: 'kept after the void' })).status).toBe(200);

    // Master data changes after the fact.
    expect((await s.api.patch(`/api/accounts/${s.HK}`, { name: 'Renamed HK', accountCountry: 'SG' })).status).toBe(200);
    expect((await s.api.patch(`/api/accounts/${s.US}`, { name: 'Renamed US' })).status).toBe(200);
    expect((await s.api.patch('/api/settings/profile', { homeRegion: 'JP' })).status).toBe(200);
    await e.exec("UPDATE account_currencies SET status = 'closed' WHERE account_id = ? AND currency = 'USD'", s.HK);

    for (const [id, rows] of written) expect(await versionRows(id)).toEqual(rows);
    const after = await Promise.all([1, 2, 3, 4, 5].map(async (n) => (await s.api.get(`/api/transactions/${T}/revisions/${n}`)).json));
    expect(after.map(withoutAccounts)).toEqual(views.map(withoutAccounts));
    expect(after[0].entries.map((en: Json) => [en.account.name, en.fundingAccountCountry])).toEqual([['Renamed HK', 'HK'], [expect.stringMatching(/^BE /), 'BE']]);
    const detail = (await s.api.get(`/api/transactions/${T}`)).json;
    expect(detail).toMatchObject({ status: 'voided', currentRevision: 5, notes: 'kept after the void', event: { revision: 5, eventId: written[4]![0] } });

    // Every published row is immutable; nothing unpublished exists.
    for (const [id, rows] of written) {
      expect(await sqlError("UPDATE transaction_events SET merchant_name = 'x' WHERE id = ?", id)).toMatch(/LEDGER_IMMUTABLE/);
      for (const en of rows.entries) expect(await sqlError('UPDATE transaction_entries SET amount = 1 WHERE id = ?', en.id)).toMatch(/LEDGER_IMMUTABLE/);
    }
    expect(
      await e.all(
        `SELECT (SELECT count(*) FROM transaction_events ev JOIN transactions t ON t.id = ev.transaction_id WHERE t.user_id = ? AND ev.revision > t.current_revision) AS events,
                (SELECT count(*) FROM transactions WHERE user_id = ? AND current_revision = 0) AS headers`,
        s.id, s.id,
      ),
    ).toEqual([{ events: 0, headers: 0 }]);
    expect(await e.all('PRAGMA foreign_key_check')).toEqual([]);

    // Each operation's key: its own first bytes — not the current state, not the notes; nothing written.
    const dump = await ledgerDump(e);
    for (const op of ops) {
      const r = await op.send(op.key);
      expect([r.status, r.res.headers.get('idempotency-replayed'), sameBytes(r, op.first!)]).toEqual([op.status, 'true', true]);
      expect(r.text).not.toMatch(/kept after the void|Renamed/);
    }
    expect(JSON.parse(ops[0]!.first!.text)).toMatchObject({ revision: 1, statusAfter: 'active', void: null });
    expect(await ledgerDump(e)).toEqual(dump);
    // The history still holds its references: the accounts of every version stay protected.
    for (const id of [s.HK, s.BE, s.US]) expect((await s.api.del(`/api/accounts/${id}`)).json.code).toBe('IN_USE');
  }, 120_000);

  it('a version that is not published is visible nowhere: detail, list, revision view and the replay of the create all show version 1', async () => {
    const s = await seedUser(e);
    const key = newKey();
    const first = await s.postBytes(spend(s), key);
    const w = ok(first, 201);
    const cols = (await e.all("SELECT name FROM pragma_table_info('transaction_events')")).map((c) => String(c.name));
    const pick = cols.map((c) => ({ id: '?', revision: '2', revision_kind: "'fact_correction'", correction_reason: "'residue'", home_region_source: "'carried'", merchant_name: "'Hidden Shop'" })[c] ?? c);
    await e.exec(`INSERT INTO transaction_events (${cols.join(', ')}) SELECT ${pick.join(', ')} FROM transaction_events WHERE id = ?`, nid('E'), w.eventId);
    expect(await header(w.transactionId)).toMatchObject({ current_revision: 1 });
    const detail = (await s.api.get(`/api/transactions/${w.transactionId}`)).json;
    expect([detail.currentRevision, detail.event.merchantName]).toEqual([1, 'Example Store']);
    const list = (await s.api.get('/api/transactions')).json.items;
    expect(list.map((x: Json) => [x.id, x.currentRevision, x.event.revision, x.event.merchantName])).toEqual([[w.transactionId, 1, 1, 'Example Store']]);
    expect((await s.api.get('/api/transactions?q=hidden')).json.items).toEqual([]);
    expect((await s.api.get(`/api/transactions/${w.transactionId}/revisions/2`)).status).toBe(404);
    const replay = await s.postBytes(spend(s), key);
    expect(sameBytes(replay, first)).toBe(true);
  });

  // ================================================================== FI with new accounts, and the bytes of each retry

  it('FI: a fact correction onto new accounts (own transfer: one entry carried, one new; spend: one new) fails at S0, S1, each entry, S3, S4 or S5 → 500, the database unchanged, no key; the same key then corrects once and replays those exact bytes', async () => {
    const s = await seedUser(e);
    const transfer = ownTransfer(s);
    const cases: [string, Body, (s: Seed) => Body, [string, string | null][]][] = [
      ['own transfer', transfer, () => factOf(transfer, { entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 100000 }, { direction: 'in', accountId: s.US, currency: 'USD', amountStatus: 'confirmed', amount: 99900 }] }),
        [['S2 carried', `NEW.funding_account_id = '${s.HK}'`], ['S2 new', `NEW.funding_account_id = '${s.US}'`]]],
      ['spend', spend(s), () => factOf(spend(s), { entries: [{ direction: 'out', accountId: s.US, currency: 'USD', amountStatus: 'confirmed', amount: 1000 }] }),
        [['S2 new', `NEW.funding_account_id = '${s.US}'`]]],
    ];
    let n = 0;
    for (const [what, create, correction, entrySteps] of cases) {
      const steps: [string, string, 'INSERT' | 'UPDATE' | 'DELETE', string | null][] = [
        ['S0', 'ledger_idempotency_keys', 'DELETE', null],
        ['S1', 'transaction_events', 'INSERT', null],
        ...entrySteps.map(([name, when]) => [name, 'transaction_entries', 'INSERT', when] as [string, string, 'INSERT', string | null]),
        ['S3', 'transactions', 'UPDATE', null],
        ['S4', 'audit_log', 'INSERT', "NEW.action = 'transaction.correct'"],
        ['S5', 'ledger_idempotency_keys', 'INSERT', null],
      ];
      for (const [step, table, event, when] of steps) {
        const w = ok(await s.postBytes(create, newKey()), 201);
        if (step === 'S0') await expiredKey(s, w);
        const key = newKey();
        const before = await ledgerDump(e);
        const r = await raising(e, table, event, when, 'TEST_INJECTED_FAILURE', () => s.correct(w.transactionId, correction(s), key));
        expect([r.status, r.json], `${what} ${step}`).toEqual([500, INTERNAL]);
        expect(await ledgerDump(e), `${what} ${step}`).toEqual(before);
        expect(await keyRow(e, s.id, key)).toBeUndefined();
        const retry = await s.correctBytes(w.transactionId, correction(s), key);
        const result = ok(retry, 201);
        expect(result.entries.map((en: Json) => en.countrySource).sort(), `${what} ${step}`).toEqual(what === 'spend' ? ['account_at_save'] : ['account_at_save', 'carried']);
        const replay = await s.correctBytes(w.transactionId, correction(s), key);
        expect([replay.status, replay.res.headers.get('idempotency-replayed'), sameBytes(replay, retry)], `${what} ${step}`).toEqual([201, 'true', true]);
        expect(await revisionsOf(w.transactionId)).toEqual([1, 2]);
        n++;
      }
    }
    expect(Number((await e.all("SELECT count(*) AS n FROM audit_log WHERE user_id = ? AND action = 'transaction.correct'", s.id))[0]!.n)).toBe(n);
  }, 120_000);

  it('FI: a create (S0 … S6) and a void (S0 … S3) that fail are a generic 500 with the database unchanged; the same key then succeeds once and replays those exact bytes', async () => {
    const s = await seedUser(e);
    const createSteps: [string, string, 'INSERT' | 'UPDATE' | 'DELETE', string | null][] = [
      ['S0', 'ledger_idempotency_keys', 'DELETE', null],
      ['S1', 'transactions', 'INSERT', null],
      ['S2', 'transaction_events', 'INSERT', null],
      ['S3', 'transaction_entries', 'INSERT', null],
      ['S4', 'transactions', 'UPDATE', null],
      ['S5', 'audit_log', 'INSERT', "NEW.action = 'transaction.create'"],
      ['S6', 'ledger_idempotency_keys', 'INSERT', null],
    ];
    for (const [step, table, event, when] of createSteps) {
      if (step === 'S0') await expiredKey(s, ok(await s.postBytes(spend(s), newKey()), 201));
      const key = newKey();
      const before = await ledgerDump(e);
      const r = await raising(e, table, event, when, 'TEST_INJECTED_FAILURE', () => s.post(spend(s), key));
      expect([r.status, r.json], `create ${step}`).toEqual([500, INTERNAL]);
      expect(await ledgerDump(e), `create ${step}`).toEqual(before);
      const retry = await s.postBytes(spend(s), key);
      ok(retry, 201);
      const replay = await s.postBytes(spend(s), key);
      expect([replay.status, replay.res.headers.get('idempotency-replayed'), sameBytes(replay, retry)], `create ${step}`).toEqual([201, 'true', true]);
    }
    const voidSteps: [string, string, 'INSERT' | 'UPDATE' | 'DELETE', string | null][] = [
      ['S0', 'ledger_idempotency_keys', 'DELETE', null],
      ['S1', 'transactions', 'UPDATE', null],
      ['S2', 'audit_log', 'INSERT', "NEW.action = 'transaction.void'"],
      ['S3', 'ledger_idempotency_keys', 'INSERT', null],
    ];
    for (const [step, table, event, when] of voidSteps) {
      const w = ok(await s.postBytes(spend(s), newKey()), 201);
      if (step === 'S0') await expiredKey(s, w);
      const key = newKey();
      const before = await ledgerDump(e);
      const r = await raising(e, table, event, when, 'TEST_INJECTED_FAILURE', () => s.voidTx(w.transactionId, { baseRevision: 1 }, key));
      expect([r.status, r.json], `void ${step}`).toEqual([500, INTERNAL]);
      expect(await ledgerDump(e), `void ${step}`).toEqual(before);
      const retry = await s.voidBytes(w.transactionId, { baseRevision: 1 }, key);
      ok(retry, 200);
      const replay = await s.voidBytes(w.transactionId, { baseRevision: 1 }, key);
      expect([replay.status, replay.res.headers.get('idempotency-replayed'), sameBytes(replay, retry)], `void ${step}`).toEqual([200, 'true', true]);
    }
  }, 120_000);

  // ================================================================== DEL-1: protection by older versions

  it('DEL-1: a correction moving to another account, currency, no card and no channel does not release the old ones — still 409 IN_USE / CURRENCY_IN_USE (counted once), also after a void; raw SQL deletes fail too', async () => {
    const s = await seedUser(e);
    const body = spend(s, { paymentChannelId: s.PP });
    const w = ok(await s.postBytes(body, newKey()), 201);
    const r2 = ok(await s.correctBytes(w.transactionId, factOf(body, { cardId: null, paymentChannelId: null, entries: [{ direction: 'out', accountId: s.US, currency: 'USD', amountStatus: 'confirmed', amount: 1000 }] }), newKey()), 201);
    expect([r2.event.cardId, r2.event.paymentChannelId, r2.entries[0].accountId]).toEqual([null, null, s.US]);
    const refusals = async () => ({
      HK: (await s.api.del(`/api/accounts/${s.HK}`)).json,
      US: (await s.api.del(`/api/accounts/${s.US}`)).json,
      HKD: (await s.api.req('PUT', `/api/accounts/${s.HK}/currencies`, { currencies: [{ code: 'USD', isDefault: true }] })).json,
      K: (await s.api.del(`/api/cards/${s.K}`)).json,
      PP: (await s.api.del(`/api/payment-channels/${s.PP}`)).json,
    });
    const inUse = (details: unknown) => ({ error: expect.any(String), code: 'IN_USE', details });
    const expected = {
      HK: inUse({ references: { balanceOfChannels: 0, transactions: 1 }, channels: [] }),
      US: inUse({ references: { balanceOfChannels: 0, transactions: 1 }, channels: [] }),
      HKD: { error: expect.any(String), code: 'CURRENCY_IN_USE', details: { currencies: ['HKD'] } },
      K: inUse({ references: { transactions: 1 } }),
      PP: inUse({ references: { transactions: 1 } }),
    };
    expect(await refusals()).toEqual(expected);
    expect((await s.voidTx(w.transactionId, { baseRevision: 2 })).status).toBe(200);
    const before = await ledgerDump(e);
    expect(await refusals()).toEqual(expected);
    expect(await ledgerDump(e)).toEqual(before); // no audit of a refused delete
    for (const [table, id] of [['accounts', s.HK], ['cards', s.K], ['payment_channels', s.PP]] as const) {
      expect(await sqlError(`DELETE FROM ${table} WHERE id = ?`, id), table).toMatch(/FOREIGN KEY constraint failed/);
    }
    expect(await sqlError("DELETE FROM account_currencies WHERE account_id = ? AND currency = 'HKD'", s.HK)).toMatch(/FOREIGN KEY constraint failed/);
    expect((await s.api.get(`/api/transactions/${w.transactionId}/revisions/1`)).json.entries[0]).toMatchObject({ accountId: s.HK, currency: 'HKD' });
  });

  /** An expired correction key of the user (so that S0 has a row to delete). */
  async function expiredKey(s: Seed, w: Json) {
    const now = e.t.clock.t;
    await e.exec(
      'INSERT INTO ledger_idempotency_keys (user_id, key, operation, request_hash, hash_version, op_id, transaction_id, result_revision, result_event_id, audit_id, response_status, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?, ?, 201, ?, ?)',
      s.id, newKey(), 'transaction.correct', 'e'.repeat(64), `op-old-${newKey()}`, w.transactionId, w.eventId, 'audit-old', now - TTL - 10, now - 10,
    );
  }
});
