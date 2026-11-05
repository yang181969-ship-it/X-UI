import {
  factCorrectionSchema,
  latestOccurredOn,
  scanSensitive,
  transactionCreateSchema,
  transactionShapeProblem,
  type AccountCurrencyStatus,
  type EntryDirection,
  type EntryShapeRule,
  type RecordMode,
  type SensitiveHit,
  type EntryFacts,
  type EventFacts,
  type FactCorrection,
  type TransactionCreate,
  type TransferMethod,
  type TxnType,
} from '@xui/ledger-shared';
import { amountToInput, parseAmountInput } from './money.ts';

/**
 * The create form's draft (M3-B4-C) and its conversion into the request body. The draft keeps
 * what the user typed — amounts as strings — and the request is built only through the shared
 * pieces: parseAmount (via parseAmountInput), transactionCreateSchema.safeParse (the parsed body is
 * what is sent and hashed), transactionShapeProblem (ENTRY_SHAPE), scanSensitive and
 * latestOccurredOn. Nothing here classifies a transaction: confirmed-domestic is the server's
 * answer (400 CONFIRMED_DOMESTIC), undetermined is saved as such.
 *
 * Client checks that need current data (registered and closed currencies) only mirror what the
 * API enforces anyway, so the form can say it before submitting.
 */

/** "Unknown" chosen explicitly for a merchant / third-party side (never a real ISO code: those are two upper-case letters). */
export const UNKNOWN_REGION = 'unknown';

export interface EntryDraft {
  accountId: string | null;
  currency: string | null;
  /** Amount not known yet (pending): never estimated. */
  pending: boolean;
  amountText: string;
  /** Backfill with a closed currency: the user confirms this entry (P7). */
  closedAck: boolean;
}

export interface CounterpartyDraft {
  name: string;
  /** ISO code, UNKNOWN_REGION (third party only), or null while not chosen. */
  country: string | null;
  institution: string;
  accountHint: string;
}

export type OwnMode = 'both' | 'one';

export interface TxnDraft {
  type: TxnType;
  recordMode: RecordMode;
  /** Backfill only: the home region at the time (null = the setting when saved). */
  declaredHomeRegion: string | null;
  occurredOn: string | null;
  /** HH:MM or null. */
  occurredTime: string | null;
  postedOn: string | null;
  eventCurrency: string | null;
  eventAmountText: string;
  /** Third-party incoming only: the sender's amount is unknown (P8). */
  eventAmountUnknown: boolean;
  merchantName: string;
  /** ISO code, UNKNOWN_REGION, or null while not chosen. */
  merchantCountry: string | null;
  cardId: string | null;
  paymentChannelId: string | null;
  transferMethod: TransferMethod | null;
  /** Own transfer: both sides registered, or one side is an unregistered own account. */
  ownMode: OwnMode;
  /** Third-party transfer, and own transfer with one side: the direction of the one entry. */
  direction: EntryDirection;
  counterparty: CounterpartyDraft;
  entries: Record<EntryDirection, EntryDraft>;
  notes: string;
}

export const emptyEntry = (): EntryDraft => ({ accountId: null, currency: null, pending: false, amountText: '', closedAck: false });

export function emptyDraft(type: TxnType, today: string): TxnDraft {
  return {
    type,
    recordMode: 'current',
    declaredHomeRegion: null,
    occurredOn: today,
    occurredTime: null,
    postedOn: null,
    eventCurrency: null,
    eventAmountText: '',
    eventAmountUnknown: false,
    merchantName: '',
    merchantCountry: null,
    cardId: null,
    paymentChannelId: null,
    transferMethod: null,
    ownMode: 'both',
    direction: 'out',
    counterparty: { name: '', country: null, institution: '', accountHint: '' },
    entries: { out: emptyEntry(), in: emptyEntry() },
    notes: '',
  };
}

export const isMerchant = (type: TxnType) => type === 'merchant_spend' || type === 'merchant_refund';

/** The entries the draft's type and mode have, in request order (out first). */
export function draftDirections(d: Pick<TxnDraft, 'type' | 'ownMode' | 'direction'>): EntryDirection[] {
  if (d.type === 'merchant_spend') return ['out'];
  if (d.type === 'merchant_refund') return ['in'];
  if (d.type === 'own_transfer' && d.ownMode === 'both') return ['out', 'in'];
  return [d.direction];
}

/** P8: only a third-party transfer whose one entry is incoming may leave the event amount unknown. */
export const eventAmountMayBeUnknown = (d: Pick<TxnDraft, 'type' | 'direction'>) => d.type === 'third_party_transfer' && d.direction === 'in';

/** The counterparty (other side) exists for transfers, except an own transfer between two registered accounts. */
export const hasCounterparty = (d: Pick<TxnDraft, 'type' | 'ownMode'>) => d.type === 'third_party_transfer' || (d.type === 'own_transfer' && d.ownMode === 'one');

/**
 * A problem with one field ('form' for the request as a whole). Keys: occurredOn, occurredTime,
 * postedOn, declaredHomeRegion, eventCurrency, eventAmount, merchantName, merchantCountry,
 * transferMethod, cardId, paymentChannelId, counterparty.<name|country|institution|accountHint>,
 * notes, entry.<out|in>.<accountId|currency|amount|closedAck>.
 */
export interface DraftIssue {
  field: string;
  code: DraftIssueCode;
  /** ENTRY_SHAPE rule, zod message, … */
  detail?: string;
}

export type DraftIssueCode =
  | 'required'
  | 'regionRequired'
  | 'empty'
  | 'currency'
  | 'format'
  | 'scale'
  | 'zero'
  | 'range'
  | 'tooLate'
  | 'postedBefore'
  | 'sameAccount'
  | 'notRegistered'
  | 'closedCurrencyCurrent'
  | 'ackRequired'
  | 'sensitive'
  | 'shape'
  | 'confirmedDomestic'
  | 'noChange'
  | 'noneSelected'
  | 'noSnapshotChange'
  | 'invalid';

/** Current status of `currency` on account `accountId`: null = not registered; undefined = not known (data not loaded). */
export type CurrencyStatusLookup = (accountId: string, currency: string) => AccountCurrencyStatus | null | undefined;

export type BuildResult = { ok: true; body: TransactionCreate } | { ok: false; issues: DraftIssue[] };

const blankToNull = (s: string) => (s.trim() === '' ? null : s.trim());
const region = (v: string | null) => (v === null || v === UNKNOWN_REGION ? null : v);

/** The free-text fields the API scans, by their request names (API_SPEC §5.0.1). */
export const SENSITIVE_FIELDS = ['merchantName', 'counterparty.name', 'counterparty.institution', 'counterparty.accountHint', 'notes'] as const;

/** Draft → the parsed POST /transactions body, or every problem the client can tell before sending. */
/**
 * Request-building context. `carried` (fact corrections, API_SPEC §5.7.2): the entry keeps the
 * previous version's account AND currency — a lawful carry-over, so a currency closed since needs no
 * acknowledgement in any record mode (DATA_MODEL §10.9.4 R3 b); the server decides it the same way.
 */
export interface BuildContext {
  now: number;
  currencyStatus?: CurrencyStatusLookup;
  carried?: (accountId: string, currency: string) => boolean;
}

export function buildCreateRequest(d: TxnDraft, ctx: BuildContext): BuildResult {
  const issues: DraftIssue[] = [];
  const add = (field: string, code: DraftIssueCode, detail?: string) => {
    if (!issues.some((i) => i.field === field && i.code === code)) issues.push({ field, code, ...(detail !== undefined && { detail }) });
  };
  const dirs = draftDirections(d);
  const backfill = d.recordMode === 'backfill';

  if (!d.occurredOn) add('occurredOn', 'required');
  else if (d.occurredOn > latestOccurredOn(ctx.now)) add('occurredOn', 'tooLate');
  if (d.occurredOn && d.postedOn && d.postedOn < d.occurredOn) add('postedOn', 'postedBefore');

  // Entries: account, a registered currency (active in current mode; closed ones confirmed in backfill), amount or pending.
  const entries = dirs.map((dir) => {
    const e = d.entries[dir];
    const f = (k: string) => `entry.${dir}.${k}`;
    if (!e.accountId) add(f('accountId'), 'required');
    if (!e.currency) add(f('currency'), 'required');
    const carriedOver = !!(e.accountId && e.currency && ctx.carried?.(e.accountId, e.currency));
    // A carried-over currency is lawful whatever its status now: no closed-currency check for it.
    const status = e.accountId && e.currency && !carriedOver ? ctx.currencyStatus?.(e.accountId, e.currency) : undefined;
    if (status === null) add(f('currency'), 'notRegistered');
    if (status === 'closed' && !backfill) add(f('currency'), 'closedCurrencyCurrent');
    if (status === 'closed' && backfill && !e.closedAck) add(f('closedAck'), 'ackRequired');
    let amount: number | null = null;
    if (!e.pending) {
      const r = parseAmountInput(e.amountText, e.currency);
      if (r.ok) amount = r.minor;
      else if (r.error !== 'currency') add(f('amount'), r.error);
    }
    return {
      direction: dir,
      accountId: e.accountId ?? '',
      currency: e.currency ?? '',
      amountStatus: e.pending ? ('pending' as const) : ('confirmed' as const),
      amount: e.pending ? null : (amount ?? 0),
      // The permission is sent only where it applies (P7): a backfill using a currency that is closed now.
      closedCurrencyAck: !carriedOver && backfill && e.closedAck && status !== 'active' && status !== null,
    };
  });
  if (dirs.length === 2 && d.entries.out.accountId && d.entries.out.accountId === d.entries.in.accountId) add('entry.in.accountId', 'sameAccount');

  // Event amount: required, except an incoming third-party transfer whose sender's amount is unknown (P8).
  let eventAmount: number | null = null;
  const unknownAllowed = eventAmountMayBeUnknown(d) && d.eventAmountUnknown;
  if (!unknownAllowed) {
    if (!d.eventCurrency) add('eventCurrency', 'required');
    const r = parseAmountInput(d.eventAmountText, d.eventCurrency);
    if (r.ok) eventAmount = r.minor;
    else if (r.error !== 'currency') add('eventAmount', r.error);
  }

  const merchant = isMerchant(d.type);
  if (merchant && d.merchantCountry === null) add('merchantCountry', 'regionRequired');
  const cp = hasCounterparty(d);
  if (cp && d.counterparty.country === null) add('counterparty.country', d.type === 'own_transfer' ? 'required' : 'regionRequired');
  // An unregistered OWN account's jurisdiction is required (it cannot be unknown).
  if (d.type === 'own_transfer' && d.ownMode === 'one' && d.counterparty.country === UNKNOWN_REGION) add('counterparty.country', 'required');

  const raw = {
    type: d.type,
    recordMode: d.recordMode,
    declaredHomeRegion: backfill ? d.declaredHomeRegion : null,
    occurredOn: d.occurredOn ?? '',
    occurredTime: d.occurredTime,
    postedOn: d.postedOn,
    eventCurrency: unknownAllowed ? (d.eventCurrency ?? null) : d.eventCurrency,
    eventAmount,
    merchantName: merchant ? blankToNull(d.merchantName) : null,
    merchantCountry: merchant ? region(d.merchantCountry) : null,
    cardId: merchant ? d.cardId : null,
    paymentChannelId: merchant ? d.paymentChannelId : null,
    transferMethod: merchant ? null : d.transferMethod,
    counterparty: cp
      ? { name: blankToNull(d.counterparty.name), country: region(d.counterparty.country), institution: blankToNull(d.counterparty.institution), accountHint: blankToNull(d.counterparty.accountHint) }
      : null,
    entries,
    notes: d.notes === '' ? null : d.notes,
  };

  for (const hit of scanSensitive({
    merchantName: raw.merchantName,
    'counterparty.name': raw.counterparty?.name,
    'counterparty.institution': raw.counterparty?.institution,
    'counterparty.accountHint': raw.counterparty?.accountHint,
    notes: raw.notes,
  })) {
    add(hit.field, 'sensitive', hit.kind);
  }

  if (issues.length) return { ok: false, issues };
  const parsed = transactionCreateSchema.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues) add(fieldOfPath(i.path, raw.entries), 'invalid', i.message);
    return { ok: false, issues };
  }
  const rule = transactionShapeProblem(parsed.data);
  if (rule) return { ok: false, issues: [{ field: 'form', code: 'shape', detail: rule }] };
  return { ok: true, body: parsed.data };
}

/**
 * A parsed request back into a draft (a restored unknown-outcome request is shown, locked, exactly
 * as it will be resent). buildCreateRequest(draftFromBody(b)) gives a request equal to b.
 */
export function draftFromBody(b: TransactionCreate): TxnDraft {
  const d = emptyDraft(b.type, b.occurredOn);
  const single = b.entries.length === 1 ? b.entries[0]! : null;
  for (const e of b.entries) {
    d.entries[e.direction] = { accountId: e.accountId, currency: e.currency, pending: e.amountStatus === 'pending', amountText: e.amount === null ? '' : amountToInput(e.amount, e.currency), closedAck: e.closedCurrencyAck };
  }
  const merchant = isMerchant(b.type);
  return {
    ...d,
    recordMode: b.recordMode,
    declaredHomeRegion: b.declaredHomeRegion,
    occurredTime: b.occurredTime,
    postedOn: b.postedOn,
    eventCurrency: b.eventCurrency,
    eventAmountText: b.eventAmount === null || b.eventCurrency === null ? '' : amountToInput(b.eventAmount, b.eventCurrency),
    eventAmountUnknown: b.type === 'third_party_transfer' && b.eventAmount === null,
    merchantName: b.merchantName ?? '',
    merchantCountry: merchant ? (b.merchantCountry ?? UNKNOWN_REGION) : null,
    cardId: b.cardId,
    paymentChannelId: b.paymentChannelId,
    transferMethod: b.transferMethod,
    ownMode: b.type === 'own_transfer' && b.entries.length === 1 ? 'one' : 'both',
    direction: single?.direction ?? 'out',
    counterparty: b.counterparty
      ? { name: b.counterparty.name ?? '', country: b.counterparty.country ?? (b.type === 'third_party_transfer' ? UNKNOWN_REGION : null), institution: b.counterparty.institution ?? '', accountHint: b.counterparty.accountHint ?? '' }
      : d.counterparty,
    notes: b.notes ?? '',
  };
}

/** A request path (zod issue path, API_SPEC §5.7.1 style) → a draft field key. */
export function fieldOfPath(path: readonly PropertyKey[], entries: readonly { direction: EntryDirection }[]): string {
  if (path.length === 0) return 'form';
  const [head, a, b] = path;
  if (head === 'entries') {
    const dir = typeof a === 'number' ? entries[a]?.direction : undefined;
    return dir ? `entry.${dir}.${String(b ?? 'accountId')}` : 'form';
  }
  if (head === 'counterparty') return a === undefined ? 'counterparty.country' : `counterparty.${String(a)}`;
  return String(head);
}

/** What a definitive (4xx) answer to POST /transactions says about the draft, field by field; null when it is not about the request's fields. */
/**
 * What a definitive (4xx) answer says about the request, field by field; null when it is not about
 * the request's fields. `body` only needs its entries (to map an entry index back to its direction).
 * For a correction (`correction: true`) a VALIDATION issue on the whole request (path []) is the
 * server's "no fact changed" answer (API_SPEC §5.7.1 step 7, §5.7.3).
 */
export function issuesFromServer(error: { status: number; code?: string; details?: unknown }, body: { entries: readonly { direction: EntryDirection }[] }, correction = false): DraftIssue[] | null {
  const details = error.details as Record<string, unknown> | unknown[] | undefined;
  switch (error.code) {
    case 'VALIDATION':
      if (!Array.isArray(details)) return [{ field: 'form', code: 'invalid' }];
      return details.map((i) => {
        const issue = i as { path?: PropertyKey[]; message?: string };
        if (correction && (issue.path ?? []).length === 0) return { field: 'form', code: 'noChange' as const };
        return { field: fieldOfPath(issue.path ?? [], body.entries), code: 'invalid' as const, ...(issue.message && { detail: issue.message }) };
      });
    case 'SENSITIVE_DATA': {
      const hits = ((details as { fields?: SensitiveHit[] } | undefined)?.fields ?? []) as SensitiveHit[];
      return hits.length ? hits.map((h) => ({ field: h.field, code: 'sensitive' as const, detail: h.kind })) : [{ field: 'form', code: 'sensitive' }];
    }
    case 'ENTRY_SHAPE':
      return [{ field: 'form', code: 'shape', detail: (details as { rule?: EntryShapeRule } | undefined)?.rule }];
    case 'CURRENCY_NOT_ON_ACCOUNT': {
      const d = details as { direction?: EntryDirection; status?: AccountCurrencyStatus | null } | undefined;
      return d?.direction ? [{ field: `entry.${d.direction}.currency`, code: d.status === 'closed' ? 'closedCurrencyCurrent' : 'notRegistered' }] : [{ field: 'form', code: 'notRegistered' }];
    }
    case 'CLOSED_CURRENCY_ACK_REQUIRED': {
      const d = details as { direction?: EntryDirection } | undefined;
      return [{ field: d?.direction ? `entry.${d.direction}.closedAck` : 'form', code: 'ackRequired' }];
    }
    case 'CONFIRMED_DOMESTIC':
      return [{ field: 'form', code: 'confirmedDomestic' }];
    default:
      return null;
  }
}

// ================================================================== fact correction (API_SPEC §5.7, M3-B4-D)

export type FactBuildResult = { ok: true; body: FactCorrection } | { ok: false; issues: DraftIssue[] };

/**
 * Draft → the parsed fact_correction body. The facts go through the same create pipeline (shared
 * amount parsing, Entry shape for the SAVED type, sensitive scan, dates), then the shared
 * factCorrectionSchema: no type, declaredHomeRegion or notes; recordMode always explicit (Q-B3-5);
 * reason required. baseRevision is the version the form was opened on (or rebased to by the user).
 */
export function buildFactCorrectionRequest(d: TxnDraft, ctx: BuildContext & { baseRevision: number; reason: string }): FactBuildResult {
  const issues: DraftIssue[] = [];
  const reason = ctx.reason.trim();
  if (reason === '') issues.push({ field: 'reason', code: 'required' });
  for (const hit of scanSensitive({ reason })) issues.push({ field: 'reason', code: 'sensitive', detail: hit.kind });
  const facts = buildCreateRequest({ ...d, declaredHomeRegion: null, notes: '' }, ctx);
  if (!facts.ok) return { ok: false, issues: [...issues, ...facts.issues] };
  if (issues.length) return { ok: false, issues };
  const { type: _type, declaredHomeRegion: _declared, notes: _notes, ...rest } = facts.body;
  const parsed = factCorrectionSchema.safeParse({ kind: 'fact_correction', baseRevision: ctx.baseRevision, reason, ...rest });
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => ({ field: fieldOfPath(i.path, rest.entries), code: 'invalid' as const, detail: i.message })) };
  return { ok: true, body: parsed.data };
}

/** A saved version (EventFacts / EntryFacts) as a draft: what a fact correction starts from. */
export function draftFromVersion(txnType: TxnType, event: EventFacts, entries: readonly EntryFacts[]): TxnDraft {
  const cp = event.counterparty;
  // Saved values are valid ISO codes (the API wrote them); the DTO types them as plain strings.
  return draftFromBody({
    type: txnType,
    recordMode: event.recordMode,
    declaredHomeRegion: null,
    occurredOn: event.occurredOn,
    occurredTime: event.occurredTime,
    postedOn: event.postedOn,
    eventCurrency: event.eventCurrency,
    eventAmount: event.eventAmount,
    merchantName: event.merchantName,
    merchantCountry: event.merchantCountry,
    cardId: event.cardId,
    paymentChannelId: event.paymentChannelId,
    transferMethod: event.transferMethod,
    // A two-registered-sides own transfer has an all-null counterparty object in the DTO; the request has none.
    counterparty: cp && (cp.name !== null || cp.country !== null || cp.institution !== null || cp.accountHint !== null) ? { name: cp.name, country: cp.country, institution: cp.institution, accountHint: cp.accountHint } : txnType === 'third_party_transfer' ? { name: null, country: null, institution: null, accountHint: null } : null,
    entries: entries.map((e) => ({ direction: e.direction, accountId: e.accountId, currency: e.currency, amountStatus: e.amountStatus, amount: e.amount, closedCurrencyAck: e.closedCurrencyAck })),
    notes: null,
  } as TransactionCreate);
}

/** A (restored) fact_correction body back into a draft of the saved type. */
export function draftFromFactBody(b: FactCorrection, txnType: TxnType): TxnDraft {
  const { kind: _k, baseRevision: _b, reason: _r, ...facts } = b;
  return draftFromBody({ ...facts, type: txnType, declaredHomeRegion: null, notes: null });
}
