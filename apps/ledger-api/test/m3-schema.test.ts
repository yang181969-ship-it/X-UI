// M3 database constraints (TEST_PLAN §5, DB-M3-1 / DB-M3-3), run unchanged on two engines:
//   libsql — a temporary file database opened by openV1Db() (identity check, every migration,
//            PRAGMA foreign_keys = ON on its single connection);
//   d1     — wrangler getPlatformProxy(): local in-memory D1 inside workerd (persist: false,
//            remoteBindings: false); migrations in _journal.json order through wrangler's splitter.
// Cases use raw SQL (and drizzle batches) only: they test the database, not an API. Every refusal
// is matched on what refused it — a LEDGER_* trigger code, a named CHECK, a named unique index or a
// foreign key — because a failing statement alone does not show which rule fired (BEFORE triggers
// run before CHECKs; foreign keys are checked at the end of the statement).
// The write chains (create / correct / void), idempotency, fault injection, concurrency and
// mutations are in m3-chains.test.ts. No remote D1 is contacted.
import { createHash } from 'node:crypto';
import { classify, mergeSegmentedSum, TRANSFER_SCOPES, type ClassificationInput, type TxnType } from '@xui/ledger-shared';
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
  ins,
  ledgerCounts,
  libsqlEngine,
  M3_TABLES,
  newKey,
  nid,
  one,
  publishRaw,
  rawTxn,
  seedUser,
  spendFacts,
  steps,
  TS,
  voidChain,
  type CorrectIn,
  type CreateIn,
  type Engine,
  type Row,
  type Seed,
} from './m3-ledger.ts';

const engines: Partial<Record<'libsql' | 'd1', Engine>> = {};
beforeAll(async () => {
  engines.libsql = await libsqlEngine();
  engines.d1 = await d1Engine('xui-m3-schema');
}, 180_000);
afterAll(async () => {
  await engines.d1?.dispose();
  await engines.libsql?.dispose();
});

// ------------------------------------------------------------------ assertions

async function rejection(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (err === null) expect.fail('expected the database to refuse the statement, but it succeeded');
  return errorText(err);
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Refused by a trigger raising `code`. */
const raises = async (p: Promise<unknown>, code: string) => expect(await rejection(p)).toMatch(new RegExp(`\\b${code}:`));
const checkFails = async (p: Promise<unknown>, name: string) => expect(await rejection(p)).toMatch(new RegExp(`CHECK constraint failed: ${escapeRe(name)}(?![\\w])`));
/** target: "table.col, table.col" as SQLite reports the index columns. */
const uniqueFails = async (p: Promise<unknown>, target: string) => expect(await rejection(p)).toMatch(new RegExp(`UNIQUE constraint failed: ${escapeRe(target)}(?![\\w.,])`));
const fkFails = async (p: Promise<unknown>) => expect(await rejection(p)).toMatch(/FOREIGN KEY constraint failed/);

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
/** INSERT with inlined literals, for literal batches (test values only — never user input). */
function insertLiteral(table: string, r: Row): string {
  const lit = (v: unknown) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  return `INSERT INTO ${table} (${Object.keys(r).join(', ')}) VALUES (${Object.values(r).map(lit).join(', ')})`;
}
const createIn = (s: Seed, x: Partial<CreateIn> = {}) => createInput(s, hash, x);
const correctIn = (s: Seed, c: CreateIn, x: Partial<CorrectIn>): CorrectIn => {
  const key = newKey();
  return {
    u: s.u, T: c.T, E: nid('E'), O: nid('O'), A: nid('A'), now: TS + 100, ip: null, key, requestHash: hash(key), hashVersion: 1,
    baseRevision: 1, kind: 'fact_correction', reason: 'correction', facts: c.facts, correctedHomeRegion: null, classification: c.classification,
    entries: c.entries.map((en) => ({ ...en, id: nid('N'), carriedFromEntryId: en.id })), ...x,
  };
};
const create = async (e: Engine, c: CreateIn) => (await e.db.batch(steps(createChain(e.db, c))), c);
const correct = (e: Engine, x: CorrectIn) => e.db.batch(steps(correctChain(e.db, x)));

/** Account and currency of the seed user in a given country (home is CN). */
const acct = (s: Seed, country: string) =>
  ({ CN: { id: s.CN, cur: 'CNY' }, HK: { id: s.HK, cur: 'HKD' }, BE: { id: s.BE, cur: 'USD' } })[country] ?? expect.fail(`no account in ${country}`);

// ------------------------------------------------------------------ expected schema (DATA_MODEL §10)

interface Fk {
  table: string;
  from: string[];
  to: string[];
  onDelete: 'CASCADE' | 'NO ACTION';
}
const USERS_FK: Fk = { table: 'users', from: ['user_id'], to: ['id'], onDelete: 'CASCADE' };
const EXPECTED_FKS: Record<(typeof M3_TABLES)[number], Fk[]> = {
  transactions: [USERS_FK],
  transaction_events: [
    USERS_FK,
    { table: 'transactions', from: ['transaction_id', 'txn_type', 'user_id'], to: ['id', 'txn_type', 'user_id'], onDelete: 'CASCADE' },
    { table: 'cards', from: ['card_id', 'user_id'], to: ['id', 'user_id'], onDelete: 'NO ACTION' },
    { table: 'payment_channels', from: ['payment_channel_id', 'user_id'], to: ['id', 'user_id'], onDelete: 'NO ACTION' },
  ],
  transaction_entries: [
    USERS_FK,
    { table: 'transaction_events', from: ['event_id', 'txn_type', 'user_id'], to: ['id', 'txn_type', 'user_id'], onDelete: 'CASCADE' },
    { table: 'accounts', from: ['funding_account_id', 'user_id'], to: ['id', 'user_id'], onDelete: 'NO ACTION' },
    { table: 'account_currencies', from: ['funding_account_id', 'user_id', 'funding_currency'], to: ['account_id', 'user_id', 'currency'], onDelete: 'NO ACTION' },
    { table: 'transaction_entries', from: ['carried_from_entry_id', 'user_id'], to: ['id', 'user_id'], onDelete: 'NO ACTION' },
  ],
  ledger_idempotency_keys: [
    USERS_FK,
    { table: 'transactions', from: ['transaction_id', 'user_id'], to: ['id', 'user_id'], onDelete: 'CASCADE' },
    { table: 'transaction_events', from: ['result_event_id', 'user_id'], to: ['id', 'user_id'], onDelete: 'CASCADE' },
  ],
};

const EXPECTED_INDEXES: Record<string, string> = {
  transactions_id_user_uq: 'CREATE UNIQUE INDEX `transactions_id_user_uq` ON `transactions` (`id`,`user_id`)',
  transactions_id_type_user_uq: 'CREATE UNIQUE INDEX `transactions_id_type_user_uq` ON `transactions` (`id`,`txn_type`,`user_id`)',
  transactions_user_status_idx: 'CREATE INDEX `transactions_user_status_idx` ON `transactions` (`user_id`,`status`)',
  transaction_events_id_user_uq: 'CREATE UNIQUE INDEX `transaction_events_id_user_uq` ON `transaction_events` (`id`,`user_id`)',
  transaction_events_id_type_user_uq: 'CREATE UNIQUE INDEX `transaction_events_id_type_user_uq` ON `transaction_events` (`id`,`txn_type`,`user_id`)',
  transaction_events_revision_uq: 'CREATE UNIQUE INDEX `transaction_events_revision_uq` ON `transaction_events` (`transaction_id`,`revision`)',
  transaction_events_user_occurred_idx: 'CREATE INDEX `transaction_events_user_occurred_idx` ON `transaction_events` (`user_id`,`occurred_on`)',
  transaction_events_user_card_idx: 'CREATE INDEX `transaction_events_user_card_idx` ON `transaction_events` (`user_id`,`card_id`)',
  transaction_events_user_channel_idx: 'CREATE INDEX `transaction_events_user_channel_idx` ON `transaction_events` (`user_id`,`payment_channel_id`)',
  transaction_entries_id_user_uq: 'CREATE UNIQUE INDEX `transaction_entries_id_user_uq` ON `transaction_entries` (`id`,`user_id`)',
  transaction_entries_event_direction_uq: 'CREATE UNIQUE INDEX `transaction_entries_event_direction_uq` ON `transaction_entries` (`event_id`,`direction`)',
  transaction_entries_event_account_uq: 'CREATE UNIQUE INDEX `transaction_entries_event_account_uq` ON `transaction_entries` (`event_id`,`funding_account_id`)',
  transaction_entries_single_uq: "CREATE UNIQUE INDEX `transaction_entries_single_uq` ON `transaction_entries` (`event_id`) WHERE `txn_type` <> 'own_transfer'",
  transaction_entries_user_account_idx: 'CREATE INDEX `transaction_entries_user_account_idx` ON `transaction_entries` (`user_id`,`funding_account_id`)',
  transaction_entries_carried_from_idx: 'CREATE INDEX `transaction_entries_carried_from_idx` ON `transaction_entries` (`carried_from_entry_id`,`user_id`)',
  ledger_idempotency_keys_user_expires_idx: 'CREATE INDEX `ledger_idempotency_keys_user_expires_idx` ON `ledger_idempotency_keys` (`user_id`,`expires_at`)',
};

/** The 21 triggers of DATA_MODEL §10.7.2: table, timing and the code each raises. */
const EXPECTED_TRIGGERS: Record<string, [table: string, head: string, code: string]> = {
  tx_insert_guard: ['transactions', 'BEFORE INSERT ON `transactions`', 'LEDGER_HEADER_INSERT'],
  tx_update_guard: ['transactions', 'BEFORE UPDATE ON `transactions`', 'LEDGER_REVISION_ORDER'],
  tx_publish_entry_count: ['transactions', 'BEFORE UPDATE OF `current_revision` ON `transactions`', 'LEDGER_ENTRY_COUNT'],
  tx_publish_own_shape: ['transactions', 'BEFORE UPDATE OF `current_revision` ON `transactions`', 'LEDGER_OWN_TRANSFER_SHAPE'],
  tx_publish_event_amount: ['transactions', 'BEFORE UPDATE OF `current_revision` ON `transactions`', 'LEDGER_EVENT_AMOUNT'],
  tx_publish_classification: ['transactions', 'BEFORE UPDATE OF `current_revision` ON `transactions`', 'LEDGER_CLASSIFICATION'],
  tx_publish_domestic: ['transactions', 'BEFORE UPDATE OF `current_revision` ON `transactions`', 'LEDGER_CONFIRMED_DOMESTIC'],
  tx_no_delete: ['transactions', 'BEFORE DELETE ON `transactions`', 'LEDGER_NO_DELETE'],
  ev_immutable: ['transaction_events', 'BEFORE UPDATE ON `transaction_events`', 'LEDGER_IMMUTABLE'],
  ev_insert_order: ['transaction_events', 'BEFORE INSERT ON `transaction_events`', 'LEDGER_REVISION_ORDER'],
  ev_snapshot_source: ['transaction_events', 'BEFORE INSERT ON `transaction_events`', 'LEDGER_SNAPSHOT_SOURCE'],
  ev_kind_guard: ['transaction_events', 'BEFORE INSERT ON `transaction_events`', 'LEDGER_REVISION_KIND'],
  ev_no_delete: ['transaction_events', 'BEFORE DELETE ON `transaction_events`', 'LEDGER_NO_DELETE'],
  en_immutable: ['transaction_entries', 'BEFORE UPDATE ON `transaction_entries`', 'LEDGER_IMMUTABLE'],
  en_insert_open: ['transaction_entries', 'BEFORE INSERT ON `transaction_entries`', 'LEDGER_IMMUTABLE'],
  en_snapshot_source: ['transaction_entries', 'BEFORE INSERT ON `transaction_entries`', 'LEDGER_SNAPSHOT_SOURCE'],
  en_kind_guard: ['transaction_entries', 'BEFORE INSERT ON `transaction_entries`', 'LEDGER_REVISION_KIND'],
  en_closed_currency: ['transaction_entries', 'BEFORE INSERT ON `transaction_entries`', 'LEDGER_CLOSED_CURRENCY'],
  en_no_delete: ['transaction_entries', 'BEFORE DELETE ON `transaction_entries`', 'LEDGER_NO_DELETE'],
  key_immutable: ['ledger_idempotency_keys', 'BEFORE UPDATE ON `ledger_idempotency_keys`', 'LEDGER_KEY_IMMUTABLE'],
  key_create_no_delete: ['ledger_idempotency_keys', 'BEFORE DELETE ON `ledger_idempotency_keys`', 'LEDGER_NO_DELETE'],
};
const PUBLISH_TRIGGERS = ['tx_publish_entry_count', 'tx_publish_own_shape', 'tx_publish_event_amount', 'tx_publish_classification', 'tx_publish_domestic'];

const EXPECTED_CHECKS: Record<(typeof M3_TABLES)[number], string[]> = {
  transactions: ['transactions_type_ck', 'transactions_status_ck', 'transactions_revision_ck', 'transactions_voided_at_ck', 'transactions_voided_op_ck', 'transactions_void_reason_ck', 'transactions_published_ck'],
  transaction_events: [
    'transaction_events_type_ck', 'transaction_events_revision_ck', 'transaction_events_revision_kind_ck', 'transaction_events_original_ck', 'transaction_events_reason_ck',
    'transaction_events_record_mode_ck', 'transaction_events_occurred_time_ck', 'transaction_events_posted_on_ck', 'transaction_events_currency_ck', 'transaction_events_amount_ck',
    'transaction_events_exponent_ck', 'transaction_events_exponent_currency_ck', 'transaction_events_amount_currency_ck', 'transaction_events_amount_required_ck',
    'transaction_events_merchant_country_ck', 'transaction_events_transfer_method_ck', 'transaction_events_counterparty_kind_ck', 'transaction_events_counterparty_country_ck',
    'transaction_events_counterparty_hint_ck', 'transaction_events_home_region_ck', 'transaction_events_home_region_source_ck', 'transaction_events_home_region_source_rule_ck',
    'transaction_events_merchant_scope_ck', 'transaction_events_transfer_scope_ck', 'transaction_events_foreign_status_ck', 'transaction_events_classifier_ck',
    'transaction_events_merchant_shape_ck', 'transaction_events_transfer_shape_ck', 'transaction_events_merchant_scope_rule_ck',
  ],
  transaction_entries: [
    'transaction_entries_type_ck', 'transaction_entries_direction_ck', 'transaction_entries_amount_ck', 'transaction_entries_amount_status_ck', 'transaction_entries_pending_ck',
    'transaction_entries_exponent_ck', 'transaction_entries_country_ck', 'transaction_entries_country_source_ck', 'transaction_entries_carried_ck', 'transaction_entries_currency_status_ck',
    'transaction_entries_ack_ck', 'transaction_entries_ack_closed_ck', 'transaction_entries_spend_direction_ck', 'transaction_entries_refund_direction_ck',
  ],
  ledger_idempotency_keys: [
    'ledger_idempotency_keys_key_ck', 'ledger_idempotency_keys_operation_ck', 'ledger_idempotency_keys_hash_ck', 'ledger_idempotency_keys_hash_version_ck',
    'ledger_idempotency_keys_result_revision_ck', 'ledger_idempotency_keys_response_status_ck', 'ledger_idempotency_keys_retention_ck', 'ledger_idempotency_keys_expires_ck',
  ],
};

/** Never columns of the ledger (DATA_MODEL §10.3: no notes on events, no is_foreign, no balance / rate / fee / converted amount). */
const FORBIDDEN = ['balance', 'opening_balance', 'exchange_rate', 'rate', 'fx_rate', 'fee', 'fees', 'converted_amount', 'base_amount', 'is_foreign', 'pan', 'iban', 'bic', 'account_number', 'claim_token'];

const norm = (s: unknown) => String(s).replace(/\s+/g, ' ').trim();

async function foreignKeys(e: Engine, table: string): Promise<Fk[]> {
  const rows = await e.all(`PRAGMA foreign_key_list(${table})`);
  const byId = new Map<number, Row[]>();
  for (const r of rows) byId.set(Number(r.id), [...(byId.get(Number(r.id)) ?? []), r]);
  return sortFks(
    [...byId.values()]
      .map((g) => g.sort((a, b) => Number(a.seq) - Number(b.seq)))
      .map((g) => ({ table: String(g[0]!.table), from: g.map((r) => String(r.from)), to: g.map((r) => String(r.to)), onDelete: String(g[0]!.on_delete).toUpperCase() as Fk['onDelete'] })),
  );
}
const sortFks = (fks: Fk[]) => [...fks].sort((a, b) => `${a.table}:${a.from}`.localeCompare(`${b.table}:${b.from}`));

async function schemaSnapshot(e: Engine) {
  const out: Record<string, unknown> = {};
  for (const t of M3_TABLES) {
    out[t] = {
      columns: (await e.all(`PRAGMA table_info(${t})`)).map((r) => [String(r.name), String(r.type), Number(r.notnull), r.dflt_value === null ? null : String(r.dflt_value), Number(r.pk)]),
      indexList: (await e.all(`PRAGMA index_list(${t})`)).map((r) => ({ name: String(r.name), unique: Number(r.unique), origin: String(r.origin), partial: Number(r.partial) })).sort((a, b) => a.name.localeCompare(b.name)),
      indexSql: (await e.all("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name", [t])).map((r) => [String(r.name), norm(r.sql)]),
      foreignKeys: await foreignKeys(e, t),
      tableSql: norm((await one(e, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).sql),
    };
  }
  out.triggers = (await e.all(`SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (${M3_TABLES.map(() => '?').join(', ')}) ORDER BY rowid`, [...M3_TABLES])).map((r) => [
    String(r.name),
    String(r.tbl_name),
    norm(r.sql),
  ]);
  return out;
}
const snapshots: Partial<Record<'libsql' | 'd1', Awaited<ReturnType<typeof schemaSnapshot>>>> = {};

// ================================================================== the cases, once per engine

describe.each(['libsql', 'd1'] as const)('M3 constraints on %s', (name) => {
  const e = () => engines[name]!;
  beforeEach(async () => {
    await e().ping();
  });

  describe('DB-M3-1 schema as built', () => {
    it('has exactly the M3 foreign-key matrix (DATA_MODEL §10.6): composite with user_id, CASCADE / NO ACTION only', async () => {
      for (const t of M3_TABLES) expect(await foreignKeys(e(), t), t).toEqual(sortFks(EXPECTED_FKS[t]));
    });

    it('U-5: every business reference includes user_id and its parent has a matching unique index', async () => {
      for (const t of M3_TABLES) {
        for (const fk of await foreignKeys(e(), t)) {
          if (fk.table === 'users') continue;
          expect(fk.from, `${t} → ${fk.table}`).toContain('user_id');
          expect(fk.onDelete, `${t} → ${fk.table}`).not.toBe('SET NULL');
          const parentIndexes = await e().all(`PRAGMA index_list(${fk.table})`);
          let matched = false;
          for (const ix of parentIndexes.filter((x) => Number(x.unique) === 1 && Number(x.partial) === 0)) {
            const cols = (await e().all(`PRAGMA index_info(\`${String(ix.name)}\`)`)).map((c) => String(c.name));
            if (cols.length === fk.to.length && cols.every((c, i) => c === fk.to[i])) matched = true;
          }
          expect(matched, `${t} → ${fk.table}(${fk.to})`).toBe(true);
        }
      }
    });

    it('has every index with its exact columns and WHERE condition; the partial index is partial', async () => {
      const rows = await e().all(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name IN (${M3_TABLES.map(() => '?').join(', ')})`, [...M3_TABLES]);
      expect(Object.fromEntries(rows.map((r) => [String(r.name), norm(r.sql)]))).toEqual(EXPECTED_INDEXES);
      const partial = await e().all("SELECT name, \"partial\" FROM pragma_index_list('transaction_entries') WHERE \"partial\" = 1");
      expect(partial.map((r) => r.name)).toEqual(['transaction_entries_single_uq']);
    });

    it('transaction_entries_carried_from_idx serves the child lookup of the (carried_from_entry_id, user_id) key; a carried chain still cascades with its user', async () => {
      // Deleting an entry makes SQLite look for entries that carry it (the foreign key's child side).
      const plan = (await e().all('EXPLAIN QUERY PLAN SELECT 1 FROM transaction_entries WHERE carried_from_entry_id = ? AND user_id = ?', ['x', 'y'])).map((r) => String(r.detail));
      // @libsql/client leaves an EXPLAIN statement un-reset until it is garbage-collected, holding a
      // table lock that would make later DROP INDEX tests fail with SQLITE_LOCKED (vitest runs with --expose-gc).
      globalThis.gc?.();
      await new Promise((r) => setImmediate(r));
      expect(plan.join(' | ')).toMatch(/SEARCH transaction_entries USING COVERING INDEX transaction_entries_carried_from_idx \(carried_from_entry_id=\? AND user_id=\?\)/);
      // Three carried versions, then the user goes: every version and entry with it, nothing left dangling.
      const s = await seedUser(e());
      const c = await create(e(), createIn(s));
      let prev = c.entries[0]!.id;
      for (const r of [1, 2, 3]) {
        const x = correctIn(s, c, { baseRevision: r, entries: [{ ...c.entries[0]!, id: nid('N'), amount: 7830 + r, carriedFromEntryId: prev }] });
        await correct(e(), x);
        prev = x.entries[0]!.id;
      }
      expect(await count(e(), 'transaction_entries', 'user_id = ? AND carried_from_entry_id IS NOT NULL', [s.u])).toBe(3);
      await e().run('DELETE FROM users WHERE id = ?', [s.u]);
      expect(await ledgerCounts(e(), s.u)).toMatchObject({ transactions: 0, transaction_events: 0, transaction_entries: 0, ledger_idempotency_keys: 0 });
      expect(await e().all('PRAGMA foreign_key_check')).toEqual([]);
    });

    it('has the 21 triggers on the right tables, each raising its code; the publish triggers share tx_update_guard form (2) as WHEN', async () => {
      const rows = await e().all("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'tx\\_%' ESCAPE '\\' OR name LIKE 'ev\\_%' ESCAPE '\\' OR name LIKE 'en\\_%' ESCAPE '\\' OR name LIKE 'key\\_%' ESCAPE '\\')");
      expect(rows).toHaveLength(21);
      const byName = Object.fromEntries(rows.map((r) => [String(r.name), r]));
      for (const [n, [table, head, code]] of Object.entries(EXPECTED_TRIGGERS)) {
        expect(String(byName[n]?.tbl_name), n).toBe(table);
        expect(norm(byName[n]?.sql), n).toContain(head);
        expect(norm(byName[n]?.sql), n).toContain(`RAISE(ABORT, '${code}:`);
      }
      // tx_update_guard runs on every UPDATE: no OF, no WHEN; its three codes in the documented order.
      const guard = norm(byName.tx_update_guard!.sql);
      expect(guard).toMatch(/BEFORE UPDATE ON `transactions` FOR EACH ROW BEGIN SELECT CASE/);
      expect(guard.indexOf('LEDGER_HEADER_IMMUTABLE')).toBeLessThan(guard.indexOf('LEDGER_VOIDED'));
      expect(guard.indexOf('LEDGER_VOIDED')).toBeLessThan(guard.indexOf('LEDGER_REVISION_ORDER'));
      const whenOf = (n: string) => norm(byName[n]!.sql).match(/FOR EACH ROW (WHEN .*?) BEGIN/)![1];
      const when = whenOf('tx_publish_entry_count');
      expect(when).toContain('NEW.`current_revision` = OLD.`current_revision` + 1');
      for (const n of PUBLISH_TRIGGERS) expect(whenOf(n), n).toBe(when);
    });

    it('fires each group in the documented order (SQLite runs the most recently created trigger first)', async () => {
      const order = async (t: string, kind: string) =>
        (await e().all(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND sql LIKE ? ORDER BY rowid DESC`, [t, `%BEFORE ${kind}%`])).map((r) => String(r.name));
      expect(await order('transactions', 'UPDATE')).toEqual(['tx_update_guard', ...PUBLISH_TRIGGERS]);
      expect(await order('transaction_events', 'INSERT')).toEqual(['ev_insert_order', 'ev_snapshot_source', 'ev_kind_guard']);
      expect(await order('transaction_entries', 'INSERT')).toEqual(['en_insert_open', 'en_snapshot_source', 'en_kind_guard', 'en_closed_currency']);
    });

    it('has every named CHECK and no forbidden column', async () => {
      for (const t of M3_TABLES) {
        const tableSql = norm((await one(e(), "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).sql);
        expect([...tableSql.matchAll(/CONSTRAINT "(\w+)" CHECK/g)].map((m) => m[1]), t).toEqual(EXPECTED_CHECKS[t]);
        const cols = (await e().all(`PRAGMA table_info(${t})`)).map((r) => String(r.name));
        for (const bad of FORBIDDEN) expect(cols, `${t}.${bad}`).not.toContain(bad);
      }
      const evCols = (await e().all('PRAGMA table_info(transaction_events)')).map((r) => String(r.name));
      expect(evCols).not.toContain('notes');
      expect(evCols).toContain('foreign_status');
    });

    it('records the snapshot compared across engines', async () => {
      snapshots[name] = await schemaSnapshot(e());
      expect(Object.keys(snapshots[name]!)).toEqual([...M3_TABLES, 'triggers']);
    });
  });

  describe('AMT-5 amounts in the database', () => {
    it('refuses 0, negatives, fractions and values above the maximum by the typeof CHECKs; stores 7830.0 as an integer', async () => {
      const s = await seedUser(e());
      const t = await rawTxn(e(), s, 'own_transfer', { ev: { counterparty_country: 'US', transfer_scope: 'foreign_cross_border' }, entries: [], publish: false });
      for (const amount of [0, -1, 78.3, 1_000_000_000_000_000]) {
        await checkFails(ins(e(), 'transaction_entries', enRow(s, t.E, 'own_transfer', { amount })), 'transaction_entries_amount_ck');
        await checkFails(ins(e(), 'transaction_events', evRow(s, t.T, nid('E'), 'own_transfer', { event_amount: amount })), 'transaction_events_amount_ck');
      }
      await checkFails(ins(e(), 'transaction_entries', enRow(s, t.E, 'own_transfer', { currency_exponent: 5 })), 'transaction_entries_exponent_ck');
      await checkFails(ins(e(), 'transaction_entries', enRow(s, t.E, 'own_transfer', { amount: 7830, amount_status: 'pending' })), 'transaction_entries_pending_ck');
      await checkFails(ins(e(), 'transaction_entries', enRow(s, t.E, 'own_transfer', { amount: null })), 'transaction_entries_pending_ck');
      const N = nid('N');
      await e().run(`INSERT INTO transaction_entries (id, user_id, event_id, txn_type, direction, funding_account_id, funding_currency, amount, amount_status, currency_exponent, funding_account_country, country_source, currency_status_at_save, created_at)
                     VALUES (?, ?, ?, 'own_transfer', 'out', ?, 'HKD', 7830.0, 'confirmed', 2, 'HK', 'account_at_save', 'active', ?)`, [N, s.u, t.E, s.HK, TS]);
      expect(await one(e(), 'SELECT amount, typeof(amount) AS t FROM transaction_entries WHERE id = ?', [N])).toEqual({ amount: 7830, t: 'integer' });
      await ins(e(), 'transaction_entries', enRow(s, t.E, 'own_transfer', { direction: 'in', funding_account_id: s.BE, funding_currency: 'USD', funding_account_country: 'BE', amount: 999_999_999_999_999 }));
    });

    it('event currency and its exponent come together; an amount needs a currency', async () => {
      const s = await seedUser(e());
      const T = nid('T');
      await ins(e(), 'transactions', { id: T, user_id: s.u, txn_type: 'third_party_transfer', created_at: TS, updated_at: TS });
      await checkFails(ins(e(), 'transaction_events', evRow(s, T, nid('E'), 'third_party_transfer', { event_currency_exponent: null })), 'transaction_events_exponent_currency_ck');
      await checkFails(ins(e(), 'transaction_events', evRow(s, T, nid('E'), 'third_party_transfer', { event_currency: null, event_currency_exponent: null })), 'transaction_events_amount_currency_ck');
      // P8: an unknown amount with a known currency is a valid third-party row.
      await ins(e(), 'transaction_events', evRow(s, T, nid('E'), 'third_party_transfer', { event_amount: null }));
    });
  });

  describe('INT whole-number columns: a REAL such as 2.5 is refused by typeof CHECKs (not only by ranges)', () => {
    it('decimal places (event_currency_exponent, currency_exponent): 2.5, -1, 5 refused; 0, 2, 3, 4 stored as integers', async () => {
      const s = await seedUser(e());
      const before = await ledgerCounts(e(), s.u);
      const header = async (type: TxnType) => {
        const T = nid('T');
        await ins(e(), 'transactions', { id: T, user_id: s.u, txn_type: type, created_at: TS, updated_at: TS });
        return T;
      };
      const T = await header('third_party_transfer');
      for (const x of [2.5, -1, 5]) await checkFails(ins(e(), 'transaction_events', evRow(s, T, nid('E'), 'third_party_transfer', { event_currency_exponent: x })), 'transaction_events_exponent_ck');
      const own = await rawTxn(e(), s, 'own_transfer', { ev: { counterparty_country: 'US' }, entries: [], publish: false });
      for (const x of [2.5, -1, 5]) await checkFails(ins(e(), 'transaction_entries', enRow(s, own.E, 'own_transfer', { currency_exponent: x })), 'transaction_entries_exponent_ck');
      expect(await ledgerCounts(e(), s.u)).toEqual({ ...before, transactions: before.transactions! + 2, transaction_events: before.transaction_events! + 1 });
      for (const x of [0, 2, 3, 4, 2.0]) {
        const t = await rawTxn(e(), s, 'own_transfer', { ev: { counterparty_country: 'US', event_currency_exponent: x }, entries: [{ currency_exponent: x }], publish: false });
        expect(await one(e(), 'SELECT typeof(event_currency_exponent) AS a FROM transaction_events WHERE id = ?', [t.E])).toEqual({ a: 'integer' });
        expect(await one(e(), 'SELECT typeof(currency_exponent) AS a, currency_exponent AS v FROM transaction_entries WHERE event_id = ?', [t.E])).toEqual({ a: 'integer', v: Math.trunc(x) });
      }
    });

    it('classifier_version, hash_version, result_revision: fractions and values below 1 refused', async () => {
      const s = await seedUser(e());
      const T = nid('T');
      await ins(e(), 'transactions', { id: T, user_id: s.u, txn_type: 'merchant_spend', created_at: TS, updated_at: TS });
      for (const x of [1.5, 0]) await checkFails(ins(e(), 'transaction_events', evRow(s, T, nid('E'), 'merchant_spend', { classifier_version: x })), 'transaction_events_classifier_ck');
      expect(await count(e(), 'transaction_events', 'transaction_id = ?', [T])).toBe(0);
      const c = await create(e(), createIn(s));
      const k = (x: Row) => ({ user_id: s.u, key: newKey(), operation: 'transaction.correct', request_hash: 'a'.repeat(64), hash_version: 1, op_id: 'o', transaction_id: c.T, result_revision: 1, result_event_id: c.E, audit_id: c.A, response_status: 201, created_at: TS, expires_at: TS + 1, ...x });
      for (const x of [1.5, 0]) await checkFails(ins(e(), 'ledger_idempotency_keys', k({ hash_version: x })), 'ledger_idempotency_keys_hash_version_ck');
      for (const x of [1.5, 0]) await checkFails(ins(e(), 'ledger_idempotency_keys', k({ result_revision: x })), 'ledger_idempotency_keys_result_revision_ck');
      for (const x of [200.5, 201.5]) await checkFails(ins(e(), 'ledger_idempotency_keys', k({ response_status: x })), 'ledger_idempotency_keys_response_status_ck');
      expect(await count(e(), 'ledger_idempotency_keys', 'user_id = ?', [s.u])).toBe(1);
      expect(await one(e(), 'SELECT typeof(hash_version) AS h, typeof(result_revision) AS r FROM ledger_idempotency_keys WHERE user_id = ?', [s.u])).toEqual({ h: 'integer', r: 'integer' });
      // closed_currency_ack is an exact set (0, 1): 0.5 is refused, 1.0 is stored as 1.
      const t = await rawTxn(e(), s, 'merchant_spend', { ev: { record_mode: 'backfill' }, entries: [], publish: false });
      const gbp = { funding_account_id: s.BE, funding_currency: 'GBP', funding_account_country: 'BE', currency_status_at_save: 'closed' };
      const half = enRow(s, t.E, 'merchant_spend', { ...gbp, closed_currency_ack: 0.5 });
      await raises(ins(e(), 'transaction_entries', half), 'LEDGER_CLOSED_CURRENCY'); // 0.5 is not the acknowledgement 1
      await checkFails(e().batchSql(['DROP TRIGGER en_closed_currency', insertLiteral('transaction_entries', half)]), 'transaction_entries_ack_ck');
      await ins(e(), 'transaction_entries', enRow(s, t.E, 'merchant_spend', { ...gbp, closed_currency_ack: 1.0 }));
      expect(await one(e(), 'SELECT typeof(closed_currency_ack) AS t FROM transaction_entries WHERE event_id = ?', [t.E])).toEqual({ t: 'integer' });
    });

    it('revision and current_revision: the guards refuse 2.5 / 0.5 / 1.5 first; with the guards dropped (rolled-back batch) the typeof CHECK refuses alone', async () => {
      const s = await seedUser(e());
      const t = await rawTxn(e(), s, 'merchant_spend');
      const rev = evRow(s, t.T, nid('E'), 'merchant_spend', { revision: 2.5, revision_kind: 'snapshot_correction', correction_reason: 'r', home_region_source: 'user_corrected' });
      await raises(ins(e(), 'transaction_events', rev), 'LEDGER_REVISION_ORDER');
      await checkFails(
        e().batchSql(['DROP TRIGGER ev_insert_order', 'DROP TRIGGER ev_snapshot_source', 'DROP TRIGGER ev_kind_guard', insertLiteral('transaction_events', rev)]),
        'transaction_events_revision_ck',
      );
      const header = { id: nid('T'), user_id: s.u, txn_type: 'merchant_spend', current_revision: 0.5, created_at: TS, updated_at: TS };
      await raises(ins(e(), 'transactions', header), 'LEDGER_HEADER_INSERT');
      await checkFails(e().batchSql(['DROP TRIGGER tx_insert_guard', insertLiteral('transactions', header)]), 'transactions_revision_ck');
      const before = await one(e(), 'SELECT * FROM transactions WHERE id = ?', [t.T]);
      await raises(e().run('UPDATE transactions SET current_revision = 1.5 WHERE id = ?', [t.T]), 'LEDGER_REVISION_ORDER');
      await checkFails(e().batchSql(['DROP TRIGGER tx_update_guard', `UPDATE transactions SET current_revision = 1.5 WHERE id = '${t.T}'`]), 'transactions_revision_ck');
      expect(await one(e(), 'SELECT * FROM transactions WHERE id = ?', [t.T])).toEqual(before);
      // Every dropped trigger came back with its batch.
      for (const n of ['ev_insert_order', 'ev_snapshot_source', 'ev_kind_guard', 'tx_insert_guard', 'tx_update_guard']) expect(await count(e(), 'sqlite_master', "type = 'trigger' AND name = ?", [n]), n).toBe(1);
      // A REAL with no fraction (2.0) is an INTEGER after affinity: a legal publish stores integer 2.
      const E2 = nid('E');
      await ins(e(), 'transaction_events', evRow(s, t.T, E2, 'merchant_spend', { revision: 2.0, revision_kind: 'fact_correction', correction_reason: 'r', home_region_source: 'carried' }));
      await ins(e(), 'transaction_entries', enRow(s, E2, 'merchant_spend', { carried_from_entry_id: t.N[0], country_source: 'carried' }));
      await e().run('UPDATE transactions SET current_revision = 2.0 WHERE id = ?', [t.T]);
      expect(await one(e(), 'SELECT typeof(current_revision) AS t, current_revision AS r FROM transactions WHERE id = ?', [t.T])).toEqual({ t: 'integer', r: 2 });
    });
  });

  describe('SHP Event / Entry shapes (raw SQL parts)', () => {
    it('SHP-1 / SHP-2: one entry per merchant version, out for a spend and in for a refund', async () => {
      const s = await seedUser(e());
      const sp = await rawTxn(e(), s, 'merchant_spend', { publish: false });
      await uniqueFails(ins(e(), 'transaction_entries', enRow(s, sp.E, 'merchant_spend', { funding_account_id: s.BE, funding_currency: 'USD', funding_account_country: 'BE' })), 'transaction_entries.event_id, transaction_entries.direction');
      const sp2 = await rawTxn(e(), s, 'merchant_spend', { entries: [], publish: false });
      await checkFails(ins(e(), 'transaction_entries', enRow(s, sp2.E, 'merchant_spend', { direction: 'in' })), 'transaction_entries_spend_direction_ck');
      const rf = await rawTxn(e(), s, 'merchant_refund', { entries: [], publish: false });
      await checkFails(ins(e(), 'transaction_entries', enRow(s, rf.E, 'merchant_refund', { direction: 'out' })), 'transaction_entries_refund_direction_ck');
      await ins(e(), 'transaction_entries', enRow(s, rf.E, 'merchant_refund'));
      await publishRaw(e(), rf.T, 1);
    });

    it('SHP-3: a third-party version has exactly one entry (partial unique index)', async () => {
      const s = await seedUser(e());
      const t = await rawTxn(e(), s, 'third_party_transfer', { ev: { counterparty_country: 'US' }, publish: false });
      await uniqueFails(ins(e(), 'transaction_entries', enRow(s, t.E, 'third_party_transfer', { direction: 'in', funding_account_id: s.BE, funding_currency: 'USD', funding_account_country: 'BE' })), 'transaction_entries.event_id');
      await checkFails(ins(e(), 'transaction_events', evRow(s, t.T, nid('E'), 'third_party_transfer', { counterparty_kind: 'self' })), 'transaction_events_transfer_shape_ck');
    });

    it('SHP-4: own transfer — one out and one in on two accounts; no exchange within one account; never three', async () => {
      const s = await seedUser(e());
      const t = await rawTxn(e(), s, 'own_transfer', { publish: false });
      await uniqueFails(ins(e(), 'transaction_entries', enRow(s, t.E, 'own_transfer', { direction: 'in', funding_currency: 'USD' })), 'transaction_entries.event_id, transaction_entries.funding_account_id');
      await uniqueFails(ins(e(), 'transaction_entries', enRow(s, t.E, 'own_transfer', { funding_account_id: s.BE, funding_currency: 'USD', funding_account_country: 'BE' })), 'transaction_entries.event_id, transaction_entries.direction');
      await ins(e(), 'transaction_entries', enRow(s, t.E, 'own_transfer', { direction: 'in', funding_account_id: s.BE, funding_currency: 'USD', funding_account_country: 'BE' }));
      // A third entry always repeats a direction; C2's upper bound is the next line of defence:
      // with the direction index dropped inside a batch, publishing three entries is LEDGER_ENTRY_COUNT
      // (and the batch rolls back, index included).
      const ix = String((await one(e(), "SELECT sql FROM sqlite_master WHERE name = 'transaction_entries_event_direction_uq'")).sql);
      const third = enRow(s, t.E, 'own_transfer', { funding_account_id: s.CN, funding_currency: 'CNY', funding_account_country: 'CN' });
      const cols = Object.keys(third);
      const lit = (v: unknown) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v)}'`);
      await raises(
        e().batchSql([
          'DROP INDEX transaction_entries_event_direction_uq',
          `INSERT INTO transaction_entries (${cols.join(', ')}) VALUES (${Object.values(third).map(lit).join(', ')})`,
          `UPDATE transactions SET current_revision = 1 WHERE id = '${t.T}'`,
        ]),
        'LEDGER_ENTRY_COUNT',
      );
      expect(String((await one(e(), "SELECT sql FROM sqlite_master WHERE name = 'transaction_entries_event_direction_uq'")).sql)).toBe(ix);
      expect(await count(e(), 'transaction_entries', 'event_id = ?', [t.E])).toBe(2);
      await publishRaw(e(), t.T, 1);
    });

    it('SHP-4 / SHP-5 / SHP-7 publish shapes: counterparty with two sides, one side without its country, no entries', async () => {
      const s = await seedUser(e());
      const two = [{}, { direction: 'in', funding_account_id: s.BE, funding_currency: 'USD', funding_account_country: 'BE' }];
      let t = await rawTxn(e(), s, 'own_transfer', { ev: { counterparty_institution: 'HSBC' }, entries: two, publish: false });
      await raises(publishRaw(e(), t.T, 1), 'LEDGER_OWN_TRANSFER_SHAPE');
      t = await rawTxn(e(), s, 'own_transfer', { ev: { counterparty_account_hint: '1234' }, entries: two, publish: false });
      await raises(publishRaw(e(), t.T, 1), 'LEDGER_OWN_TRANSFER_SHAPE');
      t = await rawTxn(e(), s, 'own_transfer', { ev: { counterparty_name: 'my old account', transfer_scope: 'foreign_to_unknown' }, publish: false });
      await raises(publishRaw(e(), t.T, 1), 'LEDGER_OWN_TRANSFER_SHAPE');
      t = await rawTxn(e(), s, 'own_transfer', { ev: { counterparty_country: 'US', transfer_scope: 'foreign_cross_border' }, publish: false });
      await publishRaw(e(), t.T, 1); // one side + its country
      for (const type of ['merchant_spend', 'merchant_refund', 'own_transfer', 'third_party_transfer'] as const) {
        t = await rawTxn(e(), s, type, { entries: [], publish: false });
        await raises(publishRaw(e(), t.T, 1), 'LEDGER_ENTRY_COUNT');
      }
    });

    it('SHP-6: type-specific fields are CHECKs', async () => {
      const s = await seedUser(e());
      const T = nid('T');
      await ins(e(), 'transactions', { id: T, user_id: s.u, txn_type: 'third_party_transfer', created_at: TS, updated_at: TS });
      await checkFails(ins(e(), 'transaction_events', evRow(s, T, nid('E'), 'third_party_transfer', { card_id: s.K })), 'transaction_events_transfer_shape_ck');
      await checkFails(ins(e(), 'transaction_events', evRow(s, T, nid('E'), 'third_party_transfer', { merchant_country: 'US' })), 'transaction_events_transfer_shape_ck');
      await checkFails(ins(e(), 'transaction_events', evRow(s, T, nid('E'), 'third_party_transfer', { transfer_scope: null })), 'transaction_events_transfer_shape_ck');
      const M = nid('T');
      await ins(e(), 'transactions', { id: M, user_id: s.u, txn_type: 'merchant_spend', created_at: TS, updated_at: TS });
      await checkFails(ins(e(), 'transaction_events', evRow(s, M, nid('E'), 'merchant_spend', { transfer_method: 'swift' })), 'transaction_events_merchant_shape_ck');
      await checkFails(ins(e(), 'transaction_events', evRow(s, M, nid('E'), 'merchant_spend', { counterparty_country: 'US' })), 'transaction_events_merchant_shape_ck');
      await checkFails(ins(e(), 'transaction_events', evRow(s, M, nid('E'), 'merchant_spend', { event_amount: null })), 'transaction_events_amount_required_ck');
      await checkFails(ins(e(), 'transaction_events', evRow(s, M, nid('E'), 'merchant_spend', { merchant_scope: 'domestic' })), 'transaction_events_merchant_scope_rule_ck');
    });

    it('SHP-8: an own transfer across currencies (HKD out, USD in) keeps both amounts, no rate', async () => {
      const s = await seedUser(e());
      const t = await rawTxn(e(), s, 'own_transfer', { entries: [{ amount: 783000 }, { direction: 'in', funding_account_id: s.BE, funding_currency: 'USD', funding_account_country: 'BE', amount: 99_850 }] });
      expect(await e().all('SELECT direction, funding_currency, amount FROM transaction_entries WHERE event_id = ? ORDER BY direction DESC', [t.E])).toEqual([
        { direction: 'out', funding_currency: 'HKD', amount: 783000 },
        { direction: 'in', funding_currency: 'USD', amount: 99_850 },
      ]);
    });
  });

  describe('REG-2 / REG-4 the SQL classifier (C6) agrees with classify() on every combination; C7 refuses confirmed domestic', () => {
    type Attempt = { label: string; input: ClassificationInput; build: (s: Seed, cls: { merchant_scope: string | null; transfer_scope: string | null; foreign_status: string }) => Promise<{ T: string }> };

    function merchantAttempt(type: 'merchant_spend' | 'merchant_refund', account: string, merchant: string | null): Attempt {
      return {
        label: `${type} account ${account} merchant ${merchant}`,
        input: { txnType: type, homeRegion: 'CN', merchantCountry: merchant, counterpartyCountry: null, entries: [{ direction: type === 'merchant_spend' ? 'out' : 'in', fundingAccountCountry: account }] },
        build: (s, cls) => {
          const a = acct(s, account);
          return rawTxn(e(), s, type, { ev: { merchant_country: merchant, ...cls }, entries: [{ funding_account_id: a.id, funding_currency: a.cur, funding_account_country: account }], publish: false });
        },
      };
    }
    function thirdPartyAttempt(f: string | null, t: string | null): Attempt {
      const input: ClassificationInput =
        f !== null
          ? { txnType: 'third_party_transfer', homeRegion: 'CN', merchantCountry: null, counterpartyCountry: t, entries: [{ direction: 'out', fundingAccountCountry: f }] }
          : { txnType: 'third_party_transfer', homeRegion: 'CN', merchantCountry: null, counterpartyCountry: null, entries: [{ direction: 'in', fundingAccountCountry: t! }] };
      return {
        label: `third party ${f} → ${t}`,
        input,
        build: (s, cls) => {
          const side = f ?? t!;
          const a = acct(s, side);
          return rawTxn(e(), s, 'third_party_transfer', {
            ev: { counterparty_country: f !== null ? t : null, ...cls },
            entries: [{ direction: f !== null ? 'out' : 'in', funding_account_id: a.id, funding_currency: a.cur, funding_account_country: side }],
            publish: false,
          });
        },
      };
    }
    function ownAttempt(f: string, t: string): Attempt {
      return {
        label: `own ${f} → ${t}`,
        input: { txnType: 'own_transfer', homeRegion: 'CN', merchantCountry: null, counterpartyCountry: null, entries: [{ direction: 'out', fundingAccountCountry: f }, { direction: 'in', fundingAccountCountry: t }] },
        build: (s, cls) => {
          const a = acct(s, f);
          const b = acct(s, t);
          return rawTxn(e(), s, 'own_transfer', {
            ev: cls,
            entries: [
              { funding_account_id: a.id, funding_currency: a.cur, funding_account_country: f },
              { direction: 'in', funding_account_id: b.id, funding_currency: b.cur, funding_account_country: t },
            ],
            publish: false,
          });
        },
      };
    }
    const SIDES = ['CN', 'HK', 'BE', null] as const;
    const attempts: Attempt[] = [
      ...(['merchant_spend', 'merchant_refund'] as const).flatMap((type) => ['CN', 'HK'].flatMap((a) => (['CN', 'US', null] as const).map((m) => merchantAttempt(type, a, m)))),
      ...SIDES.flatMap((f) => SIDES.filter((t) => f !== null || t !== null).map((t) => thirdPartyAttempt(f, t))),
      ...[['CN', 'HK'], ['HK', 'CN'], ['HK', 'BE'], ['BE', 'HK'], ['CN', 'BE'], ['BE', 'CN']].map(([f, t]) => ownAttempt(f!, t!)),
    ];

    it(`publishes the TS classification and refuses every other value (${attempts.length} combinations)`, async () => {
      const s = await seedUser(e());
      const seen = new Set<string>();
      for (const a of attempts) {
        const c = classify(a.input);
        const cls = { merchant_scope: c.merchantScope, transfer_scope: c.transferScope, foreign_status: c.foreignStatus };
        const good = await a.build(s, cls);
        if (c.foreignStatus === 'domestic') await raises(publishRaw(e(), good.T, 1), 'LEDGER_CONFIRMED_DOMESTIC'); // C6 agreed, C7 refuses (REG-4)
        else await publishRaw(e(), good.T, 1);
        seen.add(c.transferScope ?? `merchant:${c.foreignStatus}`);
        for (const fs of ['foreign', 'domestic', 'undetermined'].filter((x) => x !== c.foreignStatus)) {
          const bad = await a.build(s, { ...cls, foreign_status: fs });
          await raises(publishRaw(e(), bad.T, 1), 'LEDGER_CLASSIFICATION');
        }
        if (c.transferScope !== null) {
          for (const ts of TRANSFER_SCOPES.filter((x) => x !== c.transferScope)) {
            const bad = await a.build(s, { ...cls, transfer_scope: ts });
            await raises(publishRaw(e(), bad.T, 1), 'LEDGER_CLASSIFICATION');
          }
        }
      }
      for (const ts of TRANSFER_SCOPES) expect(seen, ts).toContain(ts);
    }, 120_000);

    it('REG-3: unknown is not domestic — a CN account with an unknown merchant, or CN → unknown, is undetermined and published', async () => {
      const s = await seedUser(e());
      const t1 = await rawTxn(e(), s, 'merchant_spend', { ev: { merchant_country: null, merchant_scope: 'unknown', foreign_status: 'undetermined' }, entries: [{ funding_account_id: s.CN, funding_currency: 'CNY', funding_account_country: 'CN' }] });
      const t2 = await rawTxn(e(), s, 'third_party_transfer', { ev: { counterparty_country: null, transfer_scope: 'domestic_to_unknown', foreign_status: 'undetermined' }, entries: [{ funding_account_id: s.CN, funding_currency: 'CNY', funding_account_country: 'CN' }] });
      for (const t of [t1, t2]) expect((await one(e(), 'SELECT current_revision FROM transactions WHERE id = ?', [t.T])).current_revision).toBe(1);
    });

    it('REG-4: a confirmed purely domestic own transfer (CN account, unregistered CN side) is refused', async () => {
      const s = await seedUser(e());
      const t = await rawTxn(e(), s, 'own_transfer', {
        ev: { counterparty_country: 'CN', transfer_scope: 'domestic_local', foreign_status: 'domestic' },
        entries: [{ funding_account_id: s.CN, funding_currency: 'CNY', funding_account_country: 'CN' }],
        publish: false,
      });
      await raises(publishRaw(e(), t.T, 1), 'LEDGER_CONFIRMED_DOMESTIC');
      expect((await one(e(), 'SELECT current_revision FROM transactions WHERE id = ?', [t.T])).current_revision).toBe(0);
    });
  });

  describe('IMM immutable versions and the header guards', () => {
    it('IMM-1: every column of an event and of an entry is immutable (even re-setting the same value)', async () => {
      const s = await seedUser(e());
      const t = await rawTxn(e(), s, 'merchant_spend');
      for (const col of (await e().all('PRAGMA table_info(transaction_events)')).map((r) => String(r.name))) await raises(e().run(`UPDATE transaction_events SET ${col} = ${col} WHERE id = ?`, [t.E]), 'LEDGER_IMMUTABLE');
      for (const col of (await e().all('PRAGMA table_info(transaction_entries)')).map((r) => String(r.name))) await raises(e().run(`UPDATE transaction_entries SET ${col} = ${col} WHERE id = ?`, [t.N[0]]), 'LEDGER_IMMUTABLE');
    });

    it('IMM-2: identity columns → HEADER_IMMUTABLE; skipping / going back → REVISION_ORDER; after void only notes; rows unchanged', async () => {
      const s = await seedUser(e());
      const { T } = await rawTxn(e(), s, 'merchant_spend');
      const row = () => one(e(), 'SELECT * FROM transactions WHERE id = ?', [T]);
      const upd = (set: string, args: unknown[] = []) => e().run(`UPDATE transactions SET ${set} WHERE id = ?`, [...args, T]);
      const before = await row();
      for (const set of ["txn_type = 'merchant_refund'", 'created_at = created_at + 1', `user_id = '${(await seedUser(e())).u}'`, "id = 'other-id'"]) await raises(upd(set), 'LEDGER_HEADER_IMMUTABLE');
      for (const set of ['current_revision = 3', 'current_revision = 0', "status = 'voided'", "voided_at = 1, voided_op_id = 'o'", "void_reason = 'r'", "status = 'voided', voided_at = 1, voided_op_id = 'o', current_revision = 2"]) {
        await raises(upd(set), 'LEDGER_REVISION_ORDER');
      }
      expect(await row()).toEqual(before);
      await upd("status = 'voided', voided_at = ?, voided_op_id = 'op1', updated_at = ?", [TS + 9, TS + 9]);
      const voided = await row();
      for (const set of ["status = 'active', voided_at = NULL, voided_op_id = NULL", 'current_revision = 2', 'voided_at = voided_at + 1', "voided_op_id = 'op2'", "void_reason = 'late reason'"]) await raises(upd(set), 'LEDGER_VOIDED');
      await raises(upd("txn_type = 'merchant_refund', status = 'active'"), 'LEDGER_HEADER_IMMUTABLE');
      expect(await row()).toEqual(voided);
      await upd("notes = 'after void', updated_at = updated_at + 1");
      expect((await row()).notes).toBe('after void');
    });

    it('IMM-3: versions only as current_revision + 1 of an active transaction of the same user', async () => {
      const s = await seedUser(e());
      const { T } = await rawTxn(e(), s, 'merchant_spend');
      const v = (x: Row) => evRow(s, T, nid('E'), 'merchant_spend', { revision_kind: 'fact_correction', correction_reason: 'r', home_region_source: 'carried', ...x });
      await raises(ins(e(), 'transaction_events', v({ revision: 3 })), 'LEDGER_REVISION_ORDER');
      // Revision 1 again (current is 1): the trigger refuses before the unique index would.
      await raises(ins(e(), 'transaction_events', v({ revision: 1, revision_kind: 'original', correction_reason: null, home_region_source: 'preference_at_save' })), 'LEDGER_REVISION_ORDER');
      await raises(ins(e(), 'transaction_events', { ...v({ revision: 2 }), user_id: (await seedUser(e())).u }), 'LEDGER_REVISION_ORDER');
      await ins(e(), 'transaction_events', v({ revision: 2 }));
      // A second unpublished candidate for the same revision passes the trigger and meets the unique index.
      await uniqueFails(ins(e(), 'transaction_events', v({ revision: 2 })), 'transaction_events.transaction_id, transaction_events.revision');
      await e().run("UPDATE transactions SET status = 'voided', voided_at = 1, voided_op_id = 'o' WHERE id = ?", [T]);
      await raises(ins(e(), 'transaction_events', v({ revision: 2 })), 'LEDGER_REVISION_ORDER');
    });

    it('IMM-4: entries only go into the unpublished next version', async () => {
      const s = await seedUser(e());
      const c = await create(e(), createIn(s));
      await raises(ins(e(), 'transaction_entries', enRow(s, c.E, 'merchant_spend', { direction: 'in', funding_account_id: s.BE })), 'LEDGER_IMMUTABLE');
      await correct(e(), correctIn(s, c, {}));
      // revision 1 is now superseded (≤ current): still closed.
      await raises(ins(e(), 'transaction_entries', enRow(s, c.E, 'merchant_spend', { direction: 'in', funding_account_id: s.BE })), 'LEDGER_IMMUTABLE');
      // The versions of a voided transaction are closed as well, and so is a missing event.
      const t = await rawTxn(e(), s, 'own_transfer', { ev: { counterparty_country: 'US' } });
      await e().run("UPDATE transactions SET status = 'voided', voided_at = 1, voided_op_id = 'o' WHERE id = ?", [t.T]);
      await raises(ins(e(), 'transaction_entries', enRow(s, t.E, 'own_transfer', { direction: 'in', funding_account_id: s.BE, funding_currency: 'USD', funding_account_country: 'BE' })), 'LEDGER_IMMUTABLE');
      await raises(ins(e(), 'transaction_entries', enRow(s, 'no-such-event', 'merchant_spend')), 'LEDGER_IMMUTABLE');
    });

    it('IMM-5: every snapshot must match its source', async () => {
      const s = await seedUser(e(), 'HK');
      const c = await create(e(), createIn(s, { classification: FOREIGN_SPEND }));
      const N1 = c.entries[0]!.id;
      // v2 (fact correction) as raw rows on top of the chain-created v1.
      const v2 = async (x: Row = {}) => {
        const E2 = nid('E');
        await ins(e(), 'transaction_events', evRow(s, c.T, E2, 'merchant_spend', { revision: 2, revision_kind: 'fact_correction', correction_reason: 'r', home_region: 'HK', home_region_source: 'carried', merchant_country: 'US', ...x }));
        return E2;
      };
      // Events.
      const T2 = nid('T');
      await ins(e(), 'transactions', { id: T2, user_id: s.u, txn_type: 'merchant_spend', created_at: TS, updated_at: TS });
      await raises(ins(e(), 'transaction_events', evRow(s, T2, nid('E'), 'merchant_spend', { home_region: 'CN' })), 'LEDGER_SNAPSHOT_SOURCE'); // preference is HK
      await raises(ins(e(), 'transaction_events', evRow(s, c.T, nid('E'), 'merchant_spend', { revision: 2, revision_kind: 'fact_correction', correction_reason: 'r', home_region: 'CN', home_region_source: 'carried' })), 'LEDGER_SNAPSHOT_SOURCE');
      await checkFails(ins(e(), 'transaction_events', evRow(s, c.T, nid('E'), 'merchant_spend', { revision: 2, revision_kind: 'fact_correction', correction_reason: 'r', home_region: 'HK', home_region_source: 'user_declared' })), 'transaction_events_home_region_source_rule_ck');
      await checkFails(ins(e(), 'transaction_events', evRow(s, c.T, nid('E'), 'merchant_spend', { revision: 2, revision_kind: 'fact_correction', correction_reason: 'r', home_region: 'GB', home_region_source: 'user_corrected', merchant_scope: 'foreign' })), 'transaction_events_home_region_source_rule_ck');
      await checkFails(ins(e(), 'transaction_events', evRow(s, T2, nid('E'), 'merchant_spend', { home_region: 'GB', home_region_source: 'user_declared' })), 'transaction_events_home_region_source_rule_ck'); // current mode
      await checkFails(ins(e(), 'transaction_events', evRow(s, c.T, nid('E'), 'merchant_spend', { revision: 2, revision_kind: 'fact_correction', correction_reason: 'r', home_region: 'HK', home_region_source: 'preference_at_save' })), 'transaction_events_home_region_source_rule_ck');
      const E2 = await v2();
      const en = (x: Row) => enRow(s, E2, 'merchant_spend', { carried_from_entry_id: N1, country_source: 'carried', ...x });
      // Entries: account_at_save mismatch (new account), carried mismatch, forged currency status.
      await raises(ins(e(), 'transaction_entries', en({ funding_account_id: s.BE, funding_currency: 'USD', funding_account_country: 'US', carried_from_entry_id: null, country_source: 'account_at_save' })), 'LEDGER_SNAPSHOT_SOURCE');
      await raises(ins(e(), 'transaction_entries', en({ funding_account_country: 'US' })), 'LEDGER_SNAPSHOT_SOURCE');
      await raises(ins(e(), 'transaction_entries', en({ currency_status_at_save: 'closed', closed_currency_ack: 0 })), 'LEDGER_SNAPSHOT_SOURCE');
      // carried_from: another transaction, the wrong version, another account.
      const other = await create(e(), createIn(s));
      await raises(ins(e(), 'transaction_entries', en({ carried_from_entry_id: other.entries[0]!.id })), 'LEDGER_SNAPSHOT_SOURCE');
      await raises(ins(e(), 'transaction_entries', en({ funding_account_id: s.BE, funding_currency: 'USD', funding_account_country: 'BE', country_source: 'carried' })), 'LEDGER_SNAPSHOT_SOURCE');
      // Same account in the previous version but not carried (fresh account_at_save), with or without a direction change.
      await raises(ins(e(), 'transaction_entries', en({ carried_from_entry_id: null, country_source: 'account_at_save' })), 'LEDGER_SNAPSHOT_SOURCE');
      // user_corrected outside a snapshot correction.
      await raises(ins(e(), 'transaction_entries', en({ country_source: 'user_corrected', funding_account_country: 'SG' })), 'LEDGER_SNAPSHOT_SOURCE');
      // CHECK: a carried row labelled account_at_save passes every trigger and meets the CHECK.
      await checkFails(ins(e(), 'transaction_entries', en({ country_source: 'account_at_save' })), 'transaction_entries_carried_ck');
      // Not-carried rows labelled carried / user_corrected: en_snapshot_source refuses first; with the
      // trigger dropped inside a batch (rolled back, trigger included) the CHECK refuses on its own.
      for (const x of [{ carried_from_entry_id: null, country_source: 'carried' }, { carried_from_entry_id: null, country_source: 'user_corrected' }]) {
        await raises(ins(e(), 'transaction_entries', en(x)), 'LEDGER_SNAPSHOT_SOURCE');
        await checkFails(e().batchSql(['DROP TRIGGER en_snapshot_source', insertLiteral('transaction_entries', en(x))]), 'transaction_entries_carried_ck');
      }
      expect(await count(e(), 'sqlite_master', "type = 'trigger' AND name = 'en_snapshot_source'")).toBe(1);
      // The legal one: carried from v1's entry of the same account.
      await ins(e(), 'transaction_entries', en({}));
      await publishRaw(e(), c.T, 2);
      // Legal combinations of a snapshot correction (v3): carried, or user_corrected with the carried entry; a new account in a fact correction (v4) as account_at_save.
      const prevEntry = String((await one(e(), 'SELECT id FROM transaction_entries WHERE event_id = ?', [E2])).id);
      const E3 = nid('E');
      await ins(e(), 'transaction_events', evRow(s, c.T, E3, 'merchant_spend', { revision: 3, revision_kind: 'snapshot_correction', correction_reason: 'r', home_region: 'HK', home_region_source: 'carried', foreign_status: 'foreign' }));
      await ins(e(), 'transaction_entries', enRow(s, E3, 'merchant_spend', { carried_from_entry_id: prevEntry, country_source: 'user_corrected', funding_account_country: 'SG' }));
      await publishRaw(e(), c.T, 3);
      const E4 = nid('E');
      await ins(e(), 'transaction_events', evRow(s, c.T, E4, 'merchant_spend', { revision: 4, revision_kind: 'fact_correction', correction_reason: 'r', home_region: 'HK', home_region_source: 'carried' }));
      await ins(e(), 'transaction_entries', enRow(s, E4, 'merchant_spend', { funding_account_id: s.BE, funding_currency: 'USD', funding_account_country: 'BE' }));
      await publishRaw(e(), c.T, 4);
    });

    it('IMM-5 (direction change): the same account keeps its snapshot even when its direction flips', async () => {
      const s = await seedUser(e());
      const c = await create(e(), createIn(s, {
        txnType: 'third_party_transfer', facts: spendFacts({ merchantName: null, merchantCountry: null, transferMethod: 'fps', counterpartyKind: 'third_party', counterpartyCountry: 'US' }),
        classification: { merchantScope: null, transferScope: 'foreign_cross_border', foreignStatus: 'foreign' },
        entries: [{ id: nid('N'), direction: 'out', accountId: s.BE, currency: 'USD', amount: 1000, amountStatus: 'confirmed', exponent: 2, closedCurrencyAck: false }],
      }));
      const flip = (carry: boolean) => correctIn(s, c, { entries: [{ ...c.entries[0]!, id: nid('N'), direction: 'in', carriedFromEntryId: carry ? c.entries[0]!.id : null }] });
      await raises(correct(e(), flip(false)), 'LEDGER_SNAPSHOT_SOURCE');
      await correct(e(), flip(true));
      expect(await one(e(), "SELECT direction, country_source FROM transaction_entries WHERE event_id = (SELECT id FROM transaction_events WHERE transaction_id = ? AND revision = 2)", [c.T])).toEqual({ direction: 'in', country_source: 'carried' });
    });

    it('IMM-6: settlement and snapshot corrections cannot change facts; no version changes the classifier', async () => {
      const s = await seedUser(e());
      const c = await create(e(), createIn(s, { facts: spendFacts({ cardId: s.K, paymentChannelId: null, postedOn: '2026-10-21' }) }));
      const base = { revision: 2, home_region: 'CN', home_region_source: 'carried', merchant_name: 'Example Store', occurred_time: '14:05', posted_on: '2026-10-21', card_id: s.K };
      const kinds: [string, string | null][] = [['settlement', null], ['snapshot_correction', 'r']];
      const changes: Row[] = [
        { record_mode: 'backfill' }, { occurred_on: '2026-10-19' }, { occurred_time: '14:06' }, { posted_on: '2026-10-22' }, { event_currency: 'EUR' }, { event_amount: 1001 },
        { event_currency_exponent: 3 }, { merchant_name: 'Other' }, { merchant_country: 'GB' }, { card_id: null }, { payment_channel_id: s.PP },
      ];
      for (const [kind, reason] of kinds) {
        for (const x of changes) await raises(ins(e(), 'transaction_events', evRow(s, c.T, nid('E'), 'merchant_spend', { ...base, revision_kind: kind, correction_reason: reason, ...x })), 'LEDGER_REVISION_KIND');
      }
      // No version changes the classifier (v1 has no upgrade operation).
      await raises(ins(e(), 'transaction_events', evRow(s, c.T, nid('E'), 'merchant_spend', { ...base, revision_kind: 'fact_correction', correction_reason: 'r', classifier_version: 2 })), 'LEDGER_REVISION_KIND');
      // A settlement's home_region is checked twice: ev_snapshot_source (carried) refuses first; the
      // same row with ev_snapshot_source dropped inside a rolled-back batch meets ev_kind_guard.
      const settledHome = evRow(s, c.T, nid('E'), 'merchant_spend', { ...base, revision_kind: 'settlement', home_region: 'GB' });
      await raises(ins(e(), 'transaction_events', settledHome), 'LEDGER_SNAPSHOT_SOURCE');
      await raises(e().batchSql(['DROP TRIGGER ev_snapshot_source', insertLiteral('transaction_events', settledHome)]), 'LEDGER_REVISION_KIND');
      expect(await count(e(), 'sqlite_master', "type = 'trigger' AND name = 'ev_snapshot_source'")).toBe(1);
      // A snapshot correction may change home_region (user_corrected).
      await ins(e(), 'transaction_events', evRow(s, c.T, nid('E'), 'merchant_spend', { ...base, revision_kind: 'snapshot_correction', correction_reason: 'r', home_region: 'GB', home_region_source: 'user_corrected' }));
      // Transfer facts.
      const t = await create(e(), createIn(s, {
        txnType: 'third_party_transfer', facts: spendFacts({ merchantName: null, merchantCountry: null, transferMethod: 'swift', counterpartyKind: 'third_party', counterpartyCountry: 'US', counterpartyName: 'Alice', counterpartyInstitution: 'Bank', counterpartyAccountHint: '12' }),
        classification: { merchantScope: null, transferScope: 'foreign_cross_border', foreignStatus: 'foreign' },
      }));
      const tb = { revision: 2, revision_kind: 'settlement', home_region_source: 'carried', counterparty_country: 'US', counterparty_name: 'Alice', counterparty_institution: 'Bank', counterparty_account_hint: '12', occurred_time: '14:05' };
      for (const x of [{ transfer_method: 'sepa' }, { counterparty_name: 'Bob' }, { counterparty_country: 'GB' }, { counterparty_institution: 'Other' }, { counterparty_account_hint: '34' }]) {
        await raises(ins(e(), 'transaction_events', evRow(s, t.T, nid('E'), 'third_party_transfer', { ...tb, ...x })), 'LEDGER_REVISION_KIND');
      }
      await ins(e(), 'transaction_events', evRow(s, t.T, nid('E'), 'third_party_transfer', tb));
    });

    it('IMM-6 (entries): settlement only completes pending amounts; snapshot correction only changes the jurisdiction; both carry every entry', async () => {
      const s = await seedUser(e());
      const pend = await create(e(), createIn(s, { entries: [{ id: nid('N'), direction: 'out', accountId: s.HK, currency: 'HKD', amount: null, amountStatus: 'pending', exponent: 2, closedCurrencyAck: false }] }));
      const N1 = pend.entries[0]!.id;
      const E2 = nid('E');
      await ins(e(), 'transaction_events', evRow(s, pend.T, E2, 'merchant_spend', { revision: 2, revision_kind: 'settlement', home_region_source: 'carried', merchant_name: 'Example Store', occurred_time: '14:05', card_id: s.K }));
      const st = (x: Row) => enRow(s, E2, 'merchant_spend', { carried_from_entry_id: N1, country_source: 'carried', ...x });
      for (const x of [{ funding_currency: 'USD' }, { currency_exponent: 3 }]) await raises(ins(e(), 'transaction_entries', st(x)), 'LEDGER_REVISION_KIND');
      // Not carried, on an account absent from v1: en_snapshot_source passes, en_kind_guard refuses.
      await raises(ins(e(), 'transaction_entries', enRow(s, E2, 'merchant_spend', { funding_account_id: s.BE, funding_currency: 'USD', funding_account_country: 'BE' })), 'LEDGER_REVISION_KIND');
      await ins(e(), 'transaction_entries', st({ amount: 7830 })); // pending → confirmed
      await publishRaw(e(), pend.T, 2);
      // In a later settlement a confirmed amount cannot change, nor go back to pending.
      const N2 = String((await one(e(), 'SELECT id FROM transaction_entries WHERE event_id = ?', [E2])).id);
      const E3 = nid('E');
      await ins(e(), 'transaction_events', evRow(s, pend.T, E3, 'merchant_spend', { revision: 3, revision_kind: 'settlement', home_region_source: 'carried', merchant_name: 'Example Store', occurred_time: '14:05', card_id: s.K }));
      await raises(ins(e(), 'transaction_entries', enRow(s, E3, 'merchant_spend', { carried_from_entry_id: N2, country_source: 'carried', amount: 7831 })), 'LEDGER_REVISION_KIND');
      await raises(ins(e(), 'transaction_entries', enRow(s, E3, 'merchant_spend', { carried_from_entry_id: N2, country_source: 'carried', amount: null, amount_status: 'pending' })), 'LEDGER_REVISION_KIND');

      // Snapshot correction (another transaction): only the jurisdiction may change.
      const conf = await create(e(), createIn(s));
      const S2 = nid('E');
      await ins(e(), 'transaction_events', evRow(s, conf.T, S2, 'merchant_spend', { revision: 2, revision_kind: 'snapshot_correction', correction_reason: 'r', home_region_source: 'carried', merchant_name: 'Example Store', occurred_time: '14:05', card_id: s.K }));
      const sc = (x: Row) => enRow(s, S2, 'merchant_spend', { carried_from_entry_id: conf.entries[0]!.id, country_source: 'user_corrected', funding_account_country: 'SG', ...x });
      await raises(ins(e(), 'transaction_entries', sc({ amount: 7831 })), 'LEDGER_REVISION_KIND');
      await raises(ins(e(), 'transaction_entries', sc({ amount: null, amount_status: 'pending' })), 'LEDGER_REVISION_KIND');
      await raises(ins(e(), 'transaction_entries', sc({ funding_currency: 'USD' })), 'LEDGER_REVISION_KIND');
      await ins(e(), 'transaction_entries', sc({}));
      await publishRaw(e(), conf.T, 2);
      expect(await one(e(), 'SELECT foreign_status FROM transaction_events WHERE id = ?', [S2])).toEqual({ foreign_status: 'foreign' });
    });

    it('IMM-10: header INSERT guard — the trigger refuses before any CHECK; nothing is written', async () => {
      const s = await seedUser(e());
      const h = (x: Row) => ({ id: nid('T'), user_id: s.u, txn_type: 'merchant_spend', created_at: TS, updated_at: TS, ...x });
      for (const x of [{ current_revision: 1 }, { status: 'voided', current_revision: 1, voided_at: TS, voided_op_id: 'o' }, { voided_at: TS }, { voided_op_id: 'o' }, { void_reason: 'r' }, { current_revision: 2, status: 'voided' }]) {
        await raises(ins(e(), 'transactions', h(x)), 'LEDGER_HEADER_INSERT');
      }
      expect(await count(e(), 'transactions', 'user_id = ?', [s.u])).toBe(0);
      // A CHECK still refuses what the trigger lets through (an unknown type).
      await checkFails(ins(e(), 'transactions', h({ txn_type: 'credit_card' })), 'transactions_type_ck');
      await ins(e(), 'transactions', h({ current_revision: 0 }));
      expect(await count(e(), 'transactions', 'user_id = ?', [s.u])).toBe(1);
    });

    it('IMM-11: publish checks run only for a legal r → r+1; any other UPDATE meets tx_update_guard only', async () => {
      const s = await seedUser(e());
      const domestic = { merchant_country: 'CN', merchant_scope: 'domestic', foreign_status: 'domestic' };
      const cn = { funding_account_id: s.CN, funding_currency: 'CNY', funding_account_country: 'CN' };
      // ① A published version that breaks C2 and C7, made with the publish triggers dropped and restored verbatim.
      // tx_update_guard is re-created too, so the firing order stays as the migration made it.
      const group = [...PUBLISH_TRIGGERS, 'tx_update_guard'];
      const listGroup = () => e().all(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${group.map(() => '?').join(', ')}) ORDER BY rowid`, group);
      const saved = await listGroup();
      expect(saved.map((r) => r.name)).toEqual(['tx_publish_domestic', 'tx_publish_classification', 'tx_publish_event_amount', 'tx_publish_own_shape', 'tx_publish_entry_count', 'tx_update_guard']);
      const bad = await rawTxn(e(), s, 'merchant_spend', { ev: domestic, entries: [], publish: false });
      for (const n of PUBLISH_TRIGGERS) await e().run(`DROP TRIGGER ${n}`);
      try {
        await publishRaw(e(), bad.T, 1);
      } finally {
        await e().run('DROP TRIGGER IF EXISTS tx_update_guard');
        for (const r of saved) await e().run(String(r.sql));
      }
      expect(await listGroup()).toEqual(saved);
      await e().run("UPDATE transactions SET notes = 'n', updated_at = updated_at + 1 WHERE id = ?", [bad.T]);
      await e().run("UPDATE transactions SET notes = 'm', current_revision = current_revision WHERE id = ?", [bad.T]);
      // ② same revision, identity or state columns.
      await raises(e().run("UPDATE transactions SET txn_type = 'merchant_refund' WHERE id = ?", [bad.T]), 'LEDGER_HEADER_IMMUTABLE');
      await raises(e().run("UPDATE transactions SET status = 'voided' WHERE id = ?", [bad.T]), 'LEDGER_REVISION_ORDER');
      // ③ r → r+2, r → r−1, r → r with another protected column.
      await raises(e().run('UPDATE transactions SET current_revision = 3 WHERE id = ?', [bad.T]), 'LEDGER_REVISION_ORDER');
      await raises(e().run('UPDATE transactions SET current_revision = 0 WHERE id = ?', [bad.T]), 'LEDGER_REVISION_ORDER');
      await raises(e().run("UPDATE transactions SET current_revision = current_revision, voided_op_id = 'x' WHERE id = ?", [bad.T]), 'LEDGER_REVISION_ORDER');
      // ⑤ publish and void at once.
      const t = await rawTxn(e(), s, 'merchant_spend', { publish: false });
      await raises(e().run("UPDATE transactions SET current_revision = 1, status = 'voided', voided_at = 1, voided_op_id = 'o' WHERE id = ?", [t.T]), 'LEDGER_REVISION_ORDER');
      // ④ voided: no publish, no return to active.
      await publishRaw(e(), t.T, 1);
      await e().run("UPDATE transactions SET status = 'voided', voided_at = 1, voided_op_id = 'o' WHERE id = ?", [t.T]);
      await raises(e().run('UPDATE transactions SET current_revision = 2 WHERE id = ?', [t.T]), 'LEDGER_VOIDED');
      await raises(e().run("UPDATE transactions SET status = 'active', voided_at = NULL, voided_op_id = NULL WHERE id = ?", [t.T]), 'LEDGER_VOIDED');
      // ⑥ a legal r → r+1 runs C2–C7, each on its own violation.
      const cases: [Row, Row[] | undefined, TxnType, string][] = [
        [{}, [], 'merchant_spend', 'LEDGER_ENTRY_COUNT'],
        [{ counterparty_name: 'x' }, [{}, { direction: 'in', funding_account_id: s.BE, funding_currency: 'USD', funding_account_country: 'BE' }], 'own_transfer', 'LEDGER_OWN_TRANSFER_SHAPE'],
        [{ event_amount: null, counterparty_country: 'US' }, undefined, 'third_party_transfer', 'LEDGER_EVENT_AMOUNT'],
        [{ foreign_status: 'undetermined' }, undefined, 'merchant_spend', 'LEDGER_CLASSIFICATION'],
        [domestic, [cn], 'merchant_spend', 'LEDGER_CONFIRMED_DOMESTIC'],
      ];
      for (const [ev, entries, type, code] of cases) {
        const x = await rawTxn(e(), s, type, { ev, entries, publish: false });
        const before = await one(e(), 'SELECT * FROM transactions WHERE id = ?', [x.T]);
        await raises(publishRaw(e(), x.T, 1), code);
        expect(await one(e(), 'SELECT * FROM transactions WHERE id = ?', [x.T])).toEqual(before);
      }
    });
  });

  describe('the 21 triggers, one raw SQL violation each (DB-M3-3)', () => {
    // Each case violates exactly the named trigger (other rules hold), so the code shows that trigger fired.
    const CASES: Record<string, (s: Seed) => Promise<void>> = {
      tx_insert_guard: (s) => raises(ins(e(), 'transactions', { id: nid('T'), user_id: s.u, txn_type: 'merchant_spend', current_revision: 1, created_at: TS, updated_at: TS }), 'LEDGER_HEADER_INSERT'),
      tx_update_guard: async (s) => raises(e().run('UPDATE transactions SET current_revision = 5 WHERE id = ?', [(await rawTxn(e(), s, 'merchant_spend')).T]), 'LEDGER_REVISION_ORDER'),
      tx_publish_entry_count: async (s) => raises(publishRaw(e(), (await rawTxn(e(), s, 'merchant_spend', { entries: [], publish: false })).T, 1), 'LEDGER_ENTRY_COUNT'),
      tx_publish_own_shape: async (s) => raises(publishRaw(e(), (await rawTxn(e(), s, 'own_transfer', { ev: { transfer_scope: 'foreign_to_unknown' }, publish: false })).T, 1), 'LEDGER_OWN_TRANSFER_SHAPE'),
      tx_publish_event_amount: async (s) => raises(publishRaw(e(), (await rawTxn(e(), s, 'third_party_transfer', { ev: { event_amount: null, counterparty_country: 'US' }, publish: false })).T, 1), 'LEDGER_EVENT_AMOUNT'),
      tx_publish_classification: async (s) => raises(publishRaw(e(), (await rawTxn(e(), s, 'merchant_spend', { ev: { foreign_status: 'undetermined' }, publish: false })).T, 1), 'LEDGER_CLASSIFICATION'),
      tx_publish_domestic: async (s) =>
        raises(publishRaw(e(), (await rawTxn(e(), s, 'merchant_spend', { ev: { merchant_country: 'CN', merchant_scope: 'domestic', foreign_status: 'domestic' }, entries: [{ funding_account_id: s.CN, funding_currency: 'CNY', funding_account_country: 'CN' }], publish: false })).T, 1), 'LEDGER_CONFIRMED_DOMESTIC'),
      tx_no_delete: async (s) => raises(e().run('DELETE FROM transactions WHERE id = ?', [(await rawTxn(e(), s, 'merchant_spend', { entries: [], publish: false })).T]), 'LEDGER_NO_DELETE'),
      ev_immutable: async (s) => raises(e().run("UPDATE transaction_events SET correction_reason = 'x' WHERE id = ?", [(await rawTxn(e(), s, 'merchant_spend')).E]), 'LEDGER_IMMUTABLE'),
      ev_insert_order: async (s) => {
        const { T } = await rawTxn(e(), s, 'merchant_spend');
        await raises(ins(e(), 'transaction_events', evRow(s, T, nid('E'), 'merchant_spend', { revision: 3, revision_kind: 'fact_correction', correction_reason: 'r', home_region_source: 'carried' })), 'LEDGER_REVISION_ORDER');
      },
      ev_snapshot_source: async (s) => {
        const T = nid('T');
        await ins(e(), 'transactions', { id: T, user_id: s.u, txn_type: 'merchant_spend', created_at: TS, updated_at: TS });
        await raises(ins(e(), 'transaction_events', evRow(s, T, nid('E'), 'merchant_spend', { home_region: 'HK', merchant_scope: 'foreign' })), 'LEDGER_SNAPSHOT_SOURCE');
      },
      ev_kind_guard: async (s) => {
        const { T } = await rawTxn(e(), s, 'merchant_spend');
        await raises(ins(e(), 'transaction_events', evRow(s, T, nid('E'), 'merchant_spend', { revision: 2, revision_kind: 'settlement', home_region_source: 'carried', event_amount: 999 })), 'LEDGER_REVISION_KIND');
      },
      ev_no_delete: async (s) => raises(e().run('DELETE FROM transaction_events WHERE id = ?', [(await rawTxn(e(), s, 'merchant_spend', { entries: [], publish: false })).E]), 'LEDGER_NO_DELETE'),
      en_immutable: async (s) => raises(e().run('UPDATE transaction_entries SET amount = 1 WHERE id = ?', [(await rawTxn(e(), s, 'merchant_spend')).N[0]]), 'LEDGER_IMMUTABLE'),
      en_insert_open: async (s) => {
        const t = await rawTxn(e(), s, 'own_transfer', { ev: { counterparty_country: 'US' } });
        await raises(ins(e(), 'transaction_entries', enRow(s, t.E, 'own_transfer', { direction: 'in', funding_account_id: s.BE, funding_currency: 'USD', funding_account_country: 'BE' })), 'LEDGER_IMMUTABLE');
      },
      en_snapshot_source: async (s) => {
        const t = await rawTxn(e(), s, 'merchant_spend', { entries: [], publish: false });
        await raises(ins(e(), 'transaction_entries', enRow(s, t.E, 'merchant_spend', { funding_account_country: 'GB' })), 'LEDGER_SNAPSHOT_SOURCE');
      },
      en_kind_guard: async (s) => {
        const { T, N } = await rawTxn(e(), s, 'merchant_spend');
        const E2 = nid('E');
        await ins(e(), 'transaction_events', evRow(s, T, E2, 'merchant_spend', { revision: 2, revision_kind: 'settlement', home_region_source: 'carried' }));
        await raises(ins(e(), 'transaction_entries', enRow(s, E2, 'merchant_spend', { carried_from_entry_id: N[0], country_source: 'carried', amount: 1 })), 'LEDGER_REVISION_KIND');
      },
      en_closed_currency: async (s) => {
        const t = await rawTxn(e(), s, 'merchant_spend', { entries: [], publish: false });
        await raises(ins(e(), 'transaction_entries', enRow(s, t.E, 'merchant_spend', { funding_account_id: s.BE, funding_currency: 'GBP', funding_account_country: 'BE', currency_status_at_save: 'closed' })), 'LEDGER_CLOSED_CURRENCY');
      },
      en_no_delete: async (s) => raises(e().run('DELETE FROM transaction_entries WHERE id = ?', [(await rawTxn(e(), s, 'merchant_spend', { publish: false })).N[0]]), 'LEDGER_NO_DELETE'),
      key_immutable: async (s) => {
        const c = await create(e(), createIn(s));
        await raises(e().run("UPDATE ledger_idempotency_keys SET op_id = 'x' WHERE user_id = ? AND key = ?", [s.u, c.key]), 'LEDGER_KEY_IMMUTABLE');
      },
      key_create_no_delete: async (s) => {
        const c = await create(e(), createIn(s));
        await raises(e().run('DELETE FROM ledger_idempotency_keys WHERE user_id = ? AND key = ?', [s.u, c.key]), 'LEDGER_NO_DELETE');
      },
    };

    it('covers exactly the triggers of migration 0002', async () => {
      const names = (await e().all(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (${M3_TABLES.map(() => '?').join(', ')})`, [...M3_TABLES])).map((r) => String(r.name)).sort();
      expect(Object.keys(CASES).sort()).toEqual(names);
      expect(names).toHaveLength(21);
    });
    for (const n of Object.keys(CASES)) {
      it(n, async () => {
        await CASES[n]!(await seedUser(e()));
      });
    }
  });

  describe('ISO error matrix: raw SQL references to a missing parent and to another user’s parent fail the same way', () => {
    /** The refusal of a statement reduced to its class: a LEDGER_* code, FOREIGN_KEY, or a named CHECK / UNIQUE. */
    const kind = async (p: Promise<unknown>) => {
      const msg = await rejection(p);
      const code = msg.match(/\b(LEDGER_[A-Z_]+):/)?.[1];
      if (code) return code;
      if (/FOREIGN KEY constraint failed/.test(msg)) return 'FOREIGN_KEY';
      return msg.match(/(CHECK|UNIQUE|NOT NULL) constraint failed: [\w.]+/)?.[0] ?? msg;
    };
    /** Expected classes per reference: [missing parent, another user's parent, same user but illegal]. */
    const EXPECTED: Record<string, [string, string, string]> = {
      'header.user_id': ['FOREIGN_KEY', 'n/a', 'n/a'],
      'event.transaction_id': ['LEDGER_REVISION_ORDER', 'LEDGER_REVISION_ORDER', 'LEDGER_REVISION_ORDER'],
      'event.card_id': ['FOREIGN_KEY', 'FOREIGN_KEY', 'n/a'],
      'event.payment_channel_id': ['FOREIGN_KEY', 'FOREIGN_KEY', 'n/a'],
      'entry.event_id': ['LEDGER_IMMUTABLE', 'LEDGER_IMMUTABLE', 'LEDGER_IMMUTABLE'],
      'entry.funding_account_id': ['LEDGER_SNAPSHOT_SOURCE', 'LEDGER_SNAPSHOT_SOURCE', 'LEDGER_SNAPSHOT_SOURCE'],
      'entry.funding_currency': ['LEDGER_SNAPSHOT_SOURCE', 'LEDGER_SNAPSHOT_SOURCE', 'LEDGER_CLOSED_CURRENCY'],
      'entry.carried_from_entry_id': ['LEDGER_SNAPSHOT_SOURCE', 'LEDGER_SNAPSHOT_SOURCE', 'LEDGER_SNAPSHOT_SOURCE'],
      'key.transaction_id': ['FOREIGN_KEY', 'FOREIGN_KEY', 'n/a'],
      'key.result_event_id': ['FOREIGN_KEY', 'FOREIGN_KEY', 'n/a'],
    };

    it('records the matrix on both engines; missing and foreign are never distinguishable', async () => {
      const a = await seedUser(e());
      const b = await seedUser(e());
      const bTxn = await rawTxn(e(), b, 'merchant_spend', { publish: false }); // b's unpublished version
      const bPub = await rawTxn(e(), b, 'merchant_spend'); // b's published version
      const got: Record<string, [string, string, string]> = {};
      const T = nid('T');
      await ins(e(), 'transactions', { id: T, user_id: a.u, txn_type: 'merchant_spend', created_at: TS, updated_at: TS });
      const aOpen = await rawTxn(e(), a, 'merchant_spend', { entries: [], publish: false });
      const aPub = await rawTxn(e(), a, 'merchant_spend');
      const ev = (x: Row) => ins(e(), 'transaction_events', evRow(a, T, nid('E'), 'merchant_spend', x));
      const en = (x: Row) => ins(e(), 'transaction_entries', enRow(a, aOpen.E, 'merchant_spend', x));
      const c = await create(e(), createIn(a));
      const key = (x: Row) => ins(e(), 'ledger_idempotency_keys', { user_id: a.u, key: newKey(), operation: 'transaction.correct', request_hash: 'a'.repeat(64), hash_version: 1, op_id: 'o', transaction_id: c.T, result_revision: 1, result_event_id: c.E, audit_id: c.A, response_status: 201, created_at: TS, expires_at: TS + 1, ...x });

      got['header.user_id'] = [await kind(ins(e(), 'transactions', { id: nid('T'), user_id: 'no-such-user', txn_type: 'merchant_spend', created_at: TS, updated_at: TS })), 'n/a', 'n/a'];
      got['event.transaction_id'] = [
        await kind(ins(e(), 'transaction_events', evRow(a, 'no-such-txn', nid('E'), 'merchant_spend'))),
        await kind(ins(e(), 'transaction_events', evRow(a, bTxn.T, nid('E'), 'merchant_spend'))),
        await kind(ev({ revision: 3, revision_kind: 'fact_correction', correction_reason: 'r', home_region_source: 'carried' })),
      ];
      got['event.card_id'] = [await kind(ev({ card_id: 'no-such-card' })), await kind(ev({ card_id: b.K })), 'n/a'];
      got['event.payment_channel_id'] = [await kind(ev({ payment_channel_id: 'no-such-channel' })), await kind(ev({ payment_channel_id: b.PP })), 'n/a'];
      got['entry.event_id'] = [
        await kind(ins(e(), 'transaction_entries', enRow(a, 'no-such-event', 'merchant_spend'))),
        await kind(ins(e(), 'transaction_entries', enRow(a, bTxn.E, 'merchant_spend'))),
        await kind(ins(e(), 'transaction_entries', enRow(a, aPub.E, 'merchant_spend', { direction: 'out', funding_account_id: a.BE, funding_currency: 'USD', funding_account_country: 'BE' }))),
      ];
      got['entry.funding_account_id'] = [
        await kind(en({ funding_account_id: 'no-such-account' })),
        await kind(en({ funding_account_id: b.HK })),
        await kind(en({ funding_account_country: 'US' })), // own account, wrong snapshot
      ];
      got['entry.funding_currency'] = [
        await kind(en({ funding_currency: 'JPY' })), // not registered on the account
        await kind(en({ funding_account_id: b.BE, funding_currency: 'EUR', funding_account_country: 'BE' })),
        await kind(en({ funding_account_id: a.BE, funding_currency: 'GBP', funding_account_country: 'BE', currency_status_at_save: 'closed' })),
      ];
      got['entry.carried_from_entry_id'] = [
        await kind(en({ carried_from_entry_id: 'no-such-entry', country_source: 'carried' })),
        await kind(en({ carried_from_entry_id: bPub.N[0], country_source: 'carried' })),
        await kind(en({ carried_from_entry_id: aPub.N[0], country_source: 'carried' })), // another transaction of a
      ];
      got['key.transaction_id'] = [await kind(key({ transaction_id: 'no-such-txn' })), await kind(key({ transaction_id: bPub.T })), 'n/a'];
      got['key.result_event_id'] = [await kind(key({ result_event_id: 'no-such-event' })), await kind(key({ result_event_id: bPub.E })), 'n/a'];

      expect(got).toEqual(EXPECTED);
      for (const [ref, [missing, foreign]] of Object.entries(got)) if (foreign !== 'n/a') expect(foreign, ref).toBe(missing);
      // Nothing of a's attempts was written.
      expect(await count(e(), 'transaction_events', 'transaction_id = ?', [T])).toBe(0);
      expect(await count(e(), 'transaction_entries', 'event_id = ?', [aOpen.E])).toBe(0);
      expect(await count(e(), 'ledger_idempotency_keys', 'user_id = ?', [a.u])).toBe(1);
    });
  });

  describe('BF-3 closed currencies (R3) and ledger CHECKs on keys', () => {
    it('a closed currency only in an acknowledged backfill or carried with the same account and currency', async () => {
      const s = await seedUser(e());
      const gbp = { funding_account_id: s.BE, funding_currency: 'GBP', funding_account_country: 'BE', currency_status_at_save: 'closed' };
      const cur = await rawTxn(e(), s, 'merchant_spend', { entries: [], publish: false });
      await raises(ins(e(), 'transaction_entries', enRow(s, cur.E, 'merchant_spend', gbp)), 'LEDGER_CLOSED_CURRENCY');
      await checkFails(ins(e(), 'transaction_entries', enRow(s, cur.E, 'merchant_spend', { closed_currency_ack: 1 })), 'transaction_entries_ack_closed_ck');
      const bf = await rawTxn(e(), s, 'merchant_spend', { ev: { record_mode: 'backfill' }, entries: [], publish: false });
      await raises(ins(e(), 'transaction_entries', enRow(s, bf.E, 'merchant_spend', gbp)), 'LEDGER_CLOSED_CURRENCY');
      await ins(e(), 'transaction_entries', enRow(s, bf.E, 'merchant_spend', { ...gbp, closed_currency_ack: 1 }));
      await publishRaw(e(), bf.T, 1);
      const N1 = String((await one(e(), 'SELECT id FROM transaction_entries WHERE event_id = ?', [bf.E])).id);
      // v2 in current mode: carrying the same account and currency is allowed …
      const E2 = nid('E');
      await ins(e(), 'transaction_events', evRow(s, bf.T, E2, 'merchant_spend', { revision: 2, revision_kind: 'fact_correction', correction_reason: 'r', home_region_source: 'carried', record_mode: 'current' }));
      // … switching to another closed currency of the same account is not (close EUR first).
      await e().run("UPDATE account_currencies SET status = 'closed' WHERE account_id = ? AND currency = 'EUR'", [s.BE]);
      await raises(ins(e(), 'transaction_entries', enRow(s, E2, 'merchant_spend', { ...gbp, funding_currency: 'EUR', carried_from_entry_id: N1, country_source: 'carried' })), 'LEDGER_CLOSED_CURRENCY');
      await ins(e(), 'transaction_entries', enRow(s, E2, 'merchant_spend', { ...gbp, carried_from_entry_id: N1, country_source: 'carried' }));
      await publishRaw(e(), bf.T, 2);
      // currency_status_at_save stays as saved when the currency is reopened (BF-6).
      await e().run("UPDATE account_currencies SET status = 'active' WHERE account_id = ? AND currency = 'GBP'", [s.BE]);
      expect((await e().all('SELECT currency_status_at_save AS st FROM transaction_entries WHERE event_id IN (?, ?)', [bf.E, E2])).map((r) => r.st)).toEqual(['closed', 'closed']);
    });

    it('key rows: key format, hash format, retention by operation, statuses', async () => {
      const s = await seedUser(e());
      const c = await create(e(), createIn(s));
      const k = (x: Row) => ({ user_id: s.u, key: newKey(), operation: 'transaction.correct', request_hash: 'a'.repeat(64), hash_version: 1, op_id: 'o', transaction_id: c.T, result_revision: 1, result_event_id: c.E, audit_id: c.A, response_status: 201, created_at: TS, expires_at: TS + 1, ...x });
      for (const key of ['a'.repeat(15), 'a'.repeat(65), 'has space 0123456', 'dots.not.allowed.x']) await checkFails(ins(e(), 'ledger_idempotency_keys', k({ key })), 'ledger_idempotency_keys_key_ck');
      for (const request_hash of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) await checkFails(ins(e(), 'ledger_idempotency_keys', k({ request_hash })), 'ledger_idempotency_keys_hash_ck');
      await checkFails(ins(e(), 'ledger_idempotency_keys', k({ operation: 'transaction.create' })), 'ledger_idempotency_keys_retention_ck');
      await checkFails(ins(e(), 'ledger_idempotency_keys', k({ expires_at: null })), 'ledger_idempotency_keys_retention_ck');
      await checkFails(ins(e(), 'ledger_idempotency_keys', k({ expires_at: TS })), 'ledger_idempotency_keys_expires_ck');
      await checkFails(ins(e(), 'ledger_idempotency_keys', k({ response_status: 409 })), 'ledger_idempotency_keys_response_status_ck');
      await checkFails(ins(e(), 'ledger_idempotency_keys', k({ operation: 'transaction.delete' })), 'ledger_idempotency_keys_operation_ck');
      await fkFails(ins(e(), 'ledger_idempotency_keys', k({ result_event_id: 'no-such-event' })));
      await ins(e(), 'ledger_idempotency_keys', k({ key: 'a'.repeat(16) }));
      await ins(e(), 'ledger_idempotency_keys', k({ key: `${'A'.repeat(32)}_-0123456789${'z'.repeat(20)}` }));
    });
  });

  describe('DEL delete protection and user cascades', () => {
    it('DEL-1: accounts, currencies, cards and channels used by any version (superseded, voided) cannot be deleted', async () => {
      const s = await seedUser(e());
      const c = await create(e(), createIn(s, { facts: spendFacts({ cardId: s.K, paymentChannelId: s.PP }) }));
      // v2 moves the entry to BE: HK is only used by the superseded v1.
      await correct(e(), correctIn(s, c, { entries: [{ ...c.entries[0]!, id: nid('N'), accountId: s.BE, currency: 'USD', carriedFromEntryId: null }], facts: spendFacts({ cardId: null }) }));
      await fkFails(e().run('DELETE FROM accounts WHERE id = ?', [s.HK]));
      await fkFails(e().run("DELETE FROM account_currencies WHERE account_id = ? AND currency = 'HKD'", [s.HK]));
      await fkFails(e().run('DELETE FROM cards WHERE id = ?', [s.K]));
      await fkFails(e().run('DELETE FROM payment_channels WHERE id = ?', [s.PP]));
      // Voided transactions still protect what they reference.
      const k = newKey();
      await e().db.batch(steps(voidChain(e().db, { u: s.u, T: c.T, now: TS + 200, ip: null, baseRevision: 2, reason: null, O: nid('O'), A: nid('A'), key: k, requestHash: hash(k), hashVersion: 1 })));
      await fkFails(e().run('DELETE FROM accounts WHERE id = ?', [s.BE]));
      await fkFails(e().run('DELETE FROM payment_channels WHERE id = ?', [s.PP]));
      // An unreferenced currency of a referenced account is still deletable.
      await e().run("DELETE FROM account_currencies WHERE account_id = ? AND currency = 'EUR'", [s.BE]);
    });

    it('DEL-3: headers, versions, entries and create keys cannot be deleted while their user exists', async () => {
      const s = await seedUser(e());
      const c = await create(e(), createIn(s));
      const tryAll = async () => {
        await raises(e().run('DELETE FROM transaction_entries WHERE id = ?', [c.entries[0]!.id]), 'LEDGER_NO_DELETE');
        await raises(e().run('DELETE FROM transaction_events WHERE id = ?', [c.E]), 'LEDGER_NO_DELETE');
        await raises(e().run('DELETE FROM transactions WHERE id = ?', [c.T]), 'LEDGER_NO_DELETE');
        await raises(e().run('DELETE FROM ledger_idempotency_keys WHERE user_id = ? AND key = ?', [s.u, c.key]), 'LEDGER_NO_DELETE');
      };
      await tryAll();
      if (name === 'libsql') {
        // The guards do not depend on foreign keys being on (D1 always enforces them).
        await e().run('PRAGMA foreign_keys = OFF');
        try {
          await tryAll();
        } finally {
          await e().run('PRAGMA foreign_keys = ON');
        }
        expect((await one(e(), 'PRAGMA foreign_keys')).foreign_keys).toBe(1);
      }
      expect(await ledgerCounts(e(), s.u)).toMatchObject({ transactions: 1, transaction_events: 1, transaction_entries: 1, ledger_idempotency_keys: 1 });
    });

    it('DEL-4 / DEL-5: deleting a user removes its whole ledger (versions, voided, keys) in one statement; others untouched; audit kept', async () => {
      const users = [await seedUser(e()), await seedUser(e())];
      for (const s of users) {
        const c = await create(e(), createIn(s, { entries: [{ id: nid('N'), direction: 'out', accountId: s.HK, currency: 'HKD', amount: null, amountStatus: 'pending', exponent: 2, closedCurrencyAck: false }] }));
        await correct(e(), correctIn(s, c, { kind: 'settlement', reason: null, entries: [{ ...c.entries[0]!, id: nid('N'), amount: 7830, amountStatus: 'confirmed', carriedFromEntryId: c.entries[0]!.id }] }));
        const v = await create(e(), createIn(s));
        const k = newKey();
        await e().db.batch(steps(voidChain(e().db, { u: s.u, T: v.T, now: TS + 300, ip: null, baseRevision: 1, reason: 'dup', O: nid('O'), A: nid('A'), key: k, requestHash: hash(k), hashVersion: 1 })));
      }
      const [a, b] = users as [Seed, Seed];
      expect(await ledgerCounts(e(), a.u)).toEqual({ transactions: 2, transaction_events: 3, transaction_entries: 3, ledger_idempotency_keys: 4, audit: 4 });
      const bBefore = await ledgerCounts(e(), b.u);
      await e().run('DELETE FROM users WHERE id = ?', [a.u]);
      expect(await ledgerCounts(e(), a.u)).toEqual({ transactions: 0, transaction_events: 0, transaction_entries: 0, ledger_idempotency_keys: 0, audit: 4 });
      for (const t of ['accounts', 'account_currencies', 'cards', 'payment_channels', 'institutions']) expect(await count(e(), t, 'user_id = ?', [a.u]), t).toBe(0);
      expect(await ledgerCounts(e(), b.u)).toEqual(bBefore);
      expect(await e().all('PRAGMA foreign_key_check')).toEqual([]);
      // The kept audit trail holds ids and version numbers only.
      for (const r of await e().all("SELECT action, detail FROM audit_log WHERE user_id = ? AND action LIKE 'transaction.%'", [a.u])) {
        expect(Object.keys(JSON.parse(String(r.detail))).sort()).toEqual(r.action === 'transaction.correct' ? ['eventId', 'id', 'kind', 'revision'] : ['eventId', 'id', 'revision']);
      }
    });
  });

  describe('SUM exact statistics in SQL (DATA_MODEL §10.12)', () => {
    const STATS = `SELECT ev.foreign_status, ev.txn_type, en.direction, en.funding_currency, en.currency_exponent,
                          CAST(SUM(en.amount / 1000000000) AS TEXT) AS hi, CAST(SUM(en.amount % 1000000000) AS TEXT) AS lo, COUNT(*) AS n
                   FROM transactions t
                   JOIN transaction_events ev ON ev.transaction_id = t.id AND ev.revision = t.current_revision
                   JOIN transaction_entries en ON en.event_id = ev.id
                   WHERE t.user_id = ? AND t.status = 'active' AND en.amount_status = 'confirmed'
                   GROUP BY ev.foreign_status, ev.txn_type, en.direction, en.funding_currency, en.currency_exponent
                   ORDER BY ev.foreign_status, ev.txn_type, en.direction, en.funding_currency, en.currency_exponent`;

    it('SUM-1 / SUM-2: 9300 published entries at the maximum — SUM(amount) overflows, the segmented sum is exact', async () => {
      const s = await seedUser(e());
      const MAX = 999_999_999_999_999;
      await e().run(
        `INSERT INTO transactions (id, user_id, txn_type, created_at, updated_at)
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 9300) SELECT ? || '_' || i, ?, 'merchant_spend', ?, ? FROM n`,
        [`sum_${s.u}`, s.u, TS, TS],
      );
      await e().run(
        `INSERT INTO transaction_events (id, user_id, transaction_id, txn_type, revision, revision_kind, record_mode, occurred_on, event_currency, event_amount, event_currency_exponent,
                                         merchant_name, merchant_country, home_region, home_region_source, merchant_scope, foreign_status, classifier_version, created_at)
         SELECT 'ev_' || id, user_id, id, txn_type, 1, 'original', 'current', '2026-10-20', 'HKD', ?, 2, 'Shop', 'US', 'CN', 'preference_at_save', 'foreign', 'foreign', 1, ? FROM transactions WHERE user_id = ?`,
        [MAX, TS, s.u],
      );
      await e().run(
        `INSERT INTO transaction_entries (id, user_id, event_id, txn_type, direction, funding_account_id, funding_currency, amount, amount_status, currency_exponent,
                                          funding_account_country, country_source, currency_status_at_save, created_at)
         SELECT 'en_' || id, user_id, id, txn_type, 'out', ?, 'HKD', ?, 'confirmed', 2, 'HK', 'account_at_save', 'active', ? FROM transaction_events WHERE user_id = ?`,
        [s.HK, MAX, TS, s.u],
      );
      await e().run('UPDATE transactions SET current_revision = 1 WHERE user_id = ?', [s.u]);
      expect(await count(e(), 'transactions', 'user_id = ? AND current_revision = 1', [s.u])).toBe(9300);
      expect(await rejection(e().all('SELECT SUM(en.amount) AS s FROM transaction_entries en WHERE en.user_id = ?', [s.u]))).toMatch(/integer overflow/i);
      const [g] = await e().all(STATS, [s.u]);
      expect(g).toMatchObject({ foreign_status: 'foreign', funding_currency: 'HKD', currency_exponent: 2, n: 9300 });
      expect(typeof g!.hi).toBe('string');
      expect(mergeSegmentedSum(String(g!.hi), String(g!.lo))).toBe((9300n * BigInt(MAX)).toString());
    }, 120_000);

    it('SUM-4 / SUM-5 / SUM-6: only confirmed entries of current versions of active transactions; groups never merge currencies, exponents, states or directions', async () => {
      const s = await seedUser(e());
      const a = await create(e(), createIn(s)); // 7830 HKD, superseded below
      await correct(e(), correctIn(s, a, { entries: [{ ...a.entries[0]!, id: nid('N'), amount: 9000, carriedFromEntryId: a.entries[0]!.id }] }));
      const v = await create(e(), createIn(s, { entries: [{ ...a.entries[0]!, id: nid('N'), amount: 5000 }] }));
      const k = newKey();
      await e().db.batch(steps(voidChain(e().db, { u: s.u, T: v.T, now: TS + 400, ip: null, baseRevision: 1, reason: null, O: nid('O'), A: nid('A'), key: k, requestHash: hash(k), hashVersion: 1 })));
      await create(e(), createIn(s, { entries: [{ ...a.entries[0]!, id: nid('N'), amount: null, amountStatus: 'pending' }] }));
      await create(e(), createIn(s, { entries: [{ ...a.entries[0]!, id: nid('N'), amount: 100 }] }));
      // An undetermined spend, a refund, and a raw HKD entry saved with 3 decimal places.
      await create(e(), createIn(s, {
        facts: spendFacts({ merchantCountry: null }), classification: { merchantScope: 'unknown', transferScope: null, foreignStatus: 'undetermined' },
        entries: [{ id: nid('N'), direction: 'out', accountId: s.CN, currency: 'CNY', amount: 300, amountStatus: 'confirmed', exponent: 2, closedCurrencyAck: false }],
      }));
      await create(e(), createIn(s, { txnType: 'merchant_refund', entries: [{ id: nid('N'), direction: 'in', accountId: s.HK, currency: 'HKD', amount: 250, amountStatus: 'confirmed', exponent: 2, closedCurrencyAck: false }] }));
      await rawTxn(e(), s, 'merchant_spend', { entries: [{ amount: 1, currency_exponent: 3 }] });
      expect(await e().all(STATS, [s.u])).toEqual([
        { foreign_status: 'foreign', txn_type: 'merchant_refund', direction: 'in', funding_currency: 'HKD', currency_exponent: 2, hi: '0', lo: '250', n: 1 },
        { foreign_status: 'foreign', txn_type: 'merchant_spend', direction: 'out', funding_currency: 'HKD', currency_exponent: 2, hi: '0', lo: '9100', n: 2 },
        { foreign_status: 'foreign', txn_type: 'merchant_spend', direction: 'out', funding_currency: 'HKD', currency_exponent: 3, hi: '0', lo: '1', n: 1 },
        { foreign_status: 'undetermined', txn_type: 'merchant_spend', direction: 'out', funding_currency: 'CNY', currency_exponent: 2, hi: '0', lo: '300', n: 1 },
      ]);
      const pending = await e().all(
        `SELECT COUNT(*) AS n FROM transactions t JOIN transaction_events ev ON ev.transaction_id = t.id AND ev.revision = t.current_revision
         JOIN transaction_entries en ON en.event_id = ev.id WHERE t.user_id = ? AND t.status = 'active' AND en.amount_status = 'pending'`,
        [s.u],
      );
      expect(pending).toEqual([{ n: 1 }]);
    });
  });
});

describe('DB-M3-1 libsql and D1 build the same M3 schema', () => {
  it('identical columns, defaults, indexes (incl. partial flags), foreign keys, table SQL and triggers in creation order', () => {
    expect(snapshots.libsql).toBeDefined();
    expect(snapshots.d1).toBeDefined();
    expect(snapshots.d1).toEqual(snapshots.libsql);
  });
});
