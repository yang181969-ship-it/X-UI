import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTECTED_MOUNTS } from '../src/app.ts';
import { hashIterations, hashPassword } from '../src/auth/password.ts';
import { users } from '../src/db/schema.ts';
import { client, login, makeUser, ORIGIN, PASSWORD, setup, SETUP_TOKEN, type TestEnv } from './helpers.ts';

let t: TestEnv;
beforeEach(async () => {
  t = await setup();
});
afterEach(() => t.cleanup());

const PUBLIC = [
  /^\/api\/health$/,
  /^\/api\/auth\/(me|login|logout|passkey\/options|passkey\/verify)$/,
  /^\/api\/setup\/:token/,
];

describe('route protection', () => {
  it('every non-public API route answers 401 to anonymous requests', async () => {
    const c = client(t);
    const routes = t.app.routes.filter((r) => r.path.startsWith('/api/') && r.method !== 'ALL' && !PUBLIC.some((p) => p.test(r.path)));
    expect(routes.length).toBeGreaterThan(50);
    for (const r of routes) {
      const path = r.path.replace(/:[a-z]+(\{[^}]*\})?/gi, 'x'.repeat(26));
      const res = await c.req(r.method, path, r.method === 'GET' ? undefined : {});
      expect.soft(res.status, `${r.method} ${r.path}`).toBe(401);
    }
    // Sanity: the mounts we expect are present.
    for (const mount of Object.keys(PROTECTED_MOUNTS)) {
      expect(routes.some((r) => r.path.startsWith(`/api${mount}`))).toBe(true);
    }
  });

  it('rejects state-changing requests without a matching Origin or CSRF header', async () => {
    const c = client(t);
    expect((await c.req('POST', '/api/auth/login', {}, { origin: 'https://evil.example' })).json.code).toBe('BAD_ORIGIN');
    const noOrigin = await t.app.request('/api/auth/login', { method: 'POST', headers: { 'x-zui-csrf': '1' }, body: '{}' });
    expect(noOrigin.status).toBe(403);
    const noHeader = await t.app.request('/api/auth/login', { method: 'POST', headers: { origin: ORIGIN }, body: '{}' });
    expect(noHeader.status).toBe(403);
  });

  it('rejects oversized request bodies', async () => {
    const big = JSON.stringify({ username: 'x'.repeat(2 * 1024 * 1024), password: 'x', totp: '123456' });
    const r = await t.app.request('/api/auth/login', {
      method: 'POST',
      headers: { origin: ORIGIN, 'x-zui-csrf': '1', 'content-type': 'application/json', 'content-length': String(big.length) },
      body: big,
    });
    expect(r.status).toBe(413);
  });

  it('sends security headers', async () => {
    const r = await client(t).get('/api/health');
    expect(r.res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(r.res.headers.get('x-frame-options')).toBe('DENY');
    expect(r.res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('password + TOTP login', () => {
  it('creates an HttpOnly SameSite=Strict session cookie', async () => {
    const u = await makeUser(t, 'alice');
    t.advance(30_000);
    const c = client(t);
    const r = await c.post('/api/auth/login', { username: 'alice', password: PASSWORD, totp: u.code() });
    expect(r.status).toBe(200);
    expect(r.json.user.username).toBe('alice');
    const cookie = r.res.headers.getSetCookie()[0]!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    expect((await c.get('/api/auth/me')).json.user.username).toBe('alice');
    await c.post('/api/auth/logout');
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects wrong password, wrong code and replayed codes with the same message', async () => {
    const u = await makeUser(t, 'alice');
    t.advance(30_000);
    const c = client(t);
    const wrongPw = await c.post('/api/auth/login', { username: 'alice', password: 'nope-nope-nope', totp: u.code() });
    const wrongCode = await c.post('/api/auth/login', { username: 'alice', password: PASSWORD, totp: '000000' });
    const unknown = await c.post('/api/auth/login', { username: 'mallory', password: PASSWORD, totp: '123456' });
    for (const r of [wrongPw, wrongCode, unknown]) {
      expect(r.status).toBe(401);
      expect(r.json.code).toBe('BAD_CREDENTIALS');
    }
    const code = u.code();
    expect((await c.post('/api/auth/login', { username: 'alice', password: PASSWORD, totp: code })).status).toBe(200);
    expect((await client(t).post('/api/auth/login', { username: 'alice', password: PASSWORD, totp: code })).status).toBe(401);
  });

  it('locks a username after 5 failures for 15 minutes', async () => {
    const u = await makeUser(t, 'alice');
    const c = client(t);
    for (let i = 0; i < 5; i++) await c.post('/api/auth/login', { username: 'alice', password: 'wrong-wrong-wrong', totp: '000000' });
    t.advance(30_000);
    const locked = await c.post('/api/auth/login', { username: 'alice', password: PASSWORD, totp: u.code() });
    expect(locked.status).toBe(429);
    expect(locked.json.code).toBe('LOCKED');
    // A family member on the same IP is not locked out.
    const bob = await makeUser(t, 'bob');
    await login(t, bob);
    t.advance(15 * 60_000 + 30_000);
    await login(t, u);
  });

  it('accepts each recovery code once', async () => {
    const u = await makeUser(t, 'alice');
    const code = u.recovery[0]!;
    const r = await client(t).post('/api/auth/login', { username: 'alice', password: PASSWORD, recoveryCode: code.toUpperCase() });
    expect(r.status).toBe(200);
    expect(r.json.session.method).toBe('recovery');
    expect((await client(t).post('/api/auth/login', { username: 'alice', password: PASSWORD, recoveryCode: code })).status).toBe(401);
  });

  it('re-hashes a password stored at another PBKDF2 cost on the next login', async () => {
    const u = await makeUser(t, 'alice');
    // e.g. a 100k hash made locally, now running where PASSWORD_ITERATIONS is lower.
    await t.db.update(users).set({ passwordHash: await hashPassword(PASSWORD, t.deps.env.SESSION_PEPPER, 20_000) }).where(eq(users.id, u.user.id));
    await login(t, u);
    const [row] = await t.db.select().from(users).where(eq(users.id, u.user.id));
    expect(hashIterations(row!.passwordHash!)).toBe(t.deps.env.PASSWORD_ITERATIONS);
    await login(t, u); // still the same password
  });

  it('updates the display name and avatar (small image data URLs only)', async () => {
    const c = await login(t, await makeUser(t, 'alice'));
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const r = await c.patch('/api/auth/profile', { displayName: 'Alice W', avatar: png });
    expect(r.json.user).toMatchObject({ displayName: 'Alice W', avatar: png });
    expect((await c.get('/api/auth/me')).json.user.avatar).toBe(png);
    expect((await c.patch('/api/auth/profile', { avatar: 'https://example.com/a.png' })).status).toBe(400);
    expect((await c.patch('/api/auth/profile', { avatar: `data:image/png;base64,${'A'.repeat(210_000)}` })).status).toBe(400);
    expect((await c.patch('/api/auth/profile', { avatar: null })).json.user.avatar).toBeNull();
  });

  it('expires idle sessions after 7 days', async () => {
    const c = await login(t, await makeUser(t, 'alice'));
    t.advance(6 * 24 * 3600_000);
    expect((await c.get('/api/auth/me')).status).toBe(200); // sliding refresh
    t.advance(6 * 24 * 3600_000);
    expect((await c.get('/api/auth/me')).status).toBe(200);
    t.advance(8 * 24 * 3600_000);
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });
});

describe('first-run setup link (single user)', () => {
  it('creates the only account with password + TOTP, then stops working', async () => {
    const guest = client(t);
    expect((await guest.get(`/api/setup/wrong-token-123456789`)).json.valid).toBe(false);
    expect((await guest.get(`/api/setup/${SETUP_TOKEN}`)).json.valid).toBe(true);
    const begin = await guest.post(`/api/setup/${SETUP_TOKEN}/begin`, { username: 'Myself', displayName: '我', password: 'a long admin password' });
    expect(begin.status).toBe(200);
    expect(begin.json.uri).toMatch(/^otpauth:\/\/totp\//);
    // The setup session cannot reach the ledger.
    expect((await guest.get('/api/accounts')).status).toBe(401);

    const { currentTotp } = await import('../src/auth/totp.ts');
    t.advance(30_000);
    expect((await guest.post(`/api/setup/${SETUP_TOKEN}/confirm`, { code: '000000' })).status).toBe(400);
    const ok = await guest.post(`/api/setup/${SETUP_TOKEN}/confirm`, { code: currentTotp(begin.json.secret, t.clock.t) });
    expect(ok.status).toBe(200);
    expect(ok.json.recoveryCodes).toHaveLength(10);
    expect(ok.json.me.user).toMatchObject({ username: 'myself', role: 'admin', status: 'active' });
    expect((await guest.get('/api/accounts')).status).toBe(200);

    // An account exists now: the link is dead.
    expect((await client(t).get(`/api/setup/${SETUP_TOKEN}`)).json.valid).toBe(false);
    expect((await client(t).post(`/api/setup/${SETUP_TOKEN}/begin`, { username: 'other', displayName: 'x', password: 'another long password' })).status).toBe(410);
  });

  it('is disabled when no SETUP_TOKEN is configured', async () => {
    t.deps.env.SETUP_TOKEN = undefined;
    expect((await client(t).get(`/api/setup/${SETUP_TOKEN}`)).json.valid).toBe(false);
  });
});

describe('step-up verification', () => {
  it('requires a recent TOTP/passkey check for sensitive actions', async () => {
    const u = await makeUser(t, 'root', 'admin');
    const c = await login(t, u);
    expect((await c.post('/api/auth/recovery-codes', {})).status).toBe(200); // fresh login counts
    t.advance(6 * 60_000);
    const denied = await c.post('/api/auth/recovery-codes', {});
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe('STEP_UP_REQUIRED');
    expect((await c.post('/api/auth/step-up/totp', { code: '000000' })).status).toBe(401);
    const ok = await c.post('/api/auth/step-up/totp', { code: u.code() });
    expect(ok.status).toBe(200);
    expect(ok.json.session.stepUpUntil).toBeGreaterThan(t.clock.t);
    expect((await c.post('/api/auth/recovery-codes', {})).status).toBe(200);
  });

  it('changing the password signs out other sessions', async () => {
    const u = await makeUser(t, 'alice');
    const a = await login(t, u);
    const b = await login(t, u);
    expect((await a.post('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'brand new password!' })).status).toBe(200);
    expect((await a.get('/api/auth/me')).status).toBe(200);
    expect((await b.get('/api/auth/me')).status).toBe(401);
  });
});
