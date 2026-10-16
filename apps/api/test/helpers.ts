import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { appConfigSchema, type AppConfig, type Role } from '@z-ui/shared';
import { createApp } from '../src/app.ts';
import { currentTotp, generateTotpSecret } from '../src/auth/totp.ts';
import { createUser, regenerateRecoveryCodes } from '../src/auth/users.ts';
import { MemoryConfigStore } from '../src/config/store.ts';
import { openLibsql } from '../src/db/client.ts';
import { users } from '../src/db/schema.ts';
import type { AppEnv, Deps } from '../src/env.ts';
import { randomBytes } from '../src/lib/crypto.ts';
import { MAX_SUBREQUESTS } from '../src/lib/chunks.ts';
import { bytesToBase64Url } from '../src/lib/encoding.ts';

export const ORIGIN = 'http://localhost:5173';
export const SETUP_TOKEN = 'test-setup-token-0123456789';

export function repoConfig(): AppConfig {
  return appConfigSchema.parse(JSON.parse(readFileSync(new URL('../../../config/app.config.json', import.meta.url), 'utf8')));
}

export async function setup(config: AppConfig = repoConfig()) {
  const dir = mkdtempSync(join(tmpdir(), 'zui-test-'));
  // Subrequests (D1 calls + outgoing fetches) made by the API request currently running.
  const budget = { used: 0, peak: 0 };
  const db = await openLibsql(`file:${join(dir, 'test.db')}`, { d1Limits: true, onCall: () => budget.used++ });
  const env: AppEnv = {
    APP_ENC_KEY: bytesToBase64Url(randomBytes(32)),
    SESSION_PEPPER: 'test-pepper',
    RP_ID: 'localhost',
    RP_NAME: 'Z-UI',
    ORIGINS: [ORIGIN],
    COOKIE_SECURE: false,
    TRUST_PROXY: false,
    SETUP_TOKEN,
    PASSWORD_ITERATIONS: 10_000,
  };
  // A controllable clock starting at 2026-10-15 10:00 local time.
  const clock = { t: new Date(2026, 9, 15, 10, 0, 0).getTime() };
  const deps: Deps = { db, env, config: new MemoryConfigStore(config), now: () => clock.t };
  let ip = '10.0.0.1';
  const app = createApp(deps, { clientIp: () => ip });
  return {
    app,
    deps,
    db,
    clock,
    budget,
    setIp: (v: string) => (ip = v),
    advance: (ms: number) => (clock.t += ms),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export type TestEnv = Awaited<ReturnType<typeof setup>>;

/** Fetch wrapper with a cookie jar and the headers a real browser page would send. */
export function client(t: TestEnv) {
  const jar = new Map<string, string>();
  async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { origin: ORIGIN, 'x-zui-csrf': '1', ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) h['content-type'] = 'application/json';
    // Count outgoing fetches too, and fail like the Workers Free plan would past the limit.
    const realFetch = t.deps.fetch;
    if (realFetch) t.deps.fetch = ((...args: Parameters<typeof fetch>) => (t.budget.used++, realFetch(...args))) as typeof fetch;
    t.budget.used = 0;
    let res: Response;
    try {
      res = await t.app.request(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    } finally {
      t.deps.fetch = realFetch;
    }
    t.budget.peak = Math.max(t.budget.peak, t.budget.used);
    if (t.budget.used > MAX_SUBREQUESTS) throw new Error(`${method} ${path} made ${t.budget.used} subrequests (Workers Free allows ${MAX_SUBREQUESTS})`);
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const [name, ...rest] = pair!.split('=');
      const value = rest.join('=');
      if (!value || /max-age=0/i.test(sc)) jar.delete(name!.trim());
      else jar.set(name!.trim(), value);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, res };
  }
  return {
    jar,
    req,
    get: (p: string) => req('GET', p),
    post: (p: string, b?: unknown) => req('POST', p, b ?? {}),
    put: (p: string, b: unknown) => req('PUT', p, b),
    patch: (p: string, b: unknown) => req('PATCH', p, b),
    del: (p: string) => req('DELETE', p),
  };
}

export const PASSWORD = 'correct horse battery';

/** Create an active user with a known TOTP secret. */
export async function makeUser(t: TestEnv, username: string, role: Role = 'member') {
  const secret = generateTotpSecret();
  const user = await createUser(t.deps, { username, displayName: username, password: PASSWORD, role, status: 'pending', totpSecret: secret });
  await t.db.update(users).set({ status: 'active', totpEnabled: true }).where(eq(users.id, user.id));
  const recovery = await regenerateRecoveryCodes(t.deps, user.id);
  return { user, secret, recovery, code: () => currentTotp(secret, t.clock.t) };
}

/** Sign in with password + TOTP. Advances the clock one TOTP step so codes are never replays. */
export async function login(t: TestEnv, u: Awaited<ReturnType<typeof makeUser>>) {
  t.advance(30_000);
  const c = client(t);
  const r = await c.post('/api/auth/login', { username: u.user.username, password: PASSWORD, totp: u.code() });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.json)}`);
  return c;
}
