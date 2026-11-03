import { z } from 'zod';
import {
  ACCOUNT_CURRENCIES_MAX,
  ACCOUNT_CURRENCY_STATUSES,
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  CARD_FORMS,
  CARD_LINK_ROLES,
  CARD_NETWORKS,
  CARD_STATUSES,
  CARD_TYPES,
  CHANNEL_STATUSES,
  CHANNEL_TYPES,
  DEPOSIT_KINDS,
  INSTITUTION_STATUSES,
  INSTITUTION_TYPES,
  NAME_MAX,
  NOTES_MAX,
  WEBSITE_MAX,
  type LedgerErrorCode,
} from './enums.ts';
import { EXPIRING_WITHIN_DAYS_MAX, EXPIRY_STATUSES } from './expiry.ts';
import { COUNTRY_CODES, CURRENCY_CODES } from './iso.ts';

/**
 * Request schemas for the M2 API (docs/product-v1/API_SPEC.md §3). Every body is a strict object:
 * unknown fields — pan, cardNumber, bin, cvv, pin, holderName, balance, force, … — are a 400
 * VALIDATION, never silently dropped. Rules that need the database (does the account hold this
 * currency, is the institution the caller's, …) and the free-text sensitive-data scan
 * (DATA_MODEL §6) are checked by the API, not here.
 */

// ------------------------------------------------------------------ fields

export const idSchema = z.string().min(1).max(64);
export const nameSchema = z.string().trim().min(1).max(NAME_MAX);
export const notesSchema = z.string().max(NOTES_MAX);
export const countrySchema = z.enum(COUNTRY_CODES);
export const currencySchema = z.enum(CURRENCY_CODES);
export const sortSchema = z.int().min(-1_000_000).max(1_000_000);

/** A real calendar date, YYYY-MM-DD. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'invalid date');

/** Card expiry, YYYY-MM (month 01–12). */
export const yearMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** Display only — the server never fetches it. https://host[:port][/path…], host made of DNS labels. */
export const websiteSchema = z
  .string()
  .max(WEBSITE_MAX)
  .regex(/^https:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}(?::\d{1,5})?(?:[/?#]\S*)?$/, 'must be an https:// URL');

/** Avatar colour (#rrggbb), stored in lower case. */
export const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((v) => v.toLowerCase());

/** Last 1–4 letters/digits of an account number — never the full number. */
export const numberHintSchema = z.string().regex(/^[0-9A-Za-z]{1,4}$/);
export const last4Schema = z.string().regex(/^[0-9]{4}$/);
export const prioritySchema = z.int().min(1).max(1_000_000);

/**
 * Card type: only debit and prepaid. Any other value (e.g. 'credit') is reported with the
 * message CARD_TYPE_UNSUPPORTED so the API can answer with that error code (see
 * ledgerErrorCode); a missing value is an ordinary validation error.
 */
export const cardTypeSchema = z.enum(CARD_TYPES, {
  error: (iss) => (iss.input === undefined ? undefined : ('CARD_TYPE_UNSUPPORTED' satisfies LedgerErrorCode)),
});

const opt = <T extends z.ZodType>(s: T) => s.nullable().optional();

// ------------------------------------------------------------------ settings

export const profileSettingsUpdateSchema = z.strictObject({ homeRegion: countrySchema });

// ------------------------------------------------------------------ institutions

const institutionShape = {
  name: nameSchema,
  country: opt(countrySchema),
  institutionType: z.enum(INSTITUTION_TYPES),
  website: opt(websiteSchema),
  color: opt(colorSchema),
  notes: opt(notesSchema),
  status: z.enum(INSTITUTION_STATUSES).optional(),
  sort: sortSchema.optional(),
};
export const institutionCreateSchema = z.strictObject(institutionShape);
export const institutionUpdateSchema = z.strictObject(institutionShape).partial();

// ------------------------------------------------------------------ accounts

export const accountCurrencyInputSchema = z.strictObject({
  code: currencySchema,
  isDefault: z.boolean().optional(),
  status: z.enum(ACCOUNT_CURRENCY_STATUSES).optional(),
});
export type AccountCurrencyInput = z.infer<typeof accountCurrencyInputSchema>;

/** 1–30 currencies, no repeats, exactly one default and the default is active. */
export const accountCurrencyListSchema = z
  .array(accountCurrencyInputSchema)
  .min(1)
  .max(ACCOUNT_CURRENCIES_MAX)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((c, i) => {
      if (seen.has(c.code)) ctx.addIssue({ code: 'custom', path: [i, 'code'], message: 'duplicate currency' });
      seen.add(c.code);
    });
    const defaults = list.filter((c) => c.isDefault);
    if (defaults.length !== 1) ctx.addIssue({ code: 'custom', message: 'exactly one currency must be the default' });
    else if (defaults[0]!.status === 'closed') ctx.addIssue({ code: 'custom', message: 'the default currency must be active' });
  });

const accountShape = {
  institutionId: idSchema,
  name: nameSchema,
  accountType: z.enum(ACCOUNT_TYPES),
  depositKind: opt(z.enum(DEPOSIT_KINDS)),
  /** Jurisdiction of the legal entity holding the account contract; never inferred. */
  accountCountry: countrySchema,
  numberHint: opt(numberHintSchema),
  status: z.enum(ACCOUNT_STATUSES).optional(),
  openedOn: opt(isoDateSchema),
  closedOn: opt(isoDateSchema),
  notes: opt(notesSchema),
  sort: sortSchema.optional(),
};

type AccountFields = { accountType?: string; depositKind?: string | null; openedOn?: string | null; closedOn?: string | null };
/** Cross-field rules that can be checked from the body alone (PATCH: only among the fields sent). */
function accountRules(v: AccountFields, ctx: z.RefinementCtx) {
  if (v.depositKind != null && v.accountType !== undefined && v.accountType !== 'bank') {
    ctx.addIssue({ code: 'custom', path: ['depositKind'], message: 'depositKind is only for bank accounts' });
  }
  if (v.openedOn && v.closedOn && v.closedOn < v.openedOn) {
    ctx.addIssue({ code: 'custom', path: ['closedOn'], message: 'closedOn is before openedOn' });
  }
}

export const accountCreateSchema = z.strictObject({ ...accountShape, currencies: accountCurrencyListSchema }).superRefine(accountRules);

/**
 * PATCH /accounts/:id. institutionId is not accepted (400 VALIDATION as an unknown field): the
 * institution an account was opened with is fixed — when the contracting legal entity changes, a
 * new account is created (DATA_MODEL §3.2) so history keeps pointing at the old one.
 */
const { institutionId: _immutableInstitution, ...accountMutableShape } = accountShape;
export const accountUpdateSchema = z.strictObject(accountMutableShape).partial().superRefine(accountRules);
export const accountCurrenciesReplaceSchema = z.strictObject({ currencies: accountCurrencyListSchema });

// ------------------------------------------------------------------ cards

const cardShape = {
  issuerInstitutionId: idSchema,
  name: nameSchema,
  network: z.enum(CARD_NETWORKS),
  cardType: cardTypeSchema,
  form: z.enum(CARD_FORMS).optional(),
  last4: last4Schema,
  /** Display only; never used to infer where the money is. */
  issuingCountry: countrySchema,
  expiresOn: opt(yearMonthSchema),
  status: z.enum(CARD_STATUSES).optional(),
  notes: opt(notesSchema),
  sort: sortSchema.optional(),
};

/** Prepaid cards only: create the stored-value account and its default spending link in the same batch. */
export const storedValueAccountInputSchema = z.strictObject({
  name: nameSchema,
  /** Defaults to the card issuer. */
  institutionId: idSchema.optional(),
  /** Required — not inferred from the card's issuing country. */
  accountCountry: countrySchema,
  currency: currencySchema,
});

export const cardCreateSchema = z.strictObject({ ...cardShape, createStoredValueAccount: storedValueAccountInputSchema.optional() }).superRefine((v, ctx) => {
  if (v.createStoredValueAccount && v.cardType !== 'prepaid') {
    ctx.addIssue({ code: 'custom', path: ['createStoredValueAccount'], message: 'only prepaid cards can create a stored-value account' });
  }
});
export const cardUpdateSchema = z.strictObject(cardShape).partial();

// ------------------------------------------------------------------ card ↔ account links

export const cardLinkCreateSchema = z
  .strictObject({
    cardId: idSchema,
    accountId: idSchema,
    /** null = every currency of the account. */
    currency: opt(currencySchema),
    role: z.enum(CARD_LINK_ROLES).optional(),
    isDefault: z.boolean().optional(),
    priority: opt(prioritySchema),
    startedOn: opt(isoDateSchema),
    notes: opt(notesSchema),
  })
  .superRefine((v, ctx) => {
    if (v.isDefault && (v.role ?? 'spending_source') !== 'spending_source') {
      ctx.addIssue({ code: 'custom', path: ['isDefault'], message: 'only a spending_source link can be the default' });
    }
  });

/** 'ended' is only reachable through POST /card-links/:id/end; ended links can't change status. */
export const cardLinkUpdateSchema = z.strictObject({
  role: z.enum(CARD_LINK_ROLES).optional(),
  priority: opt(prioritySchema),
  notes: opt(notesSchema),
  status: z.enum(['active', 'suspended']).optional(),
});

export const cardLinkEndSchema = z.strictObject({ endedOn: isoDateSchema.optional() });

// ------------------------------------------------------------------ payment channels

const channelShape = {
  name: nameSchema,
  channelType: z.enum(CHANNEL_TYPES),
  providerInstitutionId: opt(idSchema),
  /** Only payment_service channels; the account must be e_money or stored_value (API check). */
  balanceAccountId: opt(idSchema),
  region: opt(countrySchema),
  status: z.enum(CHANNEL_STATUSES).optional(),
  notes: opt(notesSchema),
  sort: sortSchema.optional(),
};

function channelRules(v: { channelType?: string; balanceAccountId?: string | null }, ctx: z.RefinementCtx) {
  if (v.balanceAccountId != null && v.channelType !== undefined && v.channelType !== 'payment_service') {
    ctx.addIssue({ code: 'custom', path: ['balanceAccountId'], message: 'only payment_service channels have a balance account' });
  }
}

export const paymentChannelCreateSchema = z.strictObject(channelShape).superRefine(channelRules);
export const paymentChannelUpdateSchema = z.strictObject(channelShape).partial().superRefine(channelRules);

/** Exactly one of cardId / accountId. */
export const channelSourceCreateSchema = z
  .strictObject({
    cardId: idSchema.optional(),
    accountId: idSchema.optional(),
    isDefault: z.boolean().optional(),
    notes: opt(notesSchema),
  })
  .superRefine((v, ctx) => {
    if ((v.cardId === undefined) === (v.accountId === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'give exactly one of cardId and accountId' });
    }
  });

export const channelSourceUpdateSchema = z.strictObject({
  isDefault: z.boolean().optional(),
  notes: opt(notesSchema),
});

// ------------------------------------------------------------------ queries

/** status filter of the list endpoints: omitted = not archived, 'all' = everything (API_SPEC §1). */
export const INSTITUTION_STATUS_FILTERS = [...INSTITUTION_STATUSES, 'all'] as const;

/** GET /institutions?q=&type=&country=&status= */
export const institutionListQuerySchema = z.strictObject({
  /** Matched against the normalized name (same rules as name_key). */
  q: z.string().max(NAME_MAX).optional(),
  type: z.enum(INSTITUTION_TYPES).optional(),
  country: countrySchema.optional(),
  status: z.enum(INSTITUTION_STATUS_FILTERS).optional(),
});

/** status filter of GET /accounts: omitted = not closed (active and frozen), 'all' = everything. */
export const ACCOUNT_STATUS_FILTERS = [...ACCOUNT_STATUSES, 'all'] as const;

/** GET /accounts?q=&institutionId=&type=&country=&currency=&status=&cardId= */
export const accountListQuerySchema = z.strictObject({
  /** Matched against the normalized account name, the institution name and the number hint. */
  q: z.string().max(NAME_MAX).optional(),
  institutionId: idSchema.optional(),
  type: z.enum(ACCOUNT_TYPES).optional(),
  /** account_country (the contracting entity's jurisdiction), not the institution's country. */
  country: countrySchema.optional(),
  /** Accounts holding this currency (active or closed). */
  currency: currencySchema.optional(),
  status: z.enum(ACCOUNT_STATUS_FILTERS).optional(),
  /** Accounts with an unfinished link to this card. */
  cardId: idSchema.optional(),
});

/** status filter of GET /cards: omitted = not closed (active and frozen), 'all' = everything. */
export const CARD_STATUS_FILTERS = [...CARD_STATUSES, 'all'] as const;

/**
 * GET /cards?q=&network=&type=&form=&status=&issuerId=&accountId=&expiringWithinDays=&expiry=&today=
 * Expiry rules: expiry.ts. `expiringWithinDays` alone keeps the cards expiring within that many
 * days (not yet expired); with `expiry` it is the threshold between 'expiring' and 'valid'.
 * `today` is the caller's calendar date (the web app sends the user's local date), so the filter
 * and the tags on screen agree across time zones.
 */
export const cardListQuerySchema = z.strictObject({
  /** Matched against the normalized card name, the issuer name and the last four digits. */
  q: z.string().max(NAME_MAX).optional(),
  network: z.enum(CARD_NETWORKS).optional(),
  type: z.enum(CARD_TYPES).optional(),
  form: z.enum(CARD_FORMS).optional(),
  status: z.enum(CARD_STATUS_FILTERS).optional(),
  issuerId: idSchema.optional(),
  /** Cards with an unfinished link to this account. */
  accountId: idSchema.optional(),
  expiringWithinDays: z
    .string()
    .regex(/^\d{1,4}$/)
    .transform(Number)
    .pipe(z.int().min(0).max(EXPIRING_WITHIN_DAYS_MAX))
    .optional(),
  expiry: z.enum(EXPIRY_STATUSES).optional(),
  today: isoDateSchema.optional(),
});

/** GET /cards/:id/spending-source?currency= — the Event (purchase) currency, upper-case ISO 4217. */
export const spendingSourceQuerySchema = z.strictObject({ currency: currencySchema });

// ------------------------------------------------------------------ errors

/** API error code for a failed request-body parse: CARD_TYPE_UNSUPPORTED or VALIDATION. */
export function ledgerErrorCode(error: z.ZodError): Extract<LedgerErrorCode, 'VALIDATION' | 'CARD_TYPE_UNSUPPORTED'> {
  return error.issues.some((i) => i.message === 'CARD_TYPE_UNSUPPORTED') ? 'CARD_TYPE_UNSUPPORTED' : 'VALIDATION';
}

export type ProfileSettingsUpdate = z.infer<typeof profileSettingsUpdateSchema>;
export type InstitutionCreate = z.infer<typeof institutionCreateSchema>;
export type InstitutionUpdate = z.infer<typeof institutionUpdateSchema>;
export type InstitutionListQuery = z.infer<typeof institutionListQuerySchema>;
export type AccountCreate = z.infer<typeof accountCreateSchema>;
export type AccountUpdate = z.infer<typeof accountUpdateSchema>;
export type AccountCurrenciesReplace = z.infer<typeof accountCurrenciesReplaceSchema>;
export type AccountListQuery = z.infer<typeof accountListQuerySchema>;
export type CardCreate = z.infer<typeof cardCreateSchema>;
export type CardUpdate = z.infer<typeof cardUpdateSchema>;
/** Query-string form (what the web app sends); the API parses it into z.infer<typeof cardListQuerySchema>. */
export type CardListQuery = z.input<typeof cardListQuerySchema>;
export type CardLinkCreate = z.infer<typeof cardLinkCreateSchema>;
export type CardLinkUpdate = z.infer<typeof cardLinkUpdateSchema>;
export type CardLinkEnd = z.infer<typeof cardLinkEndSchema>;
export type PaymentChannelCreate = z.infer<typeof paymentChannelCreateSchema>;
export type PaymentChannelUpdate = z.infer<typeof paymentChannelUpdateSchema>;
export type ChannelSourceCreate = z.infer<typeof channelSourceCreateSchema>;
export type ChannelSourceUpdate = z.infer<typeof channelSourceUpdateSchema>;
export type SpendingSourceQuery = z.infer<typeof spendingSourceQuerySchema>;
