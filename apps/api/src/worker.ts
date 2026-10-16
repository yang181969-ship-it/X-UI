import { drizzle } from 'drizzle-orm/d1';
import { createApp } from './app.ts';
import { DEFAULT_CONFIG } from './config/defaults.ts';
import { DbConfigStore } from './config/store.ts';
import type { DB } from './db/client.ts';
import * as schema from './db/schema.ts';
import { readEnv } from './env.ts';

/**
 * Cloudflare Workers entry. Static files (the SPA and the BIN lookup files) are served by
 * Workers Static Assets *without* running this code — free and not counted against the daily
 * request quota; only /api/* reaches the Worker (see wrangler.jsonc: run_worker_first).
 */

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: Parameters<typeof drizzle>[0];
  /** Cloudflare rate limiting binding (optional): cheap per-IP throttle for login endpoints. */
  AUTH_LIMITER?: RateLimiter;
  [key: string]: unknown;
}

interface Instance {
  app: ReturnType<typeof createApp>;
  config: DbConfigStore;
}

// One app per isolate; the config is re-read at most once a minute (see DbConfigStore).
let instance: Promise<Instance> | null = null;

async function boot(env: Env): Promise<Instance> {
  // drizzle's D1 driver exposes the same query API as the libsql one used locally.
  const db = drizzle(env.DB, { schema }) as unknown as DB;
  const config = new DbConfigStore(db, DEFAULT_CONFIG);
  await config.load();
  const limiter = env.AUTH_LIMITER;
  const app = createApp(
    {
      db,
      env: readEnv({ PASSWORD_ITERATIONS: '50000', COOKIE_SECURE: 'true', TRUST_PROXY: 'true', ...(env as Record<string, string | undefined>) }),
      config,
      now: Date.now,
      limiter: limiter ? async (key) => (await limiter.limit({ key })).success : undefined,
    },
    { clientIp: (c) => c.req.header('cf-connecting-ip') ?? null },
  );
  return { app, config };
}

export default {
  async fetch(request: Request, env: Env, ctx: unknown): Promise<Response> {
    instance ??= boot(env).catch((e) => {
      instance = null;
      throw e;
    });
    const { app, config } = await instance;
    await config.refreshIfStale();
    return app.fetch(request, env, ctx as never);
  },
};
