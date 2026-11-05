import { CORRECTION_KEY_TTL_DAYS, type CorrectionKind, type EntryDirection, type RecordMode, type TxnType } from '@xui/ledger-shared';
import { and, eq, isNotNull, lte, notExists, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { alias } from 'drizzle-orm/sqlite-core';
import type { DB } from '../db/client.ts';
import { accountCurrencies, accounts, auditLog, ledgerIdempotencyKeys, transactionEntries, transactionEvents, transactions, userPreferences, users } from '../db/schema.ts';
import type { AuditAction } from '../lib/audit.ts';

/**
 * The financial write chains (DATA_MODEL §10.10): create (below), correct (correctChain) and void (voidChain).
 *
 * The chain of a new transaction ("新建"): S0 … S6 in ONE
 * db.batch() — a single transaction on libsql and on D1. The statements only take decided inputs
 * (ids, facts, classification, exponents); the route decides them (transactionCreate.ts).
 *
 * - Every owned parent is selected with user_id = the caller inside the statement itself: an
 *   account or account currency that is not the caller's (or no longer exists) writes zero rows,
 *   and the key row's result columns then end up NULL (NOT NULL failure → whole batch rolled back).
 *   Card and channel ids are bound values checked by their composite foreign keys.
 * - Snapshots are read by SQL in the statement that stores them (§10.9.1): home_region from
 *   users LEFT JOIN user_preferences (or the declared value), funding_account_country and
 *   currency_status_at_save from accounts / account_currencies. foreign_status and transfer_scope
 *   are bound values, computed by the route from what it read; the publish trigger C6 re-derives
 *   them from the saved snapshots and refuses a mismatch (a snapshot source changed in between).
 *   merchant_scope is derived in the statement from the stored home_region (row CHECK).
 * - closed_currency_ack is a permission, not a fact (Q3): stored as requested only when the
 *   currency is closed at save time, otherwise 0.
 * - Gate G (no key row of this user and key yet) guards the first and the last step; the key row is
 *   inserted last, complete, and is present iff header, version, entries, publish and audit are.
 *
 * Same statements as the M3-B1 test chain (test/m3-ledger.ts), which verified them on both engines.
 */

type Statement = BatchItem<'sqlite'>;
export type Batch = [Statement, ...Statement[]];

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

/** Bound classification columns (merchant_scope is derived in SQL, see createChain). */
export interface ClassificationIn {
  transferScope: string | null;
  foreignStatus: string;
}

export interface NewEntryIn {
  id: string;
  direction: EntryDirection;
  accountId: string;
  currency: string;
  amount: number | null;
  amountStatus: 'confirmed' | 'pending';
  exponent: number;
  /** As requested; stored only if the currency is closed at save time (Q3). */
  closedCurrencyAck: boolean;
}

export interface CreateChainIn {
  u: string;
  /** Transaction, event, op and audit ids — new for every attempt. */
  T: string;
  E: string;
  O: string;
  A: string;
  now: number;
  ip: string | null;
  key: string;
  requestHash: string;
  hashVersion: number;
  txnType: TxnType;
  notes: string | null;
  facts: EventFactsIn;
  /** null: preference_at_save (read by SQL); a code: user_declared (backfill only, P4). */
  declaredHomeRegion: string | null;
  classification: ClassificationIn;
  entries: NewEntryIn[];
}

/** Gate G: this user has no key row with this key yet. */
const gate = (db: DB, u: string, k: string) =>
  notExists(db.select({ one: sql`1` }).from(ledgerIdempotencyKeys).where(and(eq(ledgerIdempotencyKeys.userId, u), eq(ledgerIdempotencyKeys.key, k))));

/** S0: this user's expired correct / void keys (create keys never expire). */
const expiredKeys = (db: DB, u: string, now: number) =>
  db.delete(ledgerIdempotencyKeys).where(and(eq(ledgerIdempotencyKeys.userId, u), isNotNull(ledgerIdempotencyKeys.expiresAt), lte(ledgerIdempotencyKeys.expiresAt, now)));

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

/** One entry of a new version on an account of the caller (account_at_save snapshots, read by SQL). */
function newEntry(db: DB, u: string, E: string, en: NewEntryIn, now: number) {
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
    closedCurrencyAck: sql`CASE WHEN ${accountCurrencies.status} = 'closed' THEN ${en.closedCurrencyAck ? 1 : 0} ELSE 0 END`.as('closed_currency_ack'),
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

/** S0 … S6 of a create, in order (named so tests can tell the steps apart). */
export function createChain(db: DB, x: CreateChainIn) {
  const G = gate(db, x.u, x.key);
  const homeRegion = x.declaredHomeRegion ? sql`${x.declaredHomeRegion}` : sql`coalesce(${userPreferences.homeRegion}, 'CN')`;
  // merchant_scope follows from the same row (the transaction_events_merchant_scope_rule_ck CHECK):
  // derived here from the home_region this statement stores, so a home region changed after the
  // route's checks can never make the row contradict itself. foreign_status / transfer_scope stay
  // bound values, re-derived by C6 at publish (LEDGER_CLASSIFICATION when the change matters).
  const merchant = x.txnType === 'merchant_spend' || x.txnType === 'merchant_refund';
  const merchantScope = merchant
    ? sql`CASE WHEN ${x.facts.merchantCountry} IS NULL THEN 'unknown' WHEN ${x.facts.merchantCountry} = ${homeRegion} THEN 'domestic' ELSE 'foreign' END`.as('merchant_scope')
    : v(null, 'merchant_scope');
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
        homeRegion: homeRegion.as('home_region'),
        homeRegionSource: v(x.declaredHomeRegion ? 'user_declared' : 'preference_at_save', 'home_region_source'),
        merchantScope,
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
  const S3 = x.entries.map((en) => newEntry(db, x.u, x.E, en, x.now));
  const S4 = db
    .update(transactions)
    .set({ currentRevision: 1, updatedAt: x.now })
    .where(
      and(
        eq(transactions.id, x.T),
        eq(transactions.userId, x.u),
        eq(transactions.currentRevision, 0),
        sql`(SELECT count(*) FROM transaction_entries WHERE event_id = ${x.E}) = ${x.entries.length}`,
      ),
    );
  const S5 = db.insert(auditLog).select(
    db
      .select({
        id: v(x.A, 'id'),
        userId: transactions.userId,
        action: v('transaction.create' satisfies AuditAction, 'action'),
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
  return { S0: expiredKeys(db, x.u, x.now), S1, S2, S3, S4, S5, S6 };
}

/** The steps flattened into one batch, in order. */
export function createBatch(db: DB, x: CreateChainIn): Batch {
  const { S0, S1, S2, S3, S4, S5, S6 } = createChain(db, x);
  return [S0, S1, S2, ...S3, S4, S5, S6];
}

/** Correct / void keys are kept this long (DATA_MODEL §10.5); create keys for good. */
export const CORRECTION_KEY_TTL_MS = CORRECTION_KEY_TTL_DAYS * 86_400_000;

export interface VoidChainIn {
  u: string;
  T: string;
  /** Op and audit ids — new for every attempt. */
  O: string;
  A: string;
  /** The request's one server time (API_SPEC §5.0.3). */
  now: number;
  ip: string | null;
  key: string;
  requestHash: string;
  hashVersion: number;
  /** The version the caller saw as current; the void acts on it. */
  baseRevision: number;
  reason: string | null;
}

/**
 * The void chain (DATA_MODEL §10.10, "作废"): S0 … S3 in ONE db.batch(). A void is no version: it
 * only updates the header (tx_update_guard form ③) — no event, no entry, current_revision unchanged.
 * S1 voids only the caller's active transaction still at baseRevision, and only while gate G holds;
 * the audit and the key row are selected by this request's op id (voided_op_id = O), so they exist
 * only if S1 voided the transaction here. The key row is last, complete, and expires in 30 days.
 */
export function voidChain(db: DB, x: VoidChainIn) {
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
        action: v('transaction.void' satisfies AuditAction, 'action'),
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
        resultRevision: sql`(SELECT current_revision FROM transactions WHERE id = ${x.T} AND user_id = ${x.u} AND status = 'voided' AND voided_op_id = ${x.O})`.as('result_revision'),
        resultEventId: sql`(SELECT e.id FROM transactions t JOIN transaction_events e ON e.transaction_id = t.id AND e.user_id = t.user_id AND e.revision = t.current_revision WHERE t.id = ${x.T} AND t.user_id = ${x.u} AND t.voided_op_id = ${x.O})`.as('result_event_id'),
        auditId: sql`(SELECT id FROM audit_log WHERE id = ${x.A})`.as('audit_id'),
        responseStatus: v(200, 'response_status'),
        createdAt: v(x.now, 'created_at'),
        expiresAt: v(x.now + CORRECTION_KEY_TTL_MS, 'expires_at'),
      } satisfies Record<keyof typeof ledgerIdempotencyKeys.$inferSelect, unknown>)
      .from(users)
      .where(and(eq(users.id, x.u), G)),
  );
  return { S0: expiredKeys(db, x.u, x.now), S1, S2, S3 };
}

export function voidBatch(db: DB, x: VoidChainIn): Batch {
  const { S0, S1, S2, S3 } = voidChain(db, x);
  return [S0, S1, S2, S3];
}

// ------------------------------------------------------------------ correct (r → r+1)

/** An entry of the new version carried over from the previous version's entry of the same account. */
export interface CarriedEntryIn {
  id: string;
  /** The previous version's entry of the same funding account (carried_from_entry_id). */
  from: string;
  /**
   * fact_correction: the request's direction, currency, exponent (current ISO table) and
   * acknowledgement. null (settlement, snapshot_correction): direction, currency and exponent are
   * copied from `from` by SQL, and its acknowledgement is carried (normalized: 0 unless closed now).
   */
  facts: { direction: EntryDirection; currency: string; exponent: number; closedCurrencyAck: boolean } | null;
  /** The amount written: a request's (fact_correction, a settled direction); null: copied from `from`. */
  amount: { amount: number | null; amountStatus: 'confirmed' | 'pending' } | null;
  /** snapshot_correction: the corrected jurisdiction (user_corrected); null: carried from `from`. */
  correctedCountry: string | null;
}

/** An entry of the new version: carried over (same account as in the previous version) or on a new account. */
export type CorrectEntryIn = { carried: CarriedEntryIn } | { fresh: NewEntryIn };

export interface CorrectChainIn {
  u: string;
  T: string;
  /** Event, op and audit ids — new for every attempt (entry ids are in `entries`). */
  E: string;
  O: string;
  A: string;
  /** The request's one server time (API_SPEC §5.0.3). */
  now: number;
  ip: string | null;
  key: string;
  requestHash: string;
  hashVersion: number;
  /** r: the version the correction is based on; the new version is r + 1. */
  baseRevision: number;
  kind: CorrectionKind;
  reason: string | null;
  txnType: TxnType;
  /** fact_correction: the corrected facts (exponent from the ISO table); null: every fact column copied from version r. */
  facts: EventFactsIn | null;
  /** snapshot_correction: the corrected home region (user_corrected); null: version r's (carried). */
  correctedHomeRegion: string | null;
  classification: ClassificationIn;
  entries: CorrectEntryIn[];
}

const prevEvent = alias(transactionEvents, 'prev');
const carriedFrom = alias(transactionEntries, 'c');

/** The fact columns of version r, in table order (settlement, snapshot_correction: none of them changes). */
function copiedFacts(p: typeof prevEvent) {
  return {
    recordMode: p.recordMode,
    occurredOn: p.occurredOn,
    occurredTime: p.occurredTime,
    postedOn: p.postedOn,
    eventCurrency: p.eventCurrency,
    eventAmount: p.eventAmount,
    eventCurrencyExponent: p.eventCurrencyExponent,
    merchantName: p.merchantName,
    merchantCountry: p.merchantCountry,
    cardId: p.cardId,
    paymentChannelId: p.paymentChannelId,
    transferMethod: p.transferMethod,
    counterpartyKind: p.counterpartyKind,
    counterpartyName: p.counterpartyName,
    counterpartyCountry: p.counterpartyCountry,
    counterpartyInstitution: p.counterpartyInstitution,
    counterpartyAccountHint: p.counterpartyAccountHint,
  } satisfies Record<keyof EventFactsIn, unknown>;
}

/**
 * A carried entry: the account always, and (settlement, snapshot_correction) direction, currency,
 * exponent and unchanged amounts come from the previous version's entry `c` by SQL; the
 * jurisdiction is c's (carried) unless a snapshot correction sets it (user_corrected);
 * currency_status_at_save is read now from account_currencies (R5).
 */
function carriedEntry(db: DB, u: string, E: string, en: CarriedEntryIn, now: number) {
  const c = carriedFrom;
  const f = en.facts;
  const row = {
    id: v(en.id, 'id'),
    userId: transactionEvents.userId,
    eventId: transactionEvents.id,
    txnType: transactionEvents.txnType,
    direction: f ? v(f.direction, 'direction') : c.direction,
    fundingAccountId: c.fundingAccountId,
    fundingCurrency: accountCurrencies.currency,
    amount: en.amount ? v(en.amount.amount, 'amount') : c.amount,
    amountStatus: en.amount ? v(en.amount.amountStatus, 'amount_status') : c.amountStatus,
    currencyExponent: f ? v(f.exponent, 'currency_exponent') : c.currencyExponent,
    fundingAccountCountry: en.correctedCountry ? v(en.correctedCountry, 'funding_account_country') : c.fundingAccountCountry,
    countrySource: v(en.correctedCountry ? 'user_corrected' : 'carried', 'country_source'),
    currencyStatusAtSave: accountCurrencies.status,
    // A permission, not a fact (Q3, Q-B3-3): the request's (fact_correction) or the carried one,
    // kept only while the currency is closed at save time. Carrying is what allows a closed
    // currency here (R3 b), never this flag.
    closedCurrencyAck: sql`CASE WHEN ${accountCurrencies.status} = 'closed' THEN ${f ? (f.closedCurrencyAck ? 1 : 0) : c.closedCurrencyAck} ELSE 0 END`.as('closed_currency_ack'),
    carriedFromEntryId: c.id,
    createdAt: v(now, 'created_at'),
  } satisfies Record<keyof typeof transactionEntries.$inferSelect, unknown>;
  return db.insert(transactionEntries).select(
    db
      .select(row)
      .from(transactionEvents)
      .innerJoin(c, and(eq(c.id, en.from), eq(c.userId, transactionEvents.userId)))
      .innerJoin(
        accountCurrencies,
        and(eq(accountCurrencies.accountId, c.fundingAccountId), eq(accountCurrencies.userId, transactionEvents.userId), f ? eq(accountCurrencies.currency, f.currency) : eq(accountCurrencies.currency, c.fundingCurrency)),
      )
      .where(and(eq(transactionEvents.id, E), eq(transactionEvents.userId, u))),
  );
}

/**
 * The correction chain (DATA_MODEL §10.10, "更正"; the same for all three kinds): S0 … S5 in ONE
 * db.batch(). S1 inserts version r+1 only for the caller's active transaction still at r, joined to
 * version r (`prev`), and only while gate G holds. S3 publishes r → r+1 only if this request's
 * event E exists and has all its entries (C1–C7 run). The audit and the key row exist only if E
 * was published as r+1 here — if another request made r+1 first, E is not there and nothing of
 * that result is counted as this one's. The key row is last, complete, 201, kept 30 days.
 */
export function correctChain(db: DB, x: CorrectChainIn) {
  const r = x.baseRevision;
  const G = gate(db, x.u, x.key);
  const p = prevEvent;
  const homeRegion = x.correctedHomeRegion ? sql`${x.correctedHomeRegion}` : sql`${p.homeRegion}`;
  const merchantCountry = x.facts ? sql`${x.facts.merchantCountry}` : sql`${p.merchantCountry}`;
  const merchant = x.txnType === 'merchant_spend' || x.txnType === 'merchant_refund';
  // Derived from the home_region this statement stores (row CHECK merchant_scope_rule_ck), as in a create.
  const merchantScope = merchant
    ? sql`CASE WHEN ${merchantCountry} IS NULL THEN 'unknown' WHEN ${merchantCountry} = ${homeRegion} THEN 'domestic' ELSE 'foreign' END`.as('merchant_scope')
    : v(null, 'merchant_scope');
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
        ...(x.facts ? factColumns(x.facts) : copiedFacts(p)),
        homeRegion: homeRegion.as('home_region'),
        homeRegionSource: v(x.correctedHomeRegion ? 'user_corrected' : 'carried', 'home_region_source'),
        merchantScope,
        transferScope: v(x.classification.transferScope, 'transfer_scope'),
        foreignStatus: v(x.classification.foreignStatus, 'foreign_status'),
        classifierVersion: p.classifierVersion,
        createdAt: v(x.now, 'created_at'),
      } satisfies Record<keyof typeof transactionEvents.$inferSelect, unknown>)
      .from(transactions)
      .innerJoin(p, and(eq(p.transactionId, transactions.id), eq(p.userId, transactions.userId), eq(p.revision, r)))
      .where(and(eq(transactions.id, x.T), eq(transactions.userId, x.u), eq(transactions.status, 'active'), eq(transactions.currentRevision, r), G)),
  );
  const S2 = x.entries.map((en) => ('carried' in en ? carriedEntry(db, x.u, x.E, en.carried, x.now) : newEntry(db, x.u, x.E, en.fresh, x.now)));
  const published = sql`EXISTS (SELECT 1 FROM transaction_events WHERE id = ${x.E} AND transaction_id = ${x.T} AND user_id = ${x.u} AND revision = ${r + 1})`;
  const S3 = db
    .update(transactions)
    .set({ currentRevision: r + 1, updatedAt: x.now })
    .where(
      and(
        eq(transactions.id, x.T),
        eq(transactions.userId, x.u),
        eq(transactions.currentRevision, r),
        published,
        sql`(SELECT count(*) FROM transaction_entries WHERE event_id = ${x.E}) = ${x.entries.length}`,
      ),
    );
  const S4 = db.insert(auditLog).select(
    db
      .select({
        id: v(x.A, 'id'),
        userId: transactions.userId,
        action: v('transaction.correct' satisfies AuditAction, 'action'),
        detail: sql`json_object('id', ${transactions.id}, 'eventId', ${x.E}, 'revision', ${transactions.currentRevision}, 'kind', ${x.kind})`.as('detail'),
        ip: v(x.ip, 'ip'),
        createdAt: v(x.now, 'created_at'),
      } satisfies Record<keyof typeof auditLog.$inferSelect, unknown>)
      .from(transactions)
      .where(and(eq(transactions.id, x.T), eq(transactions.userId, x.u), eq(transactions.currentRevision, r + 1), published)),
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
        resultRevision: sql`(SELECT current_revision FROM transactions WHERE id = ${x.T} AND user_id = ${x.u} AND status = 'active' AND current_revision = ${r + 1} AND ${published})`.as('result_revision'),
        resultEventId: sql`(SELECT e.id FROM transaction_events e JOIN transactions t ON t.id = e.transaction_id AND t.user_id = e.user_id WHERE e.id = ${x.E} AND e.transaction_id = ${x.T} AND e.user_id = ${x.u} AND e.revision = ${r + 1} AND t.current_revision = ${r + 1})`.as('result_event_id'),
        auditId: sql`(SELECT id FROM audit_log WHERE id = ${x.A})`.as('audit_id'),
        responseStatus: v(201, 'response_status'),
        createdAt: v(x.now, 'created_at'),
        expiresAt: v(x.now + CORRECTION_KEY_TTL_MS, 'expires_at'),
      } satisfies Record<keyof typeof ledgerIdempotencyKeys.$inferSelect, unknown>)
      .from(users)
      .where(and(eq(users.id, x.u), G)),
  );
  return { S0: expiredKeys(db, x.u, x.now), S1, S2, S3, S4, S5 };
}

export function correctBatch(db: DB, x: CorrectChainIn): Batch {
  const { S0, S1, S2, S3, S4, S5 } = correctChain(db, x);
  return [S0, S1, ...S2, S3, S4, S5];
}
