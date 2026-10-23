export const ROLES = ['admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

export const INSTITUTION_TYPES = ['bank', 'ewallet', 'broker', 'crypto', 'other'] as const;
export type InstitutionType = (typeof INSTITUTION_TYPES)[number];

export const ACCOUNT_TYPES = [
  'checking',
  'savings',
  'credit',
  'cash',
  'ewallet',
  'investment',
  'other',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** trade = cash leg of a stock buy/sell, created on the investments page. */
export const TRANSACTION_TYPES = ['income', 'expense', 'transfer', 'adjustment', 'trade'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/**
 * Transactions list views. outflow = money leaving an account: expenses, the sending leg of a
 * transfer and stock-buy cash legs (amount < 0 of these types only). It is not spending — a
 * transfer or a share purchase is not consumption. all = every type, stock-trade cash legs included.
 */
export const TX_FLOWS = ['outflow', 'all'] as const;
export type TxFlow = (typeof TX_FLOWS)[number];
/** Types that can appear in the outflow view (always with a negative amount). */
export const OUTFLOW_TYPES = ['expense', 'transfer', 'trade'] as const satisfies readonly TransactionType[];

/**
 * How far a transaction's details were checked against their source. Not stored (null) means
 * not marked — what every transaction recorded before these fields existed has.
 */
export const VERIFICATION_STATUSES = ['verified', 'partial', 'pending'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const CATEGORY_KINDS = ['expense', 'income'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

/** One-time bill (single due date) or subscription (recurring). */
export const BILL_KINDS = ['once', 'subscription'] as const;
export type BillKind = (typeof BILL_KINDS)[number];

/**
 * What to do with due dates that are already in the past when a bill is created:
 * record = mark paid and create the expense transactions (history counts in statistics),
 * paid = mark paid without transactions, pending = leave them unpaid.
 */
export const PAST_POLICIES = ['record', 'paid', 'pending'] as const;
export type PastPolicy = (typeof PAST_POLICIES)[number];

export const OCCURRENCE_STATUSES = ['pending', 'paid', 'skipped'] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

export const SESSION_METHODS = ['passkey', 'password_totp', 'recovery', 'setup'] as const;
export type SessionMethod = (typeof SESSION_METHODS)[number];

export const CUSTOM_FIELD_ENTITIES = ['institution', 'account', 'card', 'transaction'] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const CUSTOM_FIELD_TYPES = [
  'text',
  'number',
  'select',
  'multiselect',
  'date',
  'boolean',
  'money',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** Card face themes for the Stripe-style card component. */
export const CARD_THEMES = [
  'midnight',
  'ocean',
  'violet',
  'sunset',
  'emerald',
  'graphite',
  'gold',
  'rose',
] as const;
export type CardTheme = (typeof CARD_THEMES)[number];
