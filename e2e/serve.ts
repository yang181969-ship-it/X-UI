/**
 * Starts the production build against a throwaway database (data/e2e/) so end-to-end runs never
 * touch real data.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createUser } from '../apps/api/src/auth/users.ts';
import { DEFAULT_CONFIG } from '../apps/api/src/config/defaults.ts';
import { DbConfigStore } from '../apps/api/src/config/store.ts';
import { openLibsql } from '../apps/api/src/db/client.ts';
import { users } from '../apps/api/src/db/schema.ts';
import { readEnv } from '../apps/api/src/env.ts';
import { main, REPO_ROOT } from '../apps/api/src/node.ts';
import { ADMIN, ADMIN_TOTP_SECRET, BASE_URL, E2E_PORT } from './fixtures.ts';

const dir = resolve(REPO_ROOT, 'data/e2e');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

Object.assign(process.env, {
  NODE_ENV: 'production',
  PORT: String(E2E_PORT),
  HOST: '127.0.0.1',
  DATABASE_URL: `file:${resolve(dir, 'e2e.db')}`,
  ORIGINS: BASE_URL,
  RP_ID: 'localhost',
  APP_ENC_KEY: 'q7Lw1n0b2v3c4x5z6a7s8d9f0g1h2j3k4l5m6n7o8p0=',
  SESSION_PEPPER: 'e2e-pepper',
  COOKIE_SECURE: 'false',
});

const db = await openLibsql(process.env.DATABASE_URL!);
const env = readEnv(process.env);
const config = new DbConfigStore(db, DEFAULT_CONFIG);
await config.load();
const admin = await createUser({ db, env, config, now: Date.now }, { ...ADMIN, role: 'admin', status: 'pending', totpSecret: ADMIN_TOTP_SECRET });
await db.update(users).set({ status: 'active', totpEnabled: true }).where(eq(users.id, admin.id));

await main();
