import {
  ENTRY_DIRECTIONS,
  MERCHANT_SCOPES,
  mergeSegmentedSum,
  SUM_GROUP_ROWS_MAX,
  SUM_SEGMENT,
  TRANSFER_SCOPES,
  TXN_TYPES,
  transactionSummaryQuerySchema,
  type EntryDirection,
  type ForeignStatus,
  type MerchantScope,
  type SummaryGroup,
  type TransactionSummaryDto,
  type TransferScope,
  type TxnType,
} from '@xui/ledger-shared';
import { and, asc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { DB } from '../db/client.ts';
import { transactionEntries, transactionEvents, transactions } from '../db/schema.ts';

/**
 * GET /transactions/summary (API_SPEC §5.10, DATA_MODEL §10.12, PRODUCT_SPEC §7.7).
 *
 * Scope of every part: the caller's ACTIVE transactions, their CURRENT version only (the event's
 * revision equals the header's current_revision — superseded versions never count), the caller's
 * entries of that version, filtered by occurredOn (from / to inclusive), the transaction type and
 * the ENTRY currency (an HKD filter keeps a transaction's HKD entries, never its USD entry).
 *
 * - groups: confirmed entries per foreign_status × type × direction × currency × exponent ×
 *   merchant_scope × transfer_scope × account side (the entry's saved jurisdiction against the
 *   event's saved home_region — never the account's current country). Exact sums in SQL as two
 *   segments, CAST AS TEXT, merged with BigInt into a decimal string (no TOTAL / AVG / float).
 * - pending: pending entries counted per foreign_status × type × direction × currency × exponent;
 *   no amount of any kind.
 * - transactionCount / pendingTransactionCount: COUNT(DISTINCT transaction) over the same scope
 *   (any / pending entries).
 * - homeRegions: the distinct saved home_region of the transactions in that scope.
 *
 * Consistency: the four reads run as ONE db.batch(), which both engines execute as a single
 * transaction (libSQL: BEGIN DEFERRED … COMMIT on its one connection; D1: a batch is a
 * transaction), so every part of the answer comes from the same database state. drizzle's D1 batch
 * maps rows by column name, so every selected column has a distinct name.
 */

type C = { db: DB; userId: string };
type Query = z.infer<typeof transactionSummaryQuerySchema>;

// Explicitly qualified columns for the hand-written expressions.
const EN_AMOUNT = sql`"transaction_entries"."amount"`;
const SEGMENT = sql.raw(String(SUM_SEGMENT));
/** Account side from saved snapshots only (both columns are NOT NULL). */
const ACCOUNT_SCOPE = sql<'foreign' | 'domestic'>`CASE WHEN "transaction_entries"."funding_account_country" <> "transaction_events"."home_region" THEN 'foreign' ELSE 'domestic' END`;

/** The shared scope: caller, active, current version, the caller's entries, date / type / currency filters. */
function scope(userId: string, q: Query, amountStatus?: 'confirmed' | 'pending'): SQL {
  const conds: SQL[] = [
    eq(transactions.userId, userId),
    eq(transactions.status, 'active'),
    gte(transactions.currentRevision, 1),
    // Unary + keeps this term from choosing an index (see itsEntries).
    sql`+"transaction_entries"."user_id" = ${userId}`,
  ];
  if (q.from) conds.push(gte(transactionEvents.occurredOn, q.from));
  if (q.to) conds.push(lte(transactionEvents.occurredOn, q.to));
  if (q.type) conds.push(eq(transactions.txnType, q.type));
  if (q.currency) conds.push(eq(transactionEntries.fundingCurrency, q.currency));
  if (amountStatus) conds.push(eq(transactionEntries.amountStatus, amountStatus));
  return and(...conds)!;
}

/** The current version of each header and that version's entries (same user on every join). */
const currentEvent = and(eq(transactionEvents.transactionId, transactions.id), eq(transactionEvents.userId, transactions.userId), eq(transactionEvents.revision, transactions.currentRevision));
/**
 * Entries are reached by their event (UNIQUE(event_id, direction)). The user terms on entries carry
 * a unary + so SQLite never picks transaction_entries_user_account_idx (user_id = ?) for the inner
 * loop: without ANALYZE statistics it otherwise did so as soon as a date range drove the join from
 * transaction_events, scanning all of the user's entries once per event (10 000 transactions: 40 – 65 s).
 * The terms still filter every row; the composite foreign key already ties an entry to its event's user.
 * Semantics are unchanged: `+x` only drops the column's TEXT affinity, and user ids are always TEXT
 * (compared with a TEXT column — which gives the other side TEXT affinity — or with a bound text
 * parameter, the comparison is the same text equality). Tests pin both facts on libSQL and D1: the
 * plan reaches entries by event_id only, and every statement returns the same rows without the +.
 */
const itsEntries = and(eq(transactionEntries.eventId, transactionEvents.id), sql`+"transaction_entries"."user_id" = "transaction_events"."user_id"`);

export function summaryStatements(c: C, q: Query) {
  const confirmed = c.db
    .select({
      foreignStatus: transactionEvents.foreignStatus,
      txnType: transactions.txnType,
      direction: transactionEntries.direction,
      currency: transactionEntries.fundingCurrency,
      currencyExponent: transactionEntries.currencyExponent,
      merchantScope: transactionEvents.merchantScope,
      transferScope: transactionEvents.transferScope,
      accountScope: ACCOUNT_SCOPE.as('account_scope'),
      hi: sql<string>`CAST(SUM(${EN_AMOUNT} / ${SEGMENT}) AS TEXT)`.as('amount_hi'),
      lo: sql<string>`CAST(SUM(${EN_AMOUNT} % ${SEGMENT}) AS TEXT)`.as('amount_lo'),
      n: sql<number>`COUNT(*)`.as('entry_count'),
    })
    .from(transactions)
    .innerJoin(transactionEvents, currentEvent)
    .innerJoin(transactionEntries, itsEntries)
    .where(scope(c.userId, q, 'confirmed'))
    .groupBy(
      transactionEvents.foreignStatus,
      transactions.txnType,
      transactionEntries.direction,
      transactionEntries.fundingCurrency,
      transactionEntries.currencyExponent,
      transactionEvents.merchantScope,
      transactionEvents.transferScope,
      ACCOUNT_SCOPE,
    );
  const pending = c.db
    .select({
      foreignStatus: transactionEvents.foreignStatus,
      txnType: transactions.txnType,
      direction: transactionEntries.direction,
      currency: transactionEntries.fundingCurrency,
      currencyExponent: transactionEntries.currencyExponent,
      n: sql<number>`COUNT(*)`.as('pending_entry_count'),
    })
    .from(transactions)
    .innerJoin(transactionEvents, currentEvent)
    .innerJoin(transactionEntries, itsEntries)
    .where(scope(c.userId, q, 'pending'))
    .groupBy(transactionEvents.foreignStatus, transactions.txnType, transactionEntries.direction, transactionEntries.fundingCurrency, transactionEntries.currencyExponent);
  const counts = c.db
    .select({
      transactionCount: sql<number>`COUNT(DISTINCT "transactions"."id")`.as('txn_count'),
      pendingTransactionCount: sql<number>`COUNT(DISTINCT CASE WHEN "transaction_entries"."amount_status" = 'pending' THEN "transactions"."id" END)`.as('pending_txn_count'),
    })
    .from(transactions)
    .innerJoin(transactionEvents, currentEvent)
    .innerJoin(transactionEntries, itsEntries)
    .where(scope(c.userId, q));
  const homeRegions = c.db
    .selectDistinct({ homeRegion: transactionEvents.homeRegion })
    .from(transactions)
    .innerJoin(transactionEvents, currentEvent)
    .innerJoin(transactionEntries, itsEntries)
    .where(scope(c.userId, q))
    .orderBy(asc(transactionEvents.homeRegion));
  return [confirmed, pending, counts, homeRegions] as const;
}

/**
 * One group's exact sum. Fails (500) rather than answer a wrong amount: the segments must be
 * decimal text from SQL, and a group must stay below SUM_GROUP_ROWS_MAX rows (int64 headroom of
 * the segment sums, DATA_MODEL §10.12).
 */
export function groupAmount(hi: unknown, lo: unknown, rows: number): string {
  if (!(Number.isSafeInteger(rows) && rows >= 1 && rows < SUM_GROUP_ROWS_MAX)) throw new Error('summary group row count out of range');
  if (typeof hi !== 'string' || typeof lo !== 'string') throw new Error('summary segments are not text');
  return mergeSegmentedSum(hi, lo);
}

const rank = <T>(list: readonly T[], v: T | null) => (v === null ? list.length : list.indexOf(v));
const ACCOUNT_SCOPES = ['foreign', 'domestic'] as const;

/** Fixed order: type, direction (out first), currency, exponent, merchant side, transfer scope, account side. */
function byKey(a: SummaryGroup, b: SummaryGroup): number {
  return (
    rank(TXN_TYPES, a.txnType) - rank(TXN_TYPES, b.txnType) ||
    rank(ENTRY_DIRECTIONS, a.direction) - rank(ENTRY_DIRECTIONS, b.direction) ||
    (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0) ||
    a.currencyExponent - b.currencyExponent ||
    rank(MERCHANT_SCOPES, a.merchantScope) - rank(MERCHANT_SCOPES, b.merchantScope) ||
    rank(TRANSFER_SCOPES, a.transferScope) - rank(TRANSFER_SCOPES, b.transferScope) ||
    rank(ACCOUNT_SCOPES, a.accountScope) - rank(ACCOUNT_SCOPES, b.accountScope)
  );
}

type PendingGroup = TransactionSummaryDto['pending'][number];
const FOREIGN_ORDER: readonly ForeignStatus[] = ['foreign', 'undetermined', 'domestic'];
function pendingKey(a: PendingGroup, b: PendingGroup): number {
  return (
    rank(FOREIGN_ORDER, a.foreignStatus) - rank(FOREIGN_ORDER, b.foreignStatus) ||
    rank(TXN_TYPES, a.txnType) - rank(TXN_TYPES, b.txnType) ||
    rank(ENTRY_DIRECTIONS, a.direction) - rank(ENTRY_DIRECTIONS, b.direction) ||
    (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0) ||
    a.currencyExponent - b.currencyExponent
  );
}

export async function summarizeTransactions(c: C, q: Query): Promise<TransactionSummaryDto> {
  const [confirmedRows, pendingRows, countRows, regionRows] = await c.db.batch(summaryStatements(c, q));
  const blocks: Record<ForeignStatus, SummaryGroup[]> = { foreign: [], undetermined: [], domestic: [] };
  for (const r of confirmedRows) {
    const rows = Number(r.n);
    blocks[r.foreignStatus as ForeignStatus].push({
      txnType: r.txnType as TxnType,
      direction: r.direction as EntryDirection,
      currency: r.currency,
      currencyExponent: Number(r.currencyExponent),
      merchantScope: r.merchantScope as MerchantScope | null,
      transferScope: r.transferScope as TransferScope | null,
      accountScope: r.accountScope,
      amount: groupAmount(r.hi, r.lo, rows),
      count: rows,
    });
  }
  for (const list of Object.values(blocks)) list.sort(byKey);
  const pending: PendingGroup[] = pendingRows
    .map((r) => ({
      foreignStatus: r.foreignStatus as ForeignStatus,
      txnType: r.txnType as TxnType,
      direction: r.direction as EntryDirection,
      currency: r.currency,
      currencyExponent: Number(r.currencyExponent),
      count: Number(r.n),
    }))
    .sort(pendingKey);
  const totals = countRows[0];
  return {
    from: q.from ?? null,
    to: q.to ?? null,
    transactionCount: Number(totals?.transactionCount ?? 0),
    pendingTransactionCount: Number(totals?.pendingTransactionCount ?? 0),
    homeRegions: regionRows.map((r) => r.homeRegion),
    foreign: blocks.foreign,
    undetermined: blocks.undetermined,
    domestic: blocks.domestic,
    pending,
  };
}
