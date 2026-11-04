import type { EntryFacts, EventFacts, TransactionWriteResult } from '@xui/ledger-shared';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { ledgerIdempotencyKeys, transactionEntries, transactionEvents, transactions } from '../db/schema.ts';
import { LedgerWriteError } from './transactionErrors.ts';

/**
 * TransactionWriteResult (API_SPEC §5.2): the result of a financial write, built from immutable
 * rows only — the version's event, its entries, the header's id and type (and, for a void, the
 * void data, final once written). Never notes, current names, currentRevision or current status.
 * The first response and every replay go through writeResult(), so they are byte-for-byte equal
 * however the transaction changes afterwards.
 */

type EventRow = typeof transactionEvents.$inferSelect;
type EntryRow = typeof transactionEntries.$inferSelect;
export type KeyRow = typeof ledgerIdempotencyKeys.$inferSelect;

/** Fixed field order (the JSON text is part of the replay contract). */
export function eventFacts(r: EventRow): EventFacts {
  return {
    eventId: r.id,
    revision: r.revision,
    revisionKind: r.revisionKind,
    correctionReason: r.correctionReason,
    recordMode: r.recordMode,
    occurredOn: r.occurredOn,
    occurredTime: r.occurredTime,
    postedOn: r.postedOn,
    eventCurrency: r.eventCurrency,
    eventAmount: r.eventAmount,
    eventCurrencyExponent: r.eventCurrencyExponent,
    merchantName: r.merchantName,
    merchantCountry: r.merchantCountry,
    cardId: r.cardId,
    paymentChannelId: r.paymentChannelId,
    transferMethod: r.transferMethod,
    counterparty:
      r.counterpartyKind === null
        ? null
        : { kind: r.counterpartyKind, name: r.counterpartyName, country: r.counterpartyCountry, institution: r.counterpartyInstitution, accountHint: r.counterpartyAccountHint },
    homeRegion: r.homeRegion,
    homeRegionSource: r.homeRegionSource,
    merchantScope: r.merchantScope,
    transferScope: r.transferScope,
    foreignStatus: r.foreignStatus,
    classifierVersion: r.classifierVersion,
    createdAt: r.createdAt,
  };
}

export function entryFacts(r: EntryRow): EntryFacts {
  return {
    entryId: r.id,
    direction: r.direction,
    accountId: r.fundingAccountId,
    currency: r.fundingCurrency,
    currencyExponent: r.currencyExponent,
    amount: r.amount,
    amountStatus: r.amountStatus,
    fundingAccountCountry: r.fundingAccountCountry,
    countrySource: r.countrySource,
    currencyStatusAtSave: r.currencyStatusAtSave,
    closedCurrencyAck: r.closedCurrencyAck,
    carriedFromEntryId: r.carriedFromEntryId,
  };
}

/** Entries in direction order: out first (as the request hash orders them). */
export const byDirection = (a: { direction: string }, b: { direction: string }) => (a.direction === b.direction ? 0 : a.direction === 'out' ? -1 : 1);

/** Rebuild the result a key row stands for (its own user only). Separate plain queries: no joined selects (D1 maps by column name). */
export async function writeResult(db: DB, key: KeyRow): Promise<TransactionWriteResult> {
  const u = key.userId;
  const [header] = await db
    .select({ id: transactions.id, txnType: transactions.txnType, voidedAt: transactions.voidedAt, voidReason: transactions.voidReason })
    .from(transactions)
    .where(and(eq(transactions.id, key.transactionId), eq(transactions.userId, u)));
  const [event] = await db
    .select()
    .from(transactionEvents)
    .where(and(eq(transactionEvents.id, key.resultEventId), eq(transactionEvents.userId, u), eq(transactionEvents.transactionId, key.transactionId)));
  if (!header || !event || event.revision !== key.resultRevision) throw new LedgerWriteError('a key row points at a missing result');
  const entries = await db
    .select()
    .from(transactionEntries)
    .where(and(eq(transactionEntries.eventId, event.id), eq(transactionEntries.userId, u)));
  const isVoid = key.operation === 'transaction.void';
  if (isVoid && header.voidedAt === null) throw new LedgerWriteError('a void key row points at an active transaction');
  return {
    operation: key.operation,
    transactionId: header.id,
    txnType: header.txnType,
    revision: event.revision,
    eventId: event.id,
    statusAfter: isVoid ? 'voided' : 'active',
    recordedAt: isVoid ? header.voidedAt! : event.createdAt,
    event: eventFacts(event),
    entries: entries.sort(byDirection).map(entryFacts),
    void: isVoid ? { voidedAt: header.voidedAt!, reason: header.voidReason } : null,
  };
}
