// M2-B2.3: personal settings — GET / PATCH /settings/profile (API_SPEC §3.1; TEST_PLAN H-1 – H-4,
// H-6, D-6, R-1), including concurrent saves and failures half-way through the write batch.
// Every case runs twice with the same assertions: on libsql (a temporary file database opened by
// openV1Db) and on wrangler's local in-memory D1 (d1-app.ts — never a remote D1).
// The database-level rules of user_preferences (one row per user, default CN, CHECK, foreign key)
// are covered on both engines by m2-schema.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '../src/auth/middleware.ts';
import { startD1App, type D1App } from './d1-app.ts';
import { client, login, makeUser, setup, type TestEnv } from './helpers.ts';

type Rows = Record<string, unknown>[];
interface Engine {
  t: TestEnv;
  all: (sql: string, ...args: unknown[]) => Promise<Rows>;
  run: (sql: string) => Promise<unknown>;
  ping: () => Promise<void>;
  dispose: () => Promise<void>;
}

async function libsqlEngine(): Promise<Engine> {
  const t = await setup();
  return {
    t,
    all: async (sql, ...args) => {
      const r = await t.client.execute({ sql, args: args as never });
      return r.rows.map((row) => Object.fromEntries(r.columns.map((col, i) => [col, row[i]])));
    },
    run: (sql) => t.client.execute(sql),
    ping: async () => {},
    dispose: () => t.cleanup(),
  };
}

async function d1Engine(): Promise<Engine> {
  const h: D1App = await startD1App('xui-v1-settings-d1');
  return { t: h.t, all: h.all, run: (sql) => h.d1.prepare(sql).run(), ping: h.ping, dispose: h.dispose };
}

const ENGINES = { libsql: libsqlEngine, d1: d1Engine };

describe.each(['libsql', 'd1'] as const)('settings profile on %s', (engine) => {
  let e: Engine;
  beforeAll(async () => {
    e = await ENGINES[engine]();
  }, 180_000);
  afterAll(async () => {
    await e?.dispose();
  });
  beforeEach(() => e.ping());

  // One database per engine, so every case signs in as users of its own.
  let seq = 0;
  async function signIn(prefix = 'user') {
    const u = await makeUser(e.t, `${engine}-${prefix}-${++seq}`);
    return { user: u.user, api: await login(e.t, u) };
  }
  type Api = Awaited<ReturnType<typeof login>>;

  const prefRows = (userId: string) => e.all('SELECT user_id, home_region, created_at, updated_at FROM user_preferences WHERE user_id = ?', userId);
  const auditRows = async (userId: string) =>
    (await e.all("SELECT action, detail, created_at FROM audit_log WHERE user_id = ? AND action LIKE 'preferences.%' ORDER BY rowid", userId)).map((a) => ({ ...a, detail: JSON.parse(String(a.detail)) }));
  const auditDetails = async (userId: string) => (await auditRows(userId)).map((a) => a.detail as Record<string, unknown>);
  const homeRegion = async (api: Api) => {
    const r = await api.get('/api/settings/profile');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json.homeRegion as string;
  };

  /** Every row of every table (sqlite_master order), to prove a request wrote nothing — or only what it should. */
  async function snapshot() {
    const tables = (await e.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name")).map((r) => String(r.name));
    expect(tables).toEqual(expect.arrayContaining(['user_preferences', 'settings', 'audit_log', 'sessions', 'users']));
    const out: Record<string, Rows> = {};
    for (const table of tables) out[table] = await e.all(`SELECT * FROM "${table}" ORDER BY rowid`);
    return out;
  }

  it('H-1: without a row GET answers the default CN, marked isDefault', async () => {
    const { api, user } = await signIn();
    expect((await api.get('/api/settings/profile')).json).toEqual({ homeRegion: 'CN', isDefault: true });
    expect(await prefRows(user.id)).toEqual([]);
  });

  it('reading the default writes nothing — not even the default row', async () => {
    const { api, user } = await signIn();
    // Any write to user_preferences would now fail the request (500), so a passing GET proves none was tried.
    await e.run("CREATE TRIGGER test_no_pref_insert BEFORE INSERT ON user_preferences BEGIN SELECT RAISE(ABORT, 'TEST_NO_WRITE'); END");
    await e.run("CREATE TRIGGER test_no_pref_update BEFORE UPDATE ON user_preferences BEGIN SELECT RAISE(ABORT, 'TEST_NO_WRITE'); END");
    try {
      const before = await snapshot();
      for (let i = 0; i < 3; i++) expect(await homeRegion(api)).toBe('CN');
      // The clock stands still, so not even the session's last-seen time moves: the whole database is unchanged.
      expect(await snapshot()).toEqual(before);
    } finally {
      await e.run('DROP TRIGGER test_no_pref_insert');
      await e.run('DROP TRIGGER test_no_pref_update');
    }
    expect(await prefRows(user.id)).toEqual([]);
  });

  it('the first PATCH creates the row; the audit record says so and names the default it replaced', async () => {
    const { api, user } = await signIn();
    e.t.advance(1000);
    const r = await api.patch('/api/settings/profile', { homeRegion: 'HK' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toEqual({ homeRegion: 'HK', isDefault: false });
    const now = e.t.clock.t;
    expect(await prefRows(user.id)).toEqual([{ user_id: user.id, home_region: 'HK', created_at: now, updated_at: now }]);
    expect((await api.get('/api/settings/profile')).json).toEqual({ homeRegion: 'HK', isDefault: false });
    expect(await auditRows(user.id)).toEqual([{ action: 'preferences.home_region', detail: { from: 'CN', to: 'HK', created: true }, created_at: now }]);
  });

  it('later PATCHes update the same row (no duplicate, created_at kept) and are audited as updates', async () => {
    const { api, user } = await signIn();
    await api.patch('/api/settings/profile', { homeRegion: 'HK' });
    const created = e.t.clock.t;
    e.t.advance(60_000);
    expect((await api.patch('/api/settings/profile', { homeRegion: 'SG' })).json).toEqual({ homeRegion: 'SG', isDefault: false });
    expect(await prefRows(user.id)).toEqual([{ user_id: user.id, home_region: 'SG', created_at: created, updated_at: e.t.clock.t }]);
    // Back to CN is a stored choice (a row, not a delete): no longer marked as the default.
    e.t.advance(60_000);
    expect((await api.patch('/api/settings/profile', { homeRegion: 'CN' })).json).toEqual({ homeRegion: 'CN', isDefault: false });
    expect((await api.get('/api/settings/profile')).json).toEqual({ homeRegion: 'CN', isDefault: false });
    expect((await prefRows(user.id)).map((p) => p.home_region)).toEqual(['CN']);
    expect(await auditDetails(user.id)).toEqual([
      { from: 'CN', to: 'HK', created: true },
      { from: 'HK', to: 'SG', created: false },
      { from: 'SG', to: 'CN', created: false },
    ]);
  });

  it('saving the same value again changes nothing: no audit, same updated_at, answers the current settings', async () => {
    const { api, user } = await signIn();
    await api.patch('/api/settings/profile', { homeRegion: 'HK' });
    const saved = await prefRows(user.id);
    const before = await snapshot();
    // Less than the session touch interval, so the session row stays put too: the whole database must be unchanged.
    e.t.advance(30_000);
    const r = await api.patch('/api/settings/profile', { homeRegion: 'HK' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ homeRegion: 'HK', isDefault: false });
    expect(await snapshot()).toEqual(before);
    expect(await prefRows(user.id)).toEqual(saved);
    expect(await auditDetails(user.id)).toEqual([{ from: 'CN', to: 'HK', created: true }]);
  });

  it('saving CN without a row is the same value: nothing is written and it stays the default', async () => {
    const { api, user } = await signIn();
    const before = await snapshot();
    const r = await api.patch('/api/settings/profile', { homeRegion: 'CN' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ homeRegion: 'CN', isDefault: true });
    expect(await snapshot()).toEqual(before);
    expect(await prefRows(user.id)).toEqual([]);
    expect(await auditRows(user.id)).toEqual([]);
  });

  // ---------------------------------------------------------------- concurrency and failures

  /**
   * The audit records and the row agree: the first record starts at CN, each one starts where the
   * previous one ended and really changes the value, only the first is a creation, and the last
   * one ends at the stored value.
   */
  async function expectAuditChain(userId: string) {
    const details = await auditDetails(userId);
    const rows = await prefRows(userId);
    expect(rows).toHaveLength(1);
    let at = 'CN';
    details.forEach((d, i) => {
      expect(d.from, JSON.stringify(details)).toBe(at);
      expect(d.to).not.toBe(d.from);
      expect(d.created, JSON.stringify(details)).toBe(i === 0);
      at = d.to as string;
    });
    expect(rows[0]!.home_region).toBe(at);
    return { details, row: rows[0]! };
  }

  it('concurrency 1: two first saves at the same time — one row, one creation record', async () => {
    const same = await signIn();
    const r1 = await Promise.all([same.api.patch('/api/settings/profile', { homeRegion: 'JP' }), same.api.patch('/api/settings/profile', { homeRegion: 'JP' })]);
    expect(r1.map((r) => r.json)).toEqual([
      { homeRegion: 'JP', isDefault: false },
      { homeRegion: 'JP', isDefault: false },
    ]);
    expect((await expectAuditChain(same.user.id)).details).toEqual([{ from: 'CN', to: 'JP', created: true }]);

    const different = await signIn();
    const r2 = await Promise.all([different.api.patch('/api/settings/profile', { homeRegion: 'JP' }), different.api.patch('/api/settings/profile', { homeRegion: 'KR' })]);
    expect(r2.map((r) => r.status)).toEqual([200, 200]);
    // The first to commit created the row; the second updated it, and its record names the first one's value.
    const { details } = await expectAuditChain(different.user.id);
    expect(details).toHaveLength(2);
    expect(new Set(details.map((d) => d.to))).toEqual(new Set(['JP', 'KR']));
  });

  it('concurrency 2: two saves of different regions at the same time — applied one after the other, records chain exactly', async () => {
    const { api, user } = await signIn();
    await api.patch('/api/settings/profile', { homeRegion: 'HK' });
    const r = await Promise.all([api.patch('/api/settings/profile', { homeRegion: 'SG' }), api.patch('/api/settings/profile', { homeRegion: 'GB' })]);
    expect(r.map((x) => x.status)).toEqual([200, 200]);
    const { details, row } = await expectAuditChain(user.id);
    expect(details).toHaveLength(3);
    expect(details[0]).toEqual({ from: 'CN', to: 'HK', created: true });
    expect(new Set(details.slice(1).map((d) => d.to))).toEqual(new Set(['SG', 'GB']));
    expect((await api.get('/api/settings/profile')).json).toEqual({ homeRegion: row.home_region, isDefault: false });
  });

  it('concurrency 3: two saves of the same new region at the same time — one change, one record', async () => {
    const { api, user } = await signIn();
    await api.patch('/api/settings/profile', { homeRegion: 'HK' });
    e.t.advance(1000);
    const r = await Promise.all([api.patch('/api/settings/profile', { homeRegion: 'SG' }), api.patch('/api/settings/profile', { homeRegion: 'SG' })]);
    expect(r.map((x) => x.json)).toEqual([
      { homeRegion: 'SG', isDefault: false },
      { homeRegion: 'SG', isDefault: false },
    ]);
    const { details, row } = await expectAuditChain(user.id);
    expect(details).toEqual([
      { from: 'CN', to: 'HK', created: true },
      { from: 'HK', to: 'SG', created: false },
    ]);
    expect(row.updated_at).toBe(e.t.clock.t);
  });

  it('a save committed after this request started but before its write: the record names that value, not a stale one', async () => {
    const { api, user } = await signIn();
    await api.patch('/api/settings/profile', { homeRegion: 'HK' });
    // Another save (JP) commits at the last moment before this request's batch runs.
    const original = e.t.db.batch.bind(e.t.db);
    const spy = vi.spyOn(e.t.db, 'batch').mockImplementationOnce(async (batch) => {
      expect((await api.patch('/api/settings/profile', { homeRegion: 'JP' })).json).toEqual({ homeRegion: 'JP', isDefault: false });
      return original(batch);
    });
    const r = await api.patch('/api/settings/profile', { homeRegion: 'SG' });
    spy.mockRestore();
    expect(r.json).toEqual({ homeRegion: 'SG', isDefault: false });
    expect((await expectAuditChain(user.id)).details).toEqual([
      { from: 'CN', to: 'HK', created: true },
      { from: 'HK', to: 'JP', created: false },
      { from: 'JP', to: 'SG', created: false },
    ]);
  });

  it('a failure half-way through the write rolls back both the change and its audit record (500)', async () => {
    const { api, user } = await signIn();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The audit statement runs first; the preferences statement after it fails.
      await e.run("CREATE TRIGGER test_fail_pref_insert BEFORE INSERT ON user_preferences BEGIN SELECT RAISE(ABORT, 'TEST_INJECTED_FAILURE'); END");
      await e.run("CREATE TRIGGER test_fail_pref_update BEFORE UPDATE ON user_preferences BEGIN SELECT RAISE(ABORT, 'TEST_INJECTED_FAILURE'); END");
      let before = await snapshot();
      expect((await api.patch('/api/settings/profile', { homeRegion: 'HK' })).status).toBe(500);
      expect(await snapshot()).toEqual(before);
      await e.run('DROP TRIGGER test_fail_pref_insert');
      expect((await api.patch('/api/settings/profile', { homeRegion: 'HK' })).status).toBe(200);
      before = await snapshot();
      e.t.advance(1000);
      expect((await api.patch('/api/settings/profile', { homeRegion: 'SG' })).status).toBe(500);
      expect(await snapshot()).toEqual(before);
      await e.run('DROP TRIGGER test_fail_pref_update');

      // The audit record itself fails: the row is not changed either.
      await e.run("CREATE TRIGGER test_fail_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'preferences.home_region' BEGIN SELECT RAISE(ABORT, 'TEST_INJECTED_FAILURE'); END");
      before = await snapshot();
      expect((await api.patch('/api/settings/profile', { homeRegion: 'SG' })).status).toBe(500);
      expect(await snapshot()).toEqual(before);
      await e.run('DROP TRIGGER test_fail_audit');
    } finally {
      quiet.mockRestore();
      for (const name of ['test_fail_pref_insert', 'test_fail_pref_update', 'test_fail_audit']) await e.run(`DROP TRIGGER IF EXISTS ${name}`);
    }
    // Retrying after the failure is safe and lands exactly once.
    expect((await api.patch('/api/settings/profile', { homeRegion: 'SG' })).json).toEqual({ homeRegion: 'SG', isDefault: false });
    expect((await expectAuditChain(user.id)).details).toEqual([
      { from: 'CN', to: 'HK', created: true },
      { from: 'HK', to: 'SG', created: false },
    ]);
  });

  it('concurrent saves of two users stay apart', async () => {
    const a = await signIn('a');
    const b = await signIn('b');
    const r = await Promise.all([
      a.api.patch('/api/settings/profile', { homeRegion: 'FR' }),
      b.api.patch('/api/settings/profile', { homeRegion: 'DE' }),
      a.api.patch('/api/settings/profile', { homeRegion: 'IT' }),
    ]);
    expect(r.map((x) => x.status)).toEqual([200, 200, 200]);
    expect((await expectAuditChain(a.user.id)).details).toHaveLength(2);
    expect((await expectAuditChain(b.user.id)).details).toEqual([{ from: 'CN', to: 'DE', created: true }]);
  });

  it('H-3: users A and B have independent settings; nothing is kept in the global settings table', async () => {
    const a = await signIn('a');
    const b = await signIn('b');
    await a.api.patch('/api/settings/profile', { homeRegion: 'HK' });
    expect((await b.api.get('/api/settings/profile')).json).toEqual({ homeRegion: 'CN', isDefault: true });
    expect(await prefRows(b.user.id)).toEqual([]);
    await b.api.patch('/api/settings/profile', { homeRegion: 'SG' });
    expect(await homeRegion(a.api)).toBe('HK');
    expect(await homeRegion(b.api)).toBe('SG');
    expect((await prefRows(a.user.id)).map((p) => p.home_region)).toEqual(['HK']);
    expect((await prefRows(b.user.id)).map((p) => p.home_region)).toEqual(['SG']);
    expect(await e.all("SELECT key FROM settings WHERE key LIKE '%region%' OR value LIKE '%HK%' OR value LIKE '%SG%'")).toEqual([]);
    // The body cannot name another user: unknown fields are refused, and B's row is untouched.
    const forged = await a.api.patch('/api/settings/profile', { homeRegion: 'JP', userId: b.user.id });
    expect(forged.status).toBe(400);
    expect(forged.json.code).toBe('VALIDATION');
    expect(await homeRegion(b.api)).toBe('SG');
    expect(await homeRegion(a.api)).toBe('HK');
  });

  it('H-2: only codes from the ISO 3166-1 list are accepted (400 VALIDATION, nothing written)', async () => {
    const { api, user } = await signIn();
    const before = await snapshot();
    const bad: unknown[] = [
      { homeRegion: 'hk' },
      { homeRegion: 'CHN' },
      { homeRegion: 'XK' }, // user-assigned, not an ISO assignment
      { homeRegion: 'ZZ' },
      { homeRegion: 'UK' }, // reserved, the code is GB
      { homeRegion: ' HK' },
      { homeRegion: '' },
      { homeRegion: null },
      { homeRegion: 86 },
      {},
      { homeRegion: 'HK', theme: 'dark' },
      ['HK'],
      'HK',
    ];
    for (const b of bad) {
      const r = await api.patch('/api/settings/profile', b);
      expect.soft(r.status, JSON.stringify(b)).toBe(400);
      expect.soft(r.json.code, JSON.stringify(b)).toBe('VALIDATION');
    }
    const notJson = await api.req('PATCH', '/api/settings/profile', undefined, { 'content-type': 'application/json' });
    expect(notJson.status).toBe(400);
    expect(await snapshot()).toEqual(before);
    expect(await prefRows(user.id)).toEqual([]);
    // HK, MO and TW are codes of their own.
    for (const code of ['HK', 'MO', 'TW', 'GB', 'US']) expect((await api.patch('/api/settings/profile', { homeRegion: code })).status, code).toBe(200);
  });

  it('D-6: a home_region change only touches the user_preferences row (and its audit record)', async () => {
    const { api, user } = await signIn();
    const other = await signIn('other');
    await other.api.patch('/api/settings/profile', { homeRegion: 'DE' });
    await api.patch('/api/settings/profile', { homeRegion: 'HK' });
    const before = await snapshot();
    e.t.advance(1000);
    expect((await api.patch('/api/settings/profile', { homeRegion: 'MO' })).status).toBe(200);
    const after = await snapshot();
    for (const table of Object.keys(before).filter((x) => x !== 'user_preferences' && x !== 'audit_log')) expect(after[table], table).toEqual(before[table]);
    const mine = (s: Record<string, Rows>) => s.user_preferences!.find((r) => r.user_id === user.id);
    expect(mine(after)).toEqual({ ...mine(before), home_region: 'MO', updated_at: e.t.clock.t });
    expect(after.user_preferences!.filter((r) => r.user_id !== user.id)).toEqual(before.user_preferences!.filter((r) => r.user_id !== user.id));
    expect(after.audit_log!.slice(0, before.audit_log!.length)).toEqual(before.audit_log);
    expect(after.audit_log!.slice(before.audit_log!.length).map((a) => [a.user_id, a.action])).toEqual([[user.id, 'preferences.home_region']]);
  });

  it('R-1: both routes need a session (401)', async () => {
    const { api } = await signIn();
    await api.patch('/api/settings/profile', { homeRegion: 'HK' });
    const anon = client(e.t);
    for (const [method, b] of [['GET'], ['PATCH', { homeRegion: 'SG' }]] as const) {
      const r = await anon.req(method, '/api/settings/profile', b);
      expect.soft(r.status, method).toBe(401);
      expect.soft(r.json.code, method).toBe('UNAUTHENTICATED');
      const forged = await anon.req(method, '/api/settings/profile', b, { cookie: 'xui_session=forged' });
      expect.soft(forged.status, `${method} forged`).toBe(401);
    }
    // Signed out: replaying the old session cookie no longer works.
    const cookie = [...api.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    expect((await anon.req('GET', '/api/settings/profile', undefined, { cookie })).json).toEqual({ homeRegion: 'HK', isDefault: false });
    await api.post('/api/auth/logout');
    expect((await anon.req('GET', '/api/settings/profile', undefined, { cookie })).status).toBe(401);
    expect((await anon.req('PATCH', '/api/settings/profile', { homeRegion: 'SG' }, { cookie })).status).toBe(401);
  });

  it('R-1: PATCH needs the x-xui-csrf header and an allowed Origin (403); nothing changes otherwise', async () => {
    const { api, user } = await signIn();
    await api.patch('/api/settings/profile', { homeRegion: 'HK' });
    const before = await snapshot();
    const b = { homeRegion: 'SG' };
    const evil = await api.req('PATCH', '/api/settings/profile', b, { origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    expect(evil.json.code).toBe('BAD_ORIGIN');
    const legacyOrigin = await api.req('PATCH', '/api/settings/profile', b, { origin: 'http://localhost:5173' });
    expect(legacyOrigin.json.code).toBe('BAD_ORIGIN');
    const noCsrf = await api.req('PATCH', '/api/settings/profile', b, { [CSRF_HEADER]: '' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.json.code).toBe('CSRF');
    const legacyCsrf = await api.req('PATCH', '/api/settings/profile', b, { [CSRF_HEADER]: '', 'x-zui-csrf': '1' });
    expect(legacyCsrf.status).toBe(403);
    expect(legacyCsrf.json.code).toBe('CSRF');
    expect(await snapshot()).toEqual(before);
    expect(await homeRegion(api)).toBe('HK');
    expect((await prefRows(user.id)).map((p) => p.home_region)).toEqual(['HK']);
    expect((await api.get('/api/settings/profile')).res.headers.get('cache-control')).toBe('no-store');
  });
});
