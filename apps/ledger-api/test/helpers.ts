import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@libsql/client';
import { eq } from 'drizzle-orm';
import type { Role } from '@z-ui/shared';
import { createApp } from '../src/app.ts';
import { CSRF_HEADER } from '../src/auth/middleware.ts';
import { currentTotp, generateTotpSecret } from '../src/auth/totp.ts';
import { createUser, regenerateRecoveryCodes } from '../src/auth/users.ts';
import { openV1Db } from '../src/db/client.ts';
import { users } from '../src/db/schema.ts';
import type { AppEnv, Deps } from '../src/env.ts';
import { randomBytes } from '../src/lib/crypto.ts';
import { bytesToBase64Url } from '../src/lib/encoding.ts';

export const ORIGIN = 'http://localhost:5174';
export const SETUP_TOKEN = 'test-setup-token-0123456789';

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Attempts at deleting a database directory that Windows still reports as in use. */
const RM_ATTEMPTS = 5;

/**
 * Close every connection, then delete the directory holding their database files.
 * Windows can't delete a file that is still open, and libsql only releases the file once the
 * prepared statements of a closed connection are garbage-collected — hence the forced GC
 * (vitest.config.ts runs the workers with --expose-gc) and a few short retries.
 */
export async function removeDbDir(dir: string, clients: Client[] = []) {
  const errors: unknown[] = [];
  for (const c of new Set(clients)) {
    try {
      c.close();
    } catch (e) {
      errors.push(e);
    }
  }
  for (let attempt = 1; ; attempt++) {
    for (let i = 0; i < 2; i++) {
      globalThis.gc?.();
      await new Promise((r) => setImmediate(r)); // let native finalizers run
    }
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch (e) {
      const busy = ['EBUSY', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '');
      if (busy && attempt < RM_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 20 * attempt));
        continue;
      }
      errors.push(e);
      break;
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, `cleaning up ${dir} failed`);
}

/**
 * Run `body` with a fresh temporary directory, then close every client it registered with
 * `track` and delete the directory — whether `body` succeeded or not.
 */
export async function withDbDir<T>(prefix: string, body: (dir: string, track: <C extends Client>(c: C) => C) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const clients: Client[] = [];
  let result: T;
  try {
    result = await body(dir, (c) => (clients.push(c), c));
  } catch (err) {
    try {
      await removeDbDir(dir, clients);
    } catch (cleanupErr) {
      throw new AggregateError([err, cleanupErr], `${errorMessage(err)} (cleanup failed too: ${errorMessage(cleanupErr)})`, { cause: err });
    }
    throw err;
  }
  await removeDbDir(dir, clients);
  return result;
}

/** sha256 of every file in a directory (name → hash), to prove a database was not touched. */
export function dirFingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) out[name] = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
  return out;
}

export function testEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    APP_ENC_KEY: bytesToBase64Url(randomBytes(32)),
    SESSION_PEPPER: 'test-pepper',
    RP_ID: 'localhost',
    RP_NAME: 'X-UI',
    ORIGINS: [ORIGIN],
    COOKIE_SECURE: false,
    TRUST_PROXY: false,
    SETUP_TOKEN,
    PASSWORD_ITERATIONS: 10_000,
    ...overrides,
  };
}

/** A v1 app on a fresh temporary database. */
export async function setup(overrides: Partial<AppEnv> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'xui-v1-test-'));
  let opened;
  try {
    opened = await openV1Db(`file:${join(dir, 'x-ui-v1.db')}`, { legacyPaths: [] });
  } catch (err) {
    await removeDbDir(dir);
    throw err;
  }
  const { db, client } = opened;
  // A controllable clock starting at 2026-10-15 10:00 local time.
  const clock = { t: new Date(2026, 9, 15, 10, 0, 0).getTime() };
  const deps: Deps = { db, env: testEnv(overrides), now: () => clock.t };
  let ip = '10.0.0.1';
  const app = createApp(deps, { clientIp: () => ip });
  return {
    app,
    deps,
    db,
    client,
    dir,
    clock,
    setIp: (v: string) => (ip = v),
    advance: (ms: number) => (clock.t += ms),
    cleanup: () => removeDbDir(dir, [client]),
  };
}

export type TestEnv = Awaited<ReturnType<typeof setup>>;

/** Fetch wrapper with a cookie jar and the headers a real v1 browser page would send. */
export function client(t: Pick<TestEnv, 'app'>) {
  const jar = new Map<string, string>();
  async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { origin: ORIGIN, [CSRF_HEADER]: '1', ...headers };
    if (jar.size && !('cookie' in headers)) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await t.app.request(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
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
    patch: (p: string, b: unknown) => req('PATCH', p, b),
    del: (p: string) => req('DELETE', p),
  };
}

export const PASSWORD = 'correct horse battery';

/** Create an active user with a known TOTP secret. */
export async function makeUser(t: TestEnv, username: string, role: Role = 'admin') {
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
