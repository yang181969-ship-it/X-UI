import { IDENTITY_KEY, IDENTITY_VALUE, LEGACY_MIGRATIONS_TABLE, META_TABLE } from './identity.ts';

/** The subset of the D1 binding the identity check needs. */
export interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): { first<T = unknown>(column: string): Promise<T | null> };
    all<T = unknown>(): Promise<{ results: T[] }>;
    first<T = unknown>(column: string): Promise<T | null>;
  };
}

/**
 * The Worker's identity check (worker.ts): refuse to serve a D1 database without the X-UI v1
 * marker, or one that also carries the legacy migration log. Its own module so tests can run it
 * against local D1 (test/m2-schema.test.ts) without importing the Worker entry.
 */
export async function assertD1Identity(d1: D1Like) {
  const tables = await d1.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  const names = new Set(tables.results.map((r: { name: string }) => r.name));
  const marker = names.has(META_TABLE)
    ? await d1.prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`).bind(IDENTITY_KEY).first<string>('value')
    : null;
  if (marker !== IDENTITY_VALUE || names.has(LEGACY_MIGRATIONS_TABLE)) {
    throw new Error('[x-ui v1] the bound D1 database is not an X-UI v1 database; refusing to serve');
  }
}
