// M3-B1 Gate 1 — DB-M3-0 compatibility probes (TEST_PLAN §5.14, DATA_MODEL §10.13), run unchanged on
//   libsql — a temporary file database opened by openV1Db() (identity check, every migration, one
//            connection with PRAGMA foreign_keys = ON);
//   d1     — wrangler getPlatformProxy(): local in-memory D1 in workerd (persist: false,
//            remoteBindings: false); every migration in _journal.json order through wrangler's
//            SQL splitter, as `wrangler d1 migrations apply` does.
// Each probe is a minimal reproduction of one capability the M3 design relies on (typeof CHECKs,
// partial indexes, composite keys, trigger WHEN / subqueries / firing order, the header guards,
// C1–C7, immutability and delete guards beside user cascades, INSERT … SELECT chains with the key
// row last, ON CONFLICT, NOT NULL assertions, batch rollback, exact sums, bound-parameter limits,
// drizzle's builder in batches). Gate 1 ran these against the draft DDL before migration 0002 was
// written; they now run against 0002 itself. No remote D1 is contacted. When M3_PROBE_OUT is set,
// the per-engine evidence is written there as JSON.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  correctChain,
  count,
  createChain,
  createInput,
  d1Engine,
  enRow,
  errorText,
  evRow,
  FOREIGN_SPEND,
  freshIds as fresh,
  ins,
  ledgerCounts,
  libsqlEngine,
  newKey,
  nid,
  one,
  publishRaw,
  rawTxn,
  seedUser as seed,
  spendFacts,
  steps,
  transferFacts,
  TS,
  voidChain,
  type CreateIn,
  type Engine,
  type EntryIn,
  type Row,
} from './m3-ledger.ts';

const OUT = process.env.M3_PROBE_OUT ?? '';

const engines: Partial<Record<'libsql' | 'd1', Engine>> = {};
const evidence: Record<string, Record<string, unknown>> = {};
const record = (item: string, engine: string, detail: unknown) => ((evidence[item] ??= {})[engine] = detail);

beforeAll(async () => {
  engines.libsql = await libsqlEngine();
  engines.d1 = await d1Engine('xui-m3-db-probe');
}, 180_000);

afterAll(async () => {
  if (OUT) writeFileSync(OUT, JSON.stringify(evidence, null, 2));
  await engines.d1?.dispose();
  await engines.libsql?.dispose();
});

async function rejection(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (err === null) expect.fail('expected the database to refuse the statement, but it succeeded');
  return errorText(err);
}
const refusedWith = async (p: Promise<unknown>, code: RegExp) => {
  const msg = await rejection(p);
  expect(msg).toMatch(code);
  return msg;
};
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
type TxnType = 'merchant_spend' | 'merchant_refund' | 'own_transfer' | 'third_party_transfer';
const publish = (e: Engine, T: string, r = 1) => publishRaw(e, T, r);
const createIn = (s: Awaited<ReturnType<typeof seed>>, x: Partial<CreateIn> = {}) => createInput(s, hash, x);
const thirdPartyFacts = (x: Parameters<typeof transferFacts>[1] = {}) => transferFacts('third_party', { counterpartyCountry: 'US', ...x });

// A probe-only drizzle table for ON CONFLICT DO NOTHING.
const probeConflict = sqliteTable('probe_conflict', { id: text('id').primaryKey(), n: integer('n').notNull() });

// ================================================================== the probes, once per engine

describe.each(['libsql', 'd1'] as const)('DB-M3-0 probes on %s', (name) => {
  const e = () => engines[name]!;
  beforeEach(async () => {
    await e().ping();
  });

  it('P0 foreign keys are enforced (a reference to a missing row fails)', async () => {
    const msg = await refusedWith(ins(e(), 'institutions', { id: nid('i'), user_id: 'no-such-user', name: 'x', name_key: 'x', institution_type: 'bank', created_at: TS, updated_at: TS }), /FOREIGN KEY constraint failed/);
    const msg2 = await refusedWith(ins(e(), 'transactions', { id: nid('T'), user_id: 'no-such-user', txn_type: 'merchant_spend', created_at: TS, updated_at: TS }), /FOREIGN KEY constraint failed/);
    record('P0 foreign keys on', name, { institution: msg, transactionHeader: msg2 });
  });

  it('P1 typeof() integer CHECK: 78.3, 0, -1, 1e15 refused; 999999999999999 and 7830.0 stored as integer', async () => {
    await e().run("CREATE TABLE IF NOT EXISTS probe_amount (k TEXT, a INTEGER CHECK(typeof(a) = 'integer' AND a BETWEEN 1 AND 999999999999999))");
    const out: Record<string, unknown> = {};
    for (const lit of ['78.3', '0', '-1', '1000000000000000']) out[lit] = await refusedWith(e().run(`INSERT INTO probe_amount VALUES ('lit', ${lit})`), /CHECK constraint failed/);
    await e().run("INSERT INTO probe_amount VALUES ('max', 999999999999999)");
    await e().run("INSERT INTO probe_amount VALUES ('real', 7830.0)");
    await e().run("INSERT INTO probe_amount VALUES ('bound', ?)", [7830]);
    out['bound 78.3'] = await refusedWith(e().run('INSERT INTO probe_amount VALUES (?, ?)', ['bound-frac', 78.3]), /CHECK constraint failed/);
    const rows = await e().all("SELECT k, typeof(a) AS t, CAST(a AS TEXT) AS a FROM probe_amount WHERE k IN ('max', 'real', 'bound') ORDER BY k");
    expect(rows).toEqual([
      { k: 'bound', t: 'integer', a: '7830' },
      { k: 'max', t: 'integer', a: '999999999999999' },
      { k: 'real', t: 'integer', a: '7830' },
    ]);
    // Text that looks like an integer is converted by the INTEGER affinity before the CHECK (the API rejects strings).
    await e().run("INSERT INTO probe_amount VALUES ('text', '100')");
    out["text '100'"] = await one(e(), "SELECT typeof(a) AS t FROM probe_amount WHERE k = 'text'");
    // Large integers come back as JS numbers (lossy beyond 2^53) unless CAST AS TEXT.
    // (libsql's client refuses to return it as a number at all; D1 returns a rounded float.)
    out['2^53+1 as a number'] = await e()
      .all('SELECT 9007199254740993 AS raw')
      .then((r) => ({ returned: r[0]!.raw, exact: String(r[0]!.raw) === '9007199254740993' }), (err) => ({ refused: errorText(err) }));
    expect((await one(e(), 'SELECT CAST(9007199254740993 AS TEXT) AS txt')).txt).toBe('9007199254740993');
    out.rows = rows;
    record('P1 typeof integer CHECK', name, out);
  });

  it('P2 partial unique indexes (<>, WHERE) and expression indexes (ifnull)', async () => {
    await e().run('CREATE TABLE IF NOT EXISTS probe_pu (e TEXT, t TEXT, k TEXT)');
    await e().run("CREATE UNIQUE INDEX IF NOT EXISTS probe_pu_single ON probe_pu (e) WHERE t <> 'own_transfer'");
    await e().run("CREATE UNIQUE INDEX IF NOT EXISTS probe_pu_expr ON probe_pu (e, ifnull(k, '')) WHERE t = 'own_transfer'");
    const p = nid('e');
    await e().run("INSERT INTO probe_pu VALUES (?, 'merchant_spend', NULL)", [p]);
    const single = await refusedWith(e().run("INSERT INTO probe_pu VALUES (?, 'merchant_refund', NULL)", [p]), /UNIQUE constraint failed/);
    await e().run("INSERT INTO probe_pu VALUES (?, 'own_transfer', NULL)", [p]);
    await e().run("INSERT INTO probe_pu VALUES (?, 'own_transfer', 'a')", [p]);
    const expr = await refusedWith(e().run("INSERT INTO probe_pu VALUES (?, 'own_transfer', NULL)", [p]), /UNIQUE constraint failed/);
    // The real index: one entry per event unless own_transfer.
    const s = await seed(e());
    // Third-party transfer: a second entry with the other direction and another account only breaks the partial index.
    const t = await rawTxn(e(), s, 'third_party_transfer', { ev: { counterparty_country: 'US' }, publish: false });
    const real = await refusedWith(
      ins(e(), 'transaction_entries', enRow(s, t.E, 'third_party_transfer', { direction: 'in', funding_account_id: s.BE, funding_currency: 'USD', funding_account_country: 'BE' })),
      /UNIQUE constraint failed: transaction_entries\.event_id(?!,)/,
    );
    // The same second entry is fine for an own transfer (two sides).
    const o = await rawTxn(e(), s, 'own_transfer', { publish: false });
    await ins(e(), 'transaction_entries', enRow(s, o.E, 'own_transfer', { direction: 'in', funding_account_id: s.BE, funding_currency: 'USD', funding_account_country: 'BE' }));
    const ix = await e().all("SELECT name, \"partial\" FROM pragma_index_list('transaction_entries') WHERE name = 'transaction_entries_single_uq'");
    expect(ix).toEqual([{ name: 'transaction_entries_single_uq', partial: 1 }]);
    record('P2 partial / expression unique indexes', name, { single, expr, realEntriesSingle: real, indexList: ix });
  });

  it('P3 composite foreign keys with user_id refuse other users; NO ACTION refuses deleting a referenced parent', async () => {
    const a = await seed(e());
    const b = await seed(e());
    const T = nid('T');
    await ins(e(), 'transactions', { id: T, user_id: b.u, txn_type: 'merchant_spend', created_at: TS, updated_at: TS });
    const crossCard = await refusedWith(ins(e(), 'transaction_events', evRow(b, T, nid('E'), 'merchant_spend', { card_id: a.K })), /FOREIGN KEY constraint failed/);
    const crossChannel = await refusedWith(ins(e(), 'transaction_events', evRow(b, T, nid('E'), 'merchant_spend', { payment_channel_id: a.PP })), /FOREIGN KEY constraint failed/);
    // (transaction_id, txn_type, user_id): the version's type must be the header's.
    const typeMismatch = await refusedWith(ins(e(), 'transaction_events', evRow(b, T, nid('E'), 'merchant_refund')), /FOREIGN KEY constraint failed/);
    const E = nid('E');
    await ins(e(), 'transaction_events', evRow(b, T, E, 'merchant_spend', { card_id: b.K, payment_channel_id: b.PP }));
    // (event_id, txn_type, user_id): an entry's type must be its event's (en_insert_open does not look at the type).
    const entryType = await refusedWith(ins(e(), 'transaction_entries', enRow(b, E, 'merchant_refund', { direction: 'in', funding_account_id: b.HK })), /FOREIGN KEY constraint failed/);
    await ins(e(), 'transaction_entries', enRow(b, E, 'merchant_spend', { funding_account_id: b.HK }));
    await publish(e(), T);
    const delCard = await refusedWith(e().run('DELETE FROM cards WHERE id = ?', [b.K]), /FOREIGN KEY constraint failed/);
    const delChannel = await refusedWith(e().run('DELETE FROM payment_channels WHERE id = ?', [b.PP]), /FOREIGN KEY constraint failed/);
    const delAccount = await refusedWith(e().run('DELETE FROM accounts WHERE id = ?', [b.HK]), /FOREIGN KEY constraint failed/);
    const delCurrency = await refusedWith(e().run("DELETE FROM account_currencies WHERE account_id = ? AND currency = 'HKD'", [b.HK]), /FOREIGN KEY constraint failed/);
    // An unreferenced currency of the same account can still go.
    await e().run("DELETE FROM account_currencies WHERE account_id = ? AND currency = 'USD'", [b.HK]);
    const fks = await e().all("SELECT \"table\", \"from\", \"to\", on_delete FROM pragma_foreign_key_list('transaction_entries') ORDER BY id, seq");
    record('P3 composite FK + NO ACTION', name, { crossCard, crossChannel, typeMismatch, entryType, delCard, delChannel, delAccount, delCurrency, entryForeignKeys: fks });
  });

  it('P4/P5 BEFORE INSERT / UPDATE triggers with WHEN and subqueries; firing order is newest-created first', async () => {
    await e().run('CREATE TABLE IF NOT EXISTS probe_order (a INTEGER)');
    for (const n of ['probe_first_created', 'probe_second_created', 'probe_third_created']) {
      await e().run(`CREATE TRIGGER IF NOT EXISTS ${n} BEFORE INSERT ON probe_order FOR EACH ROW WHEN (SELECT count(*) FROM probe_order) >= 0 BEGIN SELECT RAISE(ABORT, '${n}'); END`);
    }
    const insertMsg = await refusedWith(e().run('INSERT INTO probe_order VALUES (1)'), /probe_third_created/);
    await e().run('CREATE TABLE IF NOT EXISTS probe_order_u (a INTEGER)');
    await e().run('INSERT INTO probe_order_u VALUES (1)');
    for (const n of ['probe_u_first', 'probe_u_second']) {
      await e().run(`CREATE TRIGGER IF NOT EXISTS ${n} BEFORE UPDATE OF a ON probe_order_u FOR EACH ROW WHEN NEW.a <> OLD.a AND EXISTS (SELECT 1 FROM probe_order_u) BEGIN SELECT RAISE(ABORT, '${n}'); END`);
    }
    const updateMsg = await refusedWith(e().run('UPDATE probe_order_u SET a = 2'), /probe_u_second/);
    await e().run('UPDATE probe_order_u SET a = 1'); // WHEN false: no trigger body runs
    record('P4/P5 trigger WHEN, subqueries, firing order', name, { insertFiresFirst: insertMsg, updateFiresFirst: updateMsg, conclusion: 'most recently created BEFORE trigger fires first' });
  });

  it('P6 tx_insert_guard: only unpublished, active, unvoided headers can be inserted (the trigger, not a CHECK, refuses)', async () => {
    const s = await seed(e());
    const h = (x: Row) => ({ id: nid('T'), user_id: s.u, txn_type: 'merchant_spend', created_at: TS, updated_at: TS, ...x });
    const out: Record<string, string> = {};
    out.published = await refusedWith(ins(e(), 'transactions', h({ current_revision: 1 })), /LEDGER_HEADER_INSERT/);
    out.voidedComplete = await refusedWith(ins(e(), 'transactions', h({ status: 'voided', current_revision: 1, voided_at: TS, voided_op_id: 'o' })), /LEDGER_HEADER_INSERT/);
    out.voidedAtOnly = await refusedWith(ins(e(), 'transactions', h({ voided_at: TS })), /LEDGER_HEADER_INSERT/);
    out.voidedOpOnly = await refusedWith(ins(e(), 'transactions', h({ voided_op_id: 'o' })), /LEDGER_HEADER_INSERT/);
    out.voidReasonOnly = await refusedWith(ins(e(), 'transactions', h({ void_reason: 'r' })), /LEDGER_HEADER_INSERT/);
    expect(await count(e(), 'transactions', 'user_id = ?', [s.u])).toBe(0);
    await ins(e(), 'transactions', h({ current_revision: 0 })); // bound 0 (D1: a JS number)
    await ins(e(), 'transactions', h({}));
    expect(await count(e(), 'transactions', 'user_id = ? AND current_revision = 0 AND status = ?', [s.u, 'active'])).toBe(2);
    record('P6 tx_insert_guard', name, out);
  });

  it('P7 tx_update_guard: three allowed shapes, deterministic codes (HEADER_IMMUTABLE → VOIDED → REVISION_ORDER), refused rows unchanged', async () => {
    const s = await seed(e());
    const { T } = await rawTxn(e(), s, 'merchant_spend');
    const snap = () => one(e(), 'SELECT * FROM transactions WHERE id = ?', [T]);
    const before = await snap();
    const out: Record<string, string> = {};
    const upd = (set: string, args: unknown[] = []) => e().run(`UPDATE transactions SET ${set} WHERE id = ?`, [...args, T]);
    out.txnType = await refusedWith(upd("txn_type = 'merchant_refund'"), /LEDGER_HEADER_IMMUTABLE/);
    out.createdAt = await refusedWith(upd('created_at = created_at + 1'), /LEDGER_HEADER_IMMUTABLE/);
    await upd('user_id = user_id, txn_type = txn_type'); // re-setting the same values is not a change
    out.skip = await refusedWith(upd('current_revision = current_revision + 2'), /LEDGER_REVISION_ORDER/);
    out.back = await refusedWith(upd('current_revision = current_revision - 1'), /LEDGER_REVISION_ORDER/);
    out.statusOnly = await refusedWith(upd("status = 'voided'"), /LEDGER_REVISION_ORDER/);
    out.publishAndVoid = await refusedWith(upd("status = 'voided', voided_at = 1, voided_op_id = 'o', current_revision = current_revision + 1"), /LEDGER_REVISION_ORDER/);
    out.publishWithNotes = await refusedWith(upd("current_revision = current_revision + 1, notes = 'n'"), /LEDGER_REVISION_ORDER/);
    out.voidFieldsWithoutStatus = await refusedWith(upd("voided_at = 1, voided_op_id = 'o'"), /LEDGER_REVISION_ORDER/);
    expect(await snap()).toEqual(before);
    await upd("notes = 'n1', updated_at = updated_at + 1");
    await upd("status = 'voided', voided_at = ?, voided_op_id = 'op', void_reason = 'dup', updated_at = ?", [TS + 5, TS + 5]);
    const voided = await snap();
    out.unvoid = await refusedWith(upd("status = 'active', voided_at = NULL, voided_op_id = NULL, void_reason = NULL"), /LEDGER_VOIDED/);
    out.republish = await refusedWith(upd('current_revision = current_revision + 1'), /LEDGER_VOIDED/);
    out.voidAgain = await refusedWith(upd('voided_at = voided_at + 1'), /LEDGER_VOIDED/);
    out.voidedTypeChange = await refusedWith(upd("txn_type = 'merchant_refund', current_revision = 9"), /LEDGER_HEADER_IMMUTABLE/);
    expect(await snap()).toEqual(voided);
    await upd("notes = 'after void', updated_at = updated_at + 1");
    expect((await snap()).notes).toBe('after void');
    record('P7 tx_update_guard', name, out);
  });

  it('P8 C1–C7 publish checks: each refuses its own violation; C2 runs first; WHEN keeps them out of other updates', async () => {
    const s = await seed(e());
    const out: Record<string, string> = {};
    const unpublished = (type: TxnType, o: { ev?: Row; entries?: Row[] }) => rawTxn(e(), s, type, { ...o, publish: false });
    // C2: no entries.
    let t = await unpublished('merchant_spend', { entries: [] });
    out.C2_noEntries = await refusedWith(publish(e(), t.T), /LEDGER_ENTRY_COUNT/);
    // C3: two registered sides with a counterparty; one side without the counterparty country.
    const twoSides = [{ direction: 'out' }, { direction: 'in', funding_account_id: s.BE, funding_currency: 'USD', funding_account_country: 'BE' }];
    t = await unpublished('own_transfer', { ev: { counterparty_name: 'me' }, entries: twoSides });
    out.C3_twoSidesWithCounterparty = await refusedWith(publish(e(), t.T), /LEDGER_OWN_TRANSFER_SHAPE/);
    t = await unpublished('own_transfer', { ev: { transfer_scope: 'foreign_to_unknown' }, entries: [{ direction: 'out' }] });
    out.C3_oneSideNoCountry = await refusedWith(publish(e(), t.T), /LEDGER_OWN_TRANSFER_SHAPE/);
    t = await unpublished('own_transfer', { entries: twoSides });
    await publish(e(), t.T); // the valid two-sided own transfer (HK → BE: foreign_cross_border)
    // C5: unknown event amount with an outgoing entry.
    t = await unpublished('third_party_transfer', { ev: { event_amount: null, counterparty_country: 'US' }, entries: [{ direction: 'out' }] });
    out.C5_unknownAmountOutgoing = await refusedWith(publish(e(), t.T), /LEDGER_EVENT_AMOUNT/);
    t = await unpublished('third_party_transfer', { ev: { event_amount: null, counterparty_country: 'US' }, entries: [{ direction: 'in' }] });
    await publish(e(), t.T); // P8: incoming, amount unknown — allowed
    // C6: a classification that does not follow from the snapshots (HK account, US merchant, home CN ⇒ foreign).
    t = await unpublished('merchant_spend', { ev: { foreign_status: 'undetermined' } });
    out.C6_wrongStatus = await refusedWith(publish(e(), t.T), /LEDGER_CLASSIFICATION/);
    t = await unpublished('third_party_transfer', { ev: { counterparty_country: 'US', transfer_scope: 'outbound' }, entries: [{ direction: 'out' }] });
    out.C6_wrongScope = await refusedWith(publish(e(), t.T), /LEDGER_CLASSIFICATION/);
    t = await unpublished('merchant_spend', { ev: { classifier_version: 2 } });
    out.C6_unknownClassifier = await refusedWith(publish(e(), t.T), /LEDGER_CLASSIFICATION/);
    // C7: confirmed purely domestic (CN account, CN merchant, home CN).
    const domestic = { merchant_country: 'CN', merchant_scope: 'domestic', foreign_status: 'domestic' };
    const cnEntry = { funding_account_id: s.CN, funding_currency: 'CNY', funding_account_country: 'CN' };
    t = await unpublished('merchant_spend', { ev: domestic, entries: [cnEntry] });
    out.C7_domestic = await refusedWith(publish(e(), t.T), /LEDGER_CONFIRMED_DOMESTIC/);
    // undetermined (CN account, unknown merchant) is published.
    t = await unpublished('merchant_spend', { ev: { merchant_country: null, merchant_scope: 'unknown', foreign_status: 'undetermined' }, entries: [cnEntry] });
    await publish(e(), t.T);
    // Order: zero entries AND domestic ⇒ C2 is reported; own-shape AND classification ⇒ C3.
    t = await unpublished('merchant_spend', { ev: domestic, entries: [] });
    out.order_C2_before_C7 = await refusedWith(publish(e(), t.T), /LEDGER_ENTRY_COUNT/);
    t = await unpublished('own_transfer', { ev: { counterparty_name: 'me', foreign_status: 'undetermined' }, entries: twoSides });
    out.order_C3_before_C6 = await refusedWith(publish(e(), t.T), /LEDGER_OWN_TRANSFER_SHAPE/);

    // WHEN: build a published version that breaks C2 and C7 with the publish triggers dropped,
    // restore them byte-for-byte, then change notes / updated_at: no publish check runs.
    const names = ['tx_publish_entry_count', 'tx_publish_own_shape', 'tx_publish_event_amount', 'tx_publish_classification', 'tx_publish_domestic'];
    const saved = await e().all(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${names.map(() => '?').join(', ')}) ORDER BY rowid`, names);
    expect(saved).toHaveLength(5);
    t = await unpublished('merchant_spend', { ev: domestic, entries: [] });
    for (const n of names) await e().run(`DROP TRIGGER ${n}`);
    try {
      await publish(e(), t.T);
    } finally {
      for (const r of saved) await e().run(String(r.sql));
    }
    const restored = await e().all(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${names.map(() => '?').join(', ')}) ORDER BY rowid`, names);
    expect(restored).toEqual(saved);
    await e().run("UPDATE transactions SET notes = 'kept', updated_at = updated_at + 1 WHERE id = ?", [t.T]);
    await e().run('UPDATE transactions SET updated_at = updated_at + 1 WHERE id = ?', [t.T]);
    expect((await one(e(), 'SELECT notes, current_revision FROM transactions WHERE id = ?', [t.T]))).toEqual({ notes: 'kept', current_revision: 1 });
    out.WHEN_notesOnBadVersion = 'notes / updated_at updates succeed: no C2–C7 trigger runs without a legal r → r+1 publish';
    record('P8 C1–C7 publish checks', name, out);
  });

  it('P9 versions and entries are immutable and undeletable; headers undeletable; keys immutable, create keys undeletable', async () => {
    const s = await seed(e());
    const out: Record<string, string> = {};
    const c = createIn(s);
    await e().db.batch(steps(createChain(e().db, c)));
    const N = c.entries[0]!.id;
    out.evUpdate = await refusedWith(e().run("UPDATE transaction_events SET correction_reason = 'x' WHERE id = ?", [c.E]), /LEDGER_IMMUTABLE/);
    out.evUpdateSameValue = await refusedWith(e().run('UPDATE transaction_events SET occurred_on = occurred_on WHERE id = ?', [c.E]), /LEDGER_IMMUTABLE/);
    out.enUpdate = await refusedWith(e().run('UPDATE transaction_entries SET amount = amount WHERE id = ?', [N]), /LEDGER_IMMUTABLE/);
    out.enDelete = await refusedWith(e().run('DELETE FROM transaction_entries WHERE id = ?', [N]), /LEDGER_NO_DELETE/);
    out.evDelete = await refusedWith(e().run('DELETE FROM transaction_events WHERE id = ?', [c.E]), /LEDGER_NO_DELETE/);
    out.txDelete = await refusedWith(e().run('DELETE FROM transactions WHERE id = ?', [c.T]), /LEDGER_NO_DELETE/);
    out.enAppendToPublished = await refusedWith(ins(e(), 'transaction_entries', enRow(s, c.E, 'merchant_spend', { direction: 'in', funding_account_id: s.BE })), /LEDGER_IMMUTABLE/);
    out.keyUpdate = await refusedWith(e().run('UPDATE ledger_idempotency_keys SET response_status = 201 WHERE user_id = ? AND key = ?', [s.u, c.key]), /LEDGER_KEY_IMMUTABLE/);
    out.createKeyDelete = await refusedWith(e().run('DELETE FROM ledger_idempotency_keys WHERE user_id = ? AND key = ?', [s.u, c.key]), /LEDGER_NO_DELETE/);
    // A void key (expires_at set) can be deleted (S0 does it once expired).
    const vk = newKey();
    await e().db.batch(steps(voidChain(e().db, { u: s.u, T: c.T, now: TS + 10, ip: null, baseRevision: 1, reason: null, O: nid('O'), A: nid('A'), key: vk, requestHash: hash(vk), hashVersion: 1 })));
    await e().run('DELETE FROM ledger_idempotency_keys WHERE user_id = ? AND key = ?', [s.u, vk]);
    expect(await ledgerCounts(e(), s.u)).toEqual({ transactions: 1, transaction_events: 1, transaction_entries: 1, ledger_idempotency_keys: 1, audit: 2 });
    record('P9 update / delete guards', name, out);
  });

  it('P10 deleting a user cascades through the whole ledger while the delete guards stay on; foreign_key_check is empty', async () => {
    const a = await seed(e());
    const b = await seed(e());
    for (const s of [a, b]) {
      const c = createIn(s, { entries: [{ id: nid('N'), direction: 'out', accountId: s.HK, currency: 'HKD', amount: null, amountStatus: 'pending', exponent: 2, closedCurrencyAck: false }] });
      await e().db.batch(steps(createChain(e().db, c)));
      const ck = newKey();
      await e().db.batch(
        steps(
          correctChain(e().db, {
            u: s.u, T: c.T, E: nid('E'), O: nid('O'), A: nid('A'), now: TS + 5, ip: null, key: ck, requestHash: hash(ck), hashVersion: 1,
            baseRevision: 1, kind: 'settlement', reason: null, facts: c.facts, correctedHomeRegion: null, classification: FOREIGN_SPEND,
            entries: [{ ...c.entries[0]!, id: nid('N'), amount: 7830, amountStatus: 'confirmed', carriedFromEntryId: c.entries[0]!.id }],
          }),
        ),
      );
      const v = createIn(s);
      await e().db.batch(steps(createChain(e().db, v)));
      const vk = newKey();
      await e().db.batch(steps(voidChain(e().db, { u: s.u, T: v.T, now: TS + 6, ip: null, baseRevision: 1, reason: 'dup', O: nid('O'), A: nid('A'), key: vk, requestHash: hash(vk), hashVersion: 1 })));
    }
    const bBefore = await ledgerCounts(e(), b.u);
    expect(await ledgerCounts(e(), a.u)).toEqual({ transactions: 2, transaction_events: 3, transaction_entries: 3, ledger_idempotency_keys: 4, audit: 4 });
    // Header delete with the user present: refused.
    await refusedWith(e().run('DELETE FROM transactions WHERE user_id = ?', [a.u]), /LEDGER_NO_DELETE/);
    await e().run('DELETE FROM users WHERE id = ?', [a.u]);
    const aAfter = await ledgerCounts(e(), a.u);
    expect(aAfter).toEqual({ transactions: 0, transaction_events: 0, transaction_entries: 0, ledger_idempotency_keys: 0, audit: 4 });
    expect(await ledgerCounts(e(), b.u)).toEqual(bBefore);
    const fkCheck = await e().all('PRAGMA foreign_key_check');
    expect(fkCheck).toEqual([]);
    record('P10 user cascade with delete guards', name, { before: { transactions: 2, transaction_events: 3, transaction_entries: 3, keys: 4 }, after: aAfter, otherUserUnchanged: true, foreignKeyCheck: fkCheck });
  });

  it('P11/P15 create chain (INSERT … SELECT, drizzle builder): snapshots read in SQL, key row inserted last and complete', async () => {
    const s = await seed(e(), 'HK');
    const c = createIn(s, {
      facts: spendFacts({ cardId: s.K, merchantCountry: 'US' }),
      entries: [{ id: nid('N'), direction: 'out', accountId: s.BE, currency: 'USD', amount: 1000, amountStatus: 'confirmed', exponent: 2, closedCurrencyAck: false }],
    });
    await e().db.batch(steps(createChain(e().db, c)));
    const ev = await one(e(), 'SELECT revision, revision_kind, home_region, home_region_source, foreign_status FROM transaction_events WHERE id = ?', [c.E]);
    expect(ev).toEqual({ revision: 1, revision_kind: 'original', home_region: 'HK', home_region_source: 'preference_at_save', foreign_status: 'foreign' });
    const en = await one(e(), 'SELECT funding_account_country, country_source, currency_status_at_save, typeof(amount) AS t FROM transaction_entries WHERE id = ?', [c.entries[0]!.id]);
    expect(en).toEqual({ funding_account_country: 'BE', country_source: 'account_at_save', currency_status_at_save: 'active', t: 'integer' });
    const key = await one(e(), 'SELECT * FROM ledger_idempotency_keys WHERE user_id = ? AND key = ?', [s.u, c.key]);
    expect(key).toMatchObject({ operation: 'transaction.create', op_id: c.O, transaction_id: c.T, result_revision: 1, result_event_id: c.E, audit_id: c.A, response_status: 201, expires_at: null, hash_version: 1 });
    for (const [k, val] of Object.entries(key)) if (k !== 'expires_at') expect(val, k).not.toBeNull();
    const audit = await one(e(), 'SELECT action, detail FROM audit_log WHERE id = ?', [c.A]);
    expect(audit.action).toBe('transaction.create');
    expect(JSON.parse(String(audit.detail))).toEqual({ id: c.T, eventId: c.E, revision: 1 });
    expect(await one(e(), 'SELECT status, current_revision FROM transactions WHERE id = ?', [c.T])).toEqual({ status: 'active', current_revision: 1 });
    record('P11/P15 create chain', name, { event: ev, entry: en, keyRow: key, audit: audit.detail });
  });

  it('P12 ON CONFLICT DO NOTHING (drizzle onConflictDoNothing in a batch)', async () => {
    await e().run('CREATE TABLE IF NOT EXISTS probe_conflict (id TEXT PRIMARY KEY NOT NULL, n INTEGER NOT NULL)');
    const id = nid('c');
    await e().db.batch([e().db.insert(probeConflict).values({ id, n: 1 }).onConflictDoNothing(), e().db.insert(probeConflict).values({ id, n: 2 }).onConflictDoNothing()]);
    expect(await e().all('SELECT n FROM probe_conflict WHERE id = ?', [id])).toEqual([{ n: 1 }]);
    record('P12 ON CONFLICT DO NOTHING', name, 'second insert ignored, first kept, no error');
  });

  it('P13/P14 a missing step leaves a NULL in the key row: NOT NULL fails and the whole batch rolls back', async () => {
    const s = await seed(e());
    const out: Record<string, string> = {};
    const audits = await count(e(), 'audit_log', 'user_id = ?', [s.u]);
    const zero = { transactions: 0, transaction_events: 0, transaction_entries: 0, ledger_idempotency_keys: 0, audit: audits };
    const base = createIn(s);
    const drop = async (label: string, mutate: (c: ReturnType<typeof createChain>) => Record<string, unknown>, column: RegExp) => {
      const x = fresh(base);
      out[label] = await refusedWith(e().db.batch(steps(mutate(createChain(e().db, x)) as never)), column);
      expect(await ledgerCounts(e(), s.u), label).toEqual(zero);
    };
    await drop('no publish (S4)', ({ S4: _s4, ...rest }) => rest, /NOT NULL constraint failed: ledger_idempotency_keys\.result_revision/);
    await drop('no audit (S5)', ({ S5: _s5, ...rest }) => rest, /NOT NULL constraint failed: ledger_idempotency_keys\.audit_id/);
    await drop('no event (S2)', ({ S2: _s2, ...rest }) => rest, /NOT NULL constraint failed: ledger_idempotency_keys\.result_revision/);
    // An entry that writes nothing (account of nobody): the publish condition (entry count) fails.
    const x = fresh(base);
    x.entries = [{ ...x.entries[0]!, accountId: 'no-such-account' }];
    out['entry wrote nothing'] = await refusedWith(e().db.batch(steps(createChain(e().db, x))), /NOT NULL constraint failed: ledger_idempotency_keys\.result_revision/);
    expect(await ledgerCounts(e(), s.u)).toEqual(zero);
    // A failing statement in the middle (CHECK on the entry amount) rolls back everything before it.
    const y = fresh(base);
    y.entries = [{ ...y.entries[0]!, amount: 78.3 }];
    out['bad amount mid-batch'] = await refusedWith(e().db.batch(steps(createChain(e().db, y))), /CHECK constraint failed: transaction_entries_amount_ck/);
    expect(await ledgerCounts(e(), s.u)).toEqual(zero);
    // C7 inside the chain (domestic) rolls back the header, event and entry.
    const z = fresh(base);
    z.facts = spendFacts({ merchantCountry: 'CN' });
    z.classification = { merchantScope: 'domestic', transferScope: null, foreignStatus: 'domestic' };
    z.entries = [{ ...z.entries[0]!, accountId: s.CN, currency: 'CNY' }];
    out['C7 inside the chain'] = await refusedWith(e().db.batch(steps(createChain(e().db, z))), /LEDGER_CONFIRMED_DOMESTIC/);
    expect(await ledgerCounts(e(), s.u)).toEqual(zero);
    // The same request, complete, then succeeds once.
    await e().db.batch(steps(createChain(e().db, fresh(base))));
    expect(await ledgerCounts(e(), s.u)).toEqual({ transactions: 1, transaction_events: 1, transaction_entries: 1, ledger_idempotency_keys: 1, audit: audits + 1 });
    record('P13/P14 NOT NULL assertion + atomic rollback', name, out);
  });

  it('P16 the same key again writes nothing (gate G); correction and void chains likewise; a stale base revision rolls back', async () => {
    const s = await seed(e());
    const c = createIn(s);
    await e().db.batch(steps(createChain(e().db, c)));
    const after1 = await ledgerCounts(e(), s.u);
    await e().db.batch(steps(createChain(e().db, fresh(c)))); // same key, same content, new ids
    await e().db.batch(steps(createChain(e().db, { ...fresh(c), requestHash: hash('other content'), notes: 'different' }))); // same key, other content
    expect(await ledgerCounts(e(), s.u)).toEqual(after1);
    const key = await one(e(), 'SELECT op_id, request_hash FROM ledger_idempotency_keys WHERE user_id = ? AND key = ?', [s.u, c.key]);
    expect(key).toEqual({ op_id: c.O, request_hash: c.requestHash }); // the route compares hashes and replays or answers 409

    // Correction: first wins; the same key again is a no-op; another key on the stale base revision rolls back.
    const ck = newKey();
    const corr = {
      u: s.u, T: c.T, E: nid('E'), O: nid('O'), A: nid('A'), now: TS + 5, ip: null, key: ck, requestHash: hash(ck), hashVersion: 1,
      baseRevision: 1, kind: 'fact_correction' as const, reason: 'typo', facts: spendFacts({ cardId: s.K, eventAmount: 1200 }), correctedHomeRegion: null, classification: FOREIGN_SPEND,
      entries: [{ ...c.entries[0]!, id: nid('N'), amount: 9400, carriedFromEntryId: c.entries[0]!.id }],
    };
    await e().db.batch(steps(correctChain(e().db, corr)));
    const after2 = await ledgerCounts(e(), s.u);
    expect(after2.transaction_events).toBe(2);
    await e().db.batch(steps(correctChain(e().db, { ...corr, E: nid('E'), O: nid('O'), A: nid('A'), entries: corr.entries.map((x) => ({ ...x, id: nid('N') })) })));
    expect(await ledgerCounts(e(), s.u)).toEqual(after2);
    const k2 = newKey();
    const stale = await refusedWith(
      e().db.batch(steps(correctChain(e().db, { ...corr, key: k2, requestHash: hash(k2), E: nid('E'), O: nid('O'), A: nid('A'), entries: corr.entries.map((x) => ({ ...x, id: nid('N') })) }))),
      /NOT NULL constraint failed: ledger_idempotency_keys\.result_revision/,
    );
    expect(await ledgerCounts(e(), s.u)).toEqual(after2);
    expect((await one(e(), 'SELECT current_revision FROM transactions WHERE id = ?', [c.T])).current_revision).toBe(2);

    // Void: once; the same key again is a no-op; voiding again with another key rolls back.
    const vk = newKey();
    const vd = { u: s.u, T: c.T, now: TS + 6, ip: null, baseRevision: 2, reason: null, O: nid('O'), A: nid('A'), key: vk, requestHash: hash(vk), hashVersion: 1 };
    await e().db.batch(steps(voidChain(e().db, vd)));
    const after3 = await ledgerCounts(e(), s.u);
    await e().db.batch(steps(voidChain(e().db, { ...vd, O: nid('O'), A: nid('A') })));
    expect(await ledgerCounts(e(), s.u)).toEqual(after3);
    const vk2 = newKey();
    const twice = await refusedWith(e().db.batch(steps(voidChain(e().db, { ...vd, key: vk2, requestHash: hash(vk2), O: nid('O'), A: nid('A') }))), /NOT NULL constraint failed: ledger_idempotency_keys\.result_revision/);
    expect(await ledgerCounts(e(), s.u)).toEqual(after3);
    const vkey = await one(e(), 'SELECT result_revision, result_event_id, response_status, expires_at - created_at AS ttl FROM ledger_idempotency_keys WHERE user_id = ? AND key = ?', [s.u, vk]);
    expect(vkey).toEqual({ result_revision: 2, result_event_id: corr.E, response_status: 200, ttl: 30 * 86_400_000 });
    record('P16 same-key retry and version race', name, { staleCorrection: stale, voidTwice: twice, voidKey: vkey });
  });

  it('P17/P18 CAST(SUM(...) AS TEXT), integer / and %, SUM overflow at 9300 × max, segmented sums exact', async () => {
    await e().run("CREATE TABLE IF NOT EXISTS probe_sum (a INTEGER CHECK(typeof(a) = 'integer' AND a BETWEEN 1 AND 999999999999999))");
    await e().run('DELETE FROM probe_sum');
    await e().run('INSERT INTO probe_sum (a) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 9300) SELECT 999999999999999 FROM n');
    expect(Number((await one(e(), 'SELECT count(*) AS n FROM probe_sum')).n)).toBe(9300);
    const overflow = await refusedWith(e().all('SELECT SUM(a) AS s FROM probe_sum'), /integer overflow/i);
    const total = (await one(e(), 'SELECT TOTAL(a) AS t, typeof(TOTAL(a)) AS ty FROM probe_sum')) as { t: number; ty: string };
    const exact = 9300n * 999999999999999n;
    expect(total.ty).toBe('real');
    const seg = (await one(e(), 'SELECT CAST(SUM(a / 1000000000) AS TEXT) AS hi, CAST(SUM(a % 1000000000) AS TEXT) AS lo, typeof(CAST(SUM(a / 1000000000) AS TEXT)) AS ty, COUNT(*) AS n FROM probe_sum')) as Row;
    expect(seg.ty).toBe('text');
    const merged = BigInt(String(seg.hi)) * 1_000_000_000n + BigInt(String(seg.lo));
    expect(merged).toBe(exact);
    expect(BigInt(Math.round(total.t))).not.toBe(exact); // TOTAL() is a float: not exact
    const divmod = await one(e(), 'SELECT 999999999999999 / 1000000000 AS q, 999999999999999 % 1000000000 AS r');
    expect(divmod).toEqual({ q: 999999, r: 999999999 });
    // On real ledger rows: the §10.12 statistics shape, strings out.
    const s = await seed(e());
    const c = createIn(s);
    await e().db.batch(steps(createChain(e().db, c)));
    await e().db.batch(steps(createChain(e().db, fresh({ ...c, key: newKey() }))));
    const stats = await e().all(
      `SELECT ev.foreign_status, en.funding_currency, en.currency_exponent,
              CAST(SUM(en.amount / 1000000000) AS TEXT) AS hi, CAST(SUM(en.amount % 1000000000) AS TEXT) AS lo, COUNT(*) AS n
       FROM transactions t
       JOIN transaction_events ev ON ev.transaction_id = t.id AND ev.revision = t.current_revision
       JOIN transaction_entries en ON en.event_id = ev.id
       WHERE t.user_id = ? AND t.status = 'active' AND en.amount_status = 'confirmed'
       GROUP BY ev.foreign_status, en.funding_currency, en.currency_exponent`,
      [s.u],
    );
    expect(stats).toEqual([{ foreign_status: 'foreign', funding_currency: 'HKD', currency_exponent: 2, hi: '0', lo: '15660', n: 2 }]);
    record('P17/P18 exact sums', name, { overflow, total: total.t, segmented: seg, merged: merged.toString(), exact: exact.toString(), divmod, stats });
  });

  it('P19 bound parameters: every chain statement stays ≤ 100 (D1 refuses 101)', async () => {
    const s = await seed(e());
    const two: EntryIn[] = [
      { id: 'n1', direction: 'out', accountId: s.HK, currency: 'HKD', amount: 1, amountStatus: 'confirmed', exponent: 2, closedCurrencyAck: false },
      { id: 'n2', direction: 'in', accountId: s.BE, currency: 'USD', amount: 1, amountStatus: 'confirmed', exponent: 2, closedCurrencyAck: false, carriedFromEntryId: 'x' },
    ];
    const c = createChain(e().db, createIn(s, { entries: two }));
    const k = 'k'.repeat(20);
    const r = correctChain(e().db, {
      u: s.u, T: 't', E: 'e', O: 'o', A: 'a', now: 1, ip: null, key: k, requestHash: hash(k), hashVersion: 1, baseRevision: 1, kind: 'snapshot_correction', reason: 'x',
      facts: spendFacts(), correctedHomeRegion: 'HK', classification: FOREIGN_SPEND, entries: two.map((x) => ({ ...x, correctedCountry: 'SG' })),
    });
    const v = voidChain(e().db, { u: s.u, T: 't', now: 1, ip: null, baseRevision: 1, reason: 'x', O: 'o', A: 'a', key: k, requestHash: hash(k), hashVersion: 1 });
    const counts: Record<string, number> = {};
    for (const [chain, st] of [['create', c], ['correct', r], ['void', v]] as const) {
      for (const [stepName, stmt] of Object.entries(st)) {
        for (const [i, one_] of (Array.isArray(stmt) ? stmt : [stmt]).entries()) counts[`${chain}.${stepName}${Array.isArray(stmt) ? `[${i}]` : ''}`] = (one_ as any).toSQL().params.length;
      }
    }
    expect(Math.max(...Object.values(counts))).toBeLessThanOrEqual(100);
    // Flat column lists (a ? + ? chain would hit the expression-depth limit of 100 first).
    const q = (n: number) => `SELECT ${Array.from({ length: n }, (_, i) => `? AS c${i}`).join(', ')}`;
    await e().all(q(100), Array.from({ length: 100 }, () => 1));
    let over: string;
    if (name === 'd1') over = await refusedWith(e().all(q(101), Array.from({ length: 101 }, () => 1)), /too many SQL variables/i);
    else over = `${Object.keys(await one(e(), q(101), Array.from({ length: 101 }, () => 1))).length} columns (libsql allows more; D1 is the binding limit)`;
    record('P19 bound parameters', name, { perStatement: counts, max: Math.max(...Object.values(counts)), hundredAndOne: over });
  });

  it('P20 drizzle builder statements run in D1/libsql batches; raw db.run(sql``) with parameters (informational)', async () => {
    let rawRun: string;
    try {
      await e().db.batch([e().db.run(sql`SELECT ${1} AS one`)]);
      rawRun = 'ok';
    } catch (err) {
      rawRun = `fails: ${errorText(err)}`;
    }
    record('P20 drizzle builder in batch', name, { builderChains: 'create / correct / void chains built with insert().select(), update().where(), delete() ran in db.batch() (P9–P18)', rawRunWithParams: rawRun });
  });

  it('special: ev_insert_order, ev_snapshot_source, ev_kind_guard, en_insert_open, en_snapshot_source, en_kind_guard, en_closed_currency', async () => {
    const out: Record<string, string> = {};
    const s = await seed(e(), 'HK');
    const T = nid('T');
    await ins(e(), 'transactions', { id: T, user_id: s.u, txn_type: 'merchant_spend', created_at: TS, updated_at: TS });
    out.ev_insert_order_gap = await refusedWith(ins(e(), 'transaction_events', evRow(s, T, nid('E'), 'merchant_spend', { revision: 2, revision_kind: 'settlement', home_region_source: 'carried', home_region: 'HK' })), /LEDGER_REVISION_ORDER/);
    out.ev_insert_order_otherUser = await refusedWith(ins(e(), 'transaction_events', { ...evRow(s, T, nid('E'), 'merchant_spend'), user_id: (await seed(e())).u }), /LEDGER_REVISION_ORDER/);
    out.ev_snapshot_source_preference = await refusedWith(ins(e(), 'transaction_events', evRow(s, T, nid('E'), 'merchant_spend', { home_region: 'CN' })), /LEDGER_SNAPSHOT_SOURCE/);
    // Order on events: a gap AND a wrong preference snapshot ⇒ ev_insert_order first.
    out.order_insert_order_first = await refusedWith(ins(e(), 'transaction_events', evRow(s, T, nid('E'), 'merchant_spend', { revision: 3, revision_kind: 'fact_correction', correction_reason: 'x', home_region_source: 'carried', home_region: 'ZZ' })), /LEDGER_REVISION_ORDER/);
    const E = nid('E');
    await ins(e(), 'transaction_events', evRow(s, T, E, 'merchant_spend', { home_region: 'HK' }));
    out.en_snapshot_source_country = await refusedWith(ins(e(), 'transaction_entries', enRow(s, E, 'merchant_spend', { funding_account_country: 'US' })), /LEDGER_SNAPSHOT_SOURCE/);
    out.en_snapshot_source_currencyStatus = await refusedWith(ins(e(), 'transaction_entries', enRow(s, E, 'merchant_spend', { funding_account_id: s.BE, funding_currency: 'GBP', funding_account_country: 'BE', currency_status_at_save: 'active' })), /LEDGER_SNAPSHOT_SOURCE/);
    out.en_closed_currency_current = await refusedWith(
      ins(e(), 'transaction_entries', enRow(s, E, 'merchant_spend', { funding_account_id: s.BE, funding_currency: 'GBP', funding_account_country: 'BE', currency_status_at_save: 'closed' })),
      /LEDGER_CLOSED_CURRENCY/,
    );
    // Order on entries: published version AND wrong snapshot ⇒ en_insert_open first (checked below after publishing).
    const N1 = nid('N');
    await ins(e(), 'transaction_entries', enRow(s, E, 'merchant_spend', { id: N1 }));
    await publish(e(), T);
    out.order_insert_open_first = await refusedWith(ins(e(), 'transaction_entries', enRow(s, E, 'merchant_spend', { direction: 'in', funding_account_country: 'US' })), /LEDGER_IMMUTABLE/);

    // Backfill with acknowledgement may use the closed GBP.
    const bf = createIn(s, {
      facts: spendFacts({ recordMode: 'backfill', eventCurrency: 'GBP' }),
      declaredHomeRegion: 'CN',
      entries: [{ id: nid('N'), direction: 'out', accountId: s.BE, currency: 'GBP', amount: 500, amountStatus: 'confirmed', exponent: 2, closedCurrencyAck: true }],
    });
    await e().db.batch(steps(createChain(e().db, bf)));
    expect(await one(e(), 'SELECT home_region, home_region_source FROM transaction_events WHERE id = ?', [bf.E])).toEqual({ home_region: 'CN', home_region_source: 'user_declared' });
    const noAck = createIn(s, { facts: spendFacts({ recordMode: 'backfill' }), entries: [{ ...bf.entries[0]!, id: nid('N'), closedCurrencyAck: false }] });
    out.en_closed_currency_backfillNoAck = await refusedWith(e().db.batch(steps(createChain(e().db, noAck))), /LEDGER_CLOSED_CURRENCY/);

    // Corrections on the backfilled transaction.
    const corr = (x: Partial<Parameters<typeof correctChain>[1]>) => {
      const k = newKey();
      return correctChain(e().db, {
        u: s.u, T: bf.T, E: nid('E'), O: nid('O'), A: nid('A'), now: TS + 9, ip: null, key: k, requestHash: hash(k), hashVersion: 1, baseRevision: 1,
        kind: 'fact_correction', reason: 'r', facts: bf.facts, correctedHomeRegion: null, classification: FOREIGN_SPEND,
        entries: [{ ...bf.entries[0]!, id: nid('N'), carriedFromEntryId: bf.entries[0]!.id }], ...x,
      });
    };
    out.ev_kind_guard_settlementChangesDate = await refusedWith(e().db.batch(steps(corr({ kind: 'settlement', reason: null, facts: { ...bf.facts, occurredOn: '2026-10-21' } }))), /LEDGER_REVISION_KIND/);
    out.en_kind_guard_snapshotChangesAmount = await refusedWith(e().db.batch(steps(corr({ kind: 'snapshot_correction', entries: [{ ...bf.entries[0]!, id: nid('N'), amount: 501, carriedFromEntryId: bf.entries[0]!.id, correctedCountry: 'SG' }] }))), /LEDGER_REVISION_KIND/);
    out.en_kind_guard_settlementOnConfirmed = await refusedWith(e().db.batch(steps(corr({ kind: 'settlement', reason: null, entries: [{ ...bf.entries[0]!, id: nid('N'), amount: 600, carriedFromEntryId: bf.entries[0]!.id }] }))), /LEDGER_REVISION_KIND/);
    // Fact correction on the same account without carrying the snapshot (a fresh account_at_save) is refused …
    out.en_snapshot_source_notCarried = await refusedWith(e().db.batch(steps(corr({ entries: [{ ...bf.entries[0]!, id: nid('N'), carriedFromEntryId: null, currency: 'USD' }] }))), /LEDGER_SNAPSHOT_SOURCE/);
    // … carrying it with the closed currency of the carried entry is allowed (R3 b), and the
    // closed-currency rule then holds in current mode as well.
    await e().db.batch(steps(corr({ facts: { ...bf.facts, recordMode: 'current' }, entries: [{ ...bf.entries[0]!, id: nid('N'), closedCurrencyAck: false, carriedFromEntryId: bf.entries[0]!.id }] })));
    expect(await one(e(), 'SELECT current_revision FROM transactions WHERE id = ?', [bf.T])).toEqual({ current_revision: 2 });

    // Direction change on the same account still carries (third-party out → in), not account_at_save.
    const tp = createIn(s, {
      txnType: 'third_party_transfer', facts: thirdPartyFacts(), classification: { merchantScope: null, transferScope: 'foreign_cross_border', foreignStatus: 'foreign' },
      entries: [{ id: nid('N'), direction: 'out', accountId: s.BE, currency: 'USD', amount: 1000, amountStatus: 'confirmed', exponent: 2, closedCurrencyAck: false }],
    });
    await e().db.batch(steps(createChain(e().db, tp)));
    const k3 = newKey();
    const flip = (carry: boolean) =>
      correctChain(e().db, {
        u: s.u, T: tp.T, E: nid('E'), O: nid('O'), A: nid('A'), now: TS + 9, ip: null, key: carry ? k3 : newKey(), requestHash: hash(k3), hashVersion: 1, baseRevision: 1,
        kind: 'fact_correction', reason: 'direction', facts: tp.facts, correctedHomeRegion: null, classification: { merchantScope: null, transferScope: 'foreign_cross_border', foreignStatus: 'foreign' },
        entries: [{ ...tp.entries[0]!, id: nid('N'), direction: 'in', carriedFromEntryId: carry ? tp.entries[0]!.id : null }],
      });
    out.en_snapshot_source_directionFlipNotCarried = await refusedWith(e().db.batch(steps(flip(false))), /LEDGER_SNAPSHOT_SOURCE/);
    await e().db.batch(steps(flip(true)));
    record('special trigger probes', name, out);
  });
});

describe('DB-M3-0 libsql and D1 agree', () => {
  it('both engines produced evidence for every probe', () => {
    for (const [item, byEngine] of Object.entries(evidence)) expect(Object.keys(byEngine).sort(), item).toEqual(['d1', 'libsql']);
  });
});
