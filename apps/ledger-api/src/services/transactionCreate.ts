import {
  classify,
  currencyExponent,
  DEFAULT_HOME_REGION,
  type AccountCurrencyStatus,
  type Classification,
  type ClosedCurrencyAckDetails,
  type EntryCurrencyDetails,
  type EntryInput,
  type TransactionCreate,
} from '@xui/ledger-shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Context } from 'hono';
import { accountCurrencies, accounts, cards, paymentChannels, userPreferences } from '../db/schema.ts';
import type { AppBindings } from '../env.ts';
import { fail, notFound } from '../lib/http.ts';
import { newId } from '../lib/id.ts';
import { classifyWriteFailure, LedgerWriteError } from './transactionErrors.ts';
import { answerStoredKey, committedOutcome, liveKey, takenKeyOutcome, type RequestFingerprint, type WriteOutcome } from './transactionIdempotency.ts';
import { byDirection } from './transactionResult.ts';
import { createBatch, type CreateChainIn } from './transactionWrite.ts';

/**
 * POST /transactions after the request itself passed (API_SPEC §5.4; DATA_MODEL §10.10):
 *
 * 1. Ownership, as the caller (§5.0.1): each entry's account (out first), the card, the channel —
 *    another user's and a missing one are the same 404, before any other database-dependent error.
 * 2. Account currencies: not registered → 400 CURRENCY_NOT_ON_ACCOUNT (status null); closed in a
 *    current transaction → the same with status 'closed'; closed in a backfill without the entry's
 *    acknowledgement → 400 CLOSED_CURRENCY_ACK_REQUIRED (P7).
 * 3. Classification v1 from the values read here (home region, account jurisdictions):
 *    confirmed purely domestic → 400 CONFIRMED_DOMESTIC (P2); undetermined is saved.
 * 4. The create chain in one batch, then the outcome per DATA_MODEL §10.10:
 *    - committed with this request's op id → 201; with another op id (gate G closed) or the key's
 *      primary key refused → the stored key decides (replay / 409 / 500);
 *    - key row incomplete or a foreign key refused → re-read as the caller: 404 / 400, otherwise 500
 *      (a foreign-key failure is never a 404 by itself);
 *    - LEDGER_CLASSIFICATION / LEDGER_CLOSED_CURRENCY → a controlled retry candidate, only when a
 *      re-read shows that the source the step 1–3 values came from really changed: one more full
 *      attempt with the same key and request hash and new ids (the first attempt was rolled back
 *      entirely — a RAISE aborts the batch); a second confirmed change → 409 CONCURRENT_CHANGE;
 *      no change → 500;
 *    - anything else (other LEDGER_* guards, CHECK, other UNIQUE, an unknown outcome) → 500 with
 *      the generic message; the server never re-runs a write whose outcome is unknown — the
 *      client's retry with the same key finds a committed write through the key row.
 * Database messages only go to the server log (app.onError); no response carries them.
 */

type C = Context<AppBindings>;

/** What steps 1–3 read: the values each snapshot source had, for the post-batch comparison (also used by corrections). */
export interface Sources {
  /** account id → account_country (the caller's accounts named by the entries). */
  accountCountry: Map<string, string>;
  /** `${accountId}:${currency}` → status (the caller's account currencies named by the entries). */
  currencyStatus: Map<string, AccountCurrencyStatus>;
  cardFound: boolean;
  channelFound: boolean;
  /** coalesce(user_preferences.home_region, 'CN') of the caller. */
  preference: string;
}

export const currencyKey = (accountId: string, currency: string) => `${accountId}:${currency}`;

/** The references of a request with entries, a card and a channel: a create or a fact correction. */
export type ReferencesIn = Pick<TransactionCreate, 'entries' | 'cardId' | 'paymentChannelId'>;

export async function readSources(c: C, input: ReferencesIn): Promise<Sources> {
  const { db } = c.var.deps;
  const u = c.var.user.id;
  const accountIds = [...new Set(input.entries.map((e) => e.accountId))];
  const accountRows = accountIds.length
    ? await db.select({ id: accounts.id, country: accounts.accountCountry }).from(accounts).where(and(eq(accounts.userId, u), inArray(accounts.id, accountIds)))
    : [];
  const currencyRows = accountIds.length
    ? await db
        .select({ accountId: accountCurrencies.accountId, currency: accountCurrencies.currency, status: accountCurrencies.status })
        .from(accountCurrencies)
        .where(and(eq(accountCurrencies.userId, u), inArray(accountCurrencies.accountId, accountIds)))
    : [];
  const [card] = input.cardId ? await db.select({ id: cards.id }).from(cards).where(and(eq(cards.userId, u), eq(cards.id, input.cardId))) : [];
  const [channel] = input.paymentChannelId
    ? await db.select({ id: paymentChannels.id }).from(paymentChannels).where(and(eq(paymentChannels.userId, u), eq(paymentChannels.id, input.paymentChannelId)))
    : [];
  const [pref] = await db.select({ homeRegion: userPreferences.homeRegion }).from(userPreferences).where(eq(userPreferences.userId, u));
  return {
    accountCountry: new Map(accountRows.map((r) => [r.id, r.country])),
    currencyStatus: new Map(currencyRows.map((r) => [currencyKey(r.accountId, r.currency), r.status])),
    cardFound: Boolean(card),
    channelFound: Boolean(channel),
    preference: pref?.homeRegion ?? DEFAULT_HOME_REGION,
  };
}

/** Step 1: 404 for anything the caller can't see (same body for another user's and a missing id). */
export function assertOwned(input: ReferencesIn, entries: readonly EntryInput[], s: Sources) {
  for (const e of entries) if (!s.accountCountry.has(e.accountId)) notFound('account');
  if (input.cardId !== null && !s.cardFound) notFound('card');
  if (input.paymentChannelId !== null && !s.channelFound) notFound('payment channel');
}

export const currencyProblem = (details: EntryCurrencyDetails): never =>
  fail(400, 'the entry currency is not a registered currency of the account, or it is closed', 'CURRENCY_NOT_ON_ACCOUNT', details);

/** Step 2a: every entry currency is registered on its account. */
export function assertRegistered(entries: readonly EntryInput[], s: Sources) {
  for (const e of entries) if (!s.currencyStatus.has(currencyKey(e.accountId, e.currency))) currencyProblem({ direction: e.direction, currency: e.currency, status: null });
}

/** Step 2b: closed currencies only in an acknowledged backfill (P7); an acknowledgement on an active currency is harmless (Q3). */
function assertCurrencyUsable(input: TransactionCreate, entries: readonly EntryInput[], s: Sources) {
  const closed = entries.filter((e) => s.currencyStatus.get(currencyKey(e.accountId, e.currency)) === 'closed');
  if (input.recordMode === 'current') for (const e of closed) currencyProblem({ direction: e.direction, currency: e.currency, status: 'closed' });
  for (const e of closed) {
    if (!e.closedCurrencyAck) {
      fail(400, 'a backfilled entry in a closed currency needs closedCurrencyAck: true', 'CLOSED_CURRENCY_ACK_REQUIRED', { direction: e.direction } satisfies ClosedCurrencyAckDetails);
    }
  }
}

interface Plan {
  entries: EntryInput[];
  sources: Sources;
  homeRegion: string;
  classification: Classification;
}

/** Steps 1–3. */
async function prepare(c: C, input: TransactionCreate): Promise<Plan> {
  const entries = [...input.entries].sort(byDirection);
  const sources = await readSources(c, input);
  assertOwned(input, entries, sources);
  assertRegistered(entries, sources);
  assertCurrencyUsable(input, entries, sources);
  const homeRegion = input.declaredHomeRegion ?? sources.preference;
  const classification = classify({
    txnType: input.type,
    homeRegion,
    merchantCountry: input.merchantCountry,
    counterpartyCountry: input.counterparty?.country ?? null,
    entries: entries.map((e) => ({ direction: e.direction, fundingAccountCountry: sources.accountCountry.get(e.accountId)! })),
  });
  if (classification.foreignStatus === 'domestic') {
    fail(400, 'a confirmed purely domestic transaction is not foreign financial activity and is not recorded', 'CONFIRMED_DOMESTIC');
  }
  return { entries, sources, homeRegion, classification };
}

/**
 * After LEDGER_CLASSIFICATION / LEDGER_CLOSED_CURRENCY: did a source of this attempt's values
 * change since prepare() read it? Classification: the home-region preference (only when it was
 * the source — a declared one can't change) and each entry account's jurisdiction. Closed
 * currency: each entry currency's status. A source that is gone counts as changed.
 */
async function sourcesChanged(c: C, input: TransactionCreate, plan: Plan, code: 'LEDGER_CLASSIFICATION' | 'LEDGER_CLOSED_CURRENCY'): Promise<boolean> {
  const now = await readSources(c, input);
  if (code === 'LEDGER_CLASSIFICATION') {
    if (input.declaredHomeRegion === null && now.preference !== plan.sources.preference) return true;
    return plan.entries.some((e) => now.accountCountry.get(e.accountId) !== plan.sources.accountCountry.get(e.accountId));
  }
  return plan.entries.some((e) => {
    const k = currencyKey(e.accountId, e.currency);
    return now.currencyStatus.get(k) !== plan.sources.currencyStatus.get(k);
  });
}

/** After an incomplete key row or a foreign-key failure: explain it from what the caller sees now, or give up (500). */
async function explainMissing(c: C, input: TransactionCreate, cause: unknown): Promise<never> {
  const entries = [...input.entries].sort(byDirection);
  const now = await readSources(c, input);
  assertOwned(input, entries, now);
  assertRegistered(entries, now);
  throw new LedgerWriteError('the transaction write did not complete and re-reading does not explain why', { cause });
}

function chainInput(c: C, input: TransactionCreate, plan: Plan, key: string, request: RequestFingerprint, now: number): CreateChainIn {
  const transfer = input.type === 'own_transfer' || input.type === 'third_party_transfer';
  const cp = input.counterparty;
  return {
    u: c.var.user.id,
    T: newId(now),
    E: newId(now),
    O: newId(now),
    A: newId(now),
    now,
    ip: c.var.ip,
    key,
    requestHash: request.hash,
    hashVersion: request.hashVersion,
    txnType: input.type,
    notes: input.notes,
    facts: {
      recordMode: input.recordMode,
      occurredOn: input.occurredOn,
      occurredTime: input.occurredTime,
      postedOn: input.postedOn,
      eventCurrency: input.eventCurrency,
      eventAmount: input.eventAmount,
      eventCurrencyExponent: input.eventCurrency === null ? null : currencyExponent(input.eventCurrency),
      merchantName: input.merchantName,
      merchantCountry: input.merchantCountry,
      cardId: input.cardId,
      paymentChannelId: input.paymentChannelId,
      transferMethod: input.transferMethod,
      counterpartyKind: transfer ? (input.type === 'own_transfer' ? 'self' : 'third_party') : null,
      counterpartyName: cp?.name ?? null,
      counterpartyCountry: cp?.country ?? null,
      counterpartyInstitution: cp?.institution ?? null,
      counterpartyAccountHint: cp?.accountHint ?? null,
    },
    declaredHomeRegion: input.declaredHomeRegion,
    classification: plan.classification,
    entries: plan.entries.map((e) => ({
      id: newId(now),
      direction: e.direction,
      accountId: e.accountId,
      currency: e.currency,
      amount: e.amount,
      amountStatus: e.amountStatus,
      exponent: currencyExponent(e.currency),
      closedCurrencyAck: e.closedCurrencyAck,
    })),
  };
}

/**
 * Steps 1–4 for a request whose key is not stored yet (the route looked it up first). `now` is the
 * request's one server time (API_SPEC §5.0.3): every attempt, its S0 and its key row use it.
 */
export async function createTransaction(c: C, input: TransactionCreate, key: string, request: RequestFingerprint, now: number): Promise<WriteOutcome> {
  const { db } = c.var.deps;
  const u = c.var.user.id;
  for (let attempt = 1; ; attempt++) {
    const plan = await prepare(c, input);
    const x = chainInput(c, input, plan, key, request, now);
    try {
      await db.batch(createBatch(db, x));
    } catch (err) {
      const failure = classifyWriteFailure(err);
      if (failure.kind === 'key_taken') return takenKeyOutcome(c.var.deps, u, key, request, now, err);
      if (failure.kind === 'key_incomplete' || failure.kind === 'foreign_key') return explainMissing(c, input, err);
      if (failure.kind === 'ledger' && (failure.code === 'LEDGER_CLASSIFICATION' || failure.code === 'LEDGER_CLOSED_CURRENCY')) {
        if (!(await sourcesChanged(c, input, plan, failure.code))) throw new LedgerWriteError(`${failure.code} without a changed source`, { cause: err });
        if (attempt >= 2) fail(409, 'the account jurisdiction, home region or currency status changed while saving — try again', 'CONCURRENT_CHANGE');
        // The batch was rolled back (a RAISE aborts it). A request with the same key may have
        // committed meanwhile: then that result answers this request, nothing is written again.
        const stored = await liveKey(db, u, key, now);
        if (stored) return answerStoredKey(c.var.deps, stored, request, now);
        continue;
      }
      throw new LedgerWriteError('the transaction write failed', { cause: err });
    }
    // Committed: this request's key row, or (gate G was closed) the one another request stored first.
    return committedOutcome(c.var.deps, u, key, x.O, request, now);
  }
}
