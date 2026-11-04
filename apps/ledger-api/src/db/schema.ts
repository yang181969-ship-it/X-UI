import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, unique, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  ACCOUNT_CURRENCY_STATUSES,
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  AMOUNT_MAX,
  AMOUNT_MIN,
  AMOUNT_STATUSES,
  CARD_FORMS,
  CARD_LINK_ROLES,
  CARD_LINK_STATUSES,
  CARD_NETWORKS,
  CARD_STATUSES,
  CARD_TYPES,
  CHANNEL_SOURCE_STATUSES,
  CHANNEL_STATUSES,
  CHANNEL_TYPES,
  COUNTERPARTY_KINDS,
  COUNTRY_SOURCES,
  CURRENCY_STATUSES_AT_SAVE,
  DEFAULT_HOME_REGION,
  DEPOSIT_KINDS,
  ENTRY_DIRECTIONS,
  FOREIGN_STATUSES,
  HOME_REGION_SOURCES,
  IDEMPOTENT_OPERATIONS,
  INSTITUTION_STATUSES,
  INSTITUTION_TYPES,
  MERCHANT_SCOPES,
  RECORD_MODES,
  REVISION_KINDS,
  TRANSFER_METHODS,
  TRANSFER_SCOPES,
  TXN_STATUSES,
  TXN_TYPES,
} from '@xui/ledger-shared';

/**
 * X-UI Product v1 schema (its own database: data/x-ui-v1.db locally, D1 "x-ui-v1" on Cloudflare).
 * - Ids are text (time-sortable random ids, see lib/id.ts).
 * - Timestamps are epoch milliseconds; business dates YYYY-MM-DD; booleans integer 0/1.
 * M1: authentication, settings and the database identity marker. The auth tables keep the
 * column layout of the legacy app (apps/api).
 * M2: institutions, accounts, account currencies, cards, card ↔ account links, payment channels
 * and their funding sources (docs/product-v1/DATA_MODEL.md §3–§4).
 * M3: the transaction ledger — headers, immutable versions (events) and entries, and the
 * idempotency results of financial writes (DATA_MODEL §10).
 */

const ts = (name: string) => integer(name).notNull();
const bool = (name: string) => integer(name, { mode: 'boolean' });

// ------------------------------------------------------------------ identity

/**
 * Identity marker. Written before the first migration runs (db/identity.ts) and re-asserted by
 * migration 0000 (CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE), so a database is only ever
 * migrated once it is known to be an X-UI v1 database.
 */
export const xuiV1Meta = sqliteTable('xui_v1_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  createdAt: ts('created_at'),
});

// ------------------------------------------------------------------ auth

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  role: text('role', { enum: ['admin', 'member'] }).notNull(),
  status: text('status', { enum: ['active', 'disabled', 'pending'] }).notNull(),
  passwordHash: text('password_hash'),
  totpSecretEnc: text('totp_secret_enc'),
  totpPendingEnc: text('totp_pending_enc'),
  totpEnabled: bool('totp_enabled').notNull().default(false),
  /** Last accepted TOTP time step, to reject replays of the same code. */
  totpLastStep: integer('totp_last_step'),
  /** Random WebAuthn user handle (base64url). */
  webauthnUserId: text('webauthn_user_id').notNull(),
  /** Profile picture as a small data URL (resized in the browser), or null for initials. */
  avatar: text('avatar'),
  createdAt: ts('created_at'),
  updatedAt: ts('updated_at'),
});

export const passkeys = sqliteTable(
  'passkeys',
  {
    id: text('id').primaryKey(), // credential id, base64url
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    publicKey: text('public_key').notNull(), // base64url
    counter: integer('counter').notNull().default(0),
    transports: text('transports', { mode: 'json' }).$type<string[]>(),
    deviceType: text('device_type'),
    backedUp: bool('backed_up').notNull().default(false),
    name: text('name').notNull(),
    createdAt: ts('created_at'),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [index('passkeys_user_idx').on(t.userId)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(), // sha256(token) hex
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    method: text('method', { enum: ['passkey', 'password_totp', 'recovery', 'setup'] }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: ts('created_at'),
    lastSeenAt: ts('last_seen_at'),
    expiresAt: ts('expires_at'),
    absoluteExpiresAt: ts('absolute_expires_at'),
    stepUpAt: integer('step_up_at'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const recoveryCodes = sqliteTable(
  'recovery_codes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: integer('used_at'),
    createdAt: ts('created_at'),
  },
  (t) => [index('recovery_user_idx').on(t.userId)],
);

export const loginAttempts = sqliteTable('login_attempts', {
  key: text('key').primaryKey(),
  failures: integer('failures').notNull(),
  windowStart: ts('window_start'),
  lockedUntil: integer('locked_until'),
});

export const authChallenges = sqliteTable('auth_challenges', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  purpose: text('purpose', { enum: ['register', 'login', 'step_up'] }).notNull(),
  challenge: text('challenge').notNull(),
  expiresAt: ts('expires_at'),
});

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    userId: text('user_id'),
    action: text('action').notNull(),
    detail: text('detail', { mode: 'json' }),
    ip: text('ip'),
    createdAt: ts('created_at'),
  },
  (t) => [index('audit_user_idx').on(t.userId, t.createdAt)],
);

// ------------------------------------------------------------------ settings

/** Key/value settings (same layout as the legacy table; contents are defined from M2 on). */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: ts('updated_at'),
});

// ================================================================== M2 (DATA_MODEL §3)
//
// Data isolation lives in the database: every referenced business table has UNIQUE(id, user_id)
// and every business reference is a composite foreign key that includes user_id, so a row can
// never point at another user's row even if an API check is missed (DATA_MODEL §4).
// - Restricting deletes use NO ACTION (checked at the end of the statement), never RESTRICT:
//   RESTRICT fires mid-statement and would break cascades that remove the referencing rows in
//   the same statement (deleting a user, or an account together with its currency-scoped links).
// - Composite keys only use CASCADE or NO ACTION; SET NULL would also null user_id.
// - A NULL in any child column skips the check (SQLite MATCH SIMPLE): optional references.
// - Enum CHECKs are built from the @xui/ledger-shared lists the zod schemas use.
// - Rules a CHECK cannot express are triggers, written by hand in migration 0001 (drizzle has no
//   trigger API): a channel's balance account must be e_money / stored_value, checked on channel
//   INSERT and UPDATE and when such an account's type changes (DATA_MODEL §3.6); an account's
//   institution_id never changes after INSERT (accounts_institution_immutable, §3.2).
// test/m2-schema.test.ts runs every constraint on libsql and on local D1 (workerd);
// test/migrations-guard.test.ts checks every migration file for drizzle-kit generation bugs.

/** `col IN ('a', 'b', …)` — values are fixed enum literals, never user input. */
const inListSql = (col: string, values: readonly string[]) => `${col} IN (${values.map((v) => `'${v}'`).join(', ')})`;
const inList = (col: string, values: readonly string[]) => sql.raw(inListSql(col, values));
const isBool = (col: string) => sql.raw(`${col} IN (0, 1)`);
const alpha2 = (col: string) => sql.raw(`${col} GLOB '[A-Z][A-Z]'`);
const optAlpha2 = (col: string) => sql.raw(`${col} IS NULL OR ${col} GLOB '[A-Z][A-Z]'`);
const ownerId = () =>
  text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' });

// ------------------------------------------------------------------ user preferences

/**
 * Per-user preferences. home_region is the user's own region (M3 snapshots it into each event);
 * it is never kept in the global settings table. No row = defaults (DEFAULT_HOME_REGION).
 */
export const userPreferences = sqliteTable(
  'user_preferences',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    homeRegion: text('home_region').notNull().default(DEFAULT_HOME_REGION),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  () => [check('user_preferences_home_region_ck', alpha2('home_region'))],
);

// ------------------------------------------------------------------ institutions

export const institutions = sqliteTable(
  'institutions',
  {
    id: text('id').primaryKey(),
    userId: ownerId(),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
    /** Registered seat / headquarters only — never used to infer an account's country. */
    country: text('country'),
    institutionType: text('institution_type', { enum: INSTITUTION_TYPES }).notNull(),
    /** Display only; the server never fetches it. */
    website: text('website'),
    /** #rrggbb avatar colour (instead of a logo). */
    color: text('color'),
    notes: text('notes'),
    status: text('status', { enum: INSTITUTION_STATUSES }).notNull().default('active'),
    sort: integer('sort').notNull().default(0),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    unique('institutions_id_user_uq').on(t.id, t.userId),
    // ifnull: two same-named institutions without a country are duplicates too.
    uniqueIndex('institutions_user_name_country_uq').on(t.userId, t.nameKey, sql`ifnull(${t.country}, '')`),
    index('institutions_user_status_idx').on(t.userId, t.status),
    check('institutions_country_ck', optAlpha2('country')),
    check('institutions_type_ck', inList('institution_type', INSTITUTION_TYPES)),
    check('institutions_status_ck', inList('status', INSTITUTION_STATUSES)),
  ],
);

// ------------------------------------------------------------------ accounts

/** An account that holds money. Deliberately no balance, opening balance, credit limit or full account number. */
export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    userId: ownerId(),
    institutionId: text('institution_id').notNull(),
    name: text('name').notNull(),
    /** Search and duplicate hints only — not unique. */
    nameKey: text('name_key').notNull(),
    accountType: text('account_type', { enum: ACCOUNT_TYPES }).notNull(),
    depositKind: text('deposit_kind', { enum: DEPOSIT_KINDS }),
    /** Jurisdiction of the legal entity holding the account contract (DATA_MODEL §3.2) — entered, never inferred. */
    accountCountry: text('account_country').notNull(),
    /** Last 1–4 letters/digits of the account number. */
    numberHint: text('number_hint'),
    status: text('status', { enum: ACCOUNT_STATUSES }).notNull().default('active'),
    openedOn: text('opened_on'),
    closedOn: text('closed_on'),
    notes: text('notes'),
    sort: integer('sort').notNull().default(0),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    unique('accounts_id_user_uq').on(t.id, t.userId),
    index('accounts_user_status_idx').on(t.userId, t.status),
    index('accounts_user_institution_idx').on(t.userId, t.institutionId),
    index('accounts_user_country_idx').on(t.userId, t.accountCountry),
    foreignKey({ columns: [t.institutionId, t.userId], foreignColumns: [institutions.id, institutions.userId] }).onDelete('no action'),
    check('accounts_type_ck', inList('account_type', ACCOUNT_TYPES)),
    check('accounts_deposit_kind_ck', sql.raw(`deposit_kind IS NULL OR (${inListSql('deposit_kind', DEPOSIT_KINDS)} AND account_type = 'bank')`)),
    check('accounts_country_ck', alpha2('account_country')),
    check('accounts_number_hint_ck', sql.raw(`number_hint IS NULL OR (length(number_hint) BETWEEN 1 AND 4 AND number_hint NOT GLOB '*[^0-9A-Za-z]*')`)),
    check('accounts_status_ck', inList('status', ACCOUNT_STATUSES)),
    check('accounts_dates_ck', sql.raw(`closed_on IS NULL OR opened_on IS NULL OR closed_on >= opened_on`)),
  ],
);

// ------------------------------------------------------------------ account currencies

/** Currencies an account supports: ≥ 1 per account and exactly one active default (API rule; the index allows at most one). */
export const accountCurrencies = sqliteTable(
  'account_currencies',
  {
    accountId: text('account_id').notNull(),
    userId: ownerId(),
    currency: text('currency').notNull(),
    isDefault: bool('is_default').notNull().default(false),
    status: text('status', { enum: ACCOUNT_CURRENCY_STATUSES }).notNull().default('active'),
    sort: integer('sort').notNull().default(0),
    createdAt: ts('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.currency] }),
    // Target of the (account_id, user_id, currency) keys of links (and of M3 entries).
    unique('account_currencies_account_user_currency_uq').on(t.accountId, t.userId, t.currency),
    uniqueIndex('account_currencies_default_uq').on(t.accountId).where(sql`${t.isDefault} = 1`),
    foreignKey({ columns: [t.accountId, t.userId], foreignColumns: [accounts.id, accounts.userId] }).onDelete('cascade'),
    check('account_currencies_currency_ck', sql.raw(`currency GLOB '[A-Z][A-Z][A-Z]'`)),
    check('account_currencies_is_default_ck', isBool('is_default')),
    check('account_currencies_status_ck', inList('status', ACCOUNT_CURRENCY_STATUSES)),
    check('account_currencies_default_active_ck', sql.raw(`is_default = 0 OR status = 'active'`)),
  ],
);

// ------------------------------------------------------------------ cards

/**
 * Debit and prepaid cards. Deliberately no account_id (links are many-to-many), and no PAN,
 * BIN, CVV, PIN, holder name, credit limit or statement/due day.
 */
export const cards = sqliteTable(
  'cards',
  {
    id: text('id').primaryKey(),
    userId: ownerId(),
    issuerInstitutionId: text('issuer_institution_id').notNull(),
    name: text('name').notNull(),
    network: text('network', { enum: CARD_NETWORKS }).notNull(),
    cardType: text('card_type', { enum: CARD_TYPES }).notNull(),
    form: text('form', { enum: CARD_FORMS }).notNull().default('physical'),
    last4: text('last4').notNull(),
    /** Display only — never used to infer where the money is. */
    issuingCountry: text('issuing_country').notNull(),
    /** YYYY-MM. */
    expiresOn: text('expires_on'),
    status: text('status', { enum: CARD_STATUSES }).notNull().default('active'),
    notes: text('notes'),
    sort: integer('sort').notNull().default(0),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    unique('cards_id_user_uq').on(t.id, t.userId),
    index('cards_user_status_idx').on(t.userId, t.status),
    index('cards_user_issuer_idx').on(t.userId, t.issuerInstitutionId),
    foreignKey({ columns: [t.issuerInstitutionId, t.userId], foreignColumns: [institutions.id, institutions.userId] }).onDelete('no action'),
    check('cards_network_ck', inList('network', CARD_NETWORKS)),
    check('cards_card_type_ck', inList('card_type', CARD_TYPES)),
    check('cards_form_ck', inList('form', CARD_FORMS)),
    check('cards_last4_ck', sql.raw(`last4 GLOB '[0-9][0-9][0-9][0-9]'`)),
    check('cards_issuing_country_ck', alpha2('issuing_country')),
    // YYYY-MM with month 01–12 (GLOB without wildcards also fixes the length at 7).
    check('cards_expires_on_ck', sql.raw(`expires_on IS NULL OR expires_on GLOB '[0-9][0-9][0-9][0-9]-0[1-9]' OR expires_on GLOB '[0-9][0-9][0-9][0-9]-1[0-2]'`)),
    check('cards_status_ck', inList('status', CARD_STATUSES)),
  ],
);

// ------------------------------------------------------------------ card ↔ account links

/** Many-to-many. A prepaid card's stored-value account is its spending_source. */
export const accountCardLinks = sqliteTable(
  'account_card_links',
  {
    id: text('id').primaryKey(),
    userId: ownerId(),
    cardId: text('card_id').notNull(),
    accountId: text('account_id').notNull(),
    /** null = every currency of the account. */
    currency: text('currency'),
    role: text('role', { enum: CARD_LINK_ROLES }).notNull().default('spending_source'),
    isDefault: bool('is_default').notNull().default(false),
    /** Charge order, 1 first. */
    priority: integer('priority'),
    status: text('status', { enum: CARD_LINK_STATUSES }).notNull().default('active'),
    startedOn: text('started_on'),
    endedOn: text('ended_on'),
    notes: text('notes'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    // One unfinished link per (card, account, currency scope, role); ended links may repeat.
    uniqueIndex('account_card_links_open_uq')
      .on(t.cardId, t.accountId, sql`ifnull(${t.currency}, '')`, t.role)
      .where(sql`${t.status} <> 'ended'`),
    // At most one default spending source per card and currency scope.
    uniqueIndex('account_card_links_default_uq')
      .on(t.cardId, sql`ifnull(${t.currency}, '')`)
      .where(sql`${t.isDefault} = 1`),
    index('account_card_links_user_card_idx').on(t.userId, t.cardId),
    index('account_card_links_user_account_idx').on(t.userId, t.accountId),
    foreignKey({ columns: [t.cardId, t.userId], foreignColumns: [cards.id, cards.userId] }).onDelete('cascade'),
    foreignKey({ columns: [t.accountId, t.userId], foreignColumns: [accounts.id, accounts.userId] }).onDelete('cascade'),
    foreignKey({
      columns: [t.accountId, t.userId, t.currency],
      foreignColumns: [accountCurrencies.accountId, accountCurrencies.userId, accountCurrencies.currency],
    }).onDelete('no action'),
    check('account_card_links_role_ck', inList('role', CARD_LINK_ROLES)),
    check('account_card_links_is_default_ck', isBool('is_default')),
    check('account_card_links_default_ck', sql.raw(`is_default = 0 OR (role = 'spending_source' AND status = 'active')`)),
    check('account_card_links_priority_ck', sql.raw(`priority IS NULL OR priority >= 1`)),
    check('account_card_links_status_ck', inList('status', CARD_LINK_STATUSES)),
    check('account_card_links_ended_ck', sql.raw(`ended_on IS NULL OR status = 'ended'`)),
  ],
);

// ------------------------------------------------------------------ payment channels

export const paymentChannels = sqliteTable(
  'payment_channels',
  {
    id: text('id').primaryKey(),
    userId: ownerId(),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
    channelType: text('channel_type', { enum: CHANNEL_TYPES }).notNull(),
    providerInstitutionId: text('provider_institution_id'),
    /** payment_service only; e_money / stored_value accounts (API rule); one channel per account. */
    balanceAccountId: text('balance_account_id'),
    /** Region the service account is registered in — display only. */
    region: text('region'),
    status: text('status', { enum: CHANNEL_STATUSES }).notNull().default('active'),
    notes: text('notes'),
    sort: integer('sort').notNull().default(0),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    unique('payment_channels_id_user_uq').on(t.id, t.userId),
    unique('payment_channels_user_name_uq').on(t.userId, t.nameKey),
    uniqueIndex('payment_channels_balance_account_uq')
      .on(t.balanceAccountId)
      .where(sql`${t.balanceAccountId} IS NOT NULL`),
    index('payment_channels_user_status_idx').on(t.userId, t.status),
    foreignKey({ columns: [t.providerInstitutionId, t.userId], foreignColumns: [institutions.id, institutions.userId] }).onDelete('no action'),
    foreignKey({ columns: [t.balanceAccountId, t.userId], foreignColumns: [accounts.id, accounts.userId] }).onDelete('no action'),
    check('payment_channels_type_ck', inList('channel_type', CHANNEL_TYPES)),
    check('payment_channels_balance_ck', sql.raw(`balance_account_id IS NULL OR channel_type = 'payment_service'`)),
    check('payment_channels_region_ck', optAlpha2('region')),
    check('payment_channels_status_ck', inList('status', CHANNEL_STATUSES)),
  ],
);

/** Funding sources of a channel: a card or an account (exactly one). device_wallet: cards only (API rule). */
export const paymentChannelSources = sqliteTable(
  'payment_channel_sources',
  {
    id: text('id').primaryKey(),
    userId: ownerId(),
    channelId: text('channel_id').notNull(),
    cardId: text('card_id'),
    accountId: text('account_id'),
    isDefault: bool('is_default').notNull().default(false),
    status: text('status', { enum: CHANNEL_SOURCE_STATUSES }).notNull().default('active'),
    notes: text('notes'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    uniqueIndex('payment_channel_sources_card_uq')
      .on(t.channelId, t.cardId)
      .where(sql`${t.cardId} IS NOT NULL AND ${t.status} = 'active'`),
    uniqueIndex('payment_channel_sources_account_uq')
      .on(t.channelId, t.accountId)
      .where(sql`${t.accountId} IS NOT NULL AND ${t.status} = 'active'`),
    uniqueIndex('payment_channel_sources_default_uq').on(t.channelId).where(sql`${t.isDefault} = 1`),
    index('payment_channel_sources_user_channel_idx').on(t.userId, t.channelId),
    foreignKey({ columns: [t.channelId, t.userId], foreignColumns: [paymentChannels.id, paymentChannels.userId] }).onDelete('cascade'),
    foreignKey({ columns: [t.cardId, t.userId], foreignColumns: [cards.id, cards.userId] }).onDelete('cascade'),
    foreignKey({ columns: [t.accountId, t.userId], foreignColumns: [accounts.id, accounts.userId] }).onDelete('cascade'),
    check('payment_channel_sources_xor_ck', sql.raw(`(card_id IS NULL) <> (account_id IS NULL)`)),
    check('payment_channel_sources_is_default_ck', isBool('is_default')),
    check('payment_channel_sources_default_ck', sql.raw(`is_default = 0 OR status = 'active'`)),
    check('payment_channel_sources_status_ck', inList('status', CHANNEL_SOURCE_STATUSES)),
  ],
);

// ================================================================== M3 (DATA_MODEL §10)
//
// transactions (header: identity, status, current version, notes, void data — the only table that
// is ever updated, and only as tx_update_guard allows) → transaction_events (one immutable row per
// version) → transaction_entries (one immutable row per real account movement of a version);
// ledger_idempotency_keys holds the complete result of each financial write, inserted once as the
// last statement of the write batch (§10.10) and never changed.
// - Amounts are minor-unit integers (typeof = 'integer', 1 … AMOUNT_MAX), each with its currency's
//   decimal places saved beside it; snapshots (home_region, funding_account_country,
//   currency_status_at_save) are written by SQL inside the write batch, never taken from clients.
// - The 21 triggers of §10.7.2 (version order, immutability, snapshot sources, version kinds,
//   closed currencies, publish checks C1–C7 and delete guards) are hand-written in migration 0002.
// - Foreign keys follow the M2 rules: composite with user_id, NO ACTION (never RESTRICT or SET
//   NULL) for referenced master data, CASCADE down the ledger and from users. The ledger is only
//   deleted together with its user (§10.11).
// test/m3-schema.test.ts runs every constraint and trigger on libsql and on local D1.

const optInList = (col: string, values: readonly string[]) => sql.raw(`${col} IS NULL OR ${inListSql(col, values)}`);
/**
 * typeof(col) = 'integer': revisions, decimal places and version numbers are whole numbers. A range
 * alone would let a REAL such as 2.5 through (INTEGER affinity only turns 2.0 into 2).
 */
const isInt = (col: string) => `typeof(${col}) = 'integer'`;
/** A minor-unit amount: an integer (not a REAL such as 78.3) in [AMOUNT_MIN, AMOUNT_MAX]; NULL allowed. */
const amountCheck = (col: string) => sql.raw(`${col} IS NULL OR (typeof(${col}) = 'integer' AND ${col} BETWEEN ${AMOUNT_MIN} AND ${AMOUNT_MAX})`);

// ------------------------------------------------------------------ transactions (header)

export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    userId: ownerId(),
    /** Never changes (tx_update_guard): a wrongly typed transaction is voided and recreated. */
    txnType: text('txn_type', { enum: TXN_TYPES }).notNull(),
    /** voided is final. */
    status: text('status', { enum: TXN_STATUSES }).notNull().default('active'),
    /** 0 = not yet published (only inside a write batch); then 1, 2, … one step at a time. */
    currentRevision: integer('current_revision').notNull().default(0),
    /** Not a transaction fact: no version, no history, editable in any status (P9). */
    notes: text('notes'),
    voidedAt: integer('voided_at'),
    voidReason: text('void_reason'),
    /** op_id of the request that voided the transaction (§10.10). */
    voidedOpId: text('voided_op_id'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    unique('transactions_id_user_uq').on(t.id, t.userId),
    // Target of the events' (transaction_id, txn_type, user_id) key: a version has its header's type.
    unique('transactions_id_type_user_uq').on(t.id, t.txnType, t.userId),
    index('transactions_user_status_idx').on(t.userId, t.status),
    check('transactions_type_ck', inList('txn_type', TXN_TYPES)),
    check('transactions_status_ck', inList('status', TXN_STATUSES)),
    check('transactions_revision_ck', sql.raw(`${isInt('current_revision')} AND current_revision >= 0`)),
    check('transactions_voided_at_ck', sql.raw(`(status = 'voided') = (voided_at IS NOT NULL)`)),
    check('transactions_voided_op_ck', sql.raw(`(status = 'voided') = (voided_op_id IS NOT NULL)`)),
    check('transactions_void_reason_ck', sql.raw(`void_reason IS NULL OR status = 'voided'`)),
    check('transactions_published_ck', sql.raw(`status = 'active' OR current_revision >= 1`)),
  ],
);

// ------------------------------------------------------------------ transaction_events (versions)

const MERCHANT_TYPES_SQL = `('merchant_spend', 'merchant_refund')`;
const TRANSFER_TYPES_SQL = `('own_transfer', 'third_party_transfer')`;

export const transactionEvents = sqliteTable(
  'transaction_events',
  {
    id: text('id').primaryKey(),
    userId: ownerId(),
    transactionId: text('transaction_id').notNull(),
    txnType: text('txn_type', { enum: TXN_TYPES }).notNull(),
    revision: integer('revision').notNull(),
    revisionKind: text('revision_kind', { enum: REVISION_KINDS }).notNull(),
    correctionReason: text('correction_reason'),
    /** Declared by the user (P6). */
    recordMode: text('record_mode', { enum: RECORD_MODES }).notNull(),
    /** Local date of the record, YYYY-MM-DD (no time-zone conversion). */
    occurredOn: text('occurred_on').notNull(),
    occurredTime: text('occurred_time'),
    postedOn: text('posted_on'),
    /** Spend / refund: the merchant amount; transfers: the principal sent (never the amount received, §10.3.1). */
    eventCurrency: text('event_currency'),
    eventAmount: integer('event_amount'),
    eventCurrencyExponent: integer('event_currency_exponent'),
    merchantName: text('merchant_name'),
    merchantCountry: text('merchant_country'),
    cardId: text('card_id'),
    paymentChannelId: text('payment_channel_id'),
    transferMethod: text('transfer_method', { enum: TRANSFER_METHODS }),
    counterpartyKind: text('counterparty_kind', { enum: COUNTERPARTY_KINDS }),
    counterpartyName: text('counterparty_name'),
    /** Jurisdiction of the unregistered side's contracting entity (same definition as account_country). */
    counterpartyCountry: text('counterparty_country'),
    counterpartyInstitution: text('counterparty_institution'),
    counterpartyAccountHint: text('counterparty_account_hint'),
    /** Snapshot (§10.3.2); never re-read from the current preference. */
    homeRegion: text('home_region').notNull(),
    homeRegionSource: text('home_region_source', { enum: HOME_REGION_SOURCES }).notNull(),
    merchantScope: text('merchant_scope', { enum: MERCHANT_SCOPES }),
    transferScope: text('transfer_scope', { enum: TRANSFER_SCOPES }),
    foreignStatus: text('foreign_status', { enum: FOREIGN_STATUSES }).notNull(),
    classifierVersion: integer('classifier_version').notNull(),
    createdAt: ts('created_at'),
  },
  (t) => [
    unique('transaction_events_id_user_uq').on(t.id, t.userId),
    // Target of the entries' (event_id, txn_type, user_id) key.
    unique('transaction_events_id_type_user_uq').on(t.id, t.txnType, t.userId),
    unique('transaction_events_revision_uq').on(t.transactionId, t.revision),
    index('transaction_events_user_occurred_idx').on(t.userId, t.occurredOn),
    index('transaction_events_user_card_idx').on(t.userId, t.cardId),
    index('transaction_events_user_channel_idx').on(t.userId, t.paymentChannelId),
    foreignKey({ columns: [t.transactionId, t.txnType, t.userId], foreignColumns: [transactions.id, transactions.txnType, transactions.userId] }).onDelete('cascade'),
    foreignKey({ columns: [t.cardId, t.userId], foreignColumns: [cards.id, cards.userId] }).onDelete('no action'),
    foreignKey({ columns: [t.paymentChannelId, t.userId], foreignColumns: [paymentChannels.id, paymentChannels.userId] }).onDelete('no action'),
    check('transaction_events_type_ck', inList('txn_type', TXN_TYPES)),
    check('transaction_events_revision_ck', sql.raw(`${isInt('revision')} AND revision >= 1`)),
    check('transaction_events_revision_kind_ck', inList('revision_kind', REVISION_KINDS)),
    check('transaction_events_original_ck', sql.raw(`(revision = 1) = (revision_kind = 'original')`)),
    check(
      'transaction_events_reason_ck',
      sql.raw(`(revision_kind <> 'original' OR correction_reason IS NULL) AND (revision_kind NOT IN ('fact_correction', 'snapshot_correction') OR correction_reason IS NOT NULL)`),
    ),
    check('transaction_events_record_mode_ck', inList('record_mode', RECORD_MODES)),
    check('transaction_events_occurred_time_ck', sql.raw(`occurred_time IS NULL OR occurred_time GLOB '[0-2][0-9]:[0-5][0-9]'`)),
    check('transaction_events_posted_on_ck', sql.raw(`posted_on IS NULL OR posted_on >= occurred_on`)),
    check('transaction_events_currency_ck', sql.raw(`event_currency IS NULL OR event_currency GLOB '[A-Z][A-Z][A-Z]'`)),
    check('transaction_events_amount_ck', amountCheck('event_amount')),
    check('transaction_events_exponent_ck', sql.raw(`event_currency_exponent IS NULL OR (${isInt('event_currency_exponent')} AND event_currency_exponent BETWEEN 0 AND 4)`)),
    check('transaction_events_exponent_currency_ck', sql.raw(`(event_currency IS NULL) = (event_currency_exponent IS NULL)`)),
    check('transaction_events_amount_currency_ck', sql.raw(`event_amount IS NULL OR event_currency IS NOT NULL`)),
    // P8: only a third-party transfer may lack the event amount (C5 also requires no out entry).
    check('transaction_events_amount_required_ck', sql.raw(`event_amount IS NOT NULL OR txn_type = 'third_party_transfer'`)),
    check('transaction_events_merchant_country_ck', optAlpha2('merchant_country')),
    check('transaction_events_transfer_method_ck', optInList('transfer_method', TRANSFER_METHODS)),
    check('transaction_events_counterparty_kind_ck', optInList('counterparty_kind', COUNTERPARTY_KINDS)),
    check('transaction_events_counterparty_country_ck', optAlpha2('counterparty_country')),
    check(
      'transaction_events_counterparty_hint_ck',
      sql.raw(`counterparty_account_hint IS NULL OR (length(counterparty_account_hint) BETWEEN 1 AND 4 AND counterparty_account_hint NOT GLOB '*[^0-9A-Za-z]*')`),
    ),
    check('transaction_events_home_region_ck', alpha2('home_region')),
    check('transaction_events_home_region_source_ck', inList('home_region_source', HOME_REGION_SOURCES)),
    // Which versions each home_region source may appear in (§10.3.2).
    check(
      'transaction_events_home_region_source_rule_ck',
      sql.raw(
        `(home_region_source <> 'preference_at_save' OR revision = 1) AND (home_region_source <> 'user_declared' OR (revision = 1 AND record_mode = 'backfill')) AND (home_region_source <> 'carried' OR revision > 1) AND (home_region_source <> 'user_corrected' OR (revision > 1 AND revision_kind = 'snapshot_correction'))`,
      ),
    ),
    check('transaction_events_merchant_scope_ck', optInList('merchant_scope', MERCHANT_SCOPES)),
    check('transaction_events_transfer_scope_ck', optInList('transfer_scope', TRANSFER_SCOPES)),
    check('transaction_events_foreign_status_ck', inList('foreign_status', FOREIGN_STATUSES)),
    check('transaction_events_classifier_ck', sql.raw(`${isInt('classifier_version')} AND classifier_version >= 1`)),
    // Fields of each type (§10.3).
    check(
      'transaction_events_merchant_shape_ck',
      sql.raw(
        `txn_type NOT IN ${MERCHANT_TYPES_SQL} OR (transfer_method IS NULL AND counterparty_kind IS NULL AND counterparty_name IS NULL AND counterparty_country IS NULL AND counterparty_institution IS NULL AND counterparty_account_hint IS NULL AND merchant_scope IS NOT NULL AND transfer_scope IS NULL AND event_amount IS NOT NULL)`,
      ),
    ),
    check(
      'transaction_events_transfer_shape_ck',
      sql.raw(
        `txn_type NOT IN ${TRANSFER_TYPES_SQL} OR (card_id IS NULL AND merchant_name IS NULL AND merchant_country IS NULL AND merchant_scope IS NULL AND transfer_scope IS NOT NULL AND counterparty_kind = CASE txn_type WHEN 'own_transfer' THEN 'self' ELSE 'third_party' END)`,
      ),
    ),
    // merchant_scope follows from the same row (C6 re-derives the rest at publish time).
    check(
      'transaction_events_merchant_scope_rule_ck',
      sql.raw(`merchant_scope IS NULL OR merchant_scope = CASE WHEN merchant_country IS NULL THEN 'unknown' WHEN merchant_country = home_region THEN 'domestic' ELSE 'foreign' END`),
    ),
  ],
);

// ------------------------------------------------------------------ transaction_entries

export const transactionEntries = sqliteTable(
  'transaction_entries',
  {
    id: text('id').primaryKey(),
    userId: ownerId(),
    eventId: text('event_id').notNull(),
    txnType: text('txn_type', { enum: TXN_TYPES }).notNull(),
    direction: text('direction', { enum: ENTRY_DIRECTIONS }).notNull(),
    /** out: the account charged · in: the account credited (K2). */
    fundingAccountId: text('funding_account_id').notNull(),
    /** out: the currency actually charged · in: the currency actually received. */
    fundingCurrency: text('funding_currency').notNull(),
    /** Minor units of funding_currency; null while pending. */
    amount: integer('amount'),
    amountStatus: text('amount_status', { enum: AMOUNT_STATUSES }).notNull(),
    currencyExponent: integer('currency_exponent').notNull(),
    /** Snapshot of accounts.account_country (or carried / user-corrected, country_source). */
    fundingAccountCountry: text('funding_account_country').notNull(),
    countrySource: text('country_source', { enum: COUNTRY_SOURCES }).notNull(),
    /** Status of the account currency when the entry was saved. */
    currencyStatusAtSave: text('currency_status_at_save', { enum: CURRENCY_STATUSES_AT_SAVE }).notNull(),
    closedCurrencyAck: bool('closed_currency_ack').notNull().default(false),
    /** The previous version's entry of the same account whose snapshot this one carries. */
    carriedFromEntryId: text('carried_from_entry_id'),
    createdAt: ts('created_at'),
  },
  (t) => [
    unique('transaction_entries_id_user_uq').on(t.id, t.userId),
    // At most one out and one in per version …
    unique('transaction_entries_event_direction_uq').on(t.eventId, t.direction),
    // … never both on one account (no currency exchange within an account, D2 / K7) …
    unique('transaction_entries_event_account_uq').on(t.eventId, t.fundingAccountId),
    // … and only an own transfer has two.
    uniqueIndex('transaction_entries_single_uq').on(t.eventId).where(sql`${t.txnType} <> 'own_transfer'`),
    index('transaction_entries_user_account_idx').on(t.userId, t.fundingAccountId),
    // Child side of the self-referencing (carried_from_entry_id, user_id) key, same column order:
    // deleting an entry (only ever in a user cascade) looks up the entries that carry it.
    index('transaction_entries_carried_from_idx').on(t.carriedFromEntryId, t.userId),
    foreignKey({ columns: [t.eventId, t.txnType, t.userId], foreignColumns: [transactionEvents.id, transactionEvents.txnType, transactionEvents.userId] }).onDelete('cascade'),
    foreignKey({ columns: [t.fundingAccountId, t.userId], foreignColumns: [accounts.id, accounts.userId] }).onDelete('no action'),
    foreignKey({
      columns: [t.fundingAccountId, t.userId, t.fundingCurrency],
      foreignColumns: [accountCurrencies.accountId, accountCurrencies.userId, accountCurrencies.currency],
    }).onDelete('no action'),
    foreignKey({ columns: [t.carriedFromEntryId, t.userId], foreignColumns: [t.id, t.userId] }).onDelete('no action'),
    check('transaction_entries_type_ck', inList('txn_type', TXN_TYPES)),
    check('transaction_entries_direction_ck', inList('direction', ENTRY_DIRECTIONS)),
    check('transaction_entries_amount_ck', amountCheck('amount')),
    check('transaction_entries_amount_status_ck', inList('amount_status', AMOUNT_STATUSES)),
    check('transaction_entries_pending_ck', sql.raw(`(amount IS NULL) = (amount_status = 'pending')`)),
    check('transaction_entries_exponent_ck', sql.raw(`${isInt('currency_exponent')} AND currency_exponent BETWEEN 0 AND 4`)),
    check('transaction_entries_country_ck', alpha2('funding_account_country')),
    check('transaction_entries_country_source_ck', inList('country_source', COUNTRY_SOURCES)),
    check('transaction_entries_carried_ck', sql.raw(`(carried_from_entry_id IS NULL) = (country_source = 'account_at_save')`)),
    check('transaction_entries_currency_status_ck', inList('currency_status_at_save', CURRENCY_STATUSES_AT_SAVE)),
    check('transaction_entries_ack_ck', isBool('closed_currency_ack')),
    check('transaction_entries_ack_closed_ck', sql.raw(`closed_currency_ack = 0 OR currency_status_at_save = 'closed'`)),
    check('transaction_entries_spend_direction_ck', sql.raw(`txn_type <> 'merchant_spend' OR direction = 'out'`)),
    check('transaction_entries_refund_direction_ck', sql.raw(`txn_type <> 'merchant_refund' OR direction = 'in'`)),
  ],
);

// ------------------------------------------------------------------ ledger_idempotency_keys

/** The complete, immutable result of one financial write (§10.5). Create keys are kept; correct / void keys expire after 30 days. */
export const ledgerIdempotencyKeys = sqliteTable(
  'ledger_idempotency_keys',
  {
    userId: ownerId(),
    key: text('key').notNull(),
    operation: text('operation', { enum: IDEMPOTENT_OPERATIONS }).notNull(),
    /** SHA-256 lower-case hex of the canonical request (hash_version). */
    requestHash: text('request_hash').notNull(),
    hashVersion: integer('hash_version').notNull(),
    opId: text('op_id').notNull(),
    transactionId: text('transaction_id').notNull(),
    resultRevision: integer('result_revision').notNull(),
    resultEventId: text('result_event_id').notNull(),
    /** No foreign key: audit_log has no (id, user_id) key and outlives deleted users (§6.1). */
    auditId: text('audit_id').notNull(),
    responseStatus: integer('response_status').notNull(),
    createdAt: ts('created_at'),
    expiresAt: integer('expires_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.key] }),
    index('ledger_idempotency_keys_user_expires_idx').on(t.userId, t.expiresAt),
    foreignKey({ columns: [t.transactionId, t.userId], foreignColumns: [transactions.id, transactions.userId] }).onDelete('cascade'),
    foreignKey({ columns: [t.resultEventId, t.userId], foreignColumns: [transactionEvents.id, transactionEvents.userId] }).onDelete('cascade'),
    check('ledger_idempotency_keys_key_ck', sql.raw(`length(key) BETWEEN 16 AND 64 AND key NOT GLOB '*[^0-9A-Za-z_-]*'`)),
    check('ledger_idempotency_keys_operation_ck', inList('operation', IDEMPOTENT_OPERATIONS)),
    check('ledger_idempotency_keys_hash_ck', sql.raw(`length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'`)),
    check('ledger_idempotency_keys_hash_version_ck', sql.raw(`${isInt('hash_version')} AND hash_version >= 1`)),
    check('ledger_idempotency_keys_result_revision_ck', sql.raw(`${isInt('result_revision')} AND result_revision >= 1`)),
    check('ledger_idempotency_keys_response_status_ck', sql.raw(`response_status IN (200, 201)`)),
    check('ledger_idempotency_keys_retention_ck', sql.raw(`(operation = 'transaction.create') = (expires_at IS NULL)`)),
    check('ledger_idempotency_keys_expires_ck', sql.raw(`expires_at IS NULL OR expires_at > created_at`)),
  ],
);
