import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { count, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Legacy app, imported read-only to prove the two apps don't accept each other's credentials.
import { CSRF_HEADER as LEGACY_CSRF_HEADER } from '../../api/src/auth/middleware.ts';
import * as legacySchema from '../../api/src/db/schema.ts';
import * as legacy from '../../api/test/helpers.ts';
import { CSRF_HEADER as WEB_CSRF_HEADER } from '../../ledger-web/src/api/client.ts';
import { API_PORT, WEB_PORT } from '../../ledger-web/vite.config.ts';
import { CSRF_HEADER } from '../src/auth/middleware.ts';
import { SESSION_COOKIE } from '../src/auth/session.ts';
import { TOTP_ISSUER } from '../src/auth/totp.ts';
import { users } from '../src/db/schema.ts';
import { DEFAULT_PORT, REPO_ROOT } from '../src/node.ts';
import * as v1 from './helpers.ts';

const API_ROOT = resolve(REPO_ROOT, 'apps/ledger-api');
const WEB_ROOT = resolve(REPO_ROOT, 'apps/ledger-web');

describe('names, ports and headers differ from the legacy app', () => {
  it('uses its own cookie, CSRF header, TOTP issuer and ports', () => {
    expect(SESSION_COOKIE).toBe('xui_session');
    expect(CSRF_HEADER).toBe('x-xui-csrf');
    expect(LEGACY_CSRF_HEADER).toBe('x-zui-csrf');
    expect(WEB_CSRF_HEADER).toBe(CSRF_HEADER);
    expect(TOTP_ISSUER).toBe('X-UI');
    expect([WEB_PORT, API_PORT, DEFAULT_PORT]).toEqual([5174, 8788, 8788]);
  });
});

describe('legacy and v1 side by side (one browser, localhost cookies shared across ports)', () => {
  let old: Awaited<ReturnType<typeof legacy.setup>>;
  let neu: v1.TestEnv;
  beforeEach(async () => {
    old = await legacy.setup();
    neu = await v1.setup();
  });
  afterEach(async () => {
    await old.cleanup();
    await neu.cleanup();
  });

  it("each app only accepts its own session cookie and CSRF header, and v1 writes stay in the v1 database", async () => {
    const legacyCount = async () => {
      const [u] = await old.db.select({ n: count() }).from(legacySchema.users);
      const [s] = await old.db.select({ n: count() }).from(legacySchema.sessions);
      const [a] = await old.db.select({ n: count() }).from(legacySchema.auditLog);
      return { users: u!.n, sessions: s!.n, audit: a!.n };
    };

    const oldUser = await legacy.makeUser(old, 'family', 'admin');
    const oldClient = await legacy.login(old, oldUser);
    const before = await legacyCount();

    // v1 activity: first-run setup, login, step-up, logout.
    const setupClient = v1.client(neu);
    const begin = await setupClient.post(`/api/setup/${v1.SETUP_TOKEN}/begin`, { username: 'owner', displayName: 'Owner', password: v1.PASSWORD });
    expect(begin.status).toBe(200);
    const newUser = await v1.makeUser(neu, 'second');
    const newClient = await v1.login(neu, newUser);

    // The browser holds both cookies and sends both to either port.
    const both = `${[...oldClient.jar].map(([k, val]) => `${k}=${val}`).join('; ')}; ${[...newClient.jar].map(([k, val]) => `${k}=${val}`).join('; ')}`;
    expect(both).toMatch(/zui_session=.*xui_session=/);
    const newMe = await neu.app.request('/api/auth/me', { headers: { cookie: both } });
    expect(((await newMe.json()) as { user: { username: string } }).user.username).toBe('second');
    const oldMe = await old.app.request('/api/auth/me', { headers: { cookie: both } });
    expect(((await oldMe.json()) as { user: { username: string } }).user.username).toBe('family');

    // Only the other app's cookie: refused.
    const onlyNew = `xui_session=${newClient.jar.get('xui_session')}`;
    expect((await old.app.request('/api/auth/me', { headers: { cookie: onlyNew } })).status).toBe(401);
    const onlyOld = `zui_session=${oldClient.jar.get('zui_session')}`;
    expect((await neu.app.request('/api/auth/me', { headers: { cookie: onlyOld } })).status).toBe(401);

    // CSRF headers are not interchangeable.
    const oldWithNewHeader = await old.app.request('/api/auth/logout', { method: 'POST', headers: { origin: legacy.ORIGIN, [CSRF_HEADER]: '1', cookie: both } });
    expect(oldWithNewHeader.status).toBe(403);
    const newWithOldHeader = await neu.app.request('/api/auth/logout', { method: 'POST', headers: { origin: v1.ORIGIN, [LEGACY_CSRF_HEADER]: '1', cookie: both } });
    expect(newWithOldHeader.status).toBe(403);

    // v1 logout clears only its own cookie; the legacy session stays valid.
    const logout = await neu.app.request('/api/auth/logout', { method: 'POST', headers: { origin: v1.ORIGIN, [CSRF_HEADER]: '1', cookie: both } });
    expect(logout.headers.getSetCookie().map((c) => c.split('=')[0])).toEqual(['xui_session']);
    expect((await old.app.request('/api/auth/me', { headers: { cookie: both } })).status).toBe(200);

    // Nothing v1 did reached the legacy database.
    expect(await legacyCount()).toEqual(before);
    for (const name of ['owner', 'second']) {
      expect(await old.db.select().from(legacySchema.users).where(eq(legacySchema.users.username, name))).toHaveLength(0);
    }
    expect((await neu.db.select().from(users)).map((u) => u.username).sort()).toEqual(['owner', 'second']);
  });
});

// ------------------------------------------------------------------ source scans

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (['.ts', '.tsx'].includes(extname(p))) out.push(p);
    }
  };
  walk(root);
  return out;
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SOURCES = [...sourceFiles(join(API_ROOT, 'src')), ...sourceFiles(join(WEB_ROOT, 'src')), join(WEB_ROOT, 'vite.config.ts')];

describe('source isolation', () => {
  it('imports nothing from the legacy apps (only the shared package)', () => {
    for (const file of SOURCES) {
      const appRoot = file.startsWith(API_ROOT) ? API_ROOT : WEB_ROOT;
      for (const m of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1]!;
        expect(spec, `${relative(REPO_ROOT, file)}: ${spec}`).not.toMatch(/^@z-ui\/(api|web)\b/);
        if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec);
          expect(relative(appRoot, target).startsWith('..'), `${relative(REPO_ROOT, file)} imports ${spec}`).toBe(false);
        }
      }
    }
  });

  it('uses no legacy cookie, header, storage key or database name outside the guards', () => {
    const GUARDS = [join(API_ROOT, 'src/db/identity.ts'), join(API_ROOT, 'src/node.ts')];
    for (const file of SOURCES) {
      const code = stripComments(readFileSync(file, 'utf8'));
      const where = relative(REPO_ROOT, file);
      expect(code, where).not.toMatch(/zui_session|x-zui-csrf|['"`]zui-/);
      // The guards name the legacy database in order to refuse it.
      if (!GUARDS.includes(file)) expect(code, where).not.toMatch(/z-ui\.db|Z-UI/);
    }
  });

  it('prefixes every web localStorage key with xui-v1-', () => {
    let keys = 0;
    for (const file of sourceFiles(join(WEB_ROOT, 'src'))) {
      const code = readFileSync(file, 'utf8');
      if (!/localStorage\./.test(code)) continue;
      // Keys are named constants (…KEY = '…'); calls must use them, not inline strings.
      for (const m of code.matchAll(/const\s+\w*KEY\s*=\s*'([^']+)'/g)) {
        keys++;
        expect(m[1], relative(REPO_ROOT, file)).toMatch(/^xui-v1-/);
      }
      for (const m of code.matchAll(/localStorage\.\w+\(\s*(['"`])/g)) expect.fail(`${relative(REPO_ROOT, file)}: inline storage key ${m[0]}`);
    }
    expect(keys).toBeGreaterThanOrEqual(3); // theme, language, sidebar pin
  });
});
