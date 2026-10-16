import { and, eq, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { DB } from '../db/client.ts';
import { accountCurrencies, transactions } from '../db/schema.ts';

/**
 * account_currencies.balance / tx_count are a cache of
 *   opening_balance + Σ transactions.amount   and   count(transactions)
 * per (account, currency). Every write that inserts, changes or deletes transactions appends
 * these statements to the same batch, so the cache is updated atomically with the data and
 * reading balances never scans the transactions table (D1 counts rows read per day).
 */

export interface Pair {
  accountId: string;
  currency: string;
}

const balanceSql = sql`${accountCurrencies.openingBalance} + coalesce((select sum(t.amount) from ${transactions} t where t.account_id = ${accountCurrencies.accountId} and t.currency = ${accountCurrencies.currency}), 0)`;
const countSql = sql`(select count(*) from ${transactions} t where t.account_id = ${accountCurrencies.accountId} and t.currency = ${accountCurrencies.currency})`;

/** Recompute the given (account, currency) pairs (duplicates are ignored). */
export function recalcOps(db: DB, pairs: Pair[]): BatchItem<'sqlite'>[] {
  const seen = new Set<string>();
  const ops: BatchItem<'sqlite'>[] = [];
  for (const p of pairs) {
    const key = `${p.accountId}|${p.currency}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ops.push(
      db
        .update(accountCurrencies)
        .set({ balance: balanceSql, txCount: countSql })
        .where(and(eq(accountCurrencies.accountId, p.accountId), eq(accountCurrencies.currency, p.currency))),
    );
  }
  return ops;
}

/** Recompute every currency of one account (after its currency list or opening balances changed). */
export function recalcAccountOps(db: DB, accountId: string): BatchItem<'sqlite'>[] {
  return [db.update(accountCurrencies).set({ balance: balanceSql, txCount: countSql }).where(eq(accountCurrencies.accountId, accountId))];
}

/** Repair: recompute all of a user's balances. */
export function recalcUserOps(db: DB, userId: string): BatchItem<'sqlite'>[] {
  return [db.update(accountCurrencies).set({ balance: balanceSql, txCount: countSql }).where(eq(accountCurrencies.userId, userId))];
}

export const pairsOf = (rows: { accountId: string; currency: string }[]): Pair[] => rows.map((r) => ({ accountId: r.accountId, currency: r.currency }));
