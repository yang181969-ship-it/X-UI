import { createClient, type Client, type InStatement } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { D1_MAX_PARAMS } from '../lib/chunks.ts';
import * as schema from './schema.ts';

/**
 * Database handle used by all routes. Only APIs shared with drizzle's D1 driver are used
 * (no interactive transactions — multi-statement writes go through db.batch()), and statements
 * stay within D1's limit of 100 bound parameters (see lib/chunks.ts).
 */
export type DB = LibSQLDatabase<typeof schema>;

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));


function argCount(stmt: InStatement): number {
  if (typeof stmt === 'string') return 0;
  const args = stmt.args;
  if (!args) return 0;
  return Array.isArray(args) ? args.length : Object.keys(args).length;
}

/** Make a libsql client fail like D1 would on oversized statements (used by the tests). */
function withD1Limits(client: Client, onCall?: () => void): Client {
  const check = (stmt: InStatement) => {
    const n = argCount(stmt);
    if (n > D1_MAX_PARAMS) {
      const sqlText = typeof stmt === 'string' ? stmt : stmt.sql;
      throw new Error(`D1 limit: ${n} bound parameters (max ${D1_MAX_PARAMS}) in: ${sqlText.slice(0, 120)}`);
    }
  };
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'execute') return (stmt: InStatement, ...rest: unknown[]) => (check(stmt), onCall?.(), (target.execute as (...a: unknown[]) => unknown)(stmt, ...rest));
      if (prop === 'batch') return (stmts: InStatement[], ...rest: unknown[]) => (stmts.forEach(check), onCall?.(), (target.batch as (...a: unknown[]) => unknown)(stmts, ...rest));
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

export async function openLibsql(url: string, opts: { d1Limits?: boolean; onCall?: () => void } = {}): Promise<DB> {
  // One connection: per-connection PRAGMAs (foreign_keys) stay in effect, and SQLite only
  // has a single writer anyway — the same model as D1.
  const raw = createClient({ url, concurrency: 1 });
  try {
    await raw.execute('PRAGMA foreign_keys = ON');
    await raw.execute('PRAGMA journal_mode = WAL');
    await raw.execute('PRAGMA busy_timeout = 5000');
    const client = opts.d1Limits ? withD1Limits(raw, opts.onCall) : raw;
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    return db;
  } catch (err) {
    // Nobody else holds the client yet: close it so a failed start doesn't keep the file open.
    try {
      raw.close();
    } catch (closeErr) {
      throw new AggregateError([err, closeErr], `opening the database failed, then closing it failed too: ${errorMessage(err)}`, { cause: err });
    }
    throw err;
  }
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
