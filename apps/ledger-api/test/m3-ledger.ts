// M3 ledger test kit (M3-B1): the two engines, raw-row builders, and the three financial write
// chains of DATA_MODEL §10.10 (create, correct, void) built with drizzle's query builder.
//
// The chains are TEST HELPERS, not the transaction service (that is M3-B2): they take already
// decided inputs (ids, classification, exponents, carried entries) and only build the S0–S6
// statements, so the database guarantees of the chain — key row last and complete, all or
// nothing, gate G, version race — can be verified on both engines before any route exists.
import type { Client } from '@libsql/client';
import type { CorrectionKind, EntryDirection, RecordMode, TxnType } from '@xui/ledger-shared';
import { and, eq, isNotNull, lte, notExists, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { alias } from 'drizzle-orm/sqlite-core';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformProxy, unstable_splitSqlQuery } from 'wrangler';
import { MIGRATIONS_DIR, openV1Db, type DB } from '../src/db/client.ts';
import {
  accountCurrencies,
  accounts,
  auditLog,
  ledgerIdempotencyKeys,
  transactionEntries,
  transactionEvents,
  transactions,
  userPreferences,
  users,
} from '../src/db/schema.ts';
import { removeDbDir } from './helpers.ts';

// ------------------------------------------------------------------ write chains (DATA_MODEL §10.10)

type Statement = BatchItem<'sqlite'>;
export type Batch = [Statement, ...Statement[]];
const DAY = 86_400_000;
export const KEY_TTL_MS = 30 * DAY;

/** A bound value selected under a column name (INSERT … SELECT maps by position; the name documents it). */
const v = (value: unknown, as: string) => sql`${value}`.as(as);

export interface EventFactsIn {
  recordMode: RecordMode;
  occurredOn: string;
  occurredTime: string | null;
  postedOn: string | null;
  eventCurrency: string | null;
  eventAmount: number | null;
  eventCurrencyExponent: number | null;
  merchantName: string | null;
  merchantCountry: string | null;
  cardId: string | null;
  paymentChannelId: string | null;
  transferMethod: string | null;
  counterpartyKind: 'self' | 'third_party' | null;
  counterpartyName: string | null;
  counterpartyCountry: string | null;
  counterpartyInstitution: string | null;
  counterpartyAccountHint: string | null;
}
export interface ClassificationIn {
  merchantScope: string | null;
  transferScope: string | null;
  foreignStatus: string;
}
export interface EntryIn {
  id: string;
  direction: EntryDirection;
  /** New account (account_at_save) — or, with carriedFromEntryId, ignored (the carried entry's account is used). */
  accountId: string;
  currency: string;
  amount: number | null;
  amountStatus: 'confirmed' | 'pending';
  exponent: number;
  closedCurrencyAck: boolean;
  carriedFromEntryId?: string | null;
  /** For carried entries: keep the carried snapshot, or a user correction (snapshot_correction). */
  correctedCountry?: string | null;
}
export interface WriteIds {
  /** op_id */
  O: string;
  /** audit id */
  A: string;
}
export interface KeyIn {
  key: string;
  requestHash: string;
  hashVersion: number;
}

const gate = (db: DB, u: string, k: string) =>
  notExists(db.select({ one: sql`1` }).from(ledgerIdempotencyKeys).where(and(eq(ledgerIdempotencyKeys.userId, u), eq(ledgerIdempotencyKeys.key, k))));

/** S0: this user's expired correct / void keys. */
export const s0 = (db: DB, u: string, now: number) =>
  db.delete(ledgerIdempotencyKeys).where(and(eq(ledgerIdempotencyKeys.userId, u), isNotNull(ledgerIdempotencyKeys.expiresAt), lte(ledgerIdempotencyKeys.expiresAt, now)));

function newEntry(db: DB, u: string, E: string, en: EntryIn, now: number) {
  const row = {
    id: v(en.id, 'id'),
    userId: transactionEvents.userId,
    eventId: transactionEvents.id,
    txnType: transactionEvents.txnType,
    direction: v(en.direction, 'direction'),
    fundingAccountId: accounts.id,
    fundingCurrency: accountCurrencies.currency,
    amount: v(en.amount, 'amount'),
    amountStatus: v(en.amountStatus, 'amount_status'),
    currencyExponent: v(en.exponent, 'currency_exponent'),
    fundingAccountCountry: accounts.accountCountry,
    countrySource: v('account_at_save', 'country_source'),
    currencyStatusAtSave: accountCurrencies.status,
    closedCurrencyAck: v(en.closedCurrencyAck ? 1 : 0, 'closed_currency_ack'),
    carriedFromEntryId: v(null, 'carried_from_entry_id'),
    createdAt: v(now, 'created_at'),
  } satisfies Record<keyof typeof transactionEntries.$inferSelect, unknown>;
  return db.insert(transactionEntries).select(
    db
      .select(row)
      .from(transactionEvents)
      .innerJoin(accounts, and(eq(accounts.id, en.accountId), eq(accounts.userId, transactionEvents.userId)))
      .innerJoin(accountCurrencies, and(eq(accountCurrencies.accountId, accounts.id), eq(accountCurrencies.userId, transactionEvents.userId), eq(accountCurrencies.currency, en.currency)))
      .where(and(eq(transactionEvents.id, E), eq(transactionEvents.userId, u))),
  );
}

function carriedEntry(db: DB, u: string, E: string, en: EntryIn, now: number) {
  const c = alias(transactionEntries, 'c');
  const row = {
    id: v(en.id, 'id'),
    userId: transactionEvents.userId,
    eventId: transactionEvents.id,
    txnType: transactionEvents.txnType,
    direction: v(en.direction, 'direction'),
    fundingAccountId: c.fundingAccountId,
    fundingCurrency: accountCurrencies.currency,
    amount: v(en.amount, 'amount'),
    amountStatus: v(en.amountStatus, 'amount_status'),
    currencyExponent: v(en.exponent, 'currency_exponent'),
    fundingAccountCountry: en.correctedCountry ? v(en.correctedCountry, 'funding_account_country') : c.fundingAccountCountry,
    countrySource: v(en.correctedCountry ? 'user_corrected' : 'carried', 'country_source'),
    currencyStatusAtSave: accountCurrencies.status,
    closedCurrencyAck: v(en.closedCurrencyAck ? 1 : 0, 'closed_currency_ack'),
    carriedFromEntryId: c.id,
    createdAt: v(now, 'created_at'),
  } satisfies Record<keyof typeof transactionEntries.$inferSelect, unknown>;
  return db.insert(transactionEntries).select(
    db
      .select(row)
      .from(transactionEvents)
      .innerJoin(c, and(eq(c.id, en.carriedFromEntryId!), eq(c.userId, transactionEvents.userId)))
      .innerJoin(accountCurrencies, and(eq(accountCurrencies.accountId, c.fundingAccountId), eq(accountCurrencies.userId, transactionEvents.userId), eq(accountCurrencies.currency, en.currency)))
      .where(and(eq(transactionEvents.id, E), eq(transactionEvents.userId, u))),
  );
}

const entryStatement = (db: DB, u: string, E: string, en: EntryIn, now: number) => (en.carriedFromEntryId ? carriedEntry(db, u, E, en, now) : newEntry(db, u, E, en, now));

function factColumns(f: EventFactsIn) {
  return {
    recordMode: v(f.recordMode, 'record_mode'),
    occurredOn: v(f.occurredOn, 'occurred_on'),
    occurredTime: v(f.occurredTime, 'occurred_time'),
    postedOn: v(f.postedOn, 'posted_on'),
    eventCurrency: v(f.eventCurrency, 'event_currency'),
    eventAmount: v(f.eventAmount, 'event_amount'),
    eventCurrencyExponent: v(f.eventCurrencyExponent, 'event_currency_exponent'),
    merchantName: v(f.merchantName, 'merchant_name'),
    merchantCountry: v(f.merchantCountry, 'merchant_country'),
    cardId: v(f.cardId, 'card_id'),
    paymentChannelId: v(f.paymentChannelId, 'payment_channel_id'),
    transferMethod: v(f.transferMethod, 'transfer_method'),
    counterpartyKind: v(f.counterpartyKind, 'counterparty_kind'),
    counterpartyName: v(f.counterpartyName, 'counterparty_name'),
    counterpartyCountry: v(f.counterpartyCountry, 'counterparty_country'),
    counterpartyInstitution: v(f.counterpartyInstitution, 'counterparty_institution'),
    counterpartyAccountHint: v(f.counterpartyAccountHint, 'counterparty_account_hint'),
  };
}

export interface CreateIn extends WriteIds, KeyIn {
  u: string;
  T: string;
  E: string;
  now: number;
  ip: string | null;
  txnType: TxnType;
  notes: string | null;
  facts: EventFactsIn;
  /** null: preference_at_save; a code: user_declared (backfill only). */
  declaredHomeRegion: string | null;
  classification: ClassificationIn;
  entries: EntryIn[];
}

/**
 * Switches for mutation tests (TEST_PLAN §5.17) only: each removes one condition of the chain so a
 * test can show that it is load-bearing. Never set outside those tests.
 */
export interface ChainMutations {
  /** Drop gate G from S1 and the key insert. */
  noGate?: boolean;
  /** Drop the entry-count condition from the publish UPDATE. */
  noEntryCount?: boolean;
}

/** S0…S6 of a create, in order (named so a test can drop or replace one step). */
export function createChain(db: DB, x: CreateIn, mut: ChainMutations = {}) {
  const G = mut.noGate ? sql`1 = 1` : gate(db, x.u, x.key);
  const S1 = db.insert(transactions).select(
    db
      .select({
        id: v(x.T, 'id'),
        userId: users.id,
        txnType: v(x.txnType, 'txn_type'),
        status: v('active', 'status'),
        currentRevision: v(0, 'current_revision'),
        notes: v(x.notes, 'notes'),
        voidedAt: v(null, 'voided_at'),
        voidReason: v(null, 'void_reason'),
        voidedOpId: v(null, 'voided_op_id'),
        createdAt: v(x.now, 'created_at'),
        updatedAt: v(x.now, 'updated_at'),
      } satisfies Record<keyof typeof transactions.$inferSelect, unknown>)
      .from(users)
      .where(and(eq(users.id, x.u), G)),
  );
  const S2 = db.insert(transactionEvents).select(
    db
      .select({
        id: v(x.E, 'id'),
        userId: transactions.userId,
        transactionId: transactions.id,
        txnType: transactions.txnType,
        revision: v(1, 'revision'),
        revisionKind: v('original', 'revision_kind'),
        correctionReason: v(null, 'correction_reason'),
        ...factColumns(x.facts),
        homeRegion: x.declaredHomeRegion ? v(x.declaredHomeRegion, 'home_region') : sql`coalesce(${userPreferences.homeRegion}, 'CN')`.as('home_region'),
        homeRegionSource: v(x.declaredHomeRegion ? 'user_declared' : 'preference_at_save', 'home_region_source'),
        merchantScope: v(x.classification.merchantScope, 'merchant_scope'),
        transferScope: v(x.classification.transferScope, 'transfer_scope'),
        foreignStatus: v(x.classification.foreignStatus, 'foreign_status'),
        classifierVersion: v(1, 'classifier_version'),
        createdAt: v(x.now, 'created_at'),
      } satisfies Record<keyof typeof transactionEvents.$inferSelect, unknown>)
      .from(transactions)
      .innerJoin(users, eq(users.id, transactions.userId))
      .leftJoin(userPreferences, eq(userPreferences.userId, users.id))
      .where(and(eq(transactions.id, x.T), eq(transactions.userId, x.u), eq(transactions.currentRevision, 0))),
  );
  const S3 = x.entries.map((en) => entryStatement(db, x.u, x.E, en, x.now));
  const S4 = db
    .update(transactions)
    .set({ currentRevision: 1, updatedAt: x.now })
    .where(
      and(
        eq(transactions.id, x.T),
        eq(transactions.userId, x.u),
        eq(transactions.currentRevision, 0),
        mut.noEntryCount ? undefined : sql`(SELECT count(*) FROM transaction_entries WHERE event_id = ${x.E}) = ${x.entries.length}`,
      ),
    );
  const S5 = db.insert(auditLog).select(
    db
      .select({
        id: v(x.A, 'id'),
        userId: transactions.userId,
        action: v('transaction.create', 'action'),
        detail: sql`json_object('id', ${transactions.id}, 'eventId', ${x.E}, 'revision', ${transactions.currentRevision})`.as('detail'),
        ip: v(x.ip, 'ip'),
        createdAt: v(x.now, 'created_at'),
      } satisfies Record<keyof typeof auditLog.$inferSelect, unknown>)
      .from(transactions)
      .where(and(eq(transactions.id, x.T), eq(transactions.userId, x.u), eq(transactions.currentRevision, 1))),
  );
  const S6 = db.insert(ledgerIdempotencyKeys).select(
    db
      .select({
        userId: users.id,
        key: v(x.key, 'key'),
        operation: v('transaction.create', 'operation'),
        requestHash: v(x.requestHash, 'request_hash'),
        hashVersion: v(x.hashVersion, 'hash_version'),
        opId: v(x.O, 'op_id'),
        transactionId: v(x.T, 'transaction_id'),
        resultRevision: sql`(SELECT current_revision FROM transactions WHERE id = ${x.T} AND user_id = ${x.u} AND status = 'active' AND current_revision = 1)`.as('result_revision'),
        resultEventId: sql`(SELECT id FROM transaction_events WHERE id = ${x.E} AND transaction_id = ${x.T} AND user_id = ${x.u} AND revision = 1)`.as('result_event_id'),
        auditId: sql`(SELECT id FROM audit_log WHERE id = ${x.A})`.as('audit_id'),
        responseStatus: v(201, 'response_status'),
        createdAt: v(x.now, 'created_at'),
        expiresAt: v(null, 'expires_at'),
      } satisfies Record<keyof typeof ledgerIdempotencyKeys.$inferSelect, unknown>)
      .from(users)
      .where(and(eq(users.id, x.u), G)),
  );
  return { S0: s0(db, x.u, x.now), S1, S2, S3, S4, S5, S6 };
}

export interface CorrectIn extends WriteIds, KeyIn {
  u: string;
  T: string;
  E: string;
  now: number;
  ip: string | null;
  baseRevision: number;
  kind: CorrectionKind;
  reason: string | null;
  facts: EventFactsIn;
  /** null: carried from the previous version; a code: user_corrected (snapshot_correction). */
  correctedHomeRegion: string | null;
  classification: ClassificationIn;
  entries: EntryIn[];
}

export function correctChain(db: DB, x: CorrectIn) {
  const r = x.baseRevision;
  const G = gate(db, x.u, x.key);
  const prev = alias(transactionEvents, 'prev');
  const S1 = db.insert(transactionEvents).select(
    db
      .select({
        id: v(x.E, 'id'),
        userId: transactions.userId,
        transactionId: transactions.id,
        txnType: transactions.txnType,
        revision: v(r + 1, 'revision'),
        revisionKind: v(x.kind, 'revision_kind'),
        correctionReason: v(x.reason, 'correction_reason'),
        ...factColumns(x.facts),
        homeRegion: x.correctedHomeRegion ? v(x.correctedHomeRegion, 'home_region') : prev.homeRegion,
        homeRegionSource: v(x.correctedHomeRegion ? 'user_corrected' : 'carried', 'home_region_source'),
        merchantScope: v(x.classification.merchantScope, 'merchant_scope'),
        transferScope: v(x.classification.transferScope, 'transfer_scope'),
        foreignStatus: v(x.classification.foreignStatus, 'foreign_status'),
        classifierVersion: prev.classifierVersion,
        createdAt: v(x.now, 'created_at'),
      } satisfies Record<keyof typeof transactionEvents.$inferSelect, unknown>)
      .from(transactions)
      .innerJoin(prev, and(eq(prev.transactionId, transactions.id), eq(prev.userId, transactions.userId), eq(prev.revision, r)))
      .where(and(eq(transactions.id, x.T), eq(transactions.userId, x.u), eq(transactions.status, 'active'), eq(transactions.currentRevision, r), G)),
  );
  const S2 = x.entries.map((en) => entryStatement(db, x.u, x.E, en, x.now));
  const eventPublished = sql`EXISTS (SELECT 1 FROM transaction_events WHERE id = ${x.E} AND transaction_id = ${x.T} AND user_id = ${x.u} AND revision = ${r + 1})`;
  const S3 = db
    .update(transactions)
    .set({ currentRevision: r + 1, updatedAt: x.now })
    .where(
      and(
        eq(transactions.id, x.T),
        eq(transactions.userId, x.u),
        eq(transactions.currentRevision, r),
        eventPublished,
        sql`(SELECT count(*) FROM transaction_entries WHERE event_id = ${x.E}) = ${x.entries.length}`,
      ),
    );
  const S4 = db.insert(auditLog).select(
    db
      .select({
        id: v(x.A, 'id'),
        userId: transactions.userId,
        action: v('transaction.correct', 'action'),
        detail: sql`json_object('id', ${transactions.id}, 'eventId', ${x.E}, 'revision', ${transactions.currentRevision}, 'kind', ${x.kind})`.as('detail'),
        ip: v(x.ip, 'ip'),
        createdAt: v(x.now, 'created_at'),
      } satisfies Record<keyof typeof auditLog.$inferSelect, unknown>)
      .from(transactions)
      .where(and(eq(transactions.id, x.T), eq(transactions.userId, x.u), eq(transactions.currentRevision, r + 1), eventPublished)),
  );
  const S5 = db.insert(ledgerIdempotencyKeys).select(
    db
      .select({
        userId: users.id,
        key: v(x.key, 'key'),
        operation: v('transaction.correct', 'operation'),
        requestHash: v(x.requestHash, 'request_hash'),
        hashVersion: v(x.hashVersion, 'hash_version'),
        opId: v(x.O, 'op_id'),
        transactionId: v(x.T, 'transaction_id'),
        resultRevision: sql`(SELECT current_revision FROM transactions WHERE id = ${x.T} AND user_id = ${x.u} AND current_revision = ${r + 1} AND ${eventPublished})`.as('result_revision'),
        resultEventId: sql`(SELECT e.id FROM transaction_events e JOIN transactions t ON t.id = e.transaction_id AND t.user_id = e.user_id WHERE e.id = ${x.E} AND e.transaction_id = ${x.T} AND e.user_id = ${x.u} AND e.revision = ${r + 1} AND t.current_revision = ${r + 1})`.as('result_event_id'),
        auditId: sql`(SELECT id FROM audit_log WHERE id = ${x.A})`.as('audit_id'),
        responseStatus: v(201, 'response_status'),
        createdAt: v(x.now, 'created_at'),
        expiresAt: v(x.now + KEY_TTL_MS, 'expires_at'),
      } satisfies Record<keyof typeof ledgerIdempotencyKeys.$inferSelect, unknown>)
      .from(users)
      .where(and(eq(users.id, x.u), G)),
  );
  return { S0: s0(db, x.u, x.now), S1, S2, S3, S4, S5 };
}

export interface VoidIn extends WriteIds, KeyIn {
  u: string;
  T: string;
  now: number;
  ip: string | null;
  baseRevision: number;
  reason: string | null;
}

export function voidChain(db: DB, x: VoidIn) {
  const G = gate(db, x.u, x.key);
  const S1 = db
    .update(transactions)
    .set({ status: 'voided', voidedAt: x.now, voidReason: x.reason, voidedOpId: x.O, updatedAt: x.now })
    .where(and(eq(transactions.id, x.T), eq(transactions.userId, x.u), eq(transactions.status, 'active'), eq(transactions.currentRevision, x.baseRevision), G));
  const S2 = db.insert(auditLog).select(
    db
      .select({
        id: v(x.A, 'id'),
        userId: transactions.userId,
        action: v('transaction.void', 'action'),
        detail: sql`json_object('id', ${transactions.id}, 'eventId', ${transactionEvents.id}, 'revision', ${transactions.currentRevision})`.as('detail'),
        ip: v(x.ip, 'ip'),
        createdAt: v(x.now, 'created_at'),
      } satisfies Record<keyof typeof auditLog.$inferSelect, unknown>)
      .from(transactions)
      .innerJoin(
        transactionEvents,
        and(eq(transactionEvents.transactionId, transactions.id), eq(transactionEvents.userId, transactions.userId), eq(transactionEvents.revision, transactions.currentRevision)),
      )
      .where(and(eq(transactions.id, x.T), eq(transactions.userId, x.u), eq(transactions.voidedOpId, x.O))),
  );
  const S3 = db.insert(ledgerIdempotencyKeys).select(
    db
      .select({
        userId: users.id,
        key: v(x.key, 'key'),
        operation: v('transaction.void', 'operation'),
        requestHash: v(x.requestHash, 'request_hash'),
        hashVersion: v(x.hashVersion, 'hash_version'),
        opId: v(x.O, 'op_id'),
        transactionId: v(x.T, 'transaction_id'),
        resultRevision: sql`(SELECT current_revision FROM transactions WHERE id = ${x.T} AND user_id = ${x.u} AND voided_op_id = ${x.O})`.as('result_revision'),
        resultEventId: sql`(SELECT e.id FROM transactions t JOIN transaction_events e ON e.transaction_id = t.id AND e.user_id = t.user_id AND e.revision = t.current_revision WHERE t.id = ${x.T} AND t.user_id = ${x.u} AND t.voided_op_id = ${x.O})`.as('result_event_id'),
        auditId: sql`(SELECT id FROM audit_log WHERE id = ${x.A})`.as('audit_id'),
        responseStatus: v(200, 'response_status'),
        createdAt: v(x.now, 'created_at'),
        expiresAt: v(x.now + KEY_TTL_MS, 'expires_at'),
      } satisfies Record<keyof typeof ledgerIdempotencyKeys.$inferSelect, unknown>)
      .from(users)
      .where(and(eq(users.id, x.u), G)),
  );
  return { S0: s0(db, x.u, x.now), S1, S2, S3 };
}

/** Flatten named steps (some are arrays of entry statements) into one batch, in order. */
export function steps(chain: Record<string, Statement | Statement[]>): Batch {
  const out = Object.values(chain).flatMap((s) => (Array.isArray(s) ? s : [s]));
  return out as Batch;
}

// ------------------------------------------------------------------ engines

export type Row = Record<string, unknown>;
export type D1 = Parameters<typeof drizzleD1>[0];

export interface Engine {
  name: 'libsql' | 'd1';
  db: DB;
  run(sqlText: string, args?: unknown[]): Promise<void>;
  all(sqlText: string, args?: unknown[]): Promise<Row[]>;
  /** Literal statements in one drizzle batch (one transaction on both engines). */
  batchSql(statements: string[]): Promise<void>;
  /** Re-try a trivial query on a stale workerd keep-alive socket (see m2-schema.test.ts); call before each case. */
  ping(): Promise<void>;
  dispose(): Promise<void>;
}

export const errorText = (e: unknown) => {
  const out: string[] = [];
  for (let cur: any = e, i = 0; cur && i < 6; cur = cur.cause, i++) out.push(String(cur.message ?? cur));
  return out.join(' | ');
};

/** Tags of the v1 migrations in journal order. */
export const journalTags = () => (JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] }).entries.map((e) => e.tag);

/** A temporary file database opened by openV1Db(): identity check, every migration, one connection with foreign_keys ON. */
export async function libsqlEngine(): Promise<Engine & { client: Client }> {
  const dir = mkdtempSync(join(tmpdir(), 'xui-m3-libsql-'));
  const opened = await openV1Db(`file:${join(dir, 'x-ui-v1.db')}`, { legacyPaths: [] });
  const { client, db } = opened;
  return {
    name: 'libsql',
    db,
    client,
    run: async (s, args = []) => void (await client.execute({ sql: s, args: args as never })),
    all: async (s, args = []) => {
      const r = await client.execute({ sql: s, args: args as never });
      return r.rows.map((row) => Object.fromEntries(r.columns.map((col, i) => [col, row[i]])));
    },
    batchSql: async (statements) => {
      const [first, ...rest] = statements.map((s) => db.run(sql.raw(s)));
      await db.batch([first!, ...rest]);
    },
    ping: async () => {},
    dispose: () => removeDbDir(dir, [client]),
  };
}

/**
 * wrangler's getPlatformProxy(): local in-memory D1 inside workerd (persist: false,
 * remoteBindings: false, wrangler cache in a temp dir). Every migration in _journal.json order
 * through wrangler's own SQL splitter, as `wrangler d1 migrations apply` does. No remote D1.
 */
export async function d1Engine(name: string): Promise<Engine & { d1: D1 }> {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1 }>>> | undefined;
  try {
    const config = join(dir, 'wrangler.json');
    writeFileSync(config, JSON.stringify({ name, compatibility_date: '2026-10-01', d1_databases: [{ binding: 'DB', database_name: name, database_id: '00000000-0000-0000-0000-000000000000' }] }));
    process.env.WRANGLER_CACHE_DIR = join(dir, 'cache');
    proxy = await getPlatformProxy<{ DB: D1 }>({ configPath: config, persist: false, envFiles: [], remoteBindings: false });
    const d1 = proxy.env.DB;
    for (const tag of journalTags()) for (const statement of unstable_splitSqlQuery(readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8'))) await d1.prepare(statement).run();
    const db = drizzleD1(d1) as unknown as DB;
    const p = proxy;
    return {
      name: 'd1',
      db,
      d1,
      run: async (s, args = []) => void (await d1.prepare(s).bind(...args).run()),
      all: async (s, args = []) => ((await d1.prepare(s).bind(...args).all()).results ?? []) as Row[],
      batchSql: async (statements) => {
        const [first, ...rest] = statements.map((s) => db.run(sql.raw(s)));
        await db.batch([first!, ...rest]);
      },
      ping: async () => {
        for (let attempt = 1; ; attempt++) {
          try {
            await d1.prepare('SELECT 1').first();
            return;
          } catch (e) {
            if (!/fetch failed|ECONNRESET|socket hang up/i.test(errorText(e)) || attempt >= 3) throw e;
          }
        }
      },
      dispose: async () => {
        await p.dispose();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await proxy?.dispose();
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

// ------------------------------------------------------------------ rows

export const TS = 1_790_000_000_000;
let seq = 0;
/** Unique ids across the test file (both engines share the counter, which is harmless). */
export const nid = (p: string) => `${p}${++seq}`;
/** A valid idempotency key (16–64 of [0-9A-Za-z_-]). */
export const newKey = () => `test-key-${String(++seq).padStart(10, '0')}`;

const insertSql = (table: string, r: Row) => {
  const cols = Object.keys(r);
  return [`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, Object.values(r)] as const;
};
export const ins = (e: Engine, table: string, r: Row) => e.run(...insertSql(table, r));
export const count = async (e: Engine, table: string, where = '1 = 1', args: unknown[] = []) => Number((await e.all(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, args))[0]!.n);
export const one = async (e: Engine, q: string, args: unknown[] = []) => (await e.all(q, args))[0]!;

/**
 * One user: institution I; accounts HK (bank, HK: HKD default, USD), BE (e_money, BE: USD
 * default, EUR, GBP closed), CN (bank, CN: CNY default); card K; channel PP. No preferences row
 * (home region CN) unless homeRegion is given.
 */
export async function seedUser(e: Engine, homeRegion?: string) {
  const u = nid('u');
  const s = { u, I: `${u}_I`, HK: `${u}_HK`, BE: `${u}_BE`, CN: `${u}_CN`, K: `${u}_K`, PP: `${u}_PP` };
  await ins(e, 'users', { id: u, username: u, display_name: u, role: 'member', status: 'active', webauthn_user_id: `wa-${u}`, created_at: TS, updated_at: TS });
  if (homeRegion) await ins(e, 'user_preferences', { user_id: u, home_region: homeRegion, created_at: TS, updated_at: TS });
  await ins(e, 'institutions', { id: s.I, user_id: u, name: 'Bank', name_key: 'bank', country: 'GB', institution_type: 'bank', created_at: TS, updated_at: TS });
  const account = (id: string, type: string, country: string) =>
    ins(e, 'accounts', { id, user_id: u, institution_id: s.I, name: id, name_key: id.toLowerCase(), account_type: type, account_country: country, created_at: TS, updated_at: TS });
  await account(s.HK, 'bank', 'HK');
  await account(s.BE, 'e_money', 'BE');
  await account(s.CN, 'bank', 'CN');
  const cur = (acc: string, c: string, x: Row = {}) => ins(e, 'account_currencies', { account_id: acc, user_id: u, currency: c, created_at: TS, ...x });
  await cur(s.HK, 'HKD', { is_default: 1 });
  await cur(s.HK, 'USD');
  await cur(s.BE, 'USD', { is_default: 1 });
  await cur(s.BE, 'EUR');
  await cur(s.BE, 'GBP', { status: 'closed' });
  await cur(s.CN, 'CNY', { is_default: 1 });
  await ins(e, 'cards', { id: s.K, user_id: u, issuer_institution_id: s.I, name: 'K', network: 'visa', card_type: 'debit', last4: '4321', issuing_country: 'BE', created_at: TS, updated_at: TS });
  await ins(e, 'payment_channels', { id: s.PP, user_id: u, name: 'PayPal', name_key: 'paypal', channel_type: 'payment_service', created_at: TS, updated_at: TS });
  return s;
}
export type Seed = Awaited<ReturnType<typeof seedUser>>;

const isTransfer = (t: TxnType) => t === 'own_transfer' || t === 'third_party_transfer';

/** A revision-1 event row (raw SQL): a foreign spend (HK account, US merchant, home CN) or a HK → BE transfer by default. */
export function evRow(s: Seed, T: string, E: string, type: TxnType, x: Row = {}): Row {
  const base: Row = {
    id: E, user_id: s.u, transaction_id: T, txn_type: type, revision: 1, revision_kind: 'original', record_mode: 'current',
    occurred_on: '2026-10-20', event_currency: 'USD', event_amount: 1000, event_currency_exponent: 2,
    home_region: 'CN', home_region_source: 'preference_at_save', classifier_version: 1, created_at: TS,
  };
  const shape: Row = isTransfer(type)
    ? { transfer_method: 'swift', counterparty_kind: type === 'own_transfer' ? 'self' : 'third_party', transfer_scope: 'foreign_cross_border', foreign_status: 'foreign' }
    : { merchant_name: 'Shop', merchant_country: 'US', merchant_scope: 'foreign', foreign_status: 'foreign' };
  return { ...base, ...shape, ...x };
}

/** An entry row (raw SQL): HK account, HKD 78.30 confirmed, out (in for a refund). */
export function enRow(s: Seed, E: string, type: TxnType, x: Row = {}): Row {
  return {
    id: nid('N'), user_id: s.u, event_id: E, txn_type: type, direction: type === 'merchant_refund' ? 'in' : 'out',
    funding_account_id: s.HK, funding_currency: 'HKD', amount: 7830, amount_status: 'confirmed', currency_exponent: 2,
    funding_account_country: 'HK', country_source: 'account_at_save', currency_status_at_save: 'active', closed_currency_ack: 0, created_at: TS, ...x,
  };
}

/** Header (revision 0) → event revision 1 → entries → publish (optional), each a separate raw statement. */
export async function rawTxn(e: Engine, s: Seed, type: TxnType, o: { ev?: Row; entries?: Row[]; publish?: boolean } = {}) {
  const T = nid('T');
  const E = nid('E');
  await ins(e, 'transactions', { id: T, user_id: s.u, txn_type: type, created_at: TS, updated_at: TS });
  await ins(e, 'transaction_events', evRow(s, T, E, type, o.ev));
  const N: string[] = [];
  for (const x of o.entries ?? [{}]) {
    const r = enRow(s, E, type, x);
    N.push(String(r.id));
    await ins(e, 'transaction_entries', r);
  }
  if (o.publish !== false) await publishRaw(e, T, 1);
  return { T, E, N };
}
/** UPDATE transactions SET current_revision = r (a publish when r = current + 1). */
export const publishRaw = (e: Engine, T: string, r: number) => e.run('UPDATE transactions SET current_revision = ?, updated_at = ? WHERE id = ?', [r, TS + r, T]);

export const spendFacts = (x: Partial<EventFactsIn> = {}): EventFactsIn => ({
  recordMode: 'current', occurredOn: '2026-10-20', occurredTime: '14:05', postedOn: null,
  eventCurrency: 'USD', eventAmount: 1000, eventCurrencyExponent: 2, merchantName: 'Example Store', merchantCountry: 'US',
  cardId: null, paymentChannelId: null, transferMethod: null,
  counterpartyKind: null, counterpartyName: null, counterpartyCountry: null, counterpartyInstitution: null, counterpartyAccountHint: null, ...x,
});
export const transferFacts = (kind: 'self' | 'third_party', x: Partial<EventFactsIn> = {}): EventFactsIn =>
  spendFacts({ merchantName: null, merchantCountry: null, transferMethod: 'swift', counterpartyKind: kind, ...x });
export const FOREIGN_SPEND: ClassificationIn = { merchantScope: 'foreign', transferScope: null, foreignStatus: 'foreign' };

/** A create-chain input: a foreign spend of the seed user (HK account, HKD 78.30, card K), with fresh ids and key. */
export function createInput(s: Seed, hash: (s: string) => string, x: Partial<CreateIn> = {}): CreateIn {
  const key = x.key ?? newKey();
  return {
    u: s.u, T: nid('T'), E: nid('E'), O: nid('O'), A: nid('A'), now: TS, ip: '10.0.0.1',
    key, requestHash: hash(key), hashVersion: 1, txnType: 'merchant_spend', notes: null,
    facts: spendFacts({ cardId: s.K }), declaredHomeRegion: null, classification: FOREIGN_SPEND,
    entries: [{ id: nid('N'), direction: 'out', accountId: s.HK, currency: 'HKD', amount: 7830, amountStatus: 'confirmed', exponent: 2, closedCurrencyAck: false }],
    ...x,
  };
}
/** The same request with new T / E / O / A and entry ids (what a retry of the route generates). */
export const freshIds = (x: CreateIn): CreateIn => ({ ...x, T: nid('T'), E: nid('E'), O: nid('O'), A: nid('A'), entries: x.entries.map((en) => ({ ...en, id: nid('N') })) });

export const M3_TABLES = ['transactions', 'transaction_events', 'transaction_entries', 'ledger_idempotency_keys'] as const;
/** Rows of one user in the four M3 tables, plus that user's audit records. */
export async function ledgerCounts(e: Engine, u: string) {
  const out: Record<string, number> = {};
  for (const t of M3_TABLES) out[t] = await count(e, t, 'user_id = ?', [u]);
  out.audit = await count(e, 'audit_log', 'user_id = ?', [u]);
  return out;
}

/** Every row of every M3 table plus audit_log, for "the database is unchanged" assertions. */
export async function ledgerDump(e: Engine) {
  const out: Record<string, Row[]> = {};
  for (const t of [...M3_TABLES, 'audit_log']) out[t] = await e.all(`SELECT * FROM ${t} ORDER BY rowid`);
  return out;
}
