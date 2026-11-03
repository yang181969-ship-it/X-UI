// The v1 app running unchanged on wrangler's local in-memory D1 (workerd via getPlatformProxy —
// persist: false, remoteBindings: false; no remote D1 is ever contacted). Shared by the API tests
// that must behave the same on D1 as on libsql.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/d1';
import { getPlatformProxy, unstable_splitSqlQuery } from 'wrangler';
import { createApp } from '../src/app.ts';
import { MIGRATIONS_DIR, type DB } from '../src/db/client.ts';
import { assertD1Identity } from '../src/db/d1-identity.ts';
import * as schema from '../src/db/schema.ts';
import type { Deps } from '../src/env.ts';
import { testEnv, type TestEnv } from './helpers.ts';

export type D1 = Parameters<typeof drizzle>[0];

export interface D1App {
  d1: D1;
  /** As much of TestEnv as a D1 app has: app, deps, db, clock, advance (no libsql client, no dir). */
  t: TestEnv;
  /** Result rows of a raw SQL query. */
  all: (sql: string, ...args: unknown[]) => Promise<Record<string, unknown>[]>;
  /** Re-try a trivial query on a stale keep-alive socket (see m2-schema.test.ts); call before each case. */
  ping: () => Promise<void>;
  dispose: () => Promise<void>;
}

/** The messages of an error and its causes. */
export const errorText = (e: unknown) => {
  const out: string[] = [];
  for (let cur: any = e, i = 0; cur && i < 6; cur = cur.cause, i++) out.push(String(cur.message ?? cur));
  return out.join(' | ');
};

/** Start workerd, apply every v1 migration and build the app as worker.ts does (test clock and environment). */
export async function startD1App(name: string): Promise<D1App> {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1 }>>> | undefined;
  try {
    const config = join(dir, 'wrangler.json');
    writeFileSync(config, JSON.stringify({ name, compatibility_date: '2026-10-01', d1_databases: [{ binding: 'DB', database_name: name, database_id: '00000000-0000-0000-0000-000000000000' }] }));
    process.env.WRANGLER_CACHE_DIR = join(dir, 'cache');
    proxy = await getPlatformProxy<{ DB: D1 }>({ configPath: config, persist: false, envFiles: [], remoteBindings: false });
    const d1 = proxy.env.DB;
    // As `wrangler d1 migrations apply`: journal order, wrangler's own SQL splitter.
    const tags = (JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] }).entries.map((e) => e.tag);
    for (const tag of tags) for (const statement of unstable_splitSqlQuery(readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8'))) await d1.prepare(statement).run();
    await assertD1Identity(d1);

    const db = drizzle(d1, { schema }) as unknown as DB;
    const clock = { t: new Date(2026, 9, 15, 10, 0, 0).getTime() };
    const deps: Deps = { db, env: testEnv(), now: () => clock.t };
    const app = createApp(deps, { clientIp: () => '10.0.0.1' });
    const t = { app, deps, db, clock, advance: (ms: number) => (clock.t += ms) } as unknown as TestEnv;
    const p = proxy;
    return {
      d1,
      t,
      all: async (sql, ...args) => ((await d1.prepare(sql).bind(...args).all()).results ?? []) as Record<string, unknown>[],
      ping: async () => {
        for (let attempt = 1; ; attempt++) {
          try {
            await d1.prepare('SELECT 1').first();
            return;
          } catch (e) {
            if (!/fetch failed|ECONNRESET|socket hang up/i.test(errorText(e)) || attempt >= 3) throw e;
          }
        }
      },
      dispose: async () => {
        await p.dispose();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await proxy?.dispose();
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
