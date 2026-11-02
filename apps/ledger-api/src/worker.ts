import { drizzle } from 'drizzle-orm/d1';
import { createApp } from './app.ts';
import type { DB } from './db/client.ts';
import { IDENTITY_KEY, IDENTITY_VALUE, LEGACY_MIGRATIONS_TABLE, META_TABLE } from './db/identity.ts';
import * as schema from './db/schema.ts';
import { readEnv } from './env.ts';

/**
 * Cloudflare Workers entry for X-UI v1 (reserved: see wrangler.v1.jsonc.example — not deployed
 * in M1). Static files are served by Workers Static Assets; only /api/* reaches this code.
 * D1 migrations are applied by wrangler (migrations_table "__xui_v1_migrations"); migration 0000
 * writes the identity marker, and the Worker refuses to serve a database without it.
 */

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

type D1 = Parameters<typeof drizzle>[0];

export interface Env {
  DB: D1;
  /** Cloudflare rate limiting binding (optional): cheap per-IP throttle for login endpoints. */
  AUTH_LIMITER?: RateLimiter;
  [key: string]: unknown;
}

let instance: Promise<ReturnType<typeof createApp>> | null = null;

async function assertIdentity(d1: D1) {
  const tables = await d1.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  const names = new Set(tables.results.map((r: { name: string }) => r.name));
  const marker = names.has(META_TABLE)
    ? await d1.prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`).bind(IDENTITY_KEY).first<string>('value')
    : null;
  if (marker !== IDENTITY_VALUE || names.has(LEGACY_MIGRATIONS_TABLE)) {
    throw new Error('[x-ui v1] the bound D1 database is not an X-UI v1 database; refusing to serve');
  }
}

async function boot(env: Env) {
  await assertIdentity(env.DB);
  // drizzle's D1 driver exposes the same query API as the libsql one used locally.
  const db = drizzle(env.DB, { schema }) as unknown as DB;
  const limiter = env.AUTH_LIMITER;
  return createApp(
    {
      db,
      env: readEnv({ XUI_V1_PASSWORD_ITERATIONS: '50000', XUI_V1_COOKIE_SECURE: 'true', XUI_V1_TRUST_PROXY: 'true', ...(env as Record<string, string | undefined>) }),
      now: Date.now,
      limiter: limiter ? async (key) => (await limiter.limit({ key })).success : undefined,
    },
    { clientIp: (c) => c.req.header('cf-connecting-ip') ?? null },
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: unknown): Promise<Response> {
    instance ??= boot(env).catch((e) => {
      instance = null;
      throw e;
    });
    const app = await instance;
    return app.fetch(request, env, ctx as never);
  },
};
