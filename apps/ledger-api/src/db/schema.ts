import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * X-UI Product v1 schema (its own database: data/x-ui-v1.db locally, D1 "x-ui-v1" on Cloudflare).
 * - Ids are text (time-sortable random ids, see lib/id.ts).
 * - Timestamps are epoch milliseconds.
 * M1 holds only authentication, settings and the database identity marker; ledger tables
 * arrive with M2. The auth tables keep the column layout of the legacy app (apps/api).
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
