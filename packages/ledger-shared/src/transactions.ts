import { z } from 'zod';
import {
  AMOUNT_STATUSES,
  ENTRY_DIRECTIONS,
  FOREIGN_STATUS_FILTERS,
  NAME_MAX,
  REASON_MAX,
  RECORD_MODES,
  TRANSFER_METHODS,
  TXN_STATUS_FILTERS,
  TXN_TYPES,
  type EntryDirection,
  type TxnType,
} from './enums.ts';
import { AMOUNT_MAX, AMOUNT_MIN } from './money.ts';
import { countrySchema, currencySchema, idSchema, isoDateSchema, nameSchema, notesSchema, numberHintSchema } from './schemas.ts';

/**
 * Request schemas of the M3 transaction API (API_SPEC §5). Every body and query is a strict object:
 * unknown fields — and the fields only the server writes (homeRegion outside the two places that
 * accept it, fundingAccountCountry outside a snapshot correction, merchantScope, transferScope,
 * foreignStatus, classifierVersion, revision, *Exponent, countrySource, currencyStatusAtSave,
 * carriedFromEntryId, status; type and notes in corrections) — are a 400 VALIDATION.
 *
 * Optional fields default to null, so the parsed body (what request hash v1 hashes) is the same
 * whether a client omits a field or sends null.
 *
 * The Entry shape for a transaction type (counts, directions, counterparty, event amount) is a
 * separate check, transactionShapeProblem(), because the API reports it as ENTRY_SHAPE with the
 * rule that failed. Everything that needs the database (ownership, registered and closed
 * currencies, snapshots, classification) is checked by the API and the migration 0002 triggers.
 */

const orNull = <T extends z.ZodType>(s: T) => s.nullable().default(null);

/** Minor units, 1 … 999 999 999 999 999; a JSON integer (no strings, no fractions). */
export const amountSchema = z.int().min(AMOUNT_MIN).max(AMOUNT_MAX);
/** HH:MM, 00:00 – 23:59 (local time of the record). */
export const timeSchema = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
export const reasonSchema = z.string().trim().min(1).max(REASON_MAX);
export const revisionSchema = z.int().min(1);
export const directionSchema = z.enum(ENTRY_DIRECTIONS);

export const entryInputSchema = z
  .strictObject({
    direction: directionSchema,
    accountId: idSchema,
    currency: currencySchema,
    amountStatus: z.enum(AMOUNT_STATUSES),
    /** null exactly when amountStatus is pending — never estimated. */
    amount: amountSchema.nullable(),
    /** Backfill with a closed currency only (P7): the user confirms this entry. */
    closedCurrencyAck: z.boolean().default(false),
  })
  .refine((e) => (e.amount === null) === (e.amountStatus === 'pending'), { message: 'amount is null exactly when amountStatus is pending', path: ['amount'] });

/** The side of a transfer that has no entry. kind comes from the transaction type, never from the request. */
export const counterpartyInputSchema = z.strictObject({
  name: orNull(nameSchema),
  /** Jurisdiction of that account's contracting entity (same definition as account_country). */
  country: orNull(countrySchema),
  institution: orNull(nameSchema),
  /** Last 1–4 letters / digits only — never a full account number or IBAN. */
  accountHint: orNull(numberHintSchema),
});

/** Up to 10 entries pass the schema; how many a type allows is transactionShapeProblem()'s ENTRY_SHAPE. */
const ENTRIES_MAX = 10;

const factsShape = {
  recordMode: z.enum(RECORD_MODES).default('current'),
  occurredOn: isoDateSchema,
  occurredTime: orNull(timeSchema),
  postedOn: orNull(isoDateSchema),
  eventCurrency: orNull(currencySchema),
  eventAmount: orNull(amountSchema),
  merchantName: orNull(nameSchema),
  merchantCountry: orNull(countrySchema),
  cardId: orNull(idSchema),
  paymentChannelId: orNull(idSchema),
  transferMethod: orNull(z.enum(TRANSFER_METHODS)),
  counterparty: orNull(counterpartyInputSchema),
  entries: z.array(entryInputSchema).max(ENTRIES_MAX),
};

interface FactsLike {
  occurredOn: string;
  postedOn: string | null;
  eventCurrency: string | null;
  eventAmount: number | null;
}
function checkFacts(v: FactsLike, ctx: z.RefinementCtx) {
  if (v.postedOn !== null && v.postedOn < v.occurredOn) ctx.addIssue({ code: 'custom', path: ['postedOn'], message: 'postedOn is not before occurredOn' });
  if (v.eventAmount !== null && v.eventCurrency === null) ctx.addIssue({ code: 'custom', path: ['eventCurrency'], message: 'eventAmount needs eventCurrency' });
}

/** POST /transactions. */
export const transactionCreateSchema = z
  .strictObject({
    type: z.enum(TXN_TYPES),
    /** Backfill only (P4): the home region at the time, independent of the current setting. */
    declaredHomeRegion: orNull(countrySchema),
    ...factsShape,
    notes: orNull(notesSchema),
  })
  .superRefine((v, ctx) => {
    checkFacts(v, ctx);
    if (v.declaredHomeRegion !== null && v.recordMode !== 'backfill') ctx.addIssue({ code: 'custom', path: ['declaredHomeRegion'], message: 'declaredHomeRegion is only for backfill' });
  });

const uniqueDirections = (entries: readonly { direction: EntryDirection }[], ctx: z.RefinementCtx) => {
  const seen = new Set<string>();
  entries.forEach((e, i) => {
    if (seen.has(e.direction)) ctx.addIssue({ code: 'custom', path: ['entries', i, 'direction'], message: 'duplicate direction' });
    seen.add(e.direction);
  });
};

/** settlement: turn pending entries (by direction) into confirmed amounts; everything else is carried over. */
export const settlementCorrectionSchema = z
  .strictObject({
    kind: z.literal('settlement'),
    baseRevision: revisionSchema,
    reason: orNull(reasonSchema),
    entries: z.array(z.strictObject({ direction: directionSchema, amount: amountSchema })).min(1).max(2),
  })
  .superRefine((v, ctx) => uniqueDirections(v.entries, ctx));

/** fact_correction: the complete corrected facts (no type, declaredHomeRegion or notes); reason required. */
export const factCorrectionSchema = z
  .strictObject({
    kind: z.literal('fact_correction'),
    baseRevision: revisionSchema,
    reason: reasonSchema,
    ...factsShape,
  })
  .superRefine(checkFacts);

/** snapshot_correction (P5): home region and / or an entry's jurisdiction snapshot; facts are carried over. */
export const snapshotCorrectionSchema = z
  .strictObject({
    kind: z.literal('snapshot_correction'),
    baseRevision: revisionSchema,
    reason: reasonSchema,
    homeRegion: orNull(countrySchema),
    entries: z.array(z.strictObject({ direction: directionSchema, fundingAccountCountry: countrySchema })).max(2).default([]),
  })
  .superRefine((v, ctx) => {
    uniqueDirections(v.entries, ctx);
    if (v.homeRegion === null && v.entries.length === 0) ctx.addIssue({ code: 'custom', path: ['homeRegion'], message: 'homeRegion or entries is required' });
  });

/** POST /transactions/:id/revisions. */
export const transactionCorrectionSchema = z.discriminatedUnion('kind', [settlementCorrectionSchema, factCorrectionSchema, snapshotCorrectionSchema]);

/** POST /transactions/:id/void. */
export const transactionVoidSchema = z.strictObject({ baseRevision: revisionSchema, reason: orNull(reasonSchema) });

/** PATCH /transactions/:id/notes — no idempotency key, no version, no audit (P9). */
export const transactionNotesSchema = z.strictObject({ notes: notesSchema.nullable() });

export const TRANSACTION_LIST_LIMIT_DEFAULT = 50;
const fromBeforeTo = (v: { from?: string; to?: string }) => v.from === undefined || v.to === undefined || v.from <= v.to;

/** GET /transactions (query strings). */
export const transactionListQuerySchema = z
  .strictObject({
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    type: z.enum(TXN_TYPES).optional(),
    accountId: idSchema.optional(),
    cardId: idSchema.optional(),
    channelId: idSchema.optional(),
    currency: currencySchema.optional(),
    amountStatus: z.enum(AMOUNT_STATUSES).optional(),
    foreignStatus: z.enum(FOREIGN_STATUS_FILTERS).default('all'),
    recordMode: z.enum(RECORD_MODES).optional(),
    status: z.enum(TXN_STATUS_FILTERS).default('active'),
    q: z.string().max(NAME_MAX).optional(),
    cursor: z.string().max(200).optional(),
    limit: z
      .string()
      .regex(/^[0-9]{1,3}$/)
      .transform(Number)
      .pipe(z.int().min(1).max(100))
      .optional(),
  })
  .refine(fromBeforeTo, { message: 'from is after to', path: ['from'] });

/** GET /transactions/summary (query strings). */
export const transactionSummaryQuerySchema = z
  .strictObject({
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    type: z.enum(TXN_TYPES).optional(),
    currency: currencySchema.optional(),
  })
  .refine(fromBeforeTo, { message: 'from is after to', path: ['from'] });

/** occurredOn may be at most the day after the server's UTC date (API_SPEC §5.0.2). */
export function latestOccurredOn(nowMs: number): string {
  return new Date(nowMs + 86_400_000).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ Entry shape (ENTRY_SHAPE, DATA_MODEL §10.7.1)

export const ENTRY_SHAPE_RULES = [
  /** merchant_spend: exactly one out entry; merchant_refund: exactly one in entry. */
  'merchant_entries',
  /** third_party_transfer: exactly one entry. */
  'third_party_entries',
  /** own_transfer: one entry, or two (one out, one in) on two different accounts. */
  'own_entries',
  /** Spend / refund: no counterparty and no transfer method. */
  'merchant_fields',
  /** Transfers: no card, merchant name or merchant country. */
  'transfer_fields',
  /** own_transfer with two entries: no counterparty data. */
  'own_two_sides_counterparty',
  /** own_transfer with one entry: the other (unregistered) side's country is required. */
  'own_one_side_country',
  /** eventAmount may only be null for a third-party transfer whose only entry is incoming (P8). */
  'event_amount',
] as const;
export type EntryShapeRule = (typeof ENTRY_SHAPE_RULES)[number];

export interface ShapeInput {
  type: TxnType;
  eventAmount: number | null;
  merchantName: string | null;
  merchantCountry: string | null;
  cardId: string | null;
  transferMethod: string | null;
  counterparty: { name: string | null; country: string | null; institution: string | null; accountHint: string | null } | null;
  entries: readonly { direction: EntryDirection; accountId: string }[];
}

/** The first Entry-shape rule the request breaks, or null. Mirrors the CHECKs, indexes and C2/C3/C5 of migration 0002. */
export function transactionShapeProblem(v: ShapeInput): EntryShapeRule | null {
  const n = v.entries.length;
  const cp = v.counterparty;
  const cpEmpty = cp === null || (cp.name === null && cp.country === null && cp.institution === null && cp.accountHint === null);
  switch (v.type) {
    case 'merchant_spend':
    case 'merchant_refund': {
      const dir: EntryDirection = v.type === 'merchant_spend' ? 'out' : 'in';
      if (n !== 1 || v.entries[0]!.direction !== dir) return 'merchant_entries';
      if (cp !== null || v.transferMethod !== null) return 'merchant_fields';
      break;
    }
    case 'third_party_transfer':
      if (n !== 1) return 'third_party_entries';
      break;
    case 'own_transfer': {
      if (n < 1 || n > 2) return 'own_entries';
      if (n === 2) {
        const [a, b] = v.entries as [{ direction: EntryDirection; accountId: string }, { direction: EntryDirection; accountId: string }];
        if (a.direction === b.direction || a.accountId === b.accountId) return 'own_entries';
        if (!cpEmpty) return 'own_two_sides_counterparty';
      } else if (cp === null || cp.country === null) return 'own_one_side_country';
      break;
    }
  }
  if ((v.type === 'own_transfer' || v.type === 'third_party_transfer') && (v.cardId !== null || v.merchantName !== null || v.merchantCountry !== null)) return 'transfer_fields';
  if (v.eventAmount === null && !(v.type === 'third_party_transfer' && v.entries[0]?.direction === 'in')) return 'event_amount';
  return null;
}

export type EntryInput = z.infer<typeof entryInputSchema>;
export type CounterpartyInput = z.infer<typeof counterpartyInputSchema>;
export type TransactionCreate = z.infer<typeof transactionCreateSchema>;
export type SettlementCorrection = z.infer<typeof settlementCorrectionSchema>;
export type FactCorrection = z.infer<typeof factCorrectionSchema>;
export type SnapshotCorrection = z.infer<typeof snapshotCorrectionSchema>;
export type TransactionCorrection = z.infer<typeof transactionCorrectionSchema>;
export type TransactionVoid = z.infer<typeof transactionVoidSchema>;
export type TransactionNotes = z.infer<typeof transactionNotesSchema>;
/** Query-string forms (what the web app sends). */
export type TransactionListQuery = z.input<typeof transactionListQuerySchema>;
export type TransactionSummaryQuery = z.input<typeof transactionSummaryQuerySchema>;
