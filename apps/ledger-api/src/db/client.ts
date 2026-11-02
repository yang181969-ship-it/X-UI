import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { appliedMigrationCount, assertV1DbPath, inspectIdentity, MIGRATIONS_TABLE, writeIdentity, type IdentityState } from './identity.ts';
import * as schema from './schema.ts';

/**
 * Database handle used by all routes. As in the legacy app, only APIs shared with drizzle's D1
 * driver are used (no interactive transactions — multi-statement writes go through db.batch()).
 */
export type DB = LibSQLDatabase<typeof schema>;

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

export interface OpenedDb {
  db: DB;
  client: Client;
  /** Identity found before this start: 'empty' means the database was initialized now. */
  identity: IdentityState;
  /** Migrations applied during this start (0 when already up to date). */
  applied: number;
}

export interface OpenOptions {
  /** Paths of legacy databases that must never be opened (see node.ts legacyDbPaths). */
  legacyPaths: string[];
  now?: () => number;
}

/**
 * Open the v1 database: path guard → read-only identity check → marker (fresh databases only)
 * → identity re-check → pending migrations → final identity check. Nothing is written before the
 * database is known to be empty or X-UI v1.
 */
export async function openV1Db(url: string, opts: OpenOptions): Promise<OpenedDb> {
  assertV1DbPath(url, opts.legacyPaths);
  // One connection: per-connection PRAGMAs (foreign_keys) stay in effect, and SQLite only
  // has a single writer anyway — the same model as D1.
  const client = createClient({ url, concurrency: 1 });
  try {
    const identity = await inspectIdentity(client);
    await client.execute('PRAGMA foreign_keys = ON');
    await client.execute('PRAGMA journal_mode = WAL');
    await client.execute('PRAGMA busy_timeout = 5000');
    if (identity === 'empty') await writeIdentity(client, (opts.now ?? Date.now)());
    if ((await inspectIdentity(client)) !== 'v1') throw new Error('[x-ui v1] identity marker missing after initialization');

    const before = await appliedMigrationCount(client);
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR, migrationsTable: MIGRATIONS_TABLE });
    await inspectIdentity(client);
    const applied = (await appliedMigrationCount(client)) - before;
    return { db, client, identity, applied };
  } catch (err) {
    // Nobody else holds the client yet: close it so a failed start doesn't keep the file open.
    try {
      client.close();
    } catch (closeErr) {
      throw new AggregateError([err, closeErr], `opening the database failed, then closing it failed too: ${errorMessage(err)}`, { cause: err });
    }
    throw err;
  }
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
