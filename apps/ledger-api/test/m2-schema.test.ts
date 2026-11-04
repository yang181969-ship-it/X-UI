// M2 database constraints (TEST_PLAN §3.12, DB-0 … DB-10), run unchanged on two engines:
//   libsql — a temporary file database opened through openV1Db() (identity check + migrations,
//            PRAGMA foreign_keys = ON on its single connection);
//   d1     — wrangler's getPlatformProxy(): local in-memory D1 inside workerd (persist: false,
//            remoteBindings: false, wrangler cache in a temp dir). Migrations are applied in
//            _journal.json order with wrangler's own SQL splitter, as `wrangler d1 migrations
//            apply` does. No remote D1 is ever contacted.
// Cases only use raw SQL and drizzle's db.batch(), so they test the database, not the API.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@libsql/client';
import { sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPlatformProxy, unstable_splitSqlQuery } from 'wrangler';
import { MIGRATIONS_DIR, openV1Db } from '../src/db/client.ts';
import { assertD1Identity } from '../src/db/d1-identity.ts';
import { inspectIdentity, MIGRATIONS_TABLE } from '../src/db/identity.ts';
import { removeDbDir } from './helpers.ts';

type Row = Record<string, unknown>;
type D1 = Parameters<typeof drizzleD1>[0];

interface Driver {
  run(sqlText: string, args?: unknown[]): Promise<void>;
  all(sqlText: string, args?: unknown[]): Promise<Row[]>;
  /** drizzle db.batch() of literal statements — one transaction on both engines. */
  batch(statements: string[]): Promise<void>;
}

const M2_TABLES = ['user_preferences', 'institutions', 'accounts', 'account_currencies', 'cards', 'account_card_links', 'payment_channels', 'payment_channel_sources'] as const;
const M3_TABLES = ['transactions', 'transaction_events', 'transaction_entries', 'ledger_idempotency_keys'] as const;
const BALANCE_KIND = /BALANCE_ACCOUNT_KIND/;
const INSTITUTION_IMMUTABLE = /ACCOUNT_INSTITUTION_IMMUTABLE/;
const journalTags = () => (JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] }).entries.map((e) => e.tag);

// ------------------------------------------------------------------ engines

let libsqlDir = '';
let libsqlClient: Client | undefined;
let d1Dir = '';
let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1 }>>> | undefined;
let d1: D1;
const drivers: Partial<Record<'libsql' | 'd1', Driver>> = {};

beforeAll(async () => {
  libsqlDir = mkdtempSync(join(tmpdir(), 'xui-m2-libsql-'));
  const opened = await openV1Db(`file:${join(libsqlDir, 'x-ui-v1.db')}`, { legacyPaths: [] });
  libsqlClient = opened.client;
  const c = opened.client;
  drivers.libsql = {
    run: async (s, args = []) => void (await c.execute({ sql: s, args: args as never })),
    all: async (s, args = []) => {
      const r = await c.execute({ sql: s, args: args as never });
      return r.rows.map((row) => Object.fromEntries(r.columns.map((col, i) => [col, row[i]])));
    },
    batch: async (statements) => {
      const [first, ...rest] = statements.map((s) => opened.db.run(sql.raw(s)));
      await opened.db.batch([first!, ...rest]);
    },
  };

  d1Dir = mkdtempSync(join(tmpdir(), 'xui-m2-d1-'));
  const config = join(d1Dir, 'wrangler.json');
  writeFileSync(config, JSON.stringify({ name: 'xui-v1-d1-test', compatibility_date: '2026-10-01', d1_databases: [{ binding: 'DB', database_name: 'xui-v1-d1-test', database_id: '00000000-0000-0000-0000-000000000000' }] }));
  process.env.WRANGLER_CACHE_DIR = join(d1Dir, 'cache');
  proxy = await getPlatformProxy<{ DB: D1 }>({ configPath: config, persist: false, envFiles: [], remoteBindings: false });
  d1 = proxy.env.DB;
  for (const tag of journalTags()) {
    for (const statement of unstable_splitSqlQuery(readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8'))) await d1.prepare(statement).run();
  }
  const d1db = drizzleD1(d1);
  drivers.d1 = {
    run: async (s, args = []) => void (await d1.prepare(s).bind(...args).run()),
    all: async (s, args = []) => ((await d1.prepare(s).bind(...args).all()).results ?? []) as Row[],
    batch: async (statements) => {
      const [first, ...rest] = statements.map((s) => d1db.run(sql.raw(s)));
      await d1db.batch([first!, ...rest]);
    },
  };
}, 180_000);

afterAll(async () => {
  await proxy?.dispose();
  if (d1Dir) rmSync(d1Dir, { recursive: true, force: true });
  if (libsqlDir) await removeDbDir(libsqlDir, libsqlClient ? [libsqlClient] : []);
});

// ------------------------------------------------------------------ assertions

function errorText(e: unknown): string {
  const out: string[] = [];
  for (let cur: any = e, i = 0; cur && i < 6; cur = cur.cause, i++) out.push(String(cur.message ?? cur));
  return out.join(' | ');
}

async function rejection(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (err === null) expect.fail('expected the database to refuse the statement, but it succeeded');
  return errorText(err);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fk = async (p: Promise<unknown>) => expect(await rejection(p)).toMatch(/FOREIGN KEY constraint failed/);
const checkFails = async (p: Promise<unknown>, name: string) => expect(await rejection(p)).toMatch(new RegExp(`CHECK constraint failed: ${escapeRe(name)}(?![\\w])`));
const notNull = async (p: Promise<unknown>, column: string) => expect(await rejection(p)).toMatch(new RegExp(`NOT NULL constraint failed: ${escapeRe(column)}(?![\\w])`));
/** target: "table.col, table.col" for column indexes, "index 'name'" for expression indexes. */
const uniqueFails = async (p: Promise<unknown>, target: string) =>
  expect(await rejection(p)).toMatch(new RegExp(`UNIQUE constraint failed: ${escapeRe(target)}(?![\\w.,])`));

// ------------------------------------------------------------------ rows

const T = 1_790_000_000_000;
let seq = 0;
const nid = (p: string) => `${p}_${++seq}`;

const row = {
  user: (id: string): Row => ({ id, username: id, display_name: id, role: 'member', status: 'active', webauthn_user_id: `wa-${id}`, created_at: T, updated_at: T }),
  institution: (id: string, u: string, x: Row = {}): Row => ({ id, user_id: u, name: id, name_key: id.toLowerCase(), country: 'GB', institution_type: 'bank', created_at: T, updated_at: T, ...x }),
  account: (id: string, u: string, inst: string, x: Row = {}): Row => ({ id, user_id: u, institution_id: inst, name: id, name_key: id.toLowerCase(), account_type: 'bank', account_country: 'HK', created_at: T, updated_at: T, ...x }),
  currency: (acc: string, u: string, currency: string, x: Row = {}): Row => ({ account_id: acc, user_id: u, currency, created_at: T, ...x }),
  card: (id: string, u: string, issuer: string, x: Row = {}): Row => ({ id, user_id: u, issuer_institution_id: issuer, name: id, network: 'visa', card_type: 'debit', last4: '4321', issuing_country: 'BE', created_at: T, updated_at: T, ...x }),
  link: (id: string, u: string, card: string, acc: string, x: Row = {}): Row => ({ id, user_id: u, card_id: card, account_id: acc, created_at: T, updated_at: T, ...x }),
  channel: (id: string, u: string, x: Row = {}): Row => ({ id, user_id: u, name: id, name_key: id.toLowerCase(), channel_type: 'payment_service', created_at: T, updated_at: T, ...x }),
  source: (id: string, u: string, ch: string, x: Row = {}): Row => ({ id, user_id: u, channel_id: ch, created_at: T, updated_at: T, ...x }),
};

const insertSql = (table: string, r: Row) => {
  const cols = Object.keys(r);
  return [`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, Object.values(r)] as const;
};
const ins = (d: Driver, table: string, r: Row) => d.run(...insertSql(table, r));

/**
 * One user with a complete M2 data set (and some auth rows):
 *   I (Wise, emi) ── W  e_money BE  [USD default, EUR, GBP]
 *   I2 (HSBC)     ── B  bank HK     [HKD default]
 *                 ── E  e_money LU  [USD default]   balance account of PayPal
 *                 ── S  stored_value HK [HKD default]  prepaid card P's stored-value account
 *   K debit (issuer I):  K→W spending (all currencies, default) · K→W spending EUR · K→B top-up
 *   P prepaid (issuer I2): P→S spending (default)
 *   PP PayPal (payment_service, provider I2, balance E): sources K (default), B
 *   AP Apple Pay (device_wallet): source K (default)
 */
async function seed(d: Driver) {
  const u = nid('u');
  const id = (p: string) => `${u}_${p}`;
  const s = {
    u,
    I: id('I'), I2: id('I2'), W: id('W'), B: id('B'), E: id('E'), S: id('S'), K: id('K'), P: id('P'),
    L_KW: id('L_KW'), L_KWE: id('L_KWE'), L_KB: id('L_KB'), L_PS: id('L_PS'),
    PP: id('PP'), AP: id('AP'), S_PPK: id('S_PPK'), S_PPB: id('S_PPB'), S_APK: id('S_APK'),
  };
  await ins(d, 'users', row.user(u));
  await ins(d, 'sessions', { id: id('sess'), user_id: u, method: 'password_totp', created_at: T, last_seen_at: T, expires_at: T + 1, absolute_expires_at: T + 2 });
  await ins(d, 'passkeys', { id: id('pk'), user_id: u, public_key: 'pk', name: 'key', created_at: T });
  await ins(d, 'recovery_codes', { id: id('rc'), user_id: u, code_hash: 'h', created_at: T });
  await ins(d, 'user_preferences', { user_id: u, home_region: 'HK', created_at: T, updated_at: T });
  // audit_log.user_id has no foreign key (M1): audit rows outlive the user (DATA_MODEL §6).
  await ins(d, 'audit_log', { id: id('audit'), user_id: u, action: 'login.success', detail: '{"via":"password_totp"}', ip: '10.0.0.1', created_at: T });

  await ins(d, 'institutions', row.institution(s.I, u, { name: 'Wise', name_key: 'wise', institution_type: 'emi' }));
  await ins(d, 'institutions', row.institution(s.I2, u, { name: 'HSBC', name_key: 'hsbc', country: 'HK' }));
  await ins(d, 'accounts', row.account(s.W, u, s.I, { account_type: 'e_money', account_country: 'BE' }));
  await ins(d, 'accounts', row.account(s.B, u, s.I2, { deposit_kind: 'current', number_hint: '1234' }));
  await ins(d, 'accounts', row.account(s.E, u, s.I2, { account_type: 'e_money', account_country: 'LU' }));
  await ins(d, 'accounts', row.account(s.S, u, s.I2, { account_type: 'stored_value' }));
  await ins(d, 'account_currencies', row.currency(s.W, u, 'USD', { is_default: 1 }));
  await ins(d, 'account_currencies', row.currency(s.W, u, 'EUR', { sort: 1 }));
  await ins(d, 'account_currencies', row.currency(s.W, u, 'GBP', { sort: 2 }));
  await ins(d, 'account_currencies', row.currency(s.B, u, 'HKD', { is_default: 1 }));
  await ins(d, 'account_currencies', row.currency(s.E, u, 'USD', { is_default: 1 }));
  await ins(d, 'account_currencies', row.currency(s.S, u, 'HKD', { is_default: 1 }));
  await ins(d, 'cards', row.card(s.K, u, s.I, { expires_on: '2028-07' }));
  await ins(d, 'cards', row.card(s.P, u, s.I2, { card_type: 'prepaid', form: 'virtual', last4: '0042', issuing_country: 'HK' }));
  await ins(d, 'account_card_links', row.link(s.L_KW, u, s.K, s.W, { is_default: 1 }));
  await ins(d, 'account_card_links', row.link(s.L_KWE, u, s.K, s.W, { currency: 'EUR', priority: 1 }));
  await ins(d, 'account_card_links', row.link(s.L_KB, u, s.K, s.B, { role: 'top_up_source' }));
  await ins(d, 'account_card_links', row.link(s.L_PS, u, s.P, s.S, { is_default: 1 }));
  await ins(d, 'payment_channels', row.channel(s.PP, u, { name: 'PayPal', name_key: 'paypal', provider_institution_id: s.I2, balance_account_id: s.E, region: 'LU' }));
  await ins(d, 'payment_channels', row.channel(s.AP, u, { name: 'Apple Pay', name_key: 'apple pay', channel_type: 'device_wallet' }));
  await ins(d, 'payment_channel_sources', row.source(s.S_PPK, u, s.PP, { card_id: s.K, is_default: 1 }));
  await ins(d, 'payment_channel_sources', row.source(s.S_PPB, u, s.PP, { account_id: s.B }));
  await ins(d, 'payment_channel_sources', row.source(s.S_APK, u, s.AP, { card_id: s.K, is_default: 1 }));
  return s;
}
type Seed = Awaited<ReturnType<typeof seed>>;

const count = async (d: Driver, table: string, where = '1 = 1', args: unknown[] = []) => Number((await d.all(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, args))[0]!.n);
const one = async (d: Driver, sqlText: string, args: unknown[] = []) => (await d.all(sqlText, args))[0];

/** Tables whose user_id references users(id) ON DELETE CASCADE: auth tables with a user key plus every M2 table. */
async function userTables(d: Driver): Promise<string[]> {
  const tables = (await d.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name <> '_cf_KV' ORDER BY name")).map((r) => String(r.name));
  const out: string[] = [];
  for (const t of tables) {
    const fks = await d.all(`PRAGMA foreign_key_list(${t})`);
    if (fks.some((f) => f.table === 'users' && f.from === 'user_id' && String(f.on_delete).toUpperCase() === 'CASCADE')) out.push(t);
  }
  return out;
}
const rowsOfUser = async (d: Driver, tables: string[], u: string) => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(d, t, 'user_id = ?', [u])] as const)));

// ------------------------------------------------------------------ expected schema (DATA_MODEL §3–§4)

interface Fk {
  table: string;
  from: string[];
  to: string[];
  onDelete: 'CASCADE' | 'NO ACTION';
}
const USERS_FK: Fk = { table: 'users', from: ['user_id'], to: ['id'], onDelete: 'CASCADE' };
const EXPECTED_FKS: Record<(typeof M2_TABLES)[number], Fk[]> = {
  user_preferences: [USERS_FK],
  institutions: [USERS_FK],
  accounts: [USERS_FK, { table: 'institutions', from: ['institution_id', 'user_id'], to: ['id', 'user_id'], onDelete: 'NO ACTION' }],
  account_currencies: [USERS_FK, { table: 'accounts', from: ['account_id', 'user_id'], to: ['id', 'user_id'], onDelete: 'CASCADE' }],
  cards: [USERS_FK, { table: 'institutions', from: ['issuer_institution_id', 'user_id'], to: ['id', 'user_id'], onDelete: 'NO ACTION' }],
  account_card_links: [
    USERS_FK,
    { table: 'cards', from: ['card_id', 'user_id'], to: ['id', 'user_id'], onDelete: 'CASCADE' },
    { table: 'accounts', from: ['account_id', 'user_id'], to: ['id', 'user_id'], onDelete: 'CASCADE' },
    { table: 'account_currencies', from: ['account_id', 'user_id', 'currency'], to: ['account_id', 'user_id', 'currency'], onDelete: 'NO ACTION' },
  ],
  payment_channels: [
    USERS_FK,
    { table: 'institutions', from: ['provider_institution_id', 'user_id'], to: ['id', 'user_id'], onDelete: 'NO ACTION' },
    { table: 'accounts', from: ['balance_account_id', 'user_id'], to: ['id', 'user_id'], onDelete: 'NO ACTION' },
  ],
  payment_channel_sources: [
    USERS_FK,
    { table: 'payment_channels', from: ['channel_id', 'user_id'], to: ['id', 'user_id'], onDelete: 'CASCADE' },
    { table: 'cards', from: ['card_id', 'user_id'], to: ['id', 'user_id'], onDelete: 'CASCADE' },
    { table: 'accounts', from: ['account_id', 'user_id'], to: ['id', 'user_id'], onDelete: 'CASCADE' },
  ],
};

/** Every named M2 index, as stored in sqlite_master (whitespace collapsed). */
const EXPECTED_INDEXES: Record<string, string> = {
  institutions_id_user_uq: 'CREATE UNIQUE INDEX `institutions_id_user_uq` ON `institutions` (`id`,`user_id`)',
  institutions_user_name_country_uq: "CREATE UNIQUE INDEX `institutions_user_name_country_uq` ON `institutions` (`user_id`,`name_key`,ifnull(`country`, ''))",
  institutions_user_status_idx: 'CREATE INDEX `institutions_user_status_idx` ON `institutions` (`user_id`,`status`)',
  accounts_id_user_uq: 'CREATE UNIQUE INDEX `accounts_id_user_uq` ON `accounts` (`id`,`user_id`)',
  accounts_user_status_idx: 'CREATE INDEX `accounts_user_status_idx` ON `accounts` (`user_id`,`status`)',
  accounts_user_institution_idx: 'CREATE INDEX `accounts_user_institution_idx` ON `accounts` (`user_id`,`institution_id`)',
  accounts_user_country_idx: 'CREATE INDEX `accounts_user_country_idx` ON `accounts` (`user_id`,`account_country`)',
  account_currencies_account_user_currency_uq: 'CREATE UNIQUE INDEX `account_currencies_account_user_currency_uq` ON `account_currencies` (`account_id`,`user_id`,`currency`)',
  account_currencies_default_uq: 'CREATE UNIQUE INDEX `account_currencies_default_uq` ON `account_currencies` (`account_id`) WHERE `is_default` = 1',
  cards_id_user_uq: 'CREATE UNIQUE INDEX `cards_id_user_uq` ON `cards` (`id`,`user_id`)',
  cards_user_status_idx: 'CREATE INDEX `cards_user_status_idx` ON `cards` (`user_id`,`status`)',
  cards_user_issuer_idx: 'CREATE INDEX `cards_user_issuer_idx` ON `cards` (`user_id`,`issuer_institution_id`)',
  account_card_links_open_uq:
    "CREATE UNIQUE INDEX `account_card_links_open_uq` ON `account_card_links` (`card_id`,`account_id`,ifnull(`currency`, ''),`role`) WHERE `status` <> 'ended'",
  account_card_links_default_uq: "CREATE UNIQUE INDEX `account_card_links_default_uq` ON `account_card_links` (`card_id`,ifnull(`currency`, '')) WHERE `is_default` = 1",
  account_card_links_user_card_idx: 'CREATE INDEX `account_card_links_user_card_idx` ON `account_card_links` (`user_id`,`card_id`)',
  account_card_links_user_account_idx: 'CREATE INDEX `account_card_links_user_account_idx` ON `account_card_links` (`user_id`,`account_id`)',
  payment_channels_id_user_uq: 'CREATE UNIQUE INDEX `payment_channels_id_user_uq` ON `payment_channels` (`id`,`user_id`)',
  payment_channels_user_name_uq: 'CREATE UNIQUE INDEX `payment_channels_user_name_uq` ON `payment_channels` (`user_id`,`name_key`)',
  payment_channels_balance_account_uq: 'CREATE UNIQUE INDEX `payment_channels_balance_account_uq` ON `payment_channels` (`balance_account_id`) WHERE `balance_account_id` IS NOT NULL',
  payment_channels_user_status_idx: 'CREATE INDEX `payment_channels_user_status_idx` ON `payment_channels` (`user_id`,`status`)',
  payment_channel_sources_card_uq:
    "CREATE UNIQUE INDEX `payment_channel_sources_card_uq` ON `payment_channel_sources` (`channel_id`,`card_id`) WHERE `card_id` IS NOT NULL AND `status` = 'active'",
  payment_channel_sources_account_uq:
    "CREATE UNIQUE INDEX `payment_channel_sources_account_uq` ON `payment_channel_sources` (`channel_id`,`account_id`) WHERE `account_id` IS NOT NULL AND `status` = 'active'",
  payment_channel_sources_default_uq: 'CREATE UNIQUE INDEX `payment_channel_sources_default_uq` ON `payment_channel_sources` (`channel_id`) WHERE `is_default` = 1',
  payment_channel_sources_user_channel_idx: 'CREATE INDEX `payment_channel_sources_user_channel_idx` ON `payment_channel_sources` (`user_id`,`channel_id`)',
};

/** Hand-written triggers in migration 0001 (name → table). */
const EXPECTED_TRIGGERS: Record<string, string> = {
  accounts_balance_kind_update: 'accounts',
  accounts_institution_immutable: 'accounts',
  payment_channels_balance_kind_insert: 'payment_channels',
  payment_channels_balance_kind_update: 'payment_channels',
};

const EXPECTED_CHECKS: Record<(typeof M2_TABLES)[number], string[]> = {
  user_preferences: ['user_preferences_home_region_ck'],
  institutions: ['institutions_country_ck', 'institutions_type_ck', 'institutions_status_ck'],
  accounts: ['accounts_type_ck', 'accounts_deposit_kind_ck', 'accounts_country_ck', 'accounts_number_hint_ck', 'accounts_status_ck', 'accounts_dates_ck'],
  account_currencies: ['account_currencies_currency_ck', 'account_currencies_is_default_ck', 'account_currencies_status_ck', 'account_currencies_default_active_ck'],
  cards: ['cards_network_ck', 'cards_card_type_ck', 'cards_form_ck', 'cards_last4_ck', 'cards_issuing_country_ck', 'cards_expires_on_ck', 'cards_status_ck'],
  account_card_links: [
    'account_card_links_role_ck',
    'account_card_links_is_default_ck',
    'account_card_links_default_ck',
    'account_card_links_priority_ck',
    'account_card_links_status_ck',
    'account_card_links_ended_ck',
  ],
  payment_channels: ['payment_channels_type_ck', 'payment_channels_balance_ck', 'payment_channels_region_ck', 'payment_channels_status_ck'],
  payment_channel_sources: ['payment_channel_sources_xor_ck', 'payment_channel_sources_is_default_ck', 'payment_channel_sources_default_ck', 'payment_channel_sources_status_ck'],
};

/** Columns that must never exist (DATA_MODEL §3.2, §3.4, §6). */
const FORBIDDEN_COLUMNS = ['balance', 'opening_balance', 'balance_date', 'credit_limit', 'include_in_total', 'pan', 'pan_enc', 'bin', 'bin_info', 'cvv', 'cvc', 'pin', 'holder_name', 'account_number', 'statement_day', 'due_day', 'amount'];

const norm = (s: unknown) => String(s).replace(/\s+/g, ' ').trim();

async function foreignKeys(d: Driver, table: string): Promise<Fk[]> {
  const rows = await d.all(`PRAGMA foreign_key_list(${table})`);
  const byId = new Map<number, Row[]>();
  for (const r of rows) byId.set(Number(r.id), [...(byId.get(Number(r.id)) ?? []), r]);
  return [...byId.values()]
    .map((g) => g.sort((a, b) => Number(a.seq) - Number(b.seq)))
    .map((g) => ({ table: String(g[0]!.table), from: g.map((r) => String(r.from)), to: g.map((r) => String(r.to)), onDelete: String(g[0]!.on_delete).toUpperCase() as Fk['onDelete'] }))
    .sort((a, b) => `${a.table}:${a.from}`.localeCompare(`${b.table}:${b.from}`));
}
const sortFks = (fks: Fk[]) => [...fks].sort((a, b) => `${a.table}:${a.from}`.localeCompare(`${b.table}:${b.from}`));

/** Everything DB-10 compares between the engines. */
async function schemaSnapshot(d: Driver) {
  const out: Record<string, unknown> = {};
  for (const t of M2_TABLES) {
    const indexList = (await d.all(`PRAGMA index_list(${t})`))
      .map((r) => ({ name: String(r.name), unique: Number(r.unique), origin: String(r.origin), partial: Number(r.partial) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const indexSql = (await d.all("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name", [t])).map((r) => [String(r.name), norm(r.sql)]);
    const columns = (await d.all(`PRAGMA table_info(${t})`)).map((r) => [String(r.name), String(r.type), Number(r.notnull), r.dflt_value === null ? null : String(r.dflt_value), Number(r.pk)]);
    const tableSql = norm((await one(d, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [t]))?.sql);
    out[t] = { columns, indexList, indexSql, foreignKeys: await foreignKeys(d, t), tableSql };
  }
  out.triggers = (await d.all("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")).map((r) => [String(r.name), String(r.tbl_name), norm(r.sql)]);
  return out;
}
const snapshots: Partial<Record<'libsql' | 'd1', Awaited<ReturnType<typeof schemaSnapshot>>>> = {};

/**
 * getPlatformProxy talks to workerd over a local keep-alive HTTP connection. After the libsql
 * half of the file the socket has idled long enough for workerd to drop it, and the next request
 * can fail with "fetch failed | read ECONNRESET" before reaching D1. Before each D1 case, ping
 * until the connection is fresh — retrying transport errors only, never SQL errors — so the
 * statements under test always run on a live connection.
 */
async function freshD1Connection() {
  for (let attempt = 1; ; attempt++) {
    try {
      await d1.prepare('SELECT 1').first();
      return;
    } catch (e) {
      if (!/fetch failed|ECONNRESET|socket hang up/i.test(errorText(e)) || attempt >= 3) throw e;
    }
  }
}

// ================================================================== the cases, once per engine

describe.each(['libsql', 'd1'] as const)('M2 constraints on %s', (engine) => {
  const d = () => drivers[engine]!;
  beforeEach(async () => {
    if (engine === 'd1') await freshD1Connection();
  });

  describe('DB-0 constraints are really on', () => {
    it('refuses references to rows that do not exist (foreign keys are enforced)', async () => {
      await fk(ins(d(), 'institutions', row.institution(nid('i'), 'no-such-user')));
      const s = await seed(d());
      await fk(ins(d(), 'accounts', row.account(nid('a'), s.u, 'no-such-institution')));
      await fk(ins(d(), 'account_card_links', row.link(nid('l'), s.u, 'no-such-card', s.W)));
    });

    it('is an X-UI v1 database with every migration applied', async () => {
      if (engine === 'libsql') {
        expect(await inspectIdentity(libsqlClient!)).toBe('v1');
        expect(await count(d(), MIGRATIONS_TABLE)).toBe(journalTags().length);
      } else {
        // The Worker's own boot check (worker.ts → assertD1Identity).
        await expect(assertD1Identity(d1 as never)).resolves.toBeUndefined();
      }
      const names = (await d().all("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => String(r.name));
      for (const t of M2_TABLES) expect(names).toContain(t);
    });
  });

  describe('DB-1 composite foreign keys keep users apart', () => {
    // Each bad row belongs to user b but points at a parent of user a; every other reference in
    // the row is valid, so only the foreign key under test can refuse it. The good row is the
    // same reference within one user.
    const CASES: [string, (a: Seed, b: Seed) => Promise<void>, (a: Seed, b: Seed) => Promise<void>][] = [
      [
        'accounts (institution_id, user_id) → institutions',
        (a, b) => ins(d(), 'accounts', row.account(nid('a'), b.u, a.I)),
        (_a, b) => ins(d(), 'accounts', row.account(nid('a'), b.u, b.I)),
      ],
      [
        'account_currencies (account_id, user_id) → accounts',
        (a, b) => ins(d(), 'account_currencies', row.currency(a.W, b.u, 'JPY')),
        (_a, b) => ins(d(), 'account_currencies', row.currency(b.W, b.u, 'JPY')),
      ],
      [
        'cards (issuer_institution_id, user_id) → institutions',
        (a, b) => ins(d(), 'cards', row.card(nid('c'), b.u, a.I)),
        (_a, b) => ins(d(), 'cards', row.card(nid('c'), b.u, b.I)),
      ],
      [
        'account_card_links (card_id, user_id) → cards',
        (a, b) => ins(d(), 'account_card_links', row.link(nid('l'), b.u, a.K, b.B, { role: 'other' })),
        (_a, b) => ins(d(), 'account_card_links', row.link(nid('l'), b.u, b.P, b.B, { role: 'other' })),
      ],
      [
        'account_card_links (account_id, user_id) → accounts',
        (a, b) => ins(d(), 'account_card_links', row.link(nid('l'), b.u, b.K, a.E, { role: 'other' })),
        (_a, b) => ins(d(), 'account_card_links', row.link(nid('l'), b.u, b.K, b.E, { role: 'other' })),
      ],
      [
        "account_card_links (account_id, user_id, currency) → account_currencies (a's account holds USD)",
        (a, b) => ins(d(), 'account_card_links', row.link(nid('l'), b.u, b.K, a.W, { role: 'other', currency: 'USD' })),
        (_a, b) => ins(d(), 'account_card_links', row.link(nid('l'), b.u, b.K, b.W, { role: 'other', currency: 'USD' })),
      ],
      [
        "account_card_links (account_id, user_id, currency) → account_currencies (only the other user's account holds it)",
        // b.B holds only HKD; a.W holds GBP. The card and account references are b's own, so only
        // the currency key can refuse the row.
        (_a, b) => ins(d(), 'account_card_links', row.link(nid('l'), b.u, b.K, b.B, { role: 'other', currency: 'GBP' })),
        (_a, b) => ins(d(), 'account_card_links', row.link(nid('l'), b.u, b.K, b.B, { role: 'other', currency: 'HKD' })),
      ],
      [
        'payment_channels (provider_institution_id, user_id) → institutions',
        (a, b) => ins(d(), 'payment_channels', row.channel(nid('ch'), b.u, { provider_institution_id: a.I })),
        (_a, b) => ins(d(), 'payment_channels', row.channel(nid('ch'), b.u, { provider_institution_id: b.I })),
      ],
      [
        'payment_channels (balance_account_id, user_id) → accounts',
        (a, b) => ins(d(), 'payment_channels', row.channel(nid('ch'), b.u, { balance_account_id: a.W })),
        (_a, b) => ins(d(), 'payment_channels', row.channel(nid('ch'), b.u, { balance_account_id: b.W })),
      ],
      [
        'payment_channel_sources (channel_id, user_id) → payment_channels',
        (a, b) => ins(d(), 'payment_channel_sources', row.source(nid('s'), b.u, a.PP, { card_id: b.P })),
        (_a, b) => ins(d(), 'payment_channel_sources', row.source(nid('s'), b.u, b.PP, { card_id: b.P })),
      ],
      [
        'payment_channel_sources (card_id, user_id) → cards',
        (a, b) => ins(d(), 'payment_channel_sources', row.source(nid('s'), b.u, b.AP, { card_id: a.P })),
        (_a, b) => ins(d(), 'payment_channel_sources', row.source(nid('s'), b.u, b.AP, { card_id: b.P })),
      ],
      [
        'payment_channel_sources (account_id, user_id) → accounts',
        (a, b) => ins(d(), 'payment_channel_sources', row.source(nid('s'), b.u, b.PP, { account_id: a.W })),
        (_a, b) => ins(d(), 'payment_channel_sources', row.source(nid('s'), b.u, b.PP, { account_id: b.W })),
      ],
    ];

    for (const [name, bad, good] of CASES) {
      it(name, async () => {
        const a = await seed(d());
        const b = await seed(d());
        await fk(bad(a, b));
        await good(a, b);
      });
    }

    it('a row cannot claim another user while pointing at its own parents either', async () => {
      // user_id = a, references = b's rows: refused by the same keys from the other side.
      const a = await seed(d());
      const b = await seed(d());
      await fk(ins(d(), 'account_card_links', row.link(nid('l'), a.u, b.K, b.W, { role: 'other' })));
      await fk(ins(d(), 'payment_channel_sources', row.source(nid('s'), a.u, b.PP, { account_id: b.W })));
      await fk(ins(d(), 'account_currencies', row.currency(b.B, a.u, 'USD')));
    });
  });

  describe('DB-2 optional references', () => {
    it('NULL in a referencing column skips the foreign key (MATCH SIMPLE)', async () => {
      const s = await seed(d());
      // currency NULL: the (account_id, user_id, currency) key is not checked.
      await ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.P, s.B, { role: 'top_up_source', currency: null }));
      // source by account only / by card only.
      await ins(d(), 'payment_channel_sources', row.source(nid('s'), s.u, s.PP, { account_id: s.W, card_id: null }));
      await ins(d(), 'payment_channel_sources', row.source(nid('s'), s.u, s.PP, { card_id: s.P, account_id: null }));
      // channel without provider or balance account; institution without a country.
      await ins(d(), 'payment_channels', row.channel(nid('ch'), s.u, { channel_type: 'other', provider_institution_id: null, balance_account_id: null }));
      await ins(d(), 'institutions', row.institution(nid('i'), s.u, { country: null }));
      expect(await count(d(), 'account_card_links', 'user_id = ? AND currency IS NULL', [s.u])).toBe(4);
    });
  });

  describe('DB-3 NO ACTION refuses deleting a parent on its own', () => {
    it('an institution still used by an account, a card or a channel', async () => {
      const s = await seed(d());
      await fk(d().run('DELETE FROM institutions WHERE id = ?', [s.I])); // accounts + cards
      // One reference kind at a time.
      const onlyAccount = nid('i');
      await ins(d(), 'institutions', row.institution(onlyAccount, s.u, { name_key: onlyAccount }));
      await ins(d(), 'accounts', row.account(nid('a'), s.u, onlyAccount));
      await fk(d().run('DELETE FROM institutions WHERE id = ?', [onlyAccount]));
      const onlyCard = nid('i');
      await ins(d(), 'institutions', row.institution(onlyCard, s.u, { name_key: onlyCard }));
      await ins(d(), 'cards', row.card(nid('c'), s.u, onlyCard));
      await fk(d().run('DELETE FROM institutions WHERE id = ?', [onlyCard]));
      const onlyChannel = nid('i');
      await ins(d(), 'institutions', row.institution(onlyChannel, s.u, { name_key: onlyChannel }));
      await ins(d(), 'payment_channels', row.channel(nid('ch'), s.u, { provider_institution_id: onlyChannel }));
      await fk(d().run('DELETE FROM institutions WHERE id = ?', [onlyChannel]));
      expect(await count(d(), 'institutions', 'user_id = ?', [s.u])).toBe(5);
      // Unused: deletes.
      const unused = nid('i');
      await ins(d(), 'institutions', row.institution(unused, s.u, { name_key: unused }));
      await d().run('DELETE FROM institutions WHERE id = ?', [unused]);
      expect(await count(d(), 'institutions', 'id = ?', [unused])).toBe(0);
    });

    it('an account currency still used by a currency-scoped link', async () => {
      const s = await seed(d());
      await fk(d().run('DELETE FROM account_currencies WHERE account_id = ? AND currency = ?', [s.W, 'EUR']));
      expect(await count(d(), 'account_currencies', 'account_id = ? AND currency = ?', [s.W, 'EUR'])).toBe(1);
      await d().run('DELETE FROM account_currencies WHERE account_id = ? AND currency = ?', [s.W, 'GBP']); // unused
      expect(await count(d(), 'account_currencies', 'account_id = ?', [s.W])).toBe(2);
    });

    it('an account used as a channel balance account (deletable once released)', async () => {
      const s = await seed(d());
      await fk(d().run('DELETE FROM accounts WHERE id = ?', [s.E]));
      expect(await count(d(), 'accounts', 'id = ?', [s.E])).toBe(1);
      await d().run('UPDATE payment_channels SET balance_account_id = NULL WHERE id = ?', [s.PP]);
      await d().run('DELETE FROM accounts WHERE id = ?', [s.E]);
      expect(await count(d(), 'account_currencies', 'account_id = ?', [s.E])).toBe(0);
    });
  });

  describe('DB-4 NO ACTION and CASCADE in one statement', () => {
    it('deleting an account removes its currencies, currency-scoped links and channel sources', async () => {
      const s = await seed(d());
      await ins(d(), 'payment_channel_sources', row.source(nid('s'), s.u, s.PP, { account_id: s.W }));
      await d().run('DELETE FROM accounts WHERE id = ?', [s.W]);
      expect(await count(d(), 'account_currencies', 'account_id = ?', [s.W])).toBe(0);
      expect(await count(d(), 'account_card_links', 'account_id = ?', [s.W])).toBe(0); // incl. the EUR-scoped one
      expect(await count(d(), 'payment_channel_sources', 'account_id = ?', [s.W])).toBe(0);
      expect(await count(d(), 'cards', 'id = ?', [s.K])).toBe(1);
      expect(await d().all('PRAGMA foreign_key_check')).toEqual([]);
    });

    it("deleting a user empties every user_id CASCADE table for that user, keeps the audit trail, leaves other users alone", async () => {
      const a = await seed(d());
      const b = await seed(d());
      const tables = await userTables(d());
      for (const t of [...M2_TABLES, 'sessions', 'passkeys', 'recovery_codes']) expect(tables).toContain(t);
      // audit_log is not one of them: it is kept by its own retention policy (DATA_MODEL §6).
      expect(tables).not.toContain('audit_log');
      const auditBefore = await count(d(), 'audit_log', 'user_id = ?', [a.u]);
      expect(auditBefore).toBeGreaterThan(0);
      const before = await rowsOfUser(d(), tables, b.u);
      // The M3 ledger tables are empty here; their cascade with data is DEL-4 (m3-schema.test.ts).
      const seeded = Object.entries(await rowsOfUser(d(), tables, a.u)).filter(([t]) => !(M3_TABLES as readonly string[]).includes(t));
      expect(seeded.every(([, n]) => n > 0)).toBe(true);

      await d().run('DELETE FROM users WHERE id = ?', [a.u]);

      expect(Object.values(await rowsOfUser(d(), tables, a.u)).every((n) => n === 0)).toBe(true);
      expect(await rowsOfUser(d(), tables, b.u)).toEqual(before);
      // The deleted user's audit trail stays, still naming the (now deleted) user id.
      expect(await count(d(), 'audit_log', 'user_id = ?', [a.u])).toBe(auditBefore);
      expect(await count(d(), 'users', 'id = ?', [a.u])).toBe(0);
      expect(await d().all('PRAGMA foreign_key_check')).toEqual([]);
    });
  });

  describe('DB-5 CASCADE results', () => {
    it('deleting a card removes its links and channel sources; the channels stay', async () => {
      const s = await seed(d());
      await d().run('DELETE FROM cards WHERE id = ?', [s.K]);
      expect(await count(d(), 'account_card_links', 'card_id = ?', [s.K])).toBe(0);
      expect(await count(d(), 'payment_channel_sources', 'card_id = ?', [s.K])).toBe(0);
      expect(await count(d(), 'payment_channels', 'id IN (?, ?)', [s.PP, s.AP])).toBe(2);
      expect(await count(d(), 'payment_channel_sources', 'id = ?', [s.S_PPB])).toBe(1);
      expect(await count(d(), 'accounts', 'id IN (?, ?)', [s.W, s.B])).toBe(2);
    });

    it('deleting a channel removes its sources; the cards and accounts stay', async () => {
      const s = await seed(d());
      await d().run('DELETE FROM payment_channels WHERE id = ?', [s.PP]);
      expect(await count(d(), 'payment_channel_sources', 'channel_id = ?', [s.PP])).toBe(0);
      expect(await count(d(), 'payment_channel_sources', 'channel_id = ?', [s.AP])).toBe(1);
      expect(await count(d(), 'cards', 'id = ?', [s.K])).toBe(1);
      expect(await count(d(), 'accounts', 'id IN (?, ?)', [s.B, s.E])).toBe(2);
    });
  });

  describe('DB-6 partial unique indexes', () => {
    it('one default currency per account', async () => {
      const s = await seed(d());
      await uniqueFails(ins(d(), 'account_currencies', row.currency(s.W, s.u, 'JPY', { is_default: 1 })), 'account_currencies.account_id');
      await ins(d(), 'account_currencies', row.currency(s.W, s.u, 'JPY', { is_default: 0 }));
      // A repeated currency: the (account_id, user_id, currency) key index fires before the primary key.
      await uniqueFails(ins(d(), 'account_currencies', row.currency(s.W, s.u, 'JPY')), 'account_currencies.account_id, account_currencies.user_id, account_currencies.currency');
    });

    it('one default spending source per card and currency scope', async () => {
      const s = await seed(d());
      // K already has a default for "all currencies".
      await uniqueFails(ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.K, s.E, { is_default: 1 })), "index 'account_card_links_default_uq'");
      // A different scope (USD only) may have its own default; a second USD default may not.
      await ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.K, s.E, { currency: 'USD', is_default: 1 }));
      await uniqueFails(ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.K, s.W, { currency: 'USD', is_default: 1 })), "index 'account_card_links_default_uq'");
      await ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.K, s.W, { currency: 'USD', is_default: 0 }));
    });

    it('one unfinished link per (card, account, currency scope, role); ended links may repeat', async () => {
      const s = await seed(d());
      // L_KB: K→B top_up_source, all currencies, active.
      await uniqueFails(ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.K, s.B, { role: 'top_up_source' })), "index 'account_card_links_open_uq'");
      await uniqueFails(ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.K, s.B, { role: 'top_up_source', status: 'suspended' })), "index 'account_card_links_open_uq'");
      // Other role or another currency scope: a different combination.
      await ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.K, s.B, { role: 'spending_source' }));
      await ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.K, s.B, { role: 'top_up_source', currency: 'HKD' }));
      // Ended history rows never collide, with each other or with the open link.
      await ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.K, s.B, { role: 'top_up_source', status: 'ended', ended_on: '2025-01-01' }));
      await ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.K, s.B, { role: 'top_up_source', status: 'ended', ended_on: '2025-02-01' }));
      // End the open one, then the combination can be linked again.
      await d().run("UPDATE account_card_links SET status = 'ended', ended_on = '2026-01-01' WHERE id = ?", [s.L_KB]);
      await ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.K, s.B, { role: 'top_up_source' }));
      expect(await count(d(), 'account_card_links', "card_id = ? AND account_id = ? AND role = 'top_up_source' AND currency IS NULL", [s.K, s.B])).toBe(4);
    });

    it('one default source per channel; one active record per channel and source', async () => {
      const s = await seed(d());
      await uniqueFails(ins(d(), 'payment_channel_sources', row.source(nid('s'), s.u, s.PP, { account_id: s.W, is_default: 1 })), 'payment_channel_sources.channel_id');
      await ins(d(), 'payment_channel_sources', row.source(nid('s'), s.u, s.PP, { account_id: s.W, is_default: 0 }));
      // Same card / account again while active: refused; ended history: allowed (twice).
      await uniqueFails(ins(d(), 'payment_channel_sources', row.source(nid('s'), s.u, s.PP, { card_id: s.K })), 'payment_channel_sources.channel_id, payment_channel_sources.card_id');
      await uniqueFails(ins(d(), 'payment_channel_sources', row.source(nid('s'), s.u, s.PP, { account_id: s.B })), 'payment_channel_sources.channel_id, payment_channel_sources.account_id');
      for (let i = 0; i < 2; i++) {
        await ins(d(), 'payment_channel_sources', row.source(nid('s'), s.u, s.PP, { card_id: s.K, status: 'ended' }));
        await ins(d(), 'payment_channel_sources', row.source(nid('s'), s.u, s.PP, { account_id: s.B, status: 'ended' }));
      }
      // The same card in another channel is a different record.
      await ins(d(), 'payment_channel_sources', row.source(nid('s'), s.u, s.AP, { card_id: s.P }));
    });

    it('an account is the balance account of at most one channel; channel names are unique per user', async () => {
      const s = await seed(d());
      await uniqueFails(ins(d(), 'payment_channels', row.channel(nid('ch'), s.u, { balance_account_id: s.E })), 'payment_channels.balance_account_id');
      await ins(d(), 'payment_channels', row.channel(nid('ch'), s.u, { balance_account_id: null }));
      await ins(d(), 'payment_channels', row.channel(nid('ch'), s.u, { balance_account_id: null }));
      await uniqueFails(ins(d(), 'payment_channels', row.channel(nid('ch'), s.u, { name: 'PAYPAL', name_key: 'paypal' })), 'payment_channels.user_id, payment_channels.name_key');
      const other = await seed(d());
      expect(await count(d(), 'payment_channels', "user_id = ? AND name_key = 'paypal'", [other.u])).toBe(1);
    });
  });

  describe('DB-7 expression indexes (ifnull)', () => {
    it('two unfinished all-currency links of one combination collide (NULL is not distinct here)', async () => {
      const s = await seed(d());
      await ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.P, s.B, { role: 'other', currency: null }));
      await uniqueFails(ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.P, s.B, { role: 'other', currency: null })), "index 'account_card_links_open_uq'");
      // P→S is P's all-currency default: a second all-currency default for P collides.
      await uniqueFails(ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.P, s.B, { currency: null, is_default: 1 })), "index 'account_card_links_default_uq'");
    });

    it('two same-named institutions without a country collide; with different countries they do not', async () => {
      const s = await seed(d());
      await ins(d(), 'institutions', row.institution(nid('i'), s.u, { name: 'Revolut', name_key: 'revolut', country: null }));
      await uniqueFails(ins(d(), 'institutions', row.institution(nid('i'), s.u, { name: ' REVOLUT ', name_key: 'revolut', country: null })), "index 'institutions_user_name_country_uq'");
      await ins(d(), 'institutions', row.institution(nid('i'), s.u, { name: 'Revolut', name_key: 'revolut', country: 'LT' }));
      await uniqueFails(ins(d(), 'institutions', row.institution(nid('i'), s.u, { name: 'Revolut', name_key: 'revolut', country: 'LT' })), "index 'institutions_user_name_country_uq'");
      await ins(d(), 'institutions', row.institution(nid('i'), s.u, { name: 'Revolut', name_key: 'revolut', country: 'GB' }));
      // Another user may use the same name.
      const other = await seed(d());
      await ins(d(), 'institutions', row.institution(nid('i'), other.u, { name: 'Revolut', name_key: 'revolut', country: null }));
    });
  });

  describe('DB-8 CHECK constraints', () => {
    type Case = [string, (s: Seed) => Promise<unknown>, string];
    const CASES: Case[] = [
      // cards
      ['credit card', (s) => ins(d(), 'cards', row.card(nid('c'), s.u, s.I, { card_type: 'credit' })), 'cards_card_type_ck'],
      ['last4 "123"', (s) => ins(d(), 'cards', row.card(nid('c'), s.u, s.I, { last4: '123' })), 'cards_last4_ck'],
      ['last4 "12345"', (s) => ins(d(), 'cards', row.card(nid('c'), s.u, s.I, { last4: '12345' })), 'cards_last4_ck'],
      ['last4 "abcd"', (s) => ins(d(), 'cards', row.card(nid('c'), s.u, s.I, { last4: 'abcd' })), 'cards_last4_ck'],
      ['network', (s) => ins(d(), 'cards', row.card(nid('c'), s.u, s.I, { network: 'diners club' })), 'cards_network_ck'],
      ['form', (s) => ins(d(), 'cards', row.card(nid('c'), s.u, s.I, { form: 'metal' })), 'cards_form_ck'],
      ['expires_on "07/28"', (s) => ins(d(), 'cards', row.card(nid('c'), s.u, s.I, { expires_on: '07/28' })), 'cards_expires_on_ck'],
      ['expires_on "2028-1"', (s) => ins(d(), 'cards', row.card(nid('c'), s.u, s.I, { expires_on: '2028-1' })), 'cards_expires_on_ck'],
      ['expires_on "2028-00"', (s) => ins(d(), 'cards', row.card(nid('c'), s.u, s.I, { expires_on: '2028-00' })), 'cards_expires_on_ck'],
      ['expires_on "2028-13"', (s) => ins(d(), 'cards', row.card(nid('c'), s.u, s.I, { expires_on: '2028-13' })), 'cards_expires_on_ck'],
      ['expires_on "2028-19"', (s) => ins(d(), 'cards', row.card(nid('c'), s.u, s.I, { expires_on: '2028-19' })), 'cards_expires_on_ck'],
      ['expires_on "2028-012"', (s) => ins(d(), 'cards', row.card(nid('c'), s.u, s.I, { expires_on: '2028-012' })), 'cards_expires_on_ck'],
      ['home_region lower case', (s) => d().run("UPDATE user_preferences SET home_region = 'hk' WHERE user_id = ?", [s.u]), 'user_preferences_home_region_ck'],
      ['home_region "CHN"', (s) => d().run("UPDATE user_preferences SET home_region = 'CHN' WHERE user_id = ?", [s.u]), 'user_preferences_home_region_ck'],
      ['issuing_country lower case', (s) => ins(d(), 'cards', row.card(nid('c'), s.u, s.I, { issuing_country: 'be' })), 'cards_issuing_country_ck'],
      ['card status', (s) => ins(d(), 'cards', row.card(nid('c'), s.u, s.I, { status: 'lost' })), 'cards_status_ck'],
      // payment channels and sources
      ['bank_transfer channel', (s) => ins(d(), 'payment_channels', row.channel(nid('ch'), s.u, { channel_type: 'bank_transfer' })), 'payment_channels_type_ck'],
      ['balance account on a device wallet', (s) => ins(d(), 'payment_channels', row.channel(nid('ch'), s.u, { channel_type: 'device_wallet', balance_account_id: s.W })), 'payment_channels_balance_ck'],
      ['region "USA"', (s) => ins(d(), 'payment_channels', row.channel(nid('ch'), s.u, { region: 'USA' })), 'payment_channels_region_ck'],
      ['channel status', (s) => ins(d(), 'payment_channels', row.channel(nid('ch'), s.u, { status: 'deleted' })), 'payment_channels_status_ck'],
      ['source with card and account', (s) => ins(d(), 'payment_channel_sources', row.source(nid('s'), s.u, s.PP, { card_id: s.P, account_id: s.W })), 'payment_channel_sources_xor_ck'],
      ['source with neither', (s) => ins(d(), 'payment_channel_sources', row.source(nid('s'), s.u, s.PP)), 'payment_channel_sources_xor_ck'],
      ['ended default source', (s) => ins(d(), 'payment_channel_sources', row.source(nid('s'), s.u, s.AP, { card_id: s.P, status: 'ended', is_default: 1 })), 'payment_channel_sources_default_ck'],
      ['source status', (s) => ins(d(), 'payment_channel_sources', row.source(nid('s'), s.u, s.AP, { card_id: s.P, status: 'paused' })), 'payment_channel_sources_status_ck'],
      ['ending the default source without clearing it', (s) => d().run("UPDATE payment_channel_sources SET status = 'ended' WHERE id = ?", [s.S_PPK]), 'payment_channel_sources_default_ck'],
      // links
      ['default top_up_source', (s) => ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.P, s.B, { role: 'top_up_source', is_default: 1 })), 'account_card_links_default_ck'],
      ['default "other" link', (s) => ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.P, s.B, { role: 'other', is_default: 1 })), 'account_card_links_default_ck'],
      ['default suspended link', (s) => ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.P, s.B, { status: 'suspended', is_default: 1, currency: 'HKD' })), 'account_card_links_default_ck'],
      ['suspending the default link without clearing it', (s) => d().run("UPDATE account_card_links SET status = 'suspended' WHERE id = ?", [s.L_KW]), 'account_card_links_default_ck'],
      ['ended_on on an active link', (s) => ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.P, s.B, { role: 'other', ended_on: '2026-01-01' })), 'account_card_links_ended_ck'],
      ['priority 0', (s) => ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.P, s.B, { role: 'other', priority: 0 })), 'account_card_links_priority_ck'],
      ['link role', (s) => ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.P, s.B, { role: 'owner' })), 'account_card_links_role_ck'],
      ['link status', (s) => ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.P, s.B, { role: 'other', status: 'paused' })), 'account_card_links_status_ck'],
      ['link is_default 2', (s) => ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.P, s.B, { currency: 'HKD', is_default: 2 })), 'account_card_links_is_default_ck'],
      // accounts
      ['credit account', (s) => ins(d(), 'accounts', row.account(nid('a'), s.u, s.I, { account_type: 'credit' })), 'accounts_type_ck'],
      ['investment account', (s) => ins(d(), 'accounts', row.account(nid('a'), s.u, s.I, { account_type: 'investment' })), 'accounts_type_ck'],
      ['cash account', (s) => ins(d(), 'accounts', row.account(nid('a'), s.u, s.I, { account_type: 'cash' })), 'accounts_type_ck'],
      ['deposit_kind on an e_money account', (s) => ins(d(), 'accounts', row.account(nid('a'), s.u, s.I, { account_type: 'e_money', deposit_kind: 'savings' })), 'accounts_deposit_kind_ck'],
      ['unknown deposit_kind', (s) => ins(d(), 'accounts', row.account(nid('a'), s.u, s.I, { deposit_kind: 'term' })), 'accounts_deposit_kind_ck'],
      ['number_hint "12345"', (s) => ins(d(), 'accounts', row.account(nid('a'), s.u, s.I, { number_hint: '12345' })), 'accounts_number_hint_ck'],
      ['number_hint "A-1"', (s) => ins(d(), 'accounts', row.account(nid('a'), s.u, s.I, { number_hint: 'A-1' })), 'accounts_number_hint_ck'],
      ['number_hint "12 3"', (s) => ins(d(), 'accounts', row.account(nid('a'), s.u, s.I, { number_hint: '12 3' })), 'accounts_number_hint_ck'],
      ['number_hint ""', (s) => ins(d(), 'accounts', row.account(nid('a'), s.u, s.I, { number_hint: '' })), 'accounts_number_hint_ck'],
      ['number_hint as a full IBAN', (s) => ins(d(), 'accounts', row.account(nid('a'), s.u, s.I, { number_hint: 'GB33BUKB20201555555555' })), 'accounts_number_hint_ck'],
      ['account_country lower case', (s) => ins(d(), 'accounts', row.account(nid('a'), s.u, s.I, { account_country: 'be' })), 'accounts_country_ck'],
      ['closed before opened', (s) => ins(d(), 'accounts', row.account(nid('a'), s.u, s.I, { opened_on: '2024-03-01', closed_on: '2024-02-29' })), 'accounts_dates_ck'],
      ['account status', (s) => ins(d(), 'accounts', row.account(nid('a'), s.u, s.I, { status: 'dormant' })), 'accounts_status_ck'],
      // account currencies
      ['currency "usd"', (s) => ins(d(), 'account_currencies', row.currency(s.B, s.u, 'usd')), 'account_currencies_currency_ck'],
      ['currency "US"', (s) => ins(d(), 'account_currencies', row.currency(s.B, s.u, 'US')), 'account_currencies_currency_ck'],
      ['closed default currency', (s) => ins(d(), 'account_currencies', row.currency(s.E, s.u, 'EUR', { status: 'closed', is_default: 1 })), 'account_currencies_default_active_ck'],
      ['closing the default currency without moving the default', (s) => d().run("UPDATE account_currencies SET status = 'closed' WHERE account_id = ? AND currency = 'USD'", [s.W]), 'account_currencies_default_active_ck'],
      ['currency status', (s) => ins(d(), 'account_currencies', row.currency(s.B, s.u, 'USD', { status: 'frozen' })), 'account_currencies_status_ck'],
      // institutions
      ['institution type', (s) => ins(d(), 'institutions', row.institution(nid('i'), s.u, { institution_type: 'broker' })), 'institutions_type_ck'],
      ['institution country "GBR"', (s) => ins(d(), 'institutions', row.institution(nid('i'), s.u, { country: 'GBR' })), 'institutions_country_ck'],
      ['institution status', (s) => ins(d(), 'institutions', row.institution(nid('i'), s.u, { status: 'deleted' })), 'institutions_status_ck'],
    ];

    it(`refuses ${CASES.length} invalid rows, each by the expected constraint`, async () => {
      const s = await seed(d());
      for (const [name, run, constraint] of CASES) {
        await checkFails(run(s), constraint).catch((e: unknown) => {
          throw new Error(`${name}: ${errorText(e)}`);
        });
      }
    });

    it('NOT NULL: institution_id and account_country are required', async () => {
      const s = await seed(d());
      await notNull(ins(d(), 'accounts', row.account(nid('a'), s.u, s.I, { institution_id: null })), 'accounts.institution_id');
      await notNull(ins(d(), 'accounts', row.account(nid('a'), s.u, s.I, { account_country: null })), 'accounts.account_country');
      await notNull(ins(d(), 'cards', row.card(nid('c'), s.u, s.I, { last4: null })), 'cards.last4');
    });

    it('accepts the valid edge values', async () => {
      const s = await seed(d());
      for (const hint of ['1234', 'AB12', '7', 'z9']) await ins(d(), 'accounts', row.account(nid('a'), s.u, s.I, { number_hint: hint }));
      await ins(d(), 'accounts', row.account(nid('a'), s.u, s.I, { opened_on: '2024-03-01', closed_on: '2024-03-01' }));
      for (const type of ['bank', 'e_money', 'stored_value', 'other']) await ins(d(), 'accounts', row.account(nid('a'), s.u, s.I, { account_type: type }));
      await ins(d(), 'cards', row.card(nid('c'), s.u, s.I, { last4: '0000', form: 'virtual', expires_on: '2030-12', network: 'unionpay' }));
      for (const month of ['2028-01', '2028-09', '2028-10', '2028-12']) await ins(d(), 'cards', row.card(nid('c'), s.u, s.I, { expires_on: month }));
      await ins(d(), 'account_card_links', row.link(nid('l'), s.u, s.P, s.B, { role: 'other', priority: 1, status: 'ended', ended_on: '2026-01-01' }));
      // Clearing the default first, then suspending: allowed.
      await d().run("UPDATE account_card_links SET is_default = 0, status = 'suspended' WHERE id = ?", [s.L_KW]);
    });
  });

  describe('user preferences: home_region per user', () => {
    it('each user has an independent home_region', async () => {
      const a = await seed(d());
      const b = await seed(d());
      await d().run("UPDATE user_preferences SET home_region = 'GB', updated_at = ? WHERE user_id = ?", [T + 1, a.u]);
      const regions = async () =>
        Object.fromEntries((await d().all('SELECT user_id, home_region FROM user_preferences WHERE user_id IN (?, ?)', [a.u, b.u])).map((r) => [r.user_id, r.home_region]));
      expect(await regions()).toEqual({ [a.u]: 'GB', [b.u]: 'HK' });
      await d().run("UPDATE user_preferences SET home_region = 'SG' WHERE user_id = ?", [b.u]);
      expect(await regions()).toEqual({ [a.u]: 'GB', [b.u]: 'SG' });
      // Nothing about home_region lives in the global settings table.
      expect(await count(d(), 'settings', "key LIKE '%home_region%'")).toBe(0);
    });

    it('defaults to CN, one row per user, only for existing users', async () => {
      const u = nid('u');
      await ins(d(), 'users', row.user(u));
      await ins(d(), 'user_preferences', { user_id: u, created_at: T, updated_at: T });
      expect((await one(d(), 'SELECT home_region FROM user_preferences WHERE user_id = ?', [u]))!.home_region).toBe('CN');
      await uniqueFails(ins(d(), 'user_preferences', { user_id: u, home_region: 'HK', created_at: T, updated_at: T }), 'user_preferences.user_id');
      await fk(ins(d(), 'user_preferences', { user_id: 'no-such-user', created_at: T, updated_at: T }));
      const v = nid('u');
      await ins(d(), 'users', row.user(v));
      await notNull(ins(d(), 'user_preferences', { user_id: v, home_region: null, created_at: T, updated_at: T }), 'user_preferences.home_region');
    });
  });

  describe('balance account type (triggers)', () => {
    it('INSERT: the balance account must be e_money or stored_value', async () => {
      const s = await seed(d()); // PP already uses E (e_money)
      expect(await rejection(ins(d(), 'payment_channels', row.channel(nid('ch'), s.u, { balance_account_id: s.B })))).toMatch(BALANCE_KIND); // bank
      const other = nid('a');
      await ins(d(), 'accounts', row.account(other, s.u, s.I, { account_type: 'other' }));
      expect(await rejection(ins(d(), 'payment_channels', row.channel(nid('ch'), s.u, { balance_account_id: other })))).toMatch(BALANCE_KIND);
      await ins(d(), 'payment_channels', row.channel(nid('ch'), s.u, { balance_account_id: s.S })); // stored_value
      await ins(d(), 'payment_channels', row.channel(nid('ch'), s.u, { balance_account_id: s.W })); // e_money
    });

    it('UPDATE: pointing a channel at a bank account is refused; other updates are not affected', async () => {
      const s = await seed(d());
      const ch = nid('ch');
      await ins(d(), 'payment_channels', row.channel(ch, s.u));
      expect(await rejection(d().run('UPDATE payment_channels SET balance_account_id = ? WHERE id = ?', [s.B, ch]))).toMatch(BALANCE_KIND);
      expect((await one(d(), 'SELECT balance_account_id AS v FROM payment_channels WHERE id = ?', [ch]))!.v).toBeNull();
      await d().run('UPDATE payment_channels SET balance_account_id = ? WHERE id = ?', [s.S, ch]);
      await d().run("UPDATE payment_channels SET name = 'Renamed', notes = 'x' WHERE id = ?", [s.PP]);
      expect(await rejection(d().run('UPDATE payment_channels SET balance_account_id = ? WHERE id = ?', [s.B, s.PP]))).toMatch(BALANCE_KIND);
      expect((await one(d(), 'SELECT balance_account_id AS v FROM payment_channels WHERE id = ?', [s.PP]))!.v).toBe(s.E);
    });

    it('UPDATE of the account: a balance account cannot become another type until released', async () => {
      const s = await seed(d());
      expect(await rejection(d().run("UPDATE accounts SET account_type = 'bank' WHERE id = ?", [s.E]))).toMatch(BALANCE_KIND);
      expect((await one(d(), 'SELECT account_type AS v FROM accounts WHERE id = ?', [s.E]))!.v).toBe('e_money');
      await d().run("UPDATE accounts SET account_type = 'stored_value' WHERE id = ?", [s.E]);
      await d().run("UPDATE accounts SET account_type = 'other' WHERE id = ?", [s.W]); // not a balance account
      await d().run('UPDATE payment_channels SET balance_account_id = NULL WHERE id = ?', [s.PP]);
      await d().run("UPDATE accounts SET account_type = 'bank' WHERE id = ?", [s.E]);
    });

    it('missing accounts and accounts of another user are left to the composite foreign key', async () => {
      const a = await seed(d());
      const b = await seed(d());
      await fk(ins(d(), 'payment_channels', row.channel(nid('ch'), b.u, { balance_account_id: 'no-such-account' })));
      await fk(ins(d(), 'payment_channels', row.channel(nid('ch'), b.u, { balance_account_id: a.S }))); // stored_value of user a
      const ch = nid('ch');
      await ins(d(), 'payment_channels', row.channel(ch, b.u));
      await fk(d().run('UPDATE payment_channels SET balance_account_id = ? WHERE id = ?', [a.W, ch]));
    });

    it('a trigger failure rolls back the whole batch', async () => {
      const s = await seed(d());
      const ch = nid('ch');
      expect(
        await rejection(
          d().batch([
            `UPDATE payment_channels SET balance_account_id = NULL WHERE id = '${s.PP}'`,
            `INSERT INTO payment_channels (id, user_id, name, name_key, channel_type, balance_account_id, created_at, updated_at) VALUES ('${ch}', '${s.u}', 'X', 'x', 'payment_service', '${s.B}', ${T}, ${T})`,
          ]),
        ),
      ).toMatch(BALANCE_KIND);
      expect((await one(d(), 'SELECT balance_account_id AS v FROM payment_channels WHERE id = ?', [s.PP]))!.v).toBe(s.E);
      expect(await count(d(), 'payment_channels', 'id = ?', [ch])).toBe(0);
    });
  });

  describe('institution_id is immutable (trigger)', () => {
    it('INSERT works; UPDATE of every other column works', async () => {
      const s = await seed(d()); // seed inserted the accounts
      await d().run(
        "UPDATE accounts SET name = 'Renamed', name_key = 'renamed', account_country = 'LT', status = 'frozen', number_hint = '9', notes = 'n', sort = 3, opened_on = '2024-01-01', updated_at = ? WHERE id = ?",
        [T + 1, s.W],
      );
      await d().run("UPDATE accounts SET account_type = 'other', deposit_kind = NULL WHERE id = ?", [s.B]);
      expect(await one(d(), 'SELECT name, account_country, status, institution_id FROM accounts WHERE id = ?', [s.W])).toEqual({
        name: 'Renamed',
        account_country: 'LT',
        status: 'frozen',
        institution_id: s.I,
      });
    });

    it('UPDATE of institution_id is refused, also together with other columns; the row stays as it was', async () => {
      const s = await seed(d());
      const before = await one(d(), 'SELECT * FROM accounts WHERE id = ?', [s.W]);
      expect(await rejection(d().run('UPDATE accounts SET institution_id = ? WHERE id = ?', [s.I2, s.W]))).toMatch(INSTITUTION_IMMUTABLE);
      expect(await rejection(d().run("UPDATE accounts SET name = 'Moved', institution_id = ? WHERE id = ?", [s.I2, s.W]))).toMatch(INSTITUTION_IMMUTABLE);
      // Bulk update: one statement touching several accounts fails as a whole.
      expect(await rejection(d().run('UPDATE accounts SET institution_id = ? WHERE user_id = ?', [s.I2, s.u]))).toMatch(INSTITUTION_IMMUTABLE);
      expect(await one(d(), 'SELECT * FROM accounts WHERE id = ?', [s.W])).toEqual(before);
      expect(await count(d(), 'accounts', 'user_id = ? AND institution_id = ?', [s.u, s.I])).toBe(1);
    });

    it('re-setting the same institution is not a change', async () => {
      const s = await seed(d());
      await d().run('UPDATE accounts SET institution_id = institution_id WHERE id = ?', [s.W]);
      await d().run("UPDATE accounts SET institution_id = ?, name = 'Same institution' WHERE id = ?", [s.I, s.W]);
      expect((await one(d(), 'SELECT institution_id AS v FROM accounts WHERE id = ?', [s.W]))!.v).toBe(s.I);
    });

    it("another user's institution is refused too (the trigger fires before the foreign key)", async () => {
      const a = await seed(d());
      const b = await seed(d());
      expect(await rejection(d().run('UPDATE accounts SET institution_id = ? WHERE id = ?', [a.I, b.W]))).toMatch(/ACCOUNT_INSTITUTION_IMMUTABLE|FOREIGN KEY constraint failed/);
      expect((await one(d(), 'SELECT institution_id AS v FROM accounts WHERE id = ?', [b.W]))!.v).toBe(b.I);
    });

    it('a refused institution change rolls back the whole batch', async () => {
      const s = await seed(d());
      expect(
        await rejection(d().batch([`UPDATE accounts SET name = 'Batch rename' WHERE id = '${s.W}'`, `UPDATE accounts SET institution_id = '${s.I2}' WHERE id = '${s.W}'`])),
      ).toMatch(INSTITUTION_IMMUTABLE);
      expect((await one(d(), 'SELECT name, institution_id FROM accounts WHERE id = ?', [s.W]))).toEqual({ name: s.W, institution_id: s.I });
    });

    it('does not get in the way of deleting a user (cascades delete, they do not update)', async () => {
      const a = await seed(d());
      const b = await seed(d());
      await d().run('DELETE FROM users WHERE id = ?', [a.u]);
      expect(await count(d(), 'accounts', 'user_id = ?', [a.u])).toBe(0);
      expect(await count(d(), 'institutions', 'user_id = ?', [a.u])).toBe(0);
      expect(await count(d(), 'accounts', 'user_id = ?', [b.u])).toBe(4);
      expect(await d().all('PRAGMA foreign_key_check')).toEqual([]);
      // Deleting an account on its own is not an update either.
      await d().run('UPDATE payment_channels SET balance_account_id = NULL WHERE id = ?', [b.PP]);
      await d().run('DELETE FROM accounts WHERE id = ?', [b.E]);
    });
  });

  describe('DB-9 batch atomicity', () => {
    it('"clear old default + set new default" switches atomically', async () => {
      const s = await seed(d());
      const l2 = nid('l');
      await ins(d(), 'account_card_links', row.link(l2, s.u, s.K, s.B, { role: 'spending_source', priority: 1 }));
      await d().batch([`UPDATE account_card_links SET is_default = 0 WHERE id = '${s.L_KW}'`, `UPDATE account_card_links SET is_default = 1 WHERE id = '${l2}'`]);
      expect(Number((await one(d(), 'SELECT is_default AS v FROM account_card_links WHERE id = ?', [s.L_KW]))!.v)).toBe(0);
      expect(Number((await one(d(), 'SELECT is_default AS v FROM account_card_links WHERE id = ?', [l2]))!.v)).toBe(1);
    });

    it('rolls the whole batch back when its second statement breaks a constraint', async () => {
      const s = await seed(d());
      // The new "default" is the top-up link: the CHECK refuses it, so clearing the old default must be undone.
      expect(
        await rejection(d().batch([`UPDATE account_card_links SET is_default = 0 WHERE id = '${s.L_KW}'`, `UPDATE account_card_links SET is_default = 1 WHERE id = '${s.L_KB}'`])),
      ).toMatch(/CHECK constraint failed: account_card_links_default_ck/);
      expect(Number((await one(d(), 'SELECT is_default AS v FROM account_card_links WHERE id = ?', [s.L_KW]))!.v)).toBe(1);
      expect(Number((await one(d(), 'SELECT is_default AS v FROM account_card_links WHERE id = ?', [s.L_KB]))!.v)).toBe(0);
    });

    it('rolls back earlier successful statements when a later one fails (unique, foreign key)', async () => {
      const s = await seed(d());
      const l2 = nid('l');
      await ins(d(), 'account_card_links', row.link(l2, s.u, s.K, s.B, { role: 'spending_source' }));
      // Wrong order: setting the new default first collides with the old one.
      expect(
        await rejection(d().batch([`UPDATE account_card_links SET is_default = 1 WHERE id = '${l2}'`, `UPDATE account_card_links SET is_default = 0 WHERE id = '${s.L_KW}'`])),
      ).toMatch(/UNIQUE constraint failed/);
      // Two good statements, then a cross-user reference.
      expect(
        await rejection(
          d().batch([
            `UPDATE account_card_links SET is_default = 0 WHERE id = '${s.L_KW}'`,
            `UPDATE account_card_links SET is_default = 1 WHERE id = '${l2}'`,
            `INSERT INTO account_card_links (id, user_id, card_id, account_id, created_at, updated_at) VALUES ('${nid('l')}', '${s.u}', 'no-such-card', '${s.W}', ${T}, ${T})`,
          ]),
        ),
      ).toMatch(/FOREIGN KEY constraint failed/);
      expect((await d().all('SELECT id FROM account_card_links WHERE card_id = ? AND is_default = 1', [s.K])).map((r) => r.id)).toEqual([s.L_KW]);
    });

    it('prepaid card + stored-value account + default currency + default spending link: all or nothing', async () => {
      const s = await seed(d());
      const statements = (card: string, acc: string, linkCurrency: string) => [
        insertSqlLiteral('cards', row.card(card, s.u, s.I2, { card_type: 'prepaid', last4: '8888', issuing_country: 'HK' })),
        insertSqlLiteral('accounts', row.account(acc, s.u, s.I2, { account_type: 'stored_value', account_country: 'HK' })),
        insertSqlLiteral('account_currencies', row.currency(acc, s.u, 'HKD', { is_default: 1 })),
        insertSqlLiteral('account_card_links', row.link(nid('l'), s.u, card, acc, { role: 'spending_source', currency: linkCurrency === 'all' ? null : linkCurrency, is_default: 1 })),
      ];
      // The link names a currency the new account does not hold → nothing is created.
      const [c1, a1] = [nid('c'), nid('a')];
      expect(await rejection(d().batch(statements(c1, a1, 'USD')))).toMatch(/FOREIGN KEY constraint failed/);
      expect(await count(d(), 'cards', 'id = ?', [c1])).toBe(0);
      expect(await count(d(), 'accounts', 'id = ?', [a1])).toBe(0);
      expect(await count(d(), 'account_currencies', 'account_id = ?', [a1])).toBe(0);
      // Correct batch: the stored-value account is the card's default spending source.
      const [c2, a2] = [nid('c'), nid('a')];
      await d().batch(statements(c2, a2, 'all'));
      const link = await one(d(), 'SELECT l.role, l.is_default, l.currency, a.account_type FROM account_card_links l JOIN accounts a ON a.id = l.account_id WHERE l.card_id = ?', [c2]);
      expect(link).toEqual({ role: 'spending_source', is_default: 1, currency: null, account_type: 'stored_value' });
      // A top-up account is linked as top_up_source, and cannot be the default.
      await ins(d(), 'account_card_links', row.link(nid('l'), s.u, c2, s.B, { role: 'top_up_source' }));
      await checkFails(ins(d(), 'account_card_links', row.link(nid('l'), s.u, c2, s.W, { role: 'top_up_source', is_default: 1 })), 'account_card_links_default_ck');
    });
  });

  describe('DB-10 schema as built', () => {
    it('has exactly the M2 foreign-key matrix (DATA_MODEL §4)', async () => {
      for (const t of M2_TABLES) expect(await foreignKeys(d(), t), t).toEqual(sortFks(EXPECTED_FKS[t]));
    });

    it('every business reference includes user_id and its parent has a matching unique index (U-5)', async () => {
      for (const t of M2_TABLES) {
        for (const f of await foreignKeys(d(), t)) {
          if (f.table === 'users') continue;
          expect(f.from, `${t} → ${f.table}`).toContain('user_id');
          expect(f.to[f.from.indexOf('user_id')], `${t} → ${f.table}`).toBe('user_id');
          let found = false;
          for (const ix of await d().all(`PRAGMA index_list(${f.table})`)) {
            if (Number(ix.unique) !== 1 || Number(ix.partial) !== 0) continue;
            const cols = (await d().all(`PRAGMA index_info(${String(ix.name)})`)).sort((a, b) => Number(a.seqno) - Number(b.seqno)).map((r) => String(r.name));
            if (cols.join(',') === f.to.join(',')) found = true;
          }
          expect(found, `${f.table}(${f.to.join(', ')}) has a full unique index`).toBe(true);
        }
      }
    });

    it('has every index, with its exact columns, expressions and WHERE condition (R-3)', async () => {
      const rows = await d().all(
        `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name IN (${M2_TABLES.map(() => '?').join(', ')}) ORDER BY name`,
        [...M2_TABLES],
      );
      expect(Object.fromEntries(rows.map((r) => [String(r.name), norm(r.sql)]))).toEqual(EXPECTED_INDEXES);
      for (const t of M2_TABLES) {
        for (const ix of await d().all(`PRAGMA index_list(${t})`)) {
          const expected = EXPECTED_INDEXES[String(ix.name)];
          if (!expected) continue;
          expect(Number(ix.partial), String(ix.name)).toBe(/ WHERE /.test(expected) ? 1 : 0);
          expect(Number(ix.unique), String(ix.name)).toBe(expected.startsWith('CREATE UNIQUE') ? 1 : 0);
        }
      }
    });

    it('has the balance-account and institution triggers', async () => {
      // M2 tables only: the M3 ledger triggers are checked by m3-schema.test.ts.
      const rows = (await d().all("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")).filter((r) => (M2_TABLES as readonly string[]).includes(String(r.tbl_name)));
      expect(Object.fromEntries(rows.map((r) => [String(r.name), String(r.tbl_name)]))).toEqual(EXPECTED_TRIGGERS);
      for (const r of rows.filter((x) => String(x.name).includes('balance_kind'))) {
        expect(norm(r.sql)).toContain("NOT IN ('e_money', 'stored_value')");
        expect(norm(r.sql)).toContain("RAISE(ABORT, 'BALANCE_ACCOUNT_KIND");
      }
      const immutable = norm(rows.find((x) => x.name === 'accounts_institution_immutable')?.sql);
      expect(immutable).toContain('BEFORE UPDATE OF `institution_id` ON `accounts`');
      expect(immutable).toContain('WHEN NEW.`institution_id` IS NOT OLD.`institution_id`');
      expect(immutable).toContain("RAISE(ABORT, 'ACCOUNT_INSTITUTION_IMMUTABLE");
    });

    it('has every named CHECK constraint', async () => {
      for (const t of M2_TABLES) {
        const tableSql = norm((await one(d(), "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [t]))?.sql);
        const names = [...tableSql.matchAll(/CONSTRAINT "(\w+)" CHECK/g)].map((m) => m[1]);
        expect(names, t).toEqual(EXPECTED_CHECKS[t]);
      }
    });

    it('has no balance, amount, card-number or secret columns (A-5, C-5)', async () => {
      for (const t of M2_TABLES) {
        const cols = (await d().all(`PRAGMA table_info(${t})`)).map((r) => String(r.name));
        for (const bad of FORBIDDEN_COLUMNS) expect(cols, `${t}.${bad}`).not.toContain(bad);
      }
      const cardCols = (await d().all('PRAGMA table_info(cards)')).map((r) => String(r.name));
      expect(cardCols).not.toContain('account_id');
    });

    it('records the snapshot compared across engines', async () => {
      snapshots[engine] = await schemaSnapshot(d());
      expect(Object.keys(snapshots[engine]!)).toEqual([...M2_TABLES, 'triggers']);
    });
  });
});

/** INSERT with inlined literals, for batches (test values only — never user input). */
function insertSqlLiteral(table: string, r: Row): string {
  const lit = (v: unknown) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  return `INSERT INTO ${table} (${Object.keys(r).join(', ')}) VALUES (${Object.values(r).map(lit).join(', ')})`;
}

describe('DB-10 libsql and D1 build the same schema', () => {
  it('identical columns, defaults, indexes (incl. partial flags), foreign keys and table SQL', () => {
    expect(snapshots.libsql).toBeDefined();
    expect(snapshots.d1).toBeDefined();
    expect(snapshots.d1).toEqual(snapshots.libsql);
  });
});
