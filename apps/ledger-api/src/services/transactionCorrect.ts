import {
  classify,
  currencyExponent,
  transactionShapeProblem,
  type ClosedCurrencyAckDetails,
  type EntryInput,
  type EntryShapeDetails,
  type FactCorrection,
  type SettlementCorrection,
  type SnapshotCorrection,
  type TransactionCorrection,
  type TxnType,
} from '@xui/ledger-shared';
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { transactionEntries, transactionEvents } from '../db/schema.ts';
import type { AppBindings } from '../env.ts';
import { fail } from '../lib/http.ts';
import { newId } from '../lib/id.ts';
import { assertOwned, assertRegistered, currencyKey, currencyProblem, readSources, type Sources } from './transactionCreate.ts';
import { classifyWriteFailure, LedgerWriteError } from './transactionErrors.ts';
import { answerStoredKey, committedOutcome, liveKey, takenKeyOutcome, type RequestFingerprint, type WriteOutcome } from './transactionIdempotency.ts';
import { byDirection } from './transactionResult.ts';
import { assertCurrent } from './transactionVoid.ts';
import { correctBatch, type ClassificationIn, type CorrectChainIn, type CorrectEntryIn, type EventFactsIn } from './transactionWrite.ts';

/**
 * POST /transactions/:id/revisions after the request itself passed and its key was not live
 * (API_SPEC §5.7, §5.7.1 – §5.7.4; DATA_MODEL §10.9, §10.10 "更正"). Version r = baseRevision → r+1:
 *
 * 5–6. The caller's published transaction open at r (assertCurrent: 404 → 409 TRANSACTION_VOIDED
 *      → 409 REVISION_CONFLICT), then version r itself — immutable from here on.
 * 7–10. By kind, against version r:
 *   - settlement: every listed direction is a pending entry of r (else 400 VALIDATION); all entries
 *     carried, listed ones pending → confirmed; facts, snapshots, exponents, classification unchanged;
 *   - snapshot_correction: listed directions exist, each value differs from r (else 400 VALIDATION);
 *     facts carried, corrected snapshots user_corrected, the rest carried; reclassified → a confirmed
 *     domestic version is 400 CONFIRMED_DOMESTIC { suggestion: 'void' };
 *   - fact_correction: ENTRY_SHAPE for the stored type (Q-B3-1) → no change against r (400
 *     VALIDATION, Q-B3-6) → ownership 404 → registered / closed currencies → classification with
 *     r's home region, carried snapshots for accounts already in r and read ones for new accounts.
 * 11. One correction batch, then (DATA_MODEL §10.10): this request's key row → 201; another's →
 *     replay / 409 / 500; an incomplete key row or a foreign key → steps 5–8 again as the caller
 *     sees it now, else 500. LEDGER_CLASSIFICATION / LEDGER_CLOSED_CURRENCY retry once only for a
 *     fact correction whose re-read sources really changed (Q-B3-8), with the same key, hash and
 *     request time; settlement and snapshot_correction read no source that can change → 500.
 */

type C = Context<AppBindings>;
type EventRow = typeof transactionEvents.$inferSelect;
type EntryRow = typeof transactionEntries.$inferSelect;

/** details of a correction's 400 CONFIRMED_DOMESTIC (API_SPEC §5.1): the transaction is no foreign activity — void it. */
interface ConfirmedDomesticDetails {
  suggestion: 'void';
}

interface Base {
  txnType: TxnType;
  prev: EventRow;
  /** Version r's entries, out first. */
  prevEntries: EntryRow[];
}

/** Steps 5–6 and version r. */
async function loadBase(c: C, id: string, baseRevision: number): Promise<Base> {
  const { db } = c.var.deps;
  const u = c.var.user.id;
  const header = await assertCurrent(c, id, baseRevision);
  const [prev] = await db
    .select()
    .from(transactionEvents)
    .where(and(eq(transactionEvents.transactionId, id), eq(transactionEvents.userId, u), eq(transactionEvents.revision, baseRevision)));
  if (!prev) throw new LedgerWriteError('a published transaction misses its current version');
  const prevEntries = (await db.select().from(transactionEntries).where(and(eq(transactionEntries.eventId, prev.id), eq(transactionEntries.userId, u)))).sort(byDirection);
  if (!prevEntries.length) throw new LedgerWriteError('a published version has no entries');
  return { txnType: header.txnType, prev, prevEntries };
}

/** A 400 VALIDATION that depends on version r, in the zod issue shape (Q-B3-9). */
const invalid = (path: (string | number)[], message: string): never => fail(400, 'validation failed', 'VALIDATION', [{ code: 'custom', path, message }]);

const confirmedDomestic = (): never =>
  fail(400, 'the corrected version would be confirmed purely domestic — not foreign financial activity; void the transaction instead', 'CONFIRMED_DOMESTIC', {
    suggestion: 'void',
  } satisfies ConfirmedDomesticDetails);

interface Plan {
  facts: EventFactsIn | null;
  correctedHomeRegion: string | null;
  classification: ClassificationIn;
  /** Without ids (new for every attempt). */
  entries: ((id: string) => CorrectEntryIn)[];
  /** fact_correction: what the snapshots came from, for the controlled retry. */
  retry: { sources: Sources; freshAccounts: string[]; checkedCurrencies: string[] } | null;
}

// ------------------------------------------------------------------ settlement

function planSettlement(input: SettlementCorrection, b: Base): Plan {
  const byDir = new Map(b.prevEntries.map((e) => [e.direction, e]));
  input.entries.forEach((s, i) => {
    const p = byDir.get(s.direction);
    if (!p) invalid(['entries', i, 'direction'], 'the previous version has no entry in this direction');
    if (p!.amountStatus !== 'pending') invalid(['entries', i, 'direction'], 'only a pending entry can be settled');
  });
  const settled = new Map(input.entries.map((s) => [s.direction, s.amount]));
  return {
    facts: null,
    correctedHomeRegion: null,
    // Nothing a classification reads changes: version r's values (C6 checks them again).
    classification: { transferScope: b.prev.transferScope, foreignStatus: b.prev.foreignStatus },
    entries: b.prevEntries.map((p) => (id: string) => ({
      carried: { id, from: p.id, facts: null, amount: settled.has(p.direction) ? { amount: settled.get(p.direction)!, amountStatus: 'confirmed' } : null, correctedCountry: null },
    })),
    retry: null,
  };
}

// ------------------------------------------------------------------ snapshot correction (P5)

function planSnapshot(input: SnapshotCorrection, b: Base): Plan {
  const byDir = new Map(b.prevEntries.map((e) => [e.direction, e]));
  input.entries.forEach((s, i) => {
    if (!byDir.has(s.direction)) invalid(['entries', i, 'direction'], 'the previous version has no entry in this direction');
  });
  if (input.homeRegion !== null && input.homeRegion === b.prev.homeRegion) invalid(['homeRegion'], 'the home region is the same as in the previous version');
  input.entries.forEach((s, i) => {
    if (byDir.get(s.direction)!.fundingAccountCountry === s.fundingAccountCountry) invalid(['entries', i, 'fundingAccountCountry'], 'the jurisdiction is the same as in the previous version');
  });
  const corrected = new Map(input.entries.map((s) => [s.direction, s.fundingAccountCountry]));
  const classification = classify({
    txnType: b.txnType,
    homeRegion: input.homeRegion ?? b.prev.homeRegion,
    merchantCountry: b.prev.merchantCountry,
    counterpartyCountry: b.prev.counterpartyCountry,
    entries: b.prevEntries.map((p) => ({ direction: p.direction, fundingAccountCountry: corrected.get(p.direction) ?? p.fundingAccountCountry })),
  });
  if (classification.foreignStatus === 'domestic') confirmedDomestic();
  return {
    facts: null,
    correctedHomeRegion: input.homeRegion,
    classification,
    entries: b.prevEntries.map((p) => (id: string) => ({ carried: { id, from: p.id, facts: null, amount: null, correctedCountry: corrected.get(p.direction) ?? null } })),
    retry: null,
  };
}

// ------------------------------------------------------------------ fact correction

/** Q-B3-6: the frozen facts of the request against version r — not reason, acknowledgements, snapshots, exponents or current names. */
function unchanged(input: FactCorrection, entries: readonly EntryInput[], b: Base): boolean {
  const p = b.prev;
  const cp = input.counterparty;
  const event =
    input.recordMode === p.recordMode &&
    input.occurredOn === p.occurredOn &&
    input.occurredTime === p.occurredTime &&
    input.postedOn === p.postedOn &&
    input.eventCurrency === p.eventCurrency &&
    input.eventAmount === p.eventAmount &&
    input.merchantName === p.merchantName &&
    input.merchantCountry === p.merchantCountry &&
    input.cardId === p.cardId &&
    input.paymentChannelId === p.paymentChannelId &&
    input.transferMethod === p.transferMethod &&
    (cp?.name ?? null) === p.counterpartyName &&
    (cp?.country ?? null) === p.counterpartyCountry &&
    (cp?.institution ?? null) === p.counterpartyInstitution &&
    (cp?.accountHint ?? null) === p.counterpartyAccountHint;
  const fact = (e: { direction: string; accountId: string; currency: string; amountStatus: string; amount: number | null }) => JSON.stringify([e.direction, e.accountId, e.currency, e.amountStatus, e.amount]);
  const before = b.prevEntries.map((e) => fact({ direction: e.direction, accountId: e.fundingAccountId, currency: e.fundingCurrency, amountStatus: e.amountStatus, amount: e.amount })).sort();
  const after = entries.map(fact).sort();
  return event && before.length === after.length && before.every((x, i) => x === after[i]);
}

async function planFact(c: C, input: FactCorrection, b: Base): Promise<Plan> {
  const rule = transactionShapeProblem({ ...input, type: b.txnType });
  if (rule) fail(400, 'the entries or fields do not fit the transaction type', 'ENTRY_SHAPE', { rule } satisfies EntryShapeDetails);
  const entries = [...input.entries].sort(byDirection);
  if (unchanged(input, entries, b)) invalid([], 'the correction changes no fact of the previous version');
  const sources = await readSources(c, input);
  assertOwned(input, entries, sources);
  assertRegistered(entries, sources);
  // An account already in version r carries its entry (snapshot included, §10.9.3); a closed
  // currency is allowed without acknowledgement only when that carry keeps the same currency (R3 b).
  const prevByAccount = new Map(b.prevEntries.map((e) => [e.fundingAccountId, e]));
  const exempt = (e: EntryInput) => prevByAccount.get(e.accountId)?.fundingCurrency === e.currency;
  const closed = entries.filter((e) => sources.currencyStatus.get(currencyKey(e.accountId, e.currency)) === 'closed' && !exempt(e));
  if (input.recordMode === 'current') for (const e of closed) currencyProblem({ direction: e.direction, currency: e.currency, status: 'closed' });
  for (const e of closed) {
    if (!e.closedCurrencyAck) fail(400, 'a backfilled entry in a closed currency needs closedCurrencyAck: true', 'CLOSED_CURRENCY_ACK_REQUIRED', { direction: e.direction } satisfies ClosedCurrencyAckDetails);
  }
  const country = (e: EntryInput) => prevByAccount.get(e.accountId)?.fundingAccountCountry ?? sources.accountCountry.get(e.accountId)!;
  const classification = classify({
    txnType: b.txnType,
    homeRegion: b.prev.homeRegion,
    merchantCountry: input.merchantCountry,
    counterpartyCountry: input.counterparty?.country ?? null,
    entries: entries.map((e) => ({ direction: e.direction, fundingAccountCountry: country(e) })),
  });
  if (classification.foreignStatus === 'domestic') confirmedDomestic();
  const transfer = b.txnType === 'own_transfer' || b.txnType === 'third_party_transfer';
  const cp = input.counterparty;
  return {
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
      counterpartyKind: transfer ? (b.txnType === 'own_transfer' ? 'self' : 'third_party') : null,
      counterpartyName: cp?.name ?? null,
      counterpartyCountry: cp?.country ?? null,
      counterpartyInstitution: cp?.institution ?? null,
      counterpartyAccountHint: cp?.accountHint ?? null,
    },
    correctedHomeRegion: null, // home_region is carried: a fact correction never changes a (declared) home region
    classification,
    entries: entries.map((e) => (id: string): CorrectEntryIn => {
      const p = prevByAccount.get(e.accountId);
      const exponent = currencyExponent(e.currency);
      return p
        ? { carried: { id, from: p.id, facts: { direction: e.direction, currency: e.currency, exponent, closedCurrencyAck: e.closedCurrencyAck }, amount: { amount: e.amount, amountStatus: e.amountStatus }, correctedCountry: null } }
        : { fresh: { id, direction: e.direction, accountId: e.accountId, currency: e.currency, amount: e.amount, amountStatus: e.amountStatus, exponent, closedCurrencyAck: e.closedCurrencyAck } };
    }),
    retry: {
      sources,
      freshAccounts: entries.filter((e) => !prevByAccount.has(e.accountId)).map((e) => e.accountId),
      checkedCurrencies: entries.filter((e) => !exempt(e)).map((e) => currencyKey(e.accountId, e.currency)),
    },
  };
}

// ------------------------------------------------------------------ the write

async function prepare(c: C, id: string, input: TransactionCorrection): Promise<{ base: Base; plan: Plan }> {
  const base = await loadBase(c, id, input.baseRevision);
  const plan = input.kind === 'settlement' ? planSettlement(input, base) : input.kind === 'snapshot_correction' ? planSnapshot(input, base) : await planFact(c, input, base);
  return { base, plan };
}

/** Q-B3-8: after LEDGER_CLASSIFICATION / LEDGER_CLOSED_CURRENCY, did a source of this attempt change? Only a fact correction has any. */
async function sourcesChanged(c: C, input: TransactionCorrection, plan: Plan, code: 'LEDGER_CLASSIFICATION' | 'LEDGER_CLOSED_CURRENCY'): Promise<boolean> {
  if (input.kind !== 'fact_correction' || !plan.retry) return false;
  const was = plan.retry.sources;
  const now = await readSources(c, input);
  if (code === 'LEDGER_CLASSIFICATION') return plan.retry.freshAccounts.some((a) => now.accountCountry.get(a) !== was.accountCountry.get(a));
  return plan.retry.checkedCurrencies.some((k) => now.currencyStatus.get(k) !== was.currencyStatus.get(k));
}

/** After an incomplete key row or a foreign-key failure: explain it from what the caller sees now, or give up (500). */
async function explainMissing(c: C, id: string, input: TransactionCorrection, cause: unknown): Promise<never> {
  await assertCurrent(c, id, input.baseRevision);
  if (input.kind === 'fact_correction') {
    const entries = [...input.entries].sort(byDirection);
    const now = await readSources(c, input);
    assertOwned(input, entries, now);
    assertRegistered(entries, now);
  }
  throw new LedgerWriteError('the correction did not complete and re-reading does not explain why', { cause });
}

function chainInput(c: C, id: string, input: TransactionCorrection, base: Base, plan: Plan, key: string, request: RequestFingerprint, now: number): CorrectChainIn {
  return {
    u: c.var.user.id,
    T: id,
    E: newId(now),
    O: newId(now),
    A: newId(now),
    now,
    ip: c.var.ip,
    key,
    requestHash: request.hash,
    hashVersion: request.hashVersion,
    baseRevision: input.baseRevision,
    kind: input.kind,
    reason: input.reason,
    txnType: base.txnType,
    facts: plan.facts,
    correctedHomeRegion: plan.correctedHomeRegion,
    classification: { transferScope: plan.classification.transferScope, foreignStatus: plan.classification.foreignStatus },
    entries: plan.entries.map((entry) => entry(newId(now))),
  };
}

/** Steps 5–11 for a request whose key is not live (the route looked it up first). `now` is the request's one server time. */
export async function correctTransaction(c: C, id: string, input: TransactionCorrection, key: string, request: RequestFingerprint, now: number): Promise<WriteOutcome> {
  const { db } = c.var.deps;
  const u = c.var.user.id;
  for (let attempt = 1; ; attempt++) {
    const { base, plan } = await prepare(c, id, input);
    const x = chainInput(c, id, input, base, plan, key, request, now);
    try {
      await db.batch(correctBatch(db, x));
    } catch (err) {
      const failure = classifyWriteFailure(err);
      if (failure.kind === 'key_taken') return takenKeyOutcome(c.var.deps, u, key, request, now, err);
      if (failure.kind === 'key_incomplete' || failure.kind === 'foreign_key') return explainMissing(c, id, input, err);
      if (failure.kind === 'ledger' && (failure.code === 'LEDGER_CLASSIFICATION' || failure.code === 'LEDGER_CLOSED_CURRENCY')) {
        if (!(await sourcesChanged(c, input, plan, failure.code))) throw new LedgerWriteError(`${failure.code} without a changed source`, { cause: err });
        if (attempt >= 2) fail(409, 'an account jurisdiction or currency status changed while saving — try again', 'CONCURRENT_CHANGE');
        // Rolled back (a RAISE aborts the batch). A request with the same key may have committed meanwhile.
        const stored = await liveKey(db, u, key, now);
        if (stored) return answerStoredKey(c.var.deps, stored, request, now);
        continue;
      }
      throw new LedgerWriteError('the correction failed', { cause: err });
    }
    return committedOutcome(c.var.deps, u, key, x.O, request, now);
  }
}
