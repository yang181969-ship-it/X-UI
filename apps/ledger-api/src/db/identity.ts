import type { Client } from '@libsql/client';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

/**
 * Database identity for X-UI Product v1.
 *
 * The v1 app must never migrate (or even write to) the legacy Z-UI database. Two independent
 * checks run before any migration:
 *   1. assertV1DbPath — refuses the legacy file by name, path, symlink or hard link, without
 *      opening it.
 *   2. inspectIdentity — read-only look at sqlite_master:
 *        empty     → fresh database: the marker is written (one transaction), then migrations run;
 *        v1        → marker present: only pending migrations run;
 *        legacy    → the old app's tables or migration log: refused;
 *        foreign   → anything else: refused.
 * The marker is committed before the first migration, so an interrupted first start leaves
 * either an empty file (initialized again next time) or a marked one (migrations resume; each
 * drizzle migration batch is a single transaction).
 */

export const META_TABLE = 'xui_v1_meta';
export const MIGRATIONS_TABLE = '__xui_v1_migrations';
export const IDENTITY_KEY = 'db_identity';
export const IDENTITY_VALUE = 'x-ui-product-v1';

/** Same DDL as drizzle generates for schema.xuiV1Meta; migration 0000 repeats it (test: identity.test.ts). */
export const META_TABLE_DDL =
  'CREATE TABLE IF NOT EXISTS `xui_v1_meta` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` text NOT NULL,\n\t`created_at` integer NOT NULL\n);';

/** File names used by the legacy app; v1 refuses them wherever they are. */
export const LEGACY_DB_FILE_NAMES = ['z-ui.db'];

/** The legacy app's migration log (drizzle's default table name). v1 never creates it. */
export const LEGACY_MIGRATIONS_TABLE = '__drizzle_migrations';
/** Tables that identify an unmarked database as legacy Z-UI (only used for the error message). */
const LEGACY_HINT_TABLES = [LEGACY_MIGRATIONS_TABLE, 'institutions', 'account_currencies', 'transaction_tags', 'bill_occurrences', 'credit_statements', 'invites'];

export type IdentityErrorCode = 'BAD_URL' | 'LEGACY_PATH' | 'LEGACY_DB' | 'FOREIGN_DB' | 'IDENTITY_MISMATCH';

export class DbIdentityError extends Error {
  constructor(
    readonly code: IdentityErrorCode,
    message: string,
  ) {
    super(`[x-ui v1] ${message}`);
    this.name = 'DbIdentityError';
  }
}

/** Absolute file path of a `file:` URL (query string dropped), or null for other URLs. */
export function dbPathFromUrl(url: string): string | null {
  if (!url.startsWith('file:')) return null;
  const path = url.slice(5).split('?')[0]!;
  return path ? resolve(path) : null;
}

const norm = (p: string) => {
  let out = resolve(p);
  try {
    out = realpathSync.native(out);
  } catch {
    /* not there yet */
  }
  return process.platform === 'win32' ? out.toLowerCase() : out;
};

function sameFile(a: string, b: string): boolean {
  if (norm(a) === norm(b)) return true;
  if (!existsSync(a) || !existsSync(b)) return false;
  const sa = statSync(a, { bigint: true });
  const sb = statSync(b, { bigint: true });
  return sa.ino !== 0n && sa.ino === sb.ino && sa.dev === sb.dev;
}

/**
 * Refuse URLs that could reach the legacy database. Runs before any connection is opened
 * (opening a SQLite file can already create or touch it).
 */
export function assertV1DbPath(url: string, legacyPaths: string[]): string {
  const path = dbPathFromUrl(url);
  if (!path) throw new DbIdentityError('BAD_URL', `XUI_V1_DATABASE_URL must be a local file: URL (got "${url.split(':')[0]}:…"); remote databases are not used locally.`);
  if (LEGACY_DB_FILE_NAMES.includes(basename(path).toLowerCase())) {
    throw new DbIdentityError('LEGACY_PATH', `${path} is a legacy Z-UI database file name; X-UI v1 uses its own database (default data/x-ui-v1.db).`);
  }
  for (const legacy of legacyPaths) {
    if (sameFile(path, legacy)) throw new DbIdentityError('LEGACY_PATH', `${path} is the legacy Z-UI database (${legacy}); X-UI v1 refuses to open it.`);
  }
  return path;
}

export type IdentityState = 'empty' | 'v1';

async function tableNames(client: Client): Promise<string[]> {
  const r = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'");
  return r.rows.map((row) => String(row.name));
}

/** Read-only classification of an open database. Throws DbIdentityError unless it is empty or v1. */
export async function inspectIdentity(client: Client): Promise<IdentityState> {
  const tables = await tableNames(client);
  if (tables.includes(META_TABLE)) {
    const r = await client.execute({ sql: `SELECT value FROM ${META_TABLE} WHERE key = ?`, args: [IDENTITY_KEY] });
    const value = r.rows[0]?.value;
    if (value !== IDENTITY_VALUE) {
      throw new DbIdentityError('IDENTITY_MISMATCH', `database identity is ${value === undefined ? 'missing' : `"${String(value)}"`}, expected "${IDENTITY_VALUE}".`);
    }
    if (tables.includes(LEGACY_MIGRATIONS_TABLE)) {
      throw new DbIdentityError('LEGACY_DB', `database is marked as X-UI v1 but also holds the legacy Z-UI migration log (${LEGACY_MIGRATIONS_TABLE}); refusing to continue.`);
    }
    return 'v1';
  }

  const legacy = tables.filter((t) => LEGACY_HINT_TABLES.includes(t));
  if (legacy.length) {
    throw new DbIdentityError('LEGACY_DB', `this is a legacy Z-UI database (found ${legacy.join(', ')}); X-UI v1 never migrates it.`);
  }
  // Only an empty migration log (an earlier first start stopped before the marker): still fresh.
  if (tables.length === 1 && tables[0] === MIGRATIONS_TABLE) {
    const r = await client.execute(`SELECT count(*) AS n FROM ${MIGRATIONS_TABLE}`);
    if (Number(r.rows[0]?.n ?? 0) === 0) return 'empty';
  }
  if (tables.length) {
    throw new DbIdentityError('FOREIGN_DB', `database has no X-UI v1 identity marker but contains tables (${tables.slice(0, 8).join(', ')}${tables.length > 8 ? ', …' : ''}); refusing to migrate it.`);
  }
  return 'empty';
}

/** Write the marker in one transaction (idempotent). Only called on an 'empty' database. */
export async function writeIdentity(client: Client, now: number): Promise<void> {
  await client.batch(
    [META_TABLE_DDL, { sql: `INSERT OR IGNORE INTO ${META_TABLE} (key, value, created_at) VALUES (?, ?, ?)`, args: [IDENTITY_KEY, IDENTITY_VALUE, now] }],
    'write',
  );
}

/** Number of migrations recorded in the v1 migration log (0 if the log doesn't exist yet). */
export async function appliedMigrationCount(client: Client): Promise<number> {
  const tables = await tableNames(client);
  if (!tables.includes(MIGRATIONS_TABLE)) return 0;
  const r = await client.execute(`SELECT count(*) AS n FROM ${MIGRATIONS_TABLE}`);
  return Number(r.rows[0]?.n ?? 0);
}
