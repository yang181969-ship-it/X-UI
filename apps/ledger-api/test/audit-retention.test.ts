// Audit log retention policy (DATA_MODEL §6). audit_log is the unchanged M1 table: user_id has
// no foreign key, so a user's audit trail is kept when the user is deleted (security record,
// independent of the user's lifecycle), while every user_id CASCADE table is emptied. Entries
// must never carry credentials: passwords, TOTP secrets, recovery codes, session tokens, keys.
import { describe, expect, it } from 'vitest';
import { currentTotp } from '../src/auth/totp.ts';
import { client, login, makeUser, PASSWORD, setup, SETUP_TOKEN } from './helpers.ts';

const NEW_PASSWORD = 'a different horse staple';
const WRONG_PASSWORD = 'wrong horse battery staple';

describe('audit log', () => {
  it('login.failure and login.locked never record what was typed as the username', async () => {
    const t = await setup();
    try {
      const u = await makeUser(t, 'carol');
      // Looks like a password someone typed into the username box.
      const canary = `Xui-Canary-${crypto.randomUUID()}-P@ss!`;
      const anon = client(t);
      // 5 failures lock the "username" (USER_MAX); the 6th attempt is refused as locked.
      for (let i = 0; i < 5; i++) {
        t.advance(30_000);
        expect((await anon.post('/api/auth/login', { username: canary, password: canary, totp: '123456' })).status).toBe(401);
      }
      t.advance(30_000);
      expect((await anon.post('/api/auth/login', { username: canary, password: PASSWORD, totp: '123456' })).json.code).toBe('LOCKED');
      // A real user with a wrong password: identified by user_id, still no typed text.
      t.advance(30_000);
      expect((await anon.post('/api/auth/login', { username: 'carol', password: canary, totp: u.code() })).status).toBe(401);
      // A totp / recovery code typed by mistake must not appear either.
      t.advance(30_000);
      expect((await anon.post('/api/auth/login', { username: canary.toLowerCase(), password: 'x', recoveryCode: canary })).status).toBeGreaterThanOrEqual(400);

      const rows = (await t.client.execute('SELECT * FROM audit_log ORDER BY created_at, id')).rows.map((r) => ({ ...r }));
      const text = JSON.stringify(rows);
      expect(text.includes(canary)).toBe(false);
      expect(text.toLowerCase().includes(canary.toLowerCase())).toBe(false);
      expect(text.toLowerCase().includes(canary.slice(11, 47).toLowerCase())).toBe(false); // the UUID part alone

      // The security events themselves are kept, with time, IP and (when known) the user.
      const failures = rows.filter((r) => r.action === 'login.failure');
      expect(failures.length).toBe(6);
      for (const f of failures) {
        expect(JSON.parse(String(f.detail))).toEqual({ via: 'password' });
        expect(Number(f.created_at)).toBeGreaterThan(0);
        expect(f.ip).toBe('10.0.0.1');
      }
      expect(failures.filter((f) => f.user_id === u.user.id)).toHaveLength(1);
      expect(failures.filter((f) => f.user_id === null)).toHaveLength(5);
      const locked = rows.filter((r) => r.action === 'login.locked');
      expect(locked.length).toBeGreaterThanOrEqual(1);
      for (const l of locked) expect(JSON.parse(String(l.detail))).toEqual({ scopes: ['user', 'ip'] });
    } finally {
      await t.cleanup();
    }
  });

  it('records real auth flows without credentials, and outlives the deleted user', async () => {
    const t = await setup();
    try {
      const u = await makeUser(t, 'alice');
      const other = await makeUser(t, 'bob');
      const secrets: string[] = [PASSWORD, NEW_PASSWORD, WRONG_PASSWORD, u.secret, other.secret, ...u.recovery, t.deps.env.APP_ENC_KEY, t.deps.env.SESSION_PEPPER, SETUP_TOKEN];

      // login.failure (wrong password), login.success, step_up, recovery.regenerate, totp.rebind, password.change, logout.
      t.advance(30_000);
      expect((await client(t).post('/api/auth/login', { username: 'alice', password: WRONG_PASSWORD, totp: u.code() })).status).toBe(401);
      const c = await login(t, u);
      secrets.push(...c.jar.values());
      t.advance(30_000);
      expect((await c.post('/api/auth/step-up/totp', { code: u.code() })).status).toBe(200);
      const regen = await c.post('/api/auth/recovery-codes');
      expect(regen.status).toBe(200);
      secrets.push(...(regen.json.codes as string[]));
      const rebind = await c.post('/api/auth/totp/rebind');
      expect(rebind.status).toBe(200);
      secrets.push(rebind.json.secret as string);
      t.advance(30_000);
      expect((await c.post('/api/auth/totp/rebind/confirm', { code: currentTotp(rebind.json.secret, t.clock.t) })).status).toBe(200);
      expect((await c.post('/api/auth/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(200);
      expect((await c.post('/api/auth/logout')).status).toBe(200);
      await login(t, other);

      // Stored credential material must not leak into the log either.
      const stored = await t.client.execute("SELECT password_hash, totp_secret_enc FROM users WHERE username = 'alice'");
      secrets.push(...stored.rows.flatMap((r) => [String(r.password_hash), String(r.totp_secret_enc)]));
      secrets.push(...(await t.client.execute('SELECT code_hash FROM recovery_codes')).rows.map((r) => String(r.code_hash)));

      const rows = (await t.client.execute('SELECT * FROM audit_log ORDER BY created_at, id')).rows.map((r) => ({ ...r }));
      expect(rows.map((r) => r.action)).toEqual(
        expect.arrayContaining(['login.failure', 'login.success', 'step_up', 'recovery.regenerate', 'totp.rebind', 'password.change', 'logout']),
      );
      const text = JSON.stringify(rows);
      for (const s of secrets) {
        expect(s.length, 'secret is long enough to search for').toBeGreaterThanOrEqual(8);
        expect(text.includes(s), `audit log contains a credential (${s.slice(0, 4)}…)`).toBe(false);
      }

      // Delete alice at the database level (v1 has no delete-user API).
      const alice = u.user.id;
      const auditOfAlice = rows.filter((r) => r.user_id === alice).length;
      const auditOfBob = rows.filter((r) => r.user_id === other.user.id).length;
      expect(auditOfAlice).toBeGreaterThanOrEqual(6);
      await t.client.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [alice] });

      for (const table of ['sessions', 'passkeys', 'recovery_codes', 'user_preferences']) {
        expect(Number((await t.client.execute({ sql: `SELECT count(*) AS n FROM ${table} WHERE user_id = ?`, args: [alice] })).rows[0]!.n), table).toBe(0);
      }
      const after = (await t.client.execute('SELECT user_id, count(*) AS n FROM audit_log GROUP BY user_id')).rows;
      const n = (id: string) => Number(after.find((r) => r.user_id === id)?.n ?? 0);
      expect(n(alice)).toBe(auditOfAlice);
      expect(n(other.user.id)).toBe(auditOfBob);
      expect((await t.client.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });
});
