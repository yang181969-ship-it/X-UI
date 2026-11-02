import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, unique, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  ACCOUNT_CURRENCY_STATUSES,
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  CARD_FORMS,
  CARD_LINK_ROLES,
  CARD_LINK_STATUSES,
  CARD_NETWORKS,
  CARD_STATUSES,
  CARD_TYPES,
  CHANNEL_SOURCE_STATUSES,
  CHANNEL_STATUSES,
  CHANNEL_TYPES,
  DEFAULT_HOME_REGION,
  DEPOSIT_KINDS,
  INSTITUTION_STATUSES,
  INSTITUTION_TYPES,
} from '@xui/ledger-shared';

/**
 * X-UI Product v1 schema (its own database: data/x-ui-v1.db locally, D1 "x-ui-v1" on Cloudflare).
 * - Ids are text (time-sortable random ids, see lib/id.ts).
 * - Timestamps are epoch milliseconds; business dates YYYY-MM-DD; booleans integer 0/1.
 * M1: authentication, settings and the database identity marker. The auth tables keep the
 * column layout of the legacy app (apps/api).
 * M2: institutions, accounts, account currencies, cards, card ↔ account links, payment channels
 * and their funding sources (docs/product-v1/DATA_MODEL.md §3–§4).
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
