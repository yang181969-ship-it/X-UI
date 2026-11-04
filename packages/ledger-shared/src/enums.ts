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

/**
 * Why a (not ended) link of the card was not eligible as a spending source (M2-B4 explanation of
 * the recommendation; DATA_MODEL §5 eligible(link)), checked in this order.
 * currency_closed: the link's own currency is closed, or (all-currency link) the account has no active currency.
 */
export const SPENDING_SKIP_REASONS = ['not_spending_source', 'link_suspended', 'account_inactive', 'currency_closed'] as const;
export type SpendingSkipReason = (typeof SPENDING_SKIP_REASONS)[number];

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
  'LINK_STATE',
] as const;
export type LedgerErrorCode = (typeof LEDGER_ERROR_CODES)[number];

// ------------------------------------------------------------------ limits

export const NAME_MAX = 80;
export const NOTES_MAX = 1000;
export const WEBSITE_MAX = 200;
/** Currencies per account (API_SPEC §3.3). */
export const ACCOUNT_CURRENCIES_MAX = 30;

// ================================================================== M3 transactions (DATA_MODEL §10)

/** No type change after creation: a wrongly typed transaction is voided and recreated. */
export const TXN_TYPES = ['merchant_spend', 'merchant_refund', 'own_transfer', 'third_party_transfer'] as const;
export type TxnType = (typeof TXN_TYPES)[number];
export const MERCHANT_TXN_TYPES = ['merchant_spend', 'merchant_refund'] as const satisfies readonly TxnType[];
export const TRANSFER_TXN_TYPES = ['own_transfer', 'third_party_transfer'] as const satisfies readonly TxnType[];

/** voided is final. */
export const TXN_STATUSES = ['active', 'voided'] as const;
export type TxnStatus = (typeof TXN_STATUSES)[number];

/** original is revision 1; every later version is one of the three corrections (§10.9.2). */
export const REVISION_KINDS = ['original', 'settlement', 'fact_correction', 'snapshot_correction'] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];
export const CORRECTION_KINDS = ['settlement', 'fact_correction', 'snapshot_correction'] as const satisfies readonly RevisionKind[];
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

/** Declared by the user (P6): the system never decides it from the date. */
export const RECORD_MODES = ['current', 'backfill'] as const;
export type RecordMode = (typeof RECORD_MODES)[number];

/** in: the funding_* columns name the receiving account and currency (K2). */
export const ENTRY_DIRECTIONS = ['out', 'in'] as const;
export type EntryDirection = (typeof ENTRY_DIRECTIONS)[number];

/** pending: amount unknown (null) — never estimated, not in the statistics. */
export const AMOUNT_STATUSES = ['confirmed', 'pending'] as const;
export type AmountStatus = (typeof AMOUNT_STATUSES)[number];

/** Transfers only; never used to decide where a side is. */
export const TRANSFER_METHODS = ['swift', 'sepa', 'fps', 'ach', 'local_transfer', 'internal_book', 'other'] as const;
export type TransferMethod = (typeof TRANSFER_METHODS)[number];

/** Decided by the transaction type: own_transfer → self, third_party_transfer → third_party. */
export const COUNTERPARTY_KINDS = ['self', 'third_party'] as const;
export type CounterpartyKind = (typeof COUNTERPARTY_KINDS)[number];

/** Where an event's home_region snapshot came from (§10.3.2). */
export const HOME_REGION_SOURCES = ['preference_at_save', 'carried', 'user_declared', 'user_corrected'] as const;
export type HomeRegionSource = (typeof HOME_REGION_SOURCES)[number];

/** Where an entry's funding_account_country snapshot came from (§10.4). */
export const COUNTRY_SOURCES = ['account_at_save', 'carried', 'user_corrected'] as const;
export type CountrySource = (typeof COUNTRY_SOURCES)[number];

/** Status of the account currency when the entry was saved (not when the transaction happened). */
export const CURRENCY_STATUSES_AT_SAVE = ACCOUNT_CURRENCY_STATUSES;
export type CurrencyStatusAtSave = AccountCurrencyStatus;

// ------------------------------------------------------------------ region classification v1 (§10.8)

/** The one classifier version v1 knows; later versions only via an explicit per-transaction snapshot correction. */
export const CLASSIFIER_VERSION = 1;

/** foreign: confirmed abroad · domestic: confirmed purely domestic (never published, P2) · undetermined: not enough information — not domestic. */
export const FOREIGN_STATUSES = ['foreign', 'domestic', 'undetermined'] as const;
export type ForeignStatus = (typeof FOREIGN_STATUSES)[number];

/** Merchant side of a spend / refund: unknown when the merchant country is unknown. */
export const MERCHANT_SCOPES = ['foreign', 'domestic', 'unknown'] as const;
export type MerchantScope = (typeof MERCHANT_SCOPES)[number];

/** Both sides of a transfer against the home region (§10.8.2 table). */
export const TRANSFER_SCOPES = [
  'outbound',
  'inbound',
  'foreign_cross_border',
  'foreign_local',
  'domestic_local',
  'domestic_to_unknown',
  'unknown_to_domestic',
  'foreign_to_unknown',
  'unknown_to_foreign',
] as const;
export type TransferScope = (typeof TRANSFER_SCOPES)[number];

/** List filter: one of the three states, or all. There is deliberately no "not foreign" filter. */
export const FOREIGN_STATUS_FILTERS = [...FOREIGN_STATUSES, 'all'] as const;
export const TXN_STATUS_FILTERS = [...TXN_STATUSES, 'all'] as const;

// ------------------------------------------------------------------ idempotency (API_SPEC §5.0.3)

export const IDEMPOTENT_OPERATIONS = ['transaction.create', 'transaction.correct', 'transaction.void'] as const;
export type IdempotentOperation = (typeof IDEMPOTENT_OPERATIONS)[number];
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';
/** Create keys are kept for good; correct / void keys for this many days. */
export const CORRECTION_KEY_TTL_DAYS = 30;

// ------------------------------------------------------------------ M3 errors (API_SPEC §5.1)

/** Error codes the transaction API adds to LEDGER_ERROR_CODES (which it also uses). */
export const TRANSACTION_ERROR_CODES = [
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_INVALID',
  'ENTRY_SHAPE',
  'CLOSED_CURRENCY_ACK_REQUIRED',
  'CONFIRMED_DOMESTIC',
  'IDEMPOTENCY_CONFLICT',
  'REVISION_CONFLICT',
  'TRANSACTION_VOIDED',
  'CONCURRENT_CHANGE',
] as const;
export type TransactionErrorCode = (typeof TRANSACTION_ERROR_CODES)[number];

/**
 * Codes raised by the migration 0002 triggers as RAISE(ABORT, '<CODE>: …') (DATA_MODEL §10.7.2).
 * Never shown to clients: the API maps them to TRANSACTION_ERROR_CODES / LEDGER_ERROR_CODES.
 */
export const LEDGER_DB_ERROR_CODES = [
  'LEDGER_HEADER_INSERT',
  'LEDGER_HEADER_IMMUTABLE',
  'LEDGER_VOIDED',
  'LEDGER_REVISION_ORDER',
  'LEDGER_ENTRY_COUNT',
  'LEDGER_OWN_TRANSFER_SHAPE',
  'LEDGER_EVENT_AMOUNT',
  'LEDGER_CLASSIFICATION',
  'LEDGER_CONFIRMED_DOMESTIC',
  'LEDGER_NO_DELETE',
  'LEDGER_IMMUTABLE',
  'LEDGER_SNAPSHOT_SOURCE',
  'LEDGER_REVISION_KIND',
  'LEDGER_CLOSED_CURRENCY',
  'LEDGER_KEY_IMMUTABLE',
] as const;
export type LedgerDbErrorCode = (typeof LEDGER_DB_ERROR_CODES)[number];

/** Reasons (correction, void): 1–200 characters. */
export const REASON_MAX = 200;
