/**
 * X-UI Product v1 enums (docs/product-v1/DATA_MODEL.md §3). Every list here is also a database
 * CHECK (apps/ledger-api/src/db/schema.ts builds its CHECKs from these arrays), so a value that
 * is not listed can be written neither through the API nor with raw SQL.
 * There is deliberately no credit card type, no credit / investment account type and no
 * bank_transfer channel type.
 */

// ------------------------------------------------------------------ institutions

export const INSTITUTION_TYPES = ['bank', 'emi', 'other'] as const;
export type InstitutionType = (typeof INSTITUTION_TYPES)[number];

export const INSTITUTION_STATUSES = ['active', 'archived'] as const;
export type InstitutionStatus = (typeof INSTITUTION_STATUSES)[number];

// ------------------------------------------------------------------ accounts

export const ACCOUNT_TYPES = ['bank', 'e_money', 'stored_value', 'other'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Only for account_type = 'bank'. */
export const DEPOSIT_KINDS = ['current', 'savings', 'fixed', 'other'] as const;
export type DepositKind = (typeof DEPOSIT_KINDS)[number];

export const ACCOUNT_STATUSES = ['active', 'frozen', 'closed'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ACCOUNT_CURRENCY_STATUSES = ['active', 'closed'] as const;
export type AccountCurrencyStatus = (typeof ACCOUNT_CURRENCY_STATUSES)[number];

/** Account types a payment channel may use as its balance account. */
export const BALANCE_ACCOUNT_TYPES = ['e_money', 'stored_value'] as const satisfies readonly AccountType[];

// ------------------------------------------------------------------ cards

export const CARD_NETWORKS = ['visa', 'mastercard', 'amex', 'unionpay', 'jcb', 'discover', 'diners', 'maestro', 'other'] as const;
export type CardNetwork = (typeof CARD_NETWORKS)[number];

/** No 'credit': credit cards cannot be stored (API 400 CARD_TYPE_UNSUPPORTED, database CHECK). */
export const CARD_TYPES = ['debit', 'prepaid'] as const;
export type CardType = (typeof CARD_TYPES)[number];

export const CARD_FORMS = ['physical', 'virtual'] as const;
export type CardForm = (typeof CARD_FORMS)[number];

export const CARD_STATUSES = ['active', 'frozen', 'closed'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

// ------------------------------------------------------------------ card ↔ account links

/** spending_source: the account charged when the card is used (a prepaid card's stored-value account). */
export const CARD_LINK_ROLES = ['spending_source', 'top_up_source', 'other'] as const;
export type CardLinkRole = (typeof CARD_LINK_ROLES)[number];

/** active ⇄ suspended → ended (ended is final; a new link is created instead). */
export const CARD_LINK_STATUSES = ['active', 'suspended', 'ended'] as const;
export type CardLinkStatus = (typeof CARD_LINK_STATUSES)[number];

// ------------------------------------------------------------------ payment channels

/** Transfer methods (SWIFT, FPS, SEPA, …) are not channels; they belong to M3 transactions. */
export const CHANNEL_TYPES = ['device_wallet', 'payment_service', 'other'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CHANNEL_STATUSES = ['active', 'archived'] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

export const CHANNEL_SOURCE_STATUSES = ['active', 'ended'] as const;
export type ChannelSourceStatus = (typeof CHANNEL_SOURCE_STATUSES)[number];

// ------------------------------------------------------------------ spending-source recommendation

export const SPENDING_MATCHES = ['exact_currency', 'conversion_required', 'no_match'] as const;
export type SpendingMatch = (typeof SPENDING_MATCHES)[number];

export const NO_MATCH_REASONS = ['card_inactive', 'no_eligible_link'] as const;
export type NoMatchReason = (typeof NO_MATCH_REASONS)[number];

// ------------------------------------------------------------------ user preferences

/**
 * Per-user home region (user_preferences.home_region — not the global settings table). Also the
 * column default, and what GET /settings/profile answers while the user has no preferences row.
 */
export const DEFAULT_HOME_REGION = 'CN';

// ------------------------------------------------------------------ API errors (API_SPEC §1.1)

export const LEDGER_ERROR_CODES = [
  'VALIDATION',
  'SENSITIVE_DATA',
  'CARD_TYPE_UNSUPPORTED',
  'CURRENCY_NOT_ON_ACCOUNT',
  'CHANNEL_SOURCE_KIND',
  'BALANCE_ACCOUNT_KIND',
  'NOT_FOUND',
  'DUPLICATE',
  'IN_USE',
  'CURRENCY_IN_USE',
  'INSTITUTION_ARCHIVED',
] as const;
export type LedgerErrorCode = (typeof LEDGER_ERROR_CODES)[number];

// ------------------------------------------------------------------ limits

export const NAME_MAX = 80;
export const NOTES_MAX = 1000;
export const WEBSITE_MAX = 200;
/** Currencies per account (API_SPEC §3.3). */
export const ACCOUNT_CURRENCIES_MAX = 30;
