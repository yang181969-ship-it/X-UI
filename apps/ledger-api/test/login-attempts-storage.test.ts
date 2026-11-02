// What login_attempts stores: per-username keys are user:<hex HMAC-SHA256(SESSION_PEPPER, label +
// lower-cased username)>, never the typed text (a password typed into the username box must not
// sit in the table). Checked against an independent node:crypto HMAC.
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USER_KEY_LABEL, userKey } from '../src/auth/ratelimit.ts';
import { client, makeUser, PASSWORD, setup, type TestEnv } from './helpers.ts';

const expectedKey = (pepper: string, username: string) => `user:${createHmac('sha256', pepper).update(`${USER_KEY_LABEL}${username.toLowerCase()}`, 'utf8').digest('hex')}`;

describe('login_attempts keys', () => {
  let t: TestEnv;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(() => t.cleanup());

  const keys = async () => (await t.client.execute('SELECT key FROM login_attempts ORDER BY key')).rows.map((r) => String(r.key));

  it('never contain the typed username; user keys are the HMAC of the lower-cased name', async () => {
    const canary = `Xui-Canary-${crypto.randomUUID()}-P@ss!`;
    for (const name of [canary, canary.toUpperCase()]) {
      t.advance(30_000);
      expect((await client(t).post('/api/auth/login', { username: name, password: canary, totp: '123456' })).status).toBe(401);
    }
    const stored = await keys();
    const dump = JSON.stringify((await t.client.execute('SELECT * FROM login_attempts')).rows);
    expect(dump.includes(canary)).toBe(false);
    expect(dump.toLowerCase().includes(canary.toLowerCase())).toBe(false);
    expect(dump.toLowerCase().includes(canary.slice(11, 47).toLowerCase())).toBe(false);
    // One user counter (both spellings share it) with 2 failures, one IP counter.
    expect(stored).toEqual([`ip:10.0.0.1`, expectedKey(t.deps.env.SESSION_PEPPER, canary)].sort());
    expect(stored.find((k) => k.startsWith('user:'))).toMatch(/^user:[0-9a-f]{64}$/);
    const rows = (await t.client.execute('SELECT key, failures FROM login_attempts')).rows;
    expect(Object.fromEntries(rows.map((r) => [String(r.key).split(':')[0], Number(r.failures)]))).toEqual({ user: 2, ip: 2 });
  });

  it('step-up failures write the same key as login failures for that username', async () => {
    const u = await makeUser(t, 'Erin');
    const c = client(t);
    t.advance(30_000);
    expect((await c.post('/api/auth/login', { username: 'erin', password: PASSWORD, totp: u.code() })).status).toBe(200);
    expect((await c.post('/api/auth/step-up/totp', { code: '000000' })).status).toBe(401);
    expect(await keys()).toEqual([expectedKey(t.deps.env.SESSION_PEPPER, 'erin')]);
    expect((await keys())[0]).toBe(expectedKey(t.deps.env.SESSION_PEPPER, 'ERIN'));
  });

  it('userKey: deterministic, case-insensitive, distinct per name and per pepper', async () => {
    expect(await userKey('pepper-a', 'Alice')).toBe(await userKey('pepper-a', 'alice'));
    expect(await userKey('pepper-a', 'alice')).toBe(expectedKey('pepper-a', 'alice'));
    expect(await userKey('pepper-a', 'alice')).not.toBe(await userKey('pepper-a', 'alicf'));
    expect(await userKey('pepper-a', 'alice')).not.toBe(await userKey('pepper-b', 'alice'));
    // Not a bare hash of the name (the pepper is a real key) and not the label-free HMAC either.
    expect(await userKey('pepper-a', 'alice')).not.toBe(`user:${createHmac('sha256', 'pepper-a').update('alice').digest('hex')}`);
  });
});
