import { and, eq, inArray, notInArray, sql, type Column, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { recordTypesLinkableTo, type TransactionType } from '@z-ui/shared';
import type { DB } from '../db/client.ts';
import { historicalRecords, transactions } from '../db/schema.ts';

/**
 * Keeping historical records in step with the transactions they point at. These statements go
 * into the same batch as the transaction write, before any delete: the foreign key on
 * linked_transaction_id rejects deleting a transaction a record still points at. Each one
 * increments the records' version, so a request that read them earlier can no longer act on them.
 */

const nextVersion = sql`${historicalRecords.version} + 1`;

/**
 * Transactions about to be deleted: records linked to (or converted into) one of them go back
 * to open, with link_lost_at saying why. Their own data is kept as it was.
 */
export function releaseArchiveOps(db: DB, userId: string, txIds: string[], now: number): BatchItem<'sqlite'>[] {
  if (txIds.length === 0) return [];
  return [
    db
      .update(historicalRecords)
      .set({ status: 'open', linkedTransactionId: null, convertedAt: null, linkLostAt: now, version: nextVersion, updatedAt: now })
      .where(and(eq(historicalRecords.userId, userId), inArray(historicalRecords.linkedTransactionId, txIds))),
  ];
}

/**
 * A transaction edited in place keeps its records: a link to any of its old legs moves to
 * `anchorId`, the leg that represents it now (a transfer's sending leg, else the row itself).
 */
export function followArchiveOps(db: DB, userId: string, oldIds: string[], anchorId: string, now: number): BatchItem<'sqlite'>[] {
  const others = oldIds.filter((id) => id !== anchorId);
  if (others.length === 0) return [];
  return [
    db
      .update(historicalRecords)
      .set({ linkedTransactionId: anchorId, version: nextVersion, updatedAt: now })
      .where(and(eq(historicalRecords.userId, userId), inArray(historicalRecords.linkedTransactionId, others))),
  ];
}

/**
 * A transaction edited into another type: records merely linked to it that no longer fit that
 * type (ARCHIVE_LINK_TYPES) go back to open. Converted records stay — the transaction was made
 * from them and is the copy that counts; releasing them would let them be booked a second time.
 */
export function releaseMismatchedOps(db: DB, userId: string, oldIds: string[], newType: TransactionType, now: number): BatchItem<'sqlite'>[] {
  const fits = recordTypesLinkableTo(newType);
  return [
    db
      .update(historicalRecords)
      .set({ status: 'open', linkedTransactionId: null, linkLostAt: now, version: nextVersion, updatedAt: now })
      .where(
        and(
          eq(historicalRecords.userId, userId),
          inArray(historicalRecords.linkedTransactionId, oldIds),
          eq(historicalRecords.status, 'linked'),
          fits.length ? notInArray(historicalRecords.recordType, fits) : undefined,
        ),
      ),
  ];
}

/**
 * SQL condition, evaluated inside the write that relies on it: transaction `txId` (a value or a
 * column) exists, belongs to `userId`, has one of `types`, and is the anchor of its entry — a
 * transfer's sending leg, or a row that is not part of a transfer.
 */
export function fittingAnchor(txId: string | Column, userId: string | Column, types: readonly TransactionType[]): SQL {
  const typeOk = types.length ? inArray(transactions.type, [...types]) : sql`0`;
  return sql`exists (select 1 from ${transactions} where ${transactions.id} = ${txId} and ${transactions.userId} = ${userId} and ${typeOk} and (${transactions.transferGroupId} is null or ${transactions.amount} < 0))`;
}

/**
 * A transaction edited into another type while a record was converted into it: such a record
 * can't be released (it would be booked again), so if it no longer fits the new type the edit
 * is refused — this statement sets its status to NULL, which NOT NULL turns into an error that
 * rolls back the transaction's whole batch. Records that still fit are left as they are.
 */
export function convertedTypeGuardOps(db: DB, userId: string, oldIds: string[], newType: TransactionType): BatchItem<'sqlite'>[] {
  const fits = recordTypesLinkableTo(newType);
  const fitsSql = fits.length ? inArray(historicalRecords.recordType, fits) : sql`0`;
  return [
    db
      .update(historicalRecords)
      .set({ status: sql`case when ${fitsSql} then ${historicalRecords.status} else null end` })
      .where(and(eq(historicalRecords.userId, userId), inArray(historicalRecords.linkedTransactionId, oldIds), eq(historicalRecords.status, 'converted'))),
  ];
}

/** The leg a record points at: a transfer's sending leg (lowest id on a tie), else the row itself. */
export function anchorLeg<T extends { id: string; amount: number }>(legs: T[]): T {
  const sorted = [...legs].sort((a, b) => (a.id < b.id ? -1 : 1));
  return sorted.find((l) => l.amount < 0) ?? sorted[0]!;
}
