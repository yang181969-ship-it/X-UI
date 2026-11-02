// Login throttling behaviour, observed only through HTTP and the clock — never through the stored
// key format — so the same file passes before and after login_attempts keys became HMACs.
// Limits (src/auth/ratelimit.ts): 5 failures per username / 30 per IP in 15 minutes → locked 15 minutes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { client, makeUser, PASSWORD, setup, type TestEnv } from './helpers.ts';

const MIN = 60_000;

describe('lockout behaviour (key-format independent)', () => {
  let t: TestEnv;
  let carol: Awaited<ReturnType<typeof makeUser>>;
  beforeEach(async () => {
    t = await setup();
    carol = await makeUser(t, 'carol');
  });
  afterEach(() => t.cleanup());

  /** One login attempt; the clock moves one TOTP step first so codes are never replays. */
  async function attempt(username: string, ok: boolean) {
    t.advance(30_000);
    return client(t).post('/api/auth/login', { username, password: ok ? PASSWORD : 'wrong password here', totp: carol.code() });
  }
  const fail = async (username: string, n: number) => {
    for (let i = 0; i < n; i++) expect((await attempt(username, false)).status).toBe(401);
  };

  it('4 failures do not lock; a successful login resets the counter', async () => {
    await fail('carol', 4);
    expect((await attempt('carol', true)).status).toBe(200);
    await fail('carol', 4); // would be 8 without the reset
    expect((await attempt('carol', true)).status).toBe(200);
  });

  it('5 failures lock the username — even the right credentials are refused — until the lock expires', async () => {
    await fail('carol', 5);
    const locked = await attempt('carol', true);
    expect(locked.status).toBe(429);
    expect(locked.json.code).toBe('LOCKED');
    // attempt() itself moves the clock 30 s: these land 14 min and 15.5 min after the 5th failure.
    t.advance(13 * MIN);
    expect((await attempt('carol', true)).json.code).toBe('LOCKED');
    t.advance(1 * MIN);
    expect((await attempt('carol', true)).status).toBe(200);
  });

  it('usernames are counted case-insensitively', async () => {
    for (const name of ['Carol', 'CAROL', 'cArOl', 'carol', 'CaRoL']) expect((await attempt(name, false)).status).toBe(401);
    expect((await attempt('carol', true)).json.code).toBe('LOCKED');
  });

  it('failures older than the 15-minute window start a new count', async () => {
    await fail('carol', 4);
    t.advance(15 * MIN + 1);
    await fail('carol', 4);
    expect((await attempt('carol', true)).status).toBe(200);
  });

  it('a locked username does not lock other users (same IP)', async () => {
    const dave = await makeUser(t, 'dave');
    await fail('carol', 5);
    t.advance(30_000);
    expect((await client(t).post('/api/auth/login', { username: 'dave', password: PASSWORD, totp: dave.code() })).status).toBe(200);
  });

  it('unknown usernames are throttled the same way', async () => {
    await fail('nobody-here', 5);
    expect((await attempt('NOBODY-HERE', false)).json.code).toBe('LOCKED');
  });

  it('30 failures from one IP lock that IP for every username; other IPs are unaffected', async () => {
    for (let i = 0; i < 30; i++) expect((await attempt(`stranger-${i}`, false)).status).toBe(401);
    expect((await attempt('carol', true)).json.code).toBe('LOCKED');
    t.setIp('10.0.0.2');
    expect((await attempt('carol', true)).status).toBe(200);
  });

  it('wrong step-up codes count against the same per-username limit as logins', async () => {
    const c = client(t);
    t.advance(30_000);
    expect((await c.post('/api/auth/login', { username: 'carol', password: PASSWORD, totp: carol.code() })).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await c.post('/api/auth/step-up/totp', { code: '000000' })).status).toBe(401);
    expect((await c.post('/api/auth/step-up/totp', { code: carol.code() })).json.code).toBe('LOCKED');
    expect((await attempt('carol', true)).json.code).toBe('LOCKED');
  });
});
