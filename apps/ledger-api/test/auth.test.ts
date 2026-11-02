import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTECTED_MOUNTS } from '../src/app.ts';
import { CSRF_HEADER } from '../src/auth/middleware.ts';
import { currentTotp } from '../src/auth/totp.ts';
import { auditLog, users } from '../src/db/schema.ts';
import { IDENTITY_VALUE } from '../src/db/identity.ts';
import { client, login, makeUser, ORIGIN, PASSWORD, setup, SETUP_TOKEN, type TestEnv } from './helpers.ts';

let t: TestEnv;
beforeEach(async () => {
  t = await setup();
});
afterEach(() => t.cleanup());

const PUBLIC = [/^\/api\/health$/, /^\/api\/auth\/(me|login|logout|passkey\/options|passkey\/verify)$/, /^\/api\/setup\/:token/];

describe('route protection', () => {
  it('every non-public API route answers 401 to anonymous requests', async () => {
    const c = client(t);
    const routes = t.app.routes.filter((r) => r.path.startsWith('/api/') && r.method !== 'ALL' && !PUBLIC.some((p) => p.test(r.path)));
    expect(routes.length).toBeGreaterThan(15);
    for (const r of routes) {
      const path = r.path.replace(/:[a-z]+(\{[^}]*\})?/gi, 'x'.repeat(26));
      const res = await c.req(r.method, path, r.method === 'GET' ? undefined : {});
      expect.soft(res.status, `${r.method} ${r.path}`).toBe(401);
    }
    for (const mount of Object.keys(PROTECTED_MOUNTS)) expect(routes.some((r) => r.path.startsWith(`/api${mount}`))).toBe(true);
  });

  it('uses the x-xui-csrf header and an allowed Origin; the legacy header is not enough', async () => {
    expect(CSRF_HEADER).toBe('x-xui-csrf');
    const c = client(t);
    expect((await c.req('POST', '/api/auth/login', {}, { origin: 'https://evil.example' })).json.code).toBe('BAD_ORIGIN');
    // The legacy dev origin is not allowed either.
    expect((await c.req('POST', '/api/auth/login', {}, { origin: 'http://localhost:5173' })).json.code).toBe('BAD_ORIGIN');
    const noOrigin = await t.app.request('/api/auth/login', { method: 'POST', headers: { [CSRF_HEADER]: '1' }, body: '{}' });
    expect(noOrigin.status).toBe(403);
    const legacyHeader = await t.app.request('/api/auth/login', { method: 'POST', headers: { origin: ORIGIN, 'x-zui-csrf': '1' }, body: '{}' });
    expect(legacyHeader.status).toBe(403);
    expect(((await legacyHeader.json()) as { code: string }).code).toBe('CSRF');
  });

  it('rejects oversized bodies and sends security headers', async () => {
    const big = JSON.stringify({ username: 'x'.repeat(2 * 1024 * 1024), password: 'x', totp: '123456' });
    const r = await t.app.request('/api/auth/login', {
      method: 'POST',
      headers: { origin: ORIGIN, [CSRF_HEADER]: '1', 'content-type': 'application/json', 'content-length': String(big.length) },
      body: big,
    });
    expect(r.status).toBe(413);
    const h = await client(t).get('/api/health');
    expect(h.json).toEqual({ ok: true, product: 'x-ui', edition: 'v1' });
    expect(h.res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(h.res.headers.get('x-frame-options')).toBe('DENY');
    expect(h.res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('session cookie', () => {
  it('is xui_session, HttpOnly and SameSite=Strict — never zui_session', async () => {
    const u = await makeUser(t, 'alice');
    t.advance(30_000);
    const c = client(t);
    const r = await c.post('/api/auth/login', { username: 'alice', password: PASSWORD, totp: u.code() });
    expect(r.status).toBe(200);
    const cookies = r.res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^xui_session=/);
    expect(cookies[0]).toMatch(/HttpOnly/);
    expect(cookies[0]).toMatch(/SameSite=Strict/);
    expect(cookies[0]).toMatch(/Path=\//);
    expect([...c.jar.keys()]).toEqual(['xui_session']);
    expect((await c.get('/api/auth/me')).json.user.username).toBe('alice');

    // localhost cookies ignore ports, so a browser sends both apps' cookies to both servers.
    // The same token under the legacy name is ignored by v1.
    const token = c.jar.get('xui_session')!;
    const legacyNamed = await c.req('GET', '/api/auth/me', undefined, { cookie: `zui_session=${token}` });
    expect(legacyNamed.status).toBe(401);

    await c.post('/api/auth/logout');
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('uses the __Host- prefix and Secure over HTTPS', async () => {
    const s = await setup({ COOKIE_SECURE: true });
    try {
      const u = await makeUser(s, 'bob');
      s.advance(30_000);
      const r = await client(s).post('/api/auth/login', { username: 'bob', password: PASSWORD, totp: u.code() });
      expect(r.res.headers.getSetCookie()[0]).toMatch(/^__Host-xui_session=.*Secure/);
    } finally {
      await s.cleanup();
    }
  });
});

describe('password + TOTP login', () => {
  it('rejects wrong password, wrong code and replays with the same message, and locks after 5 failures', async () => {
    const u = await makeUser(t, 'alice');
    t.advance(30_000);
    const c = client(t);
    const code = u.code();
    expect((await c.post('/api/auth/login', { username: 'alice', password: 'wrong password', totp: code })).json.code).toBe('BAD_CREDENTIALS');
    expect((await c.post('/api/auth/login', { username: 'alice', password: PASSWORD, totp: '000000' })).json.code).toBe('BAD_CREDENTIALS');
    expect((await c.post('/api/auth/login', { username: 'alice', password: PASSWORD, totp: code })).status).toBe(200);
    expect((await client(t).post('/api/auth/login', { username: 'alice', password: PASSWORD, totp: code })).json.code).toBe('BAD_CREDENTIALS');
    // The success above cleared the counter: the replay plus 4 more failures make 5.
    for (let i = 0; i < 4; i++) await c.post('/api/auth/login', { username: 'alice', password: 'nope', totp: '123456' });
    expect((await c.post('/api/auth/login', { username: 'alice', password: PASSWORD, totp: u.code() })).json.code).toBe('LOCKED');
    const audit = await t.db.select().from(auditLog).where(eq(auditLog.action, 'login.locked'));
    expect(audit.length).toBeGreaterThan(0);
  });

  it('accepts each recovery code once', async () => {
    const u = await makeUser(t, 'alice');
    const c = client(t);
    expect((await c.post('/api/auth/login', { username: 'alice', password: PASSWORD, recoveryCode: u.recovery[0] })).status).toBe(200);
    expect((await client(t).post('/api/auth/login', { username: 'alice', password: PASSWORD, recoveryCode: u.recovery[0] })).status).toBe(401);
  });
});

describe('first-run setup link', () => {
  it('creates the only account with an X-UI TOTP entry, then stops working', async () => {
    const c = client(t);
    expect((await c.get(`/api/setup/${SETUP_TOKEN}`)).json).toEqual({ valid: true });
    const begin = await c.post(`/api/setup/${SETUP_TOKEN}/begin`, { username: 'owner', displayName: 'Owner', password: PASSWORD });
    expect(begin.status).toBe(200);
    expect(begin.json.uri).toMatch(/^otpauth:\/\/totp\/X-UI:owner\?/);
    expect(begin.json.uri).toContain('issuer=X-UI');
    t.advance(30_000);
    const done = await c.post(`/api/setup/${SETUP_TOKEN}/confirm`, { code: currentTotp(begin.json.secret, t.clock.t) });
    expect(done.status).toBe(200);
    expect(done.json.recoveryCodes).toHaveLength(10);
    expect(done.json.me.user.role).toBe('admin');
    expect((await c.get('/api/auth/me')).json.user.username).toBe('owner');
    expect((await client(t).get(`/api/setup/${SETUP_TOKEN}`)).json).toEqual({ valid: false });
    expect((await client(t).post(`/api/setup/${SETUP_TOKEN}/begin`, { username: 'mallory', displayName: 'M', password: PASSWORD })).status).toBe(410);
    expect(await t.db.select().from(users)).toHaveLength(1);
  });

  it('is disabled without XUI_V1_SETUP_TOKEN', async () => {
    const s = await setup({ SETUP_TOKEN: undefined });
    try {
      expect((await client(s).get(`/api/setup/${SETUP_TOKEN}`)).json).toEqual({ valid: false });
    } finally {
      await s.cleanup();
    }
  });
});

describe('step-up and passkeys', () => {
  it('requires a recent TOTP/passkey check for sensitive actions', async () => {
    const u = await makeUser(t, 'alice');
    const c = await login(t, u);
    t.advance(6 * 60_000);
    expect((await c.post('/api/auth/recovery-codes')).json.code).toBe('STEP_UP_REQUIRED');
    t.advance(30_000);
    expect((await c.post('/api/auth/step-up/totp', { code: u.code() })).status).toBe(200);
    expect((await c.post('/api/auth/recovery-codes')).json.codes).toHaveLength(10);
  });

  it('registers passkeys for RP "localhost" named X-UI, and does not know credentials from other databases', async () => {
    const u = await makeUser(t, 'alice');
    const c = await login(t, u);
    const reg = await c.post('/api/auth/passkeys/options');
    expect(reg.json.options.rp).toEqual({ name: 'X-UI', id: 'localhost' });

    const opts = await client(t).post('/api/auth/passkey/options');
    expect(opts.json.options.rpId).toBe('localhost');
    // A credential the legacy app registered for rpId "localhost" is offered by the browser too,
    // but it does not exist in the v1 database.
    const r = await client(t).post('/api/auth/passkey/verify', {
      challengeId: opts.json.challengeId,
      response: { id: 'legacy-credential-id', rawId: 'legacy-credential-id', type: 'public-key', response: {} },
    });
    expect(r.status).toBe(401);
    expect(r.json.code).toBe('WEBAUTHN');
  });
});

describe('system info', () => {
  it('reports the v1 database identity to signed-in users', async () => {
    expect((await client(t).get('/api/system/info')).status).toBe(401);
    const c = await login(t, await makeUser(t, 'alice'));
    const r = await c.get('/api/system/info');
    expect(r.json).toMatchObject({ product: 'x-ui', edition: 'v1', database: { identity: IDENTITY_VALUE } });
  });
});
