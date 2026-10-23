// The archive's database guarantees on Cloudflare D1 itself: a local, in-memory D1 run by workerd
// (wrangler's getPlatformProxy — the engine `wrangler dev` uses), never a remote database.
// Migrations are split with wrangler's own splitter, as `wrangler d1 migrations apply` does.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPlatformProxy, unstable_splitSqlQuery } from 'wrangler';
import { createApp } from '../src/app.ts';
import { MemoryConfigStore } from '../src/config/store.ts';
import { MIGRATIONS_DIR, type DB } from '../src/db/client.ts';
import * as schema from '../src/db/schema.ts';
import { historicalRecords, transactions } from '../src/db/schema.ts';
import type { AppEnv, Deps } from '../src/env.ts';
import { runBatch } from '../src/lib/ledger.ts';
import { insertLegOps, insertLegOpsWhen } from '../src/routes/transactions.ts';
import { ACCEPTED_ROWS, REFUSED_ROWS } from './archive-rows.ts';
import { account, failsWith, ledger } from './archive-util.ts';
import { ORIGIN, client, login, makeUser, repoConfig, type TestEnv } from './helpers.ts';
import { interleave } from './interleave.ts';
import { BILL_RESETS, strayLegs } from './bill-resets.ts';
import { LINK_RACES, linkProblems } from './link-races.ts';
import { schemaDrift } from './schema-check.ts';

type D1 = Parameters<typeof drizzle>[0];
type C = ReturnType<typeof client>;

let dir: string;
let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1 }>>> | undefined;
let d1: D1;
let t: TestEnv;
let users = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'zui-d1-'));
  const config = join(dir, 'wrangler.json');
  writeFileSync(config, JSON.stringify({ name: 'zui-d1-test', compatibility_date: '2026-10-01', d1_databases: [{ binding: 'DB', database_name: 'zui-d1-test', database_id: '00000000-0000-0000-0000-000000000000' }] }));
  // Keep wrangler's cache out of the repository too.
  process.env.WRANGLER_CACHE_DIR = join(dir, 'cache');
  proxy = await getPlatformProxy<{ DB: D1 }>({ configPath: config, persist: false, envFiles: [], remoteBindings: false });
  d1 = proxy.env.DB;
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  for (const { tag } of journal.entries) {
    for (const statement of unstable_splitSqlQuery(readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8'))) await d1.prepare(statement).run();
  }

  const db = drizzle(d1, { schema }) as unknown as DB;
  const env: AppEnv = {
    APP_ENC_KEY: 'q7Lw1n0b2v3c4x5z6a7s8d9f0g1h2j3k4l5m6n7o8p0=',
    SESSION_PEPPER: 'test-pepper',
    RP_ID: 'localhost',
    RP_NAME: 'Z-UI',
    ORIGINS: [ORIGIN],
    COOKIE_SECURE: false,
    TRUST_PROXY: false,
    PASSWORD_ITERATIONS: 10_000,
  };
  // The same frozen clock as the libSQL tests: requests in one test share the millisecond.
  const clock = { t: new Date(2026, 9, 15, 10, 0, 0).getTime() };
  const deps: Deps = { db, env, config: new MemoryConfigStore(repoConfig()), now: () => clock.t };
  const app = createApp(deps, { clientIp: () => '10.0.0.1' });
  t = { app, deps, db, clock, budget: { used: 0, peak: 0 }, setIp: () => '', advance: (ms: number) => (clock.t += ms), cleanup: async () => {} } as TestEnv;
}, 120_000);

afterAll(async () => {
  await proxy?.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const q = async (sqlText: string) => ((await d1.prepare(sqlText).all()).results ?? []) as Record<string, unknown>[];
const txCount = async () => Number((await q('select count(*) as n from transactions'))[0]!['n']);

describe('local D1', () => {
  let a: C;
  let cny: string;
  let hkd: string;
  let multi: string;

  const rec = async (b: Record<string, unknown>) => {
    const r = await a.post('/api/archive', b);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json;
  };
  const ready = (extra: Record<string, unknown> = {}) => ({
    title: 'Ready',
    recordType: 'expense',
    datePrecision: 'day',
    dateFrom: '2023-05-06',
    dateTo: '2023-05-06',
    amount: 100,
    currency: 'CNY',
    accountId: cny,
    verificationStatus: 'verified',
    ...extra,
  });
  const meanwhile = async (other: () => Promise<unknown>, run: () => Promise<{ status: number; json: any }>) => {
    let res: { status: number; json: any } | undefined;
    expect(await interleave(t.deps, other, async () => (res = await run()))).toBe(true);
    return res!;
  };

  beforeEach(async () => {
    // One database for the file (workerd starts once); every test has its own user.
    a = await login(t, await makeUser(t, `d1user${++users}`));
    const bank = (await a.post('/api/institutions', { name: 'HSBC', country: 'HK', type: 'bank' })).json.id;
    cny = await account(a, bank, 'CNY', [{ currency: 'CNY', openingBalance: 100_000 }]);
    hkd = await account(a, bank, 'HKD', [{ currency: 'HKD', openingBalance: 0 }]);
    multi = await account(a, bank, 'Multi', [
      { currency: 'CNY', openingBalance: 50_000 },
      { currency: 'USD', openingBalance: 10_000 },
    ]);
  });

  describe('undoing a bill payment', () => {
    afterEach(async () => {
      expect(await strayLegs({ a, deps: t.deps, q: q, cny, hkd, multi })).toEqual([]);
      expect(await linkProblems(q)).toEqual([]);
    });
    for (const [name, run] of BILL_RESETS) it(name, () => run({ a, deps: t.deps, q: q, cny, hkd, multi }));
  });

  describe('links racing changes to their transaction', () => {
    let b: C;
    beforeEach(async () => {
      b = await login(t, await makeUser(t, `d1user${++users}`));
      await account(b, (await b.post('/api/institutions', { name: 'CMB', country: 'CN', type: 'bank' })).json.id, 'Bob', [{ currency: 'CNY', openingBalance: 1000 }]);
    });
    afterEach(async () => expect(await linkProblems(q)).toEqual([]));
    for (const [name, run] of LINK_RACES) it(name, () => run({ a, b, deps: t.deps, q, cny, hkd }));
  });

  it('builds exactly the Drizzle schema from the full migration chain', async () => {
    expect(await schemaDrift(q)).toEqual([]);
  });

  it('refuses impossible dates and every other bad row in the table itself', async () => {
    const userId = (await a.get('/api/auth/me')).json.user.id as string;
    let n = 0;
    const raw = (v: Record<string, unknown>) =>
      t.db.insert(historicalRecords).values({ id: `${userId}-${n++}`, userId, title: 'raw', recordType: 'unknown', datePrecision: 'unknown', createdAt: 1, updatedAt: 1, ...v } as never);
    for (const [name, v] of REFUSED_ROWS) await failsWith(raw(v), /CHECK constraint failed/).catch((e) => Promise.reject(new Error(`${name}: ${e.message}`)));
    for (const [, v] of ACCEPTED_ROWS) await raw(v);
    expect(Number((await q(`select count(*) as n from historical_records where user_id = '${userId}'`))[0]!['n'])).toBe(ACCEPTED_ROWS.length);
  });

  it('refuses a conversion when the record changed in the same millisecond, booking nothing', async () => {
    const r = await rec(ready());
    const before = await ledger(a);
    const n = await txCount();
    // Amount and verification changed meanwhile.
    const res = await meanwhile(() => a.put(`/api/archive/${r.id}`, ready({ amount: 900, verificationStatus: 'pending' })), () => a.post(`/api/archive/${r.id}/convert`));
    expect([res.status, res.json.code]).toEqual([409, 'ARCHIVE_CHANGED']);
    // Only the verification changed meanwhile.
    const s = await rec(ready());
    const res2 = await meanwhile(() => a.patch(`/api/archive/${s.id}/verification`, { verificationStatus: 'partial' }), () => a.post(`/api/archive/${s.id}/convert`));
    expect([res2.status, res2.json.code]).toEqual([409, 'ARCHIVE_CHANGED']);
    expect(await txCount()).toBe(n);
    expect(await ledger(a)).toEqual(before);
    expect((await a.get(`/api/archive/${r.id}`)).json).toMatchObject({ status: 'open', amount: 900, verificationStatus: 'pending', linkedTransactionId: null, version: 2, updatedAt: r.updatedAt });
    expect((await a.get(`/api/archive/${s.id}`)).json).toMatchObject({ status: 'open', verificationStatus: 'partial', version: 2 });
  });

  it('writes both legs of a cross-currency transfer or neither', async () => {
    const body = ready({ recordType: 'transfer', accountId: null, fromAccountId: multi, toAccountId: hkd, currency: 'USD', toCurrency: 'HKD', amount: 1000, toAmount: 7800 });
    const r = await rec(body);
    const before = await ledger(a);
    const n = await txCount();
    const res = await meanwhile(() => a.put(`/api/archive/${r.id}`, { ...body, toAmount: 7900 }), () => a.post(`/api/archive/${r.id}/convert`));
    expect([res.status, res.json.code]).toEqual([409, 'ARCHIVE_CHANGED']);
    expect(await txCount()).toBe(n);
    expect(await ledger(a)).toEqual(before);
    const ok = (await a.post(`/api/archive/${r.id}/convert`)).json;
    expect(ok.linkedTransactions.map((l: any) => [l.accountId, l.amount, l.currency])).toEqual([
      [multi, -1000, 'USD'],
      [hkd, 7900, 'HKD'],
    ]);
    expect(await txCount()).toBe(n + 2);
  });

  it('rolls a batch back when its status guard fails, and conditional legs alone write nothing', async () => {
    const r = await rec(ready());
    const userId = (await a.get('/api/auth/me')).json.user.id as string;
    const before = await ledger(a);
    const n = await txCount();
    const base = { cardId: null, categoryId: null, counterparty: null, note: null, extra: {}, occurredAt: '2026-01-01' };
    const transfer = [
      { ...base, role: 'from', type: 'transfer', accountId: multi, currency: 'USD', amount: -100 },
      { ...base, role: 'to', type: 'transfer', accountId: hkd, currency: 'HKD', amount: 780 },
    ] as never[];
    const guard = t.db
      .update(historicalRecords)
      .set({ status: sql`case when ${historicalRecords.version} = ${r.version + 1} then 'converted' else null end` })
      .where(eq(historicalRecords.id, r.id));
    await failsWith(runBatch(t.db, [...insertLegOps(t.db, userId, transfer, [], t.clock.t).ops, guard]), /NOT NULL constraint failed: historical_records\.status/);
    const stale = sql`exists (select 1 from ${historicalRecords} where ${historicalRecords.id} = ${r.id} and ${historicalRecords.version} = ${r.version + 1})`;
    await runBatch(t.db, insertLegOpsWhen(t.db, userId, transfer, t.clock.t, stale).ops);
    expect(await txCount()).toBe(n);
    expect(await ledger(a)).toEqual(before);
    expect((await a.get(`/api/archive/${r.id}`)).json).toMatchObject({ status: 'open', version: 1 });
  });

  it('lets at most one of several concurrent conversions through', async () => {
    const n = await txCount();
    const r = await rec(ready());
    const results = await Promise.all([1, 2, 3].map(() => a.post(`/api/archive/${r.id}/convert`)));
    expect(results.filter((x) => x.status === 200)).toHaveLength(1);
    for (const x of results.filter((x) => x.status !== 200)) expect([x.status, ['ARCHIVE_CHANGED', 'ARCHIVE_STATUS'].includes(x.json.code)]).toEqual([409, true]);
    const x = await rec(ready({ recordType: 'transfer', accountId: null, fromAccountId: cny, toAccountId: hkd, toCurrency: 'HKD', toAmount: 130 }));
    const xs = await Promise.all([1, 2].map(() => a.post(`/api/archive/${x.id}/convert`)));
    expect(xs.filter((res) => res.status === 200)).toHaveLength(1);
    expect(await txCount()).toBe(n + 3);
    const rows = await t.db.select().from(transactions).where(eq(transactions.transferGroupId, (await a.get(`/api/archive/${x.id}`)).json.linkedTransactions[0].transferGroupId));
    expect(rows).toHaveLength(2);
  });

  it('refuses single-statement writes that lost the race (link vs edit)', async () => {
    const r = await rec(ready());
    const e = (await a.post('/api/transactions', { type: 'expense', accountId: cny, amount: 1, occurredAt: '2026-01-01' })).json;
    const res = await meanwhile(() => a.put(`/api/archive/${r.id}`, ready({ note: 'edited' })), () => a.post(`/api/archive/${r.id}/link`, { transactionId: e.id }));
    expect([res.status, res.json.code]).toEqual([409, 'ARCHIVE_CHANGED']);
    expect((await a.get(`/api/archive/${r.id}`)).json).toMatchObject({ status: 'open', linkedTransactionId: null, note: 'edited', version: 2 });
  });
});
