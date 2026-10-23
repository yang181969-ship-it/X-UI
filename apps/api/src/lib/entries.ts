import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { DB } from '../db/client.ts';
import { transactions, users } from '../db/schema.ts';
import { errorChain, fail } from './http.ts';

/**
 * Deleting a ledger entry — one transaction, or every leg of a transfer — exactly as it was read.
 *
 * A route reads the legs, then deletes them in a batch. Between the two another request may have
 * turned the entry into a transfer (a new leg), back into one row (a leg gone), or moved a leg to
 * another account. Deleting the ids read would then leave a stray leg or recompute the wrong
 * balances. So the batch starts with guardOps: if the entry is no longer what was read, the
 * whole batch fails and nothing is written.
 */

type Leg = typeof transactions.$inferSelect;

/** The transaction and, for a transfer, every leg sharing its group (empty if it doesn't exist). */
export async function entryLegs(db: DB, userId: string, id: string): Promise<Leg[]> {
  const [cur] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.userId, userId)));
  if (!cur) return [];
  if (!cur.transferGroupId) return [cur];
  return db
    .select()
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.transferGroupId, cur.transferGroupId)));
}

/** A whole transfer: exactly one sending and one receiving leg, both transfers. */
export function isWholeTransfer(legs: Leg[]): boolean {
  return legs.length === 2 && legs.every((l) => l.type === 'transfer') && legs.some((l) => l.amount < 0) && legs.some((l) => l.amount > 0);
}

/**
 * SQL: the entry still has exactly these legs — the same ids, accounts, currencies and group,
 * and no other leg in that group.
 */
export function entryUnchanged(userId: string, legs: Leg[]): SQL {
  const group = legs[0]?.transferGroupId ?? null;
  const same = or(
    ...legs.map((l) =>
      and(
        eq(transactions.id, l.id),
        eq(transactions.accountId, l.accountId),
        eq(transactions.currency, l.currency),
        l.transferGroupId ? eq(transactions.transferGroupId, l.transferGroupId) : isNull(transactions.transferGroupId),
      ),
    ),
  );
  const members = group ? or(inArray(transactions.id, legs.map((l) => l.id)), eq(transactions.transferGroupId, group)) : inArray(transactions.id, legs.map((l) => l.id));
  return sql`(select count(*) from ${transactions} where ${transactions.userId} = ${userId} and ${members}) = ${legs.length} and (select count(*) from ${transactions} where ${transactions.userId} = ${userId} and ${same}) = ${legs.length}`;
}

/**
 * First statement of a batch that must only run while `condition` holds: if it doesn't, the
 * user's own row gets a NULL username, which NOT NULL turns into an error that rolls the whole
 * batch back (libSQL and D1 alike). The user's row always exists, so unlike a guard on the row
 * being changed it can't silently match nothing; when the condition holds it writes the same value.
 */
export function guardOps(db: DB, userId: string, condition: SQL): BatchItem<'sqlite'>[] {
  return [
    db
      .update(users)
      .set({ username: sql`case when ${condition} then ${users.username} else null end` })
      .where(eq(users.id, userId)),
  ];
}

/** A batch error from a failed guardOps becomes 409 TX_CHANGED; any other error is rethrown. */
export function rethrowGuard(err: unknown): never {
  if (errorChain(err).includes('users.username')) fail(409, 'the transaction was changed meanwhile — reload and try again', 'TX_CHANGED');
  throw err;
}
