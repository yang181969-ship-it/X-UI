import { and, countDistinct, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { transactionEntries, transactionEvents } from '../db/schema.ts';

/**
 * How many of the caller's transactions reference an account, card or channel — for the 409 IN_USE
 * details of the M2 deletes (API_SPEC §5.12, DATA_MODEL §10.11 L5). Every version counts (current
 * and superseded) and every status (voided too); a transaction is counted once however many
 * versions or entries name the object. The NO ACTION foreign keys are what actually refuses the
 * delete — these counts only explain it (before the delete, or after the keys refused it).
 */

/** Transactions with an entry (any version) on the account. */
export async function transactionsUsingAccount(db: DB, userId: string, accountId: string): Promise<number> {
  const [row] = await db
    .select({ n: countDistinct(transactionEvents.transactionId) })
    .from(transactionEntries)
    .innerJoin(transactionEvents, and(eq(transactionEvents.id, transactionEntries.eventId), eq(transactionEvents.userId, transactionEntries.userId)))
    .where(and(eq(transactionEntries.userId, userId), eq(transactionEntries.fundingAccountId, accountId)));
  return Number(row?.n ?? 0);
}

/** Transactions with a version (any) that used the card. */
export async function transactionsUsingCard(db: DB, userId: string, cardId: string): Promise<number> {
  const [row] = await db
    .select({ n: countDistinct(transactionEvents.transactionId) })
    .from(transactionEvents)
    .where(and(eq(transactionEvents.userId, userId), eq(transactionEvents.cardId, cardId)));
  return Number(row?.n ?? 0);
}

/** Transactions with a version (any) that used the payment channel. */
export async function transactionsUsingChannel(db: DB, userId: string, channelId: string): Promise<number> {
  const [row] = await db
    .select({ n: countDistinct(transactionEvents.transactionId) })
    .from(transactionEvents)
    .where(and(eq(transactionEvents.userId, userId), eq(transactionEvents.paymentChannelId, channelId)));
  return Number(row?.n ?? 0);
}

/** Which of `currencies` of the account an entry (any version) uses. */
export async function currenciesUsedByEntries(db: DB, userId: string, accountId: string, currencies: readonly string[]): Promise<string[]> {
  if (!currencies.length) return [];
  const rows = await db
    .selectDistinct({ currency: transactionEntries.fundingCurrency })
    .from(transactionEntries)
    .where(and(eq(transactionEntries.userId, userId), eq(transactionEntries.fundingAccountId, accountId), inArray(transactionEntries.fundingCurrency, [...currencies])));
  return rows.map((r) => r.currency);
}
