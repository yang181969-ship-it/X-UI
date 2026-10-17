import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, openLibsql } from '../src/db/client.ts';
import { client, login, makeUser, setup, type TestEnv } from './helpers.ts';

let t: TestEnv;
type C = ReturnType<typeof client>;

async function bank(c: C, name = 'HSBC', country = 'HK') {
  return (await c.post('/api/institutions', { name, country, type: 'bank' })).json.id as string;
}

async function account(c: C, institutionId: string, currencies: { currency: string; openingBalance?: number; includeInTotal?: boolean }[], type = 'checking') {
  const r = await c.post('/api/accounts', { institutionId, name: currencies.map((x) => x.currency).join('/'), type, currencies, openingDate: '2026-01-01' });
  expect(r.status).toBe(201);
  return r.json;
}

const bal = (a: any, cur: string) => a.currencies.find((x: any) => x.currency === cur)?.balance;

describe('multi-currency accounts', () => {
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(() => t.cleanup());

  it('keeps one balance per currency, converts inside the account and honours "include in total"', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const wise = await bank(a, 'Wise', 'ZZ');
    const acc = await account(a, wise, [
      { currency: 'USD', openingBalance: 100000 },
      { currency: 'HKD', openingBalance: 0 },
      { currency: 'EUR', openingBalance: 50000, includeInTotal: false },
    ]);
    expect(acc.currency).toBe('USD');
    expect(acc.currencies.map((x: any) => x.currency)).toEqual(['USD', 'HKD', 'EUR']);

    // Bookings default to the primary currency; others must be held by the account.
    expect((await a.post('/api/transactions', { type: 'expense', accountId: acc.id, amount: 1000, occurredAt: '2026-10-01' })).json.currency).toBe('USD');
    expect((await a.post('/api/transactions', { type: 'income', accountId: acc.id, currency: 'HKD', amount: 8000, occurredAt: '2026-10-02' })).json.currency).toBe('HKD');
    expect((await a.post('/api/transactions', { type: 'income', accountId: acc.id, currency: 'JPY', amount: 1, occurredAt: '2026-10-02' })).json.code).toBe('CURRENCY_NOT_HELD');

    // Exchange USD → HKD inside the same account.
    const fx = await a.post('/api/transactions', { type: 'transfer', fromAccountId: acc.id, fromCurrency: 'USD', toAccountId: acc.id, toCurrency: 'HKD', amount: 10000, toAmount: 77800, occurredAt: '2026-10-03' });
    expect(fx.status).toBe(201);
    expect((await a.post('/api/transactions', { type: 'transfer', fromAccountId: acc.id, toAccountId: acc.id, amount: 1, occurredAt: '2026-10-03' })).json.code).toBe('SAME_ACCOUNT');

    const after = (await a.get(`/api/accounts/${acc.id}`)).json;
    expect(bal(after, 'USD')).toBe(100000 - 1000 - 10000);
    expect(bal(after, 'HKD')).toBe(8000 + 77800);
    expect(bal(after, 'EUR')).toBe(50000);

    // EUR is excluded from the totals.
    const dash = (await a.get('/api/dashboard')).json;
    expect(dash.totals.map((x: any) => x.currency).sort()).toEqual(['HKD', 'USD']);
    expect(dash.tree[0].country).toBe('ZZ');
    expect(dash.tree[0].institutions[0].accounts[0].balances).toHaveLength(3);

    // A currency with transactions cannot be removed; adding/reordering is fine.
    const removeHkd = await a.patch(`/api/accounts/${acc.id}`, { currencies: [{ currency: 'USD', openingBalance: 100000 }] });
    expect(removeHkd.status).toBe(409);
    expect(removeHkd.json.code).toBe('CURRENCY_IN_USE');
    const reordered = await a.patch(`/api/accounts/${acc.id}`, {
      currencies: [
        { currency: 'HKD', openingBalance: 0 },
        { currency: 'USD', openingBalance: 100000 },
        { currency: 'JPY', openingBalance: 0 },
      ],
    });
    expect(reordered.json.currency).toBe('HKD');
    expect(reordered.json.currencies.map((x: any) => x.currency)).toEqual(['HKD', 'USD', 'JPY']);
    expect(bal(reordered.json, 'HKD')).toBe(85800);
  });

  it('hides currencies whose totals are zero from the dashboard', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    await account(a, await bank(a), [{ currency: 'USD', openingBalance: 500 }, { currency: 'GBP', openingBalance: 0 }]);
    expect((await a.get('/api/dashboard')).json.totals.map((x: any) => x.currency)).toEqual(['USD']);
  });
});

describe('virtual cards', () => {
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(() => t.cleanup());

  it('issues virtual cards under a physical card and tracks spending against the limit', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const acc = await account(a, await bank(a), [{ currency: 'USD', openingBalance: 100000 }]);
    const physical = (await a.post('/api/cards', { accountId: acc.id, last4: '1111', funding: 'debit' })).json;
    expect(physical).toMatchObject({ form: 'physical', status: 'active', parentCardId: null });

    const virtual = await a.post('/api/cards', {
      accountId: acc.id,
      form: 'virtual',
      parentCardId: physical.id,
      last4: '2222',
      funding: 'debit',
      spendLimit: 2000,
      merchant: 'Netflix',
    });
    expect(virtual.json).toMatchObject({ form: 'virtual', parentCardId: physical.id, spendLimit: 2000, limitPeriod: 'month', merchant: 'Netflix', spent: 0 });

    await a.post('/api/transactions', { type: 'expense', accountId: acc.id, cardId: virtual.json.id, amount: 1549, occurredAt: '2026-10-05' });
    await a.post('/api/transactions', { type: 'expense', accountId: acc.id, cardId: virtual.json.id, amount: 1549, occurredAt: '2026-09-05' });
    const cards = (await a.get('/api/cards')).json;
    expect(cards.find((c: any) => c.id === virtual.json.id).spent).toBe(1549); // this month only

    // Nested virtual cards are not allowed; freezing works.
    expect((await a.post('/api/cards', { accountId: acc.id, form: 'virtual', parentCardId: virtual.json.id, last4: '3333', funding: 'debit' })).json.code).toBe('BAD_PARENT');
    expect((await a.patch(`/api/cards/${virtual.json.id}`, { status: 'frozen' })).json.status).toBe('frozen');
    // Switching a card back to physical drops its parent.
    expect((await a.patch(`/api/cards/${virtual.json.id}`, { form: 'physical' })).json.parentCardId).toBeNull();
  });

  it('accepts UnionPay numbers without a Luhn check digit but not other brands', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const acc = await account(a, await bank(a), [{ currency: 'CNY' }]);
    const up = await a.post('/api/cards', { accountId: acc.id, pan: '6212 3456 7890 1234 563', funding: 'debit' });
    expect(up.status).toBe(201);
    expect(up.json).toMatchObject({ brand: 'unionpay', last4: '4563' });
    expect((await a.post('/api/cards', { accountId: acc.id, pan: '4242424242424241', funding: 'debit' })).json.code).toBe('BAD_PAN');
    const amex = await a.post('/api/cards', { accountId: acc.id, pan: '3782 822463 10005', funding: 'credit' });
    expect(amex.json).toMatchObject({ brand: 'amex', bin: '378282', last4: '0005' });
  });

  it('keeps the public BIN record only while it matches the card\'s 6-digit BIN', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const acc = await account(a, await bank(a), [{ currency: 'USD' }]);
    const info = { bin: '424242', scheme: 'VISA', type: 'CREDIT', issuer: 'STRIPE TEST BANK', country: 'US' };
    const card = await a.post('/api/cards', { accountId: acc.id, pan: '4242 4242 4242 4242', funding: 'credit', binInfo: info });
    expect(card.json).toMatchObject({ bin: '424242', binInfo: info });
    // A record for another BIN is ignored.
    const wrong = await a.post('/api/cards', { accountId: acc.id, last4: '1111', bin: '411111', funding: 'debit', binInfo: info });
    expect(wrong.json.binInfo).toBeNull();
    // Only 6-digit BINs are accepted.
    expect((await a.post('/api/cards', { accountId: acc.id, last4: '1111', bin: '41111111', funding: 'debit' })).status).toBe(400);
    // Unrelated edits keep it; changing the number drops the stale record.
    expect((await a.patch(`/api/cards/${card.json.id}`, { nickname: 'Main' })).json.binInfo).toEqual(info);
    const changed = await a.patch(`/api/cards/${card.json.id}`, { pan: '5555 5555 5555 4444' });
    expect(changed.json).toMatchObject({ bin: '555555', binInfo: null });
  });
});

describe('bills: one-time, subscriptions and history', () => {
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(() => t.cleanup());

  it('records past due dates as paid transactions by default, back to any start date', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const acc = await account(a, await bank(a), [{ currency: 'USD', openingBalance: 1000000 }]);
    const bill = await a.post('/api/bills', { name: 'ChatGPT', kind: 'subscription', amount: 2000, currency: 'USD', accountId: acc.id, freq: 'monthly', startDate: '2023-03-14' });
    expect(bill.status).toBe(201);
    // 2023-03-14 … 2026-09-14 = 43 past months recorded; 2026-10-14 is yesterday → also past.
    expect(bill.json.past).toEqual({ recorded: 44, markedPaid: 0 });
    const occ = (await a.get('/api/bills/occurrences')).json;
    expect(occ[0].dueDate).toBe('2023-03-14');
    expect(occ.filter((o: any) => o.status === 'paid')).toHaveLength(44);
    expect(occ.find((o: any) => o.dueDate === '2026-11-14').status).toBe('pending');
    expect(bal((await a.get(`/api/accounts/${acc.id}`)).json, 'USD')).toBe(1000000 - 44 * 2000);
    const txs = (await a.get('/api/transactions?pageSize=200')).json;
    expect(txs.total).toBe(44);
    expect(txs.items.at(-1)).toMatchObject({ occurredAt: '2023-03-14', counterparty: 'ChatGPT', amount: -2000 });
  });

  it('can mark the past paid without transactions, and handles one-time bills', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const acc = await account(a, await bank(a), [{ currency: 'USD', openingBalance: 0 }]);
    const sub = await a.post('/api/bills', { name: 'Domain', kind: 'subscription', amount: 1200, currency: 'USD', accountId: acc.id, freq: 'yearly', startDate: '2020-05-01', pastPolicy: 'paid' });
    expect(sub.json.past).toEqual({ recorded: 0, markedPaid: 7 });
    expect((await a.get('/api/transactions')).json.total).toBe(0);

    expect((await a.post('/api/bills', { name: 'x', kind: 'subscription', amount: 1, currency: 'USD', startDate: '2026-11-01' })).json.code).toBe('VALIDATION');
    const once = await a.post('/api/bills', { name: '签证费', kind: 'once', amount: 18500, currency: 'USD', accountId: acc.id, startDate: '2026-11-20' });
    expect(once.json).toMatchObject({ kind: 'once', freq: null, nextDueDate: '2026-11-20' });
    const occ = (await a.get(`/api/bills/occurrences?billId=${once.json.id}`)).json;
    expect(occ.map((o: any) => o.dueDate)).toEqual(['2026-11-20']);
    await a.post(`/api/bills/occurrences/${occ[0].id}/pay`, {});
    expect((await a.get('/api/bills')).json.find((b: any) => b.id === once.json.id).nextDueDate).toBeNull();
  });

  it('pays from another currency of a multi-currency account only with the charged amount', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const acc = await account(a, await bank(a), [{ currency: 'HKD', openingBalance: 100000 }, { currency: 'USD', openingBalance: 0 }]);
    const bill = await a.post('/api/bills', { name: 'Spotify', kind: 'subscription', amount: 1199, currency: 'USD', accountId: acc.id, freq: 'monthly', startDate: '2026-10-20' });
    const [o] = (await a.get(`/api/bills/occurrences?billId=${bill.json.id}`)).json;
    // The account holds USD → paid in USD by default.
    expect((await a.post(`/api/bills/occurrences/${o.id}/pay`, {})).json.transaction).toMatchObject({ currency: 'USD', amount: -1199 });
    await a.post(`/api/bills/occurrences/${o.id}/reset`);
    expect((await a.post(`/api/bills/occurrences/${o.id}/pay`, { currency: 'HKD' })).json.code).toBe('AMOUNT_REQUIRED');
    expect((await a.post(`/api/bills/occurrences/${o.id}/pay`, { currency: 'HKD', amount: 9400 })).json.transaction).toMatchObject({ currency: 'HKD', amount: -9400 });
  });
});

describe('statistics', () => {
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(() => t.cleanup());

  it('summarises income/expense by month, category, tag and institution for one currency', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const chase = await bank(a, 'Chase', 'US');
    const hsbc = await bank(a, 'HSBC', 'HK');
    const usd = (await account(a, chase, [{ currency: 'USD', openingBalance: 0 }])).id;
    const hk = (await account(a, hsbc, [{ currency: 'HKD', openingBalance: 0 }, { currency: 'USD', openingBalance: 0 }])).id;
    const cats = (await a.get('/api/categories')).json;
    const ai = cats.find((c: any) => c.name === 'AI 服务').id;
    const stream = cats.find((c: any) => c.name === '流媒体').id;
    const tag = (await a.post('/api/tags', { name: '工作' })).json.id;
    const tx = (b: Record<string, unknown>) => a.post('/api/transactions', b);
    await tx({ type: 'income', accountId: usd, amount: 500000, occurredAt: '2026-08-01' });
    await tx({ type: 'expense', accountId: usd, amount: 2000, occurredAt: '2026-08-14', categoryId: ai, tagIds: [tag] });
    await tx({ type: 'expense', accountId: usd, amount: 2000, occurredAt: '2026-09-14', categoryId: ai, tagIds: [tag] });
    await tx({ type: 'expense', accountId: hk, currency: 'USD', amount: 1549, occurredAt: '2026-09-20', categoryId: stream });
    await tx({ type: 'expense', accountId: hk, currency: 'HKD', amount: 8800, occurredAt: '2026-09-21' });
    await tx({ type: 'transfer', fromAccountId: usd, toAccountId: hk, toCurrency: 'USD', amount: 10000, occurredAt: '2026-09-22' });

    // One currency at a time…
    const s = (await a.get('/api/stats?from=2026-07-01&to=2026-10-31&currency=USD')).json;
    expect(s).toMatchObject({ currency: 'USD', convertedTo: null, missing: [] });
    expect(s.currencies.sort()).toEqual(['HKD', 'USD']);
    expect(s.totals).toEqual({ income: 500000, expense: 5549, count: 4 });
    expect(s.months).toEqual([
      { month: '2026-07', income: 0, expense: 0 },
      { month: '2026-08', income: 500000, expense: 2000 },
      { month: '2026-09', income: 0, expense: 3549 },
      { month: '2026-10', income: 0, expense: 0 },
    ]);
    expect(s.byCategory).toEqual([
      { categoryId: ai, amount: 4000, count: 2 },
      { categoryId: stream, amount: 1549, count: 1 },
    ]);
    expect(s.byTag).toEqual([{ tagId: tag, amount: 4000, count: 2 }]);

    // …or everything converted to one currency: by default the summary currency (CNY).
    expect((await a.get('/api/stats?from=2026-07-01&to=2026-10-31')).json).toMatchObject({ currency: null, convertedTo: 'CNY', missing: ['USD', 'HKD'] });
    // Without an HKD rate the HKD spending is left out and reported as missing.
    const noRate = (await a.get('/api/stats?from=2026-07-01&to=2026-10-31&convertTo=USD')).json;
    expect(noRate).toMatchObject({ currency: null, convertedTo: 'USD', missing: ['HKD'], totals: { income: 500000, expense: 5549, count: 4 } });
    await a.put('/api/fx/HKD', { perUsd: 7.8 });
    const all = (await a.get('/api/stats?from=2026-07-01&to=2026-10-31&convertTo=USD')).json;
    expect(all).toMatchObject({ currency: null, convertedTo: 'USD', missing: [] });
    expect(all.totals).toEqual({ income: 500000, expense: 5549 + 1128, count: 5 }); // HK$88 / 7.8 = $11.28
    expect(all.months[2]).toEqual({ month: '2026-09', income: 0, expense: 3549 + 1128 });
    expect(all.byCategory).toEqual([
      { categoryId: ai, amount: 4000, count: 2 },
      { categoryId: stream, amount: 1549, count: 1 },
      { categoryId: null, amount: 1128, count: 1 },
    ]);
    expect(all.byInstitution).toEqual([
      { institutionId: chase, income: 500000, expense: 4000 },
      { institutionId: hsbc, income: 0, expense: 1549 + 1128 },
    ]);
    const inHkd = (await a.get('/api/stats?from=2026-07-01&to=2026-10-31&convertTo=HKD')).json;
    expect(inHkd).toMatchObject({ convertedTo: 'HKD', totals: { income: 3900000, count: 5 } });

    const hsbcOnly = (await a.get(`/api/stats?from=2026-07-01&to=2026-10-31&institutionId=${hsbc}&currency=HKD`)).json;
    expect(hsbcOnly.totals).toEqual({ income: 0, expense: 8800, count: 1 });
    expect(hsbcOnly.byCategory).toEqual([{ categoryId: null, amount: 8800, count: 1 }]);
  });

  it('imports newly added default categories without duplicating existing ones', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    expect((await a.post('/api/categories/import-defaults')).json.added).toBe(0);
    const cfg = structuredClone(t.deps.config.get());
    cfg.defaultCategories.expense.push({ name: '新分类' });
    await t.deps.config.save(cfg);
    expect((await a.post('/api/categories/import-defaults')).json.added).toBe(1);
    expect((await a.post('/api/categories/import-defaults')).json.added).toBe(0);
  });
});

describe('migration 0001', () => {
  it('carries single-currency data into the multi-currency schema', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zui-mig-'));
    try {
      // A migrations folder containing only 0000 → a database exactly at the old schema.
      const only0000 = join(dir, 'migrations');
      mkdirSync(join(only0000, 'meta'), { recursive: true });
      const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'));
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx === 0);
      writeFileSync(join(only0000, 'meta/_journal.json'), JSON.stringify(journal));
      const first = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('0000'))!;
      copyFileSync(join(MIGRATIONS_DIR, first), join(only0000, first));

      const url = `file:${join(dir, 'old.db')}`;
      const raw = createClient({ url });
      await migrate(drizzle(raw), { migrationsFolder: only0000 });
      await raw.executeMultiple(`
        INSERT INTO users VALUES ('u1','alice','Alice','member','active',NULL,NULL,NULL,0,NULL,'w',0,0);
        INSERT INTO institutions VALUES ('i1','u1','HSBC','HK','bank',NULL,NULL,NULL,'{}',0,0,0,0);
        INSERT INTO accounts VALUES ('a1','u1','i1','One','checking','HKD',12345,'2026-01-01',NULL,NULL,NULL,'{}',0,0,0,0);
        INSERT INTO cards VALUES ('c1','u1','a1',NULL,'visa','credit',NULL,'4242',NULL,NULL,NULL,NULL,1,20,'midnight',NULL,'{}',0,0,0);
        INSERT INTO transactions VALUES ('t1','u1','a1',NULL,'expense',-500,'2026-10-01',NULL,NULL,NULL,NULL,NULL,NULL,'{}',0,0);
        INSERT INTO credit_statements VALUES ('s1','u1','c1',NULL,NULL,'2026-10-01','2026-10-20',500,NULL,NULL,0,0);
        INSERT INTO bills VALUES ('b1','u1','Rent','rent',100,'HKD',NULL,NULL,NULL,'monthly',1,'2026-01-01',NULL,3,1,NULL,0,0);
        INSERT INTO bill_occurrences VALUES ('o1','u1','b1','2026-01-01',100,'paid',NULL,0);
      `);
      raw.close();

      await openLibsql(url); // applies 0001
      const check = createClient({ url });
      const q = async (sqlText: string) => (await check.execute(sqlText)).rows;
      expect(await q('SELECT account_id, currency, opening_balance, include_in_total FROM account_currencies')).toEqual([
        expect.objectContaining({ account_id: 'a1', currency: 'HKD', opening_balance: 12345, include_in_total: 1 }),
      ]);
      expect((await q('SELECT currency FROM transactions'))[0]).toMatchObject({ currency: 'HKD' });
      expect((await q('SELECT currency FROM credit_statements'))[0]).toMatchObject({ currency: 'HKD' });
      expect((await q('SELECT kind, freq FROM bills'))[0]).toMatchObject({ kind: 'subscription', freq: 'monthly' });
      expect(await q('SELECT id FROM bill_occurrences')).toHaveLength(1); // recreating bills kept its occurrences
      expect((await q('SELECT form, status, single_use FROM cards'))[0]).toMatchObject({ form: 'physical', status: 'active', single_use: 0 });
      expect((await q('PRAGMA table_info(accounts)')).map((r) => r['name'])).not.toContain('opening_balance');
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- markets (network mocked)

function mockFetch(routes: Record<string, unknown | ((url: string) => unknown)>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) return new Response('not found', { status: 404 });
    const body = typeof hit[1] === 'function' ? (hit[1] as (u: string) => unknown)(url) : hit[1];
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('FX rates (manual sync)', () => {
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(() => t.cleanup());

  it('stores configured currencies and converts the dashboard to the default currency', async () => {
    t.deps.fetch = mockFetch({
      'https://open.er-api.com/': { result: 'success', time_last_update_unix: 1792000000, rates: { USD: 1, HKD: 7.8, CNY: 7.2, EUR: 0.9, XYZ: 3 } },
    });
    const a = await login(t, await makeUser(t, 'alice'));
    const acc = await account(a, await bank(a), [{ currency: 'USD', openingBalance: 100000 }, { currency: 'HKD', openingBalance: 780000 }]);
    expect((await a.get('/api/dashboard')).json.converted).toBeNull(); // no rates yet

    const sync = await a.post('/api/fx/sync');
    expect(sync.status).toBe(200);
    const codes = sync.json.rates.map((r: any) => r.currency);
    expect(codes).toContain('HKD');
    expect(codes).not.toContain('XYZ'); // not configured → not stored
    expect(sync.json.missing).toContain('JPY');

    // By default the overview converts to the summary currency (CNY): $1,000 + HK$7,800 at 7.2.
    expect((await a.get('/api/dashboard')).json.converted).toMatchObject({ currency: 'CNY', net: 720000 + 720000, missing: [] });
    const dash = (await a.get('/api/dashboard?currency=USD')).json;
    expect(dash.converted).toMatchObject({ currency: 'USD', net: 100000 + 100000, missing: [] }); // HK$7,800 = $1,000
    // A manual rate overrides the synced one.
    await a.put('/api/fx/HKD', { perUsd: 7.5 });
    expect((await a.get('/api/dashboard?currency=USD')).json.converted.net).toBe(100000 + 104000);
    expect(bal((await a.get(`/api/accounts/${acc.id}`)).json, 'HKD')).toBe(780000);
  });

  it('converts with manual rates only (USD needs no rate)', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    await account(a, await bank(a), [{ currency: 'HKD', openingBalance: 780000 }]);
    const fx = await a.put('/api/fx/HKD', { perUsd: 7.8 });
    expect(fx.json.syncedAt).toBeNull(); // a typed-in rate is not a sync
    expect((await a.get('/api/dashboard?currency=USD')).json.converted).toMatchObject({ currency: 'USD', net: 100000, missing: [] });
  });

  it('falls back to Frankfurter when the first source fails', async () => {
    t.deps.fetch = mockFetch({
      'https://open.er-api.com/': new Error('offline'),
      'https://api.frankfurter.dev/': { date: '2026-10-15', rates: { HKD: 7.85, EUR: 0.89 } },
    });
    const a = await login(t, await makeUser(t, 'alice'));
    const r = await a.post('/api/fx/sync');
    expect(r.json.rates.find((x: any) => x.currency === 'HKD')).toMatchObject({ perUsd: 7.85, source: 'frankfurter (ECB)', asOf: '2026-10-15' });
  });
});

describe('US stocks', () => {
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(() => t.cleanup());

  it('keeps shares in an investment account valued at market, paying from a separate cash account', async () => {
    t.deps.fetch = mockFetch({
      'https://query1.finance.yahoo.com/v8/finance/chart/AAPL': { chart: { result: [{ meta: { regularMarketPrice: 220.5, regularMarketTime: 1792000000, longName: 'Apple Inc.' } }] } },
      'https://query1.finance.yahoo.com/v8/finance/chart/BRK-B': { chart: { result: [] } },
      'https://query1.finance.yahoo.com/v1/finance/search': { quotes: [] },
    });
    const a = await login(t, await makeUser(t, 'alice'));
    const bankId = await bank(a, 'Chase', 'US');
    const checking = await account(a, bankId, [{ currency: 'USD', openingBalance: 1000000 }]);
    const broker = await account(a, await bank(a, 'Schwab', 'US'), [{ currency: 'USD', openingBalance: 0 }], 'investment');
    const trade = (b: Record<string, unknown>) => a.post('/api/invest/trades', { accountId: broker.id, cashAccountId: checking.id, tradeDate: '2026-09-01', ...b });

    expect((await trade({ symbol: 'aapl', side: 'buy', quantity: '10', price: '150', fee: 100 })).status).toBe(201);
    await trade({ symbol: 'AAPL', side: 'buy', quantity: '5', amount: 100000 }); // total given → price $200
    await trade({ symbol: 'BRK.B', side: 'buy', quantity: '0.5', price: '480.123456' });
    // The money left the cash account: −(1500 + 1) − 1000 − 240.06 (0.5 × 480.123456 → 240.06)
    expect(bal((await a.get(`/api/accounts/${checking.id}`)).json, 'USD')).toBe(1000000 - 150100 - 100000 - 24006);
    // No prices yet: the investment account is worth 0 so far.
    const unpriced = (await a.get(`/api/accounts/${broker.id}`)).json;
    expect(bal(unpriced, 'USD')).toBe(0);
    expect(unpriced.investment).toMatchObject({ positions: 2, unpriced: 2, costBasis: 250100 + 24006 });

    expect((await trade({ symbol: 'AAPL', side: 'sell', quantity: '16', price: '210', tradeDate: '2026-10-01' })).json.code).toBe('OVERSELL');
    const sold = await trade({ symbol: 'AAPL', side: 'sell', quantity: '6', price: '210', fee: 100, tradeDate: '2026-10-01' });
    // cost of 15 shares = 150100 + 100000 = 250100; 6 sold → cost out 100040; proceeds 126000 − 100 = 125900
    expect(sold.json.holdings.find((h: any) => h.symbol === 'AAPL')).toMatchObject({ quantity: '9', costBasis: 150060, realized: 125900 - 100040, marketValue: null });
    expect(sold.json.trades[0]).toMatchObject({ accountId: broker.id, cashAccountId: checking.id });
    const cash = 1000000 - 150100 - 100000 - 24006 + 125900;
    expect(bal((await a.get(`/api/accounts/${checking.id}`)).json, 'USD')).toBe(cash);

    const synced = await a.post('/api/invest/prices/sync');
    expect(synced.json).toMatchObject({ updated: 1, remaining: 0, failed: [{ symbol: 'BRK.B', reason: 'not_found', suggestion: null }] });
    expect(synced.json.holdings.find((h: any) => h.symbol === 'AAPL')).toMatchObject({ name: 'Apple Inc.', price: '220.5', marketValue: 198450, unrealized: 198450 - 150060 });
    await a.put('/api/invest/prices/BRK.B', { price: '500' });
    expect((await a.get('/api/invest')).json.totals.marketValue).toBe(198450 + 25000);

    // The investment account is worth its market value; totals count it once.
    const brokerNow = (await a.get(`/api/accounts/${broker.id}`)).json;
    expect(bal(brokerNow, 'USD')).toBe(223450);
    expect(brokerNow.investment).toMatchObject({ marketValue: 223450, positions: 2, unpriced: 0 });
    const dash = (await a.get('/api/dashboard')).json;
    expect(dash.totals.find((x: any) => x.currency === 'USD').net).toBe(cash + 223450);
    expect(dash.investments).toMatchObject({ marketValue: 223450, positions: 2 });
    await a.put('/api/fx/HKD', { perUsd: 7.8 });
    expect((await a.get('/api/dashboard?currency=USD')).json.converted.net).toBe(cash + 223450); // not added twice

    // Realized gains count as income in the statistics unless switched off.
    const stats = (await a.get('/api/stats?from=2026-01-01&to=2026-12-31&convertTo=USD')).json;
    expect(stats.invest).toEqual({ gain: 25860, loss: 0, sells: 1 });
    expect(stats.totals).toMatchObject({ income: 25860, expense: 0, count: 1 });
    expect(stats.months.find((m: any) => m.month === '2026-10').income).toBe(25860);
    expect((await a.get('/api/stats?from=2026-01-01&to=2026-12-31&convertTo=USD&invest=0')).json.totals.count).toBe(0);

    // Cash legs can only be changed from the investments page; deleting a trade removes its leg.
    const tradeTx = (await a.get('/api/transactions?type=trade')).json.items[0];
    expect(tradeTx.accountId).toBe(checking.id);
    expect((await a.del(`/api/transactions/${tradeTx.id}`)).json.code).toBe('TRADE_TX');
    const brk = (await a.get('/api/invest')).json.trades.find((x: any) => x.symbol === 'BRK.B');
    await a.del(`/api/invest/trades/${brk.id}`);
    expect(bal((await a.get(`/api/accounts/${checking.id}`)).json, 'USD')).toBe(cash + 24006);
    expect((await a.del(`/api/accounts/${broker.id}`)).json.code).toBe('HAS_CHILDREN');
  });

  it('counts losses as expenses, per institution, and only in USD', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const schwab = await bank(a, 'Schwab', 'US');
    const broker = await account(a, schwab, [{ currency: 'USD' }, { currency: 'HKD', openingBalance: 100 }], 'investment');
    const trade = (b: Record<string, unknown>) => a.post('/api/invest/trades', { accountId: broker.id, symbol: 'TSLA', quantity: '2', tradeDate: '2026-03-01', ...b });
    await trade({ side: 'buy', price: '300' });
    await trade({ side: 'sell', quantity: '1', price: '250', tradeDate: '2026-04-02' });
    const stats = (await a.get('/api/stats?from=2026-01-01&to=2026-12-31&convertTo=USD')).json;
    expect(stats.currencies).toContain('USD');
    expect(stats.invest).toEqual({ gain: 0, loss: 5000, sells: 1 });
    expect(stats.byCategory).toEqual([{ categoryId: '__invest', amount: 5000, count: 1 }]);
    expect(stats.byInstitution).toEqual([{ institutionId: schwab, income: 0, expense: 5000 }]);
    expect((await a.get(`/api/stats?from=2026-01-01&to=2026-12-31&convertTo=USD&institutionId=${await bank(a, 'Other')}`)).json.invest).toBeNull();
    expect((await a.get('/api/stats?from=2026-01-01&to=2026-12-31&currency=HKD')).json.invest).toBeNull();
  });

  it('only accepts investment accounts holding USD, and USD cash accounts', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const bankId = await bank(a);
    const checking = await account(a, bankId, [{ currency: 'USD' }]);
    const cny = await account(a, bankId, [{ currency: 'CNY' }]);
    const hkdBroker = await account(a, bankId, [{ currency: 'HKD' }], 'investment');
    const broker = await account(a, bankId, [{ currency: 'USD' }], 'investment');
    const buy = (b: Record<string, unknown>) => a.post('/api/invest/trades', { symbol: 'AAPL', side: 'buy', quantity: '1', price: '100', tradeDate: '2026-10-01', ...b });
    expect((await buy({ accountId: checking.id })).json.code).toBe('NOT_INVESTMENT_ACCOUNT');
    expect((await buy({ accountId: hkdBroker.id })).json.code).toBe('CURRENCY_NOT_HELD');
    expect((await buy({ accountId: broker.id, cashAccountId: cny.id })).json.code).toBe('CURRENCY_NOT_HELD');
    expect((await buy({})).status).toBe(400); // the investment account is required
    // Without a cash account only the position is recorded.
    const ok = await buy({ accountId: broker.id });
    expect(ok.status).toBe(201);
    expect(ok.json.trades[0]).toMatchObject({ cashAccountId: null, transactionId: null });
  });

  it('suggests the right ticker for a typo and renames it on every trade', async () => {
    t.deps.fetch = mockFetch({
      'https://query1.finance.yahoo.com/v8/finance/chart/APPL': { chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } },
      'https://query1.finance.yahoo.com/v8/finance/chart/AAPL': { chart: { result: [{ meta: { regularMarketPrice: 342, regularMarketTime: 1792000000 } }] } },
      'https://query1.finance.yahoo.com/v1/finance/search?q=APPL': { quotes: [{ symbol: 'AAPL', quoteType: 'EQUITY' }, { symbol: 'APLD', quoteType: 'EQUITY' }] },
    });
    const a = await login(t, await makeUser(t, 'alice'));
    const bankId = await bank(a);
    const checking = await account(a, bankId, [{ currency: 'USD', openingBalance: 100000 }]);
    const broker = await account(a, bankId, [{ currency: 'USD' }], 'investment');
    await a.post('/api/invest/trades', { accountId: broker.id, cashAccountId: checking.id, symbol: 'APPL', side: 'buy', quantity: '2', price: '150', tradeDate: '2026-10-01' });
    const first = await a.post('/api/invest/prices/sync');
    expect(first.json.failed).toEqual([{ symbol: 'APPL', reason: 'not_found', suggestion: 'AAPL' }]);

    const renamed = await a.post('/api/invest/symbols/APPL/rename', { to: 'aapl' });
    expect(renamed.json.holdings.map((h: any) => h.symbol)).toEqual(['AAPL']);
    expect((await a.get('/api/transactions?type=trade')).json.items[0].counterparty).toBe('BUY AAPL × 2');
    const second = await a.post('/api/invest/prices/sync');
    expect(second.json).toMatchObject({ updated: 1, failed: [] });
    expect((await a.post('/api/invest/symbols/NOPE/rename', { to: 'AAPL' })).status).toBe(404);
  });

  it('retries a temporary Yahoo failure on the second host', async () => {
    t.deps.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://query1.')) return new Response('Too Many Requests', { status: 429 });
      return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 10, regularMarketTime: 1792000000 } }] } }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const a = await login(t, await makeUser(t, 'alice'));
    const broker = await account(a, await bank(a), [{ currency: 'USD' }], 'investment');
    await a.post('/api/invest/trades', { accountId: broker.id, symbol: 'MSFT', side: 'buy', quantity: '1', price: '1', tradeDate: '2026-10-01' });
    expect((await a.post('/api/invest/prices/sync')).json).toMatchObject({ updated: 1, failed: [] });
  });
});

describe('migration 0002', () => {
  it('records the old brokerage account as the cash account of existing trades', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zui-mig-'));
    try {
      const old = join(dir, 'migrations');
      mkdirSync(join(old, 'meta'), { recursive: true });
      const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'));
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 1);
      writeFileSync(join(old, 'meta/_journal.json'), JSON.stringify(journal));
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => /^000[01]_/.test(f))) copyFileSync(join(MIGRATIONS_DIR, f), join(old, f));

      const url = `file:${join(dir, 'old.db')}`;
      const raw = createClient({ url });
      await migrate(drizzle(raw), { migrationsFolder: old });
      await raw.executeMultiple(`
        INSERT INTO users (id, username, display_name, role, status, webauthn_user_id, totp_enabled, created_at, updated_at) VALUES ('u1','alice','Alice','admin','active','w',0,0,0);
        INSERT INTO institutions (id, user_id, name, country, type, extra, sort, archived, created_at, updated_at) VALUES ('i1','u1','Schwab','US','broker','{}',0,0,0,0);
        INSERT INTO accounts (id, user_id, institution_id, name, type, currency, opening_date, extra, sort, archived, created_at, updated_at) VALUES ('a1','u1','i1','Brokerage','checking','USD','2026-01-01','{}',0,0,0,0);
        INSERT INTO account_currencies (account_id, user_id, currency, opening_balance, include_in_total, sort, balance, tx_count) VALUES ('a1','u1','USD',100000,1,0,70000,1);
        INSERT INTO transactions (id, user_id, account_id, type, amount, currency, occurred_at, counterparty, extra, created_at, updated_at) VALUES ('t1','u1','a1','trade',-30000,'USD','2026-10-01','BUY AAPL × 2','{}',0,0);
        INSERT INTO trades (id, user_id, account_id, symbol, side, quantity_micros, price_micros, amount, fee, currency, trade_date, transaction_id, created_at, updated_at)
          VALUES ('tr1','u1','a1','AAPL','buy',2000000,150000000,30000,0,'USD','2026-10-01','t1',0,0),
                 ('tr2','u1','a1','MSFT','buy',1000000,100000000,10000,0,'USD','2026-10-02',NULL,0,0);
        INSERT INTO securities (symbol, price_micros, price_at, source, currency, updated_at) VALUES ('AAPL', 200000000, 0, 'manual', 'USD', 0);
      `);
      raw.close();

      const db = await openLibsql(url); // applies 0002
      const check = createClient({ url });
      expect((await check.execute('SELECT id, account_id, cash_account_id FROM trades ORDER BY id')).rows).toEqual([
        expect.objectContaining({ id: 'tr1', account_id: 'a1', cash_account_id: 'a1' }),
        expect.objectContaining({ id: 'tr2', account_id: 'a1', cash_account_id: null }),
      ]);
      check.close();
      // The old brokerage account keeps its cash and now also shows the shares it holds.
      const { listAccountsWithBalance } = await import('../src/routes/accounts.ts');
      const [acc] = await listAccountsWithBalance(db, 'u1');
      expect(acc!.currencies[0]!.balance).toBe(70000 + 40000);
      expect(acc!.investment).toMatchObject({ marketValue: 40000, positions: 2, unpriced: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('credit limits', () => {
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(() => t.cleanup());

  it('shows how much of the limit is used and reminds when it is exceeded', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const bankId = await bank(a);
    const r = await a.post('/api/accounts', { institutionId: bankId, name: 'Visa', type: 'credit', currencies: [{ currency: 'USD', openingBalance: -50000 }], openingDate: '2026-01-01', creditLimit: 100000 });
    expect(r.json.creditUsage).toEqual({ used: 50000, limit: 100000, percent: 50, over: false });
    expect((await a.get('/api/reminders')).json.filter((x: any) => x.kind === 'over_limit')).toHaveLength(0);

    await a.post('/api/transactions', { type: 'expense', accountId: r.json.id, amount: 70000, occurredAt: '2026-10-10' });
    expect((await a.get(`/api/accounts/${r.json.id}`)).json.creditUsage).toEqual({ used: 120000, limit: 100000, percent: 120, over: true });
    const reminders = (await a.get('/api/reminders')).json.filter((x: any) => x.kind === 'over_limit');
    expect(reminders).toEqual([expect.objectContaining({ title: 'Visa', amount: 20000, currency: 'USD', severity: 'overdue', refId: r.json.id })]);
    await a.post('/api/reminders/dismiss', { key: reminders[0].key });
    expect((await a.get('/api/reminders')).json.filter((x: any) => x.kind === 'over_limit')).toHaveLength(0);

    // Non-credit accounts and credit accounts without a limit have no usage.
    expect((await account(a, bankId, [{ currency: 'USD' }])).creditUsage).toBeNull();
  });
});

describe('dashboard currency', () => {
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(() => t.cleanup());

  it('converts the net worth to the chosen currency', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    await account(a, await bank(a), [{ currency: 'USD', openingBalance: 100000 }, { currency: 'HKD', openingBalance: 780000 }]);
    await a.put('/api/fx/HKD', { perUsd: 7.8 });
    // Default: the summary currency (CNY), which needs its own rate.
    expect((await a.get('/api/dashboard')).json.converted).toMatchObject({ currency: 'CNY', missing: ['USD', 'HKD'] });
    await a.put('/api/fx/CNY', { perUsd: 7 });
    expect((await a.get('/api/dashboard')).json.converted).toMatchObject({ currency: 'CNY', net: 1400000, missing: [] });
    expect((await a.get('/api/dashboard?currency=USD')).json.converted).toMatchObject({ currency: 'USD', net: 200000 });
    expect((await a.get('/api/dashboard?currency=HKD')).json.converted).toMatchObject({ currency: 'HKD', net: 1560000, missing: [] });
    expect((await a.get('/api/dashboard?currency=EUR')).json.converted).toMatchObject({ currency: 'EUR', missing: ['USD', 'HKD'] });
    expect((await a.get('/api/dashboard?currency=XYZ')).json.converted.currency).toBe('CNY'); // not configured → default
    // Everything else keeps the default currency (USD).
    expect((await a.get('/api/config')).json.app).toMatchObject({ defaultCurrency: 'USD', summaryCurrency: 'CNY' });
  });
});

describe('cached balances', () => {
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(() => t.cleanup());

  it('always equal a full recomputation', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const inst = await bank(a);
    const x = await account(a, inst, [{ currency: 'USD', openingBalance: 50000 }, { currency: 'HKD', openingBalance: 0 }]);
    const y = await account(a, inst, [{ currency: 'USD', openingBalance: 0 }], 'credit');
    const card = (await a.post('/api/cards', { accountId: y.id, last4: '1234', funding: 'credit' })).json.id;
    const e1 = (await a.post('/api/transactions', { type: 'expense', accountId: y.id, cardId: card, amount: 3000, occurredAt: '2026-10-01' })).json;
    const tr = (await a.post('/api/transactions', { type: 'transfer', fromAccountId: x.id, toAccountId: x.id, toCurrency: 'HKD', amount: 1000, toAmount: 7800, occurredAt: '2026-10-02' })).json;
    await a.put(`/api/transactions/${tr.id}`, { type: 'transfer', fromAccountId: x.id, toAccountId: y.id, amount: 2000, occurredAt: '2026-10-02' });
    await a.put(`/api/transactions/${e1.id}`, { type: 'income', accountId: x.id, currency: 'HKD', amount: 500, occurredAt: '2026-10-03' });
    const bill = (await a.post('/api/bills', { name: 'Netflix', kind: 'subscription', amount: 1549, currency: 'USD', cardId: card, freq: 'monthly', startDate: '2026-08-15' })).json;
    const st = (await a.post('/api/statements', { cardId: card, statementDate: '2026-10-05', dueDate: '2026-10-23', statementAmount: 3000 })).json;
    await a.post(`/api/statements/${st.id}/repay`, { fromAccountId: x.id, amount: 1000, occurredAt: '2026-10-10' });
    const [occ] = (await a.get(`/api/bills/occurrences?billId=${bill.id}`)).json;
    await a.post(`/api/bills/occurrences/${occ.id}/reset`);
    await a.patch(`/api/accounts/${x.id}`, { currencies: [{ currency: 'USD', openingBalance: 60000 }, { currency: 'HKD', openingBalance: 100 }, { currency: 'EUR', openingBalance: 9 }] });

    const cached = (await a.get('/api/accounts')).json;
    await a.post('/api/accounts/recalc');
    const fresh = (await a.get('/api/accounts')).json;
    expect(cached).toEqual(fresh);
    expect(bal(fresh.find((r: any) => r.id === x.id), 'USD')).toBe(60000 - 2000 - 1000);
    expect(bal(fresh.find((r: any) => r.id === x.id), 'HKD')).toBe(100 + 500);
    expect(bal(fresh.find((r: any) => r.id === x.id), 'EUR')).toBe(9);
  });
});

describe('Workers Free budget (≤ 50 subrequests per request, checked by the test client)', () => {
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(() => t.cleanup());

  it('records ~570 weekly payments in one request and refuses longer histories', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const acc = await account(a, await bank(a), [{ currency: 'USD', openingBalance: 10_000_000 }]);
    const r = await a.post('/api/bills', { name: 'Weekly', kind: 'subscription', amount: 100, currency: 'USD', accountId: acc.id, freq: 'weekly', startDate: '2016-01-01' });
    expect(r.status).toBe(201);
    const n = r.json.past.recorded;
    expect(n).toBeGreaterThan(550);
    expect(bal((await a.get(`/api/accounts/${acc.id}`)).json, 'USD')).toBe(10_000_000 - n * 100);
    const occ = (await a.get('/api/bills/occurrences')).json;
    expect(occ.filter((o: any) => o.status === 'paid' && o.transactionId)).toHaveLength(n);
    // Every recorded payment points at its own transaction.
    expect(new Set(occ.map((o: any) => o.transactionId).filter(Boolean)).size).toBe(n);
    expect((await a.get('/api/transactions?pageSize=1')).json.total).toBe(n);

    const tooLong = await a.post('/api/bills', { name: 'Old', kind: 'subscription', amount: 100, currency: 'USD', accountId: acc.id, freq: 'weekly', startDate: '1990-01-01' });
    expect(tooLong.json.code).toBe('HISTORY_TOO_LONG');
    expect((await a.patch(`/api/bills/${r.json.id}`, { startDate: '1990-01-01' })).json.code).toBe('HISTORY_TOO_LONG');

    // Deleting the bill keeps the payments as plain expenses.
    expect((await a.del(`/api/bills/${r.json.id}`)).status).toBe(200);
    expect((await a.get('/api/transactions?pageSize=1')).json.total).toBe(n);
    expect((await a.post('/api/accounts/recalc')).status).toBe(200);
  });

  it('syncs at most 30 quotes per request, stalest first', async () => {
    let calls = 0;
    t.deps.fetch = mockFetch({
      'https://query1.finance.yahoo.com/v8/finance/chart/': () => (calls++, { chart: { result: [{ meta: { regularMarketPrice: 10, regularMarketTime: 1792000000 } }] } }),
    });
    const a = await login(t, await makeUser(t, 'alice'));
    const broker = await account(a, await bank(a, 'Schwab', 'US'), [{ currency: 'USD', openingBalance: 1_000_000 }], 'investment');
    for (let i = 0; i < 35; i++) await a.post('/api/invest/trades', { accountId: broker.id, symbol: `S${i}`, side: 'buy', quantity: '1', price: '1', tradeDate: '2026-01-01' });
    const first = await a.post('/api/invest/prices/sync');
    expect(first.json).toMatchObject({ updated: 30, remaining: 5 });
    expect(calls).toBe(30);
    t.advance(60_000);
    const second = await a.post('/api/invest/prices/sync');
    expect(second.json.updated).toBe(30);
    // The 5 symbols without a price were fetched first the second time.
    expect(second.json.holdings.every((h: any) => h.price === '10')).toBe(true);
  });

  it('keeps everyday pages cheap with many accounts', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const inst = await bank(a);
    for (let i = 0; i < 30; i++) await account(a, inst, [{ currency: 'USD', openingBalance: 100 }, { currency: 'HKD', openingBalance: 100 }]);
    for (const path of ['/api/dashboard', '/api/accounts', '/api/cards', '/api/reminders', '/api/bills/occurrences', '/api/stats?from=2000-01-01&to=2026-12-31', '/api/invest', '/api/fx']) {
      expect((await a.get(path)).status).toBe(200);
      expect(t.budget.used, path).toBeLessThanOrEqual(15);
    }
  });
});

describe('what the transactions list shows', () => {
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(() => t.cleanup());

  it('leaves out stock cash legs and "hidden" spending, which still count in the statistics', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const bankId = await bank(a);
    const wise = await account(a, bankId, [{ currency: 'HKD', openingBalance: 100000 }, { currency: 'USD', openingBalance: 100000 }]);
    const broker = await account(a, bankId, [{ currency: 'USD' }], 'investment');
    const hidden = (await a.post('/api/tags', { name: 'Hidden' })).json.id;
    await a.post('/api/transactions', { type: 'expense', accountId: wise.id, currency: 'USD', amount: 1200, occurredAt: '2026-10-01', counterparty: 'Rent' });
    await a.post('/api/transactions', { type: 'expense', accountId: wise.id, currency: 'USD', amount: 300, occurredAt: '2026-10-02', counterparty: 'Coffee', tagIds: [hidden] });
    await a.post('/api/invest/trades', { accountId: broker.id, cashAccountId: wise.id, symbol: 'AAPL', side: 'buy', quantity: '2', price: '150', tradeDate: '2026-10-03' });
    await a.post('/api/invest/trades', { accountId: broker.id, cashAccountId: wise.id, symbol: 'AAPL', side: 'sell', quantity: '1', price: '160', tradeDate: '2026-10-04' });

    const list = (await a.get('/api/transactions')).json;
    expect(list.items.map((x: any) => x.counterparty)).toEqual(['Rent']);
    expect(list.sums).toEqual([expect.objectContaining({ currency: 'USD', expense: 1200 })]);
    expect((await a.get('/api/transactions?hidden=1')).json.items.map((x: any) => x.counterparty)).toEqual(['Coffee', 'Rent']);
    expect((await a.get('/api/transactions?type=trade')).json.items).toHaveLength(2);
    // The account's own ledger shows everything, so its balance adds up.
    const ledger = (await a.get(`/api/transactions?accountId=${wise.id}&hidden=1&trades=1`)).json;
    expect(ledger.total).toBe(4);
    expect((await a.get('/api/dashboard')).json.recent.map((x: any) => x.counterparty)).toEqual(['Rent']);

    // The paying account keeps its USD balance visible and the trades move its money.
    const wiseNow = (await a.get(`/api/accounts/${wise.id}`)).json;
    expect(wiseNow.stockCash).toBe(true);
    expect(bal(wiseNow, 'USD')).toBe(100000 - 1200 - 300 - 30000 + 16000);
    expect((await a.get(`/api/accounts/${broker.id}`)).json.stockCash).toBe(false);

    // Statistics: hidden spending counts; stock money in/out is reported on its own.
    const stats = (await a.get('/api/stats?from=2026-10-01&to=2026-10-31&currency=USD')).json;
    expect(stats.totals.expense).toBe(1500);
    expect(stats.stockFlows).toMatchObject({ buy: 30000, sell: 16000, count: 2, byAccount: [{ accountId: wise.id, buy: 30000, sell: 16000 }] });
    expect(stats.stockFlows.months).toEqual([{ month: '2026-10', buy: 30000, sell: 16000 }]);
    expect((await a.get('/api/stats?from=2026-10-01&to=2026-10-31&currency=USD&invest=0')).json.stockFlows).toBeNull();
    expect((await a.get('/api/stats?from=2026-10-01&to=2026-10-31&currency=HKD')).json.stockFlows).toBeNull();
  });
});

describe('balance date', () => {
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(() => t.cleanup());

  it('treats the synced balance as the end of that day: only later transactions change it', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const inst = await bank(a);
    const acc = await account(a, inst, [{ currency: 'USD', openingBalance: 100000 }, { currency: 'HKD', openingBalance: 5000 }]);
    const tx = (amount: number, occurredAt: string, currency = 'USD') => a.post('/api/transactions', { type: 'expense', accountId: acc.id, currency, amount, occurredAt });
    await tx(1000, '2026-10-05');
    await tx(500, '2026-10-10');
    await tx(200, '2026-10-11');
    await tx(300, '2026-10-05', 'HKD');
    // No date yet: every transaction counts (existing accounts keep their balances).
    expect(bal((await a.get(`/api/accounts/${acc.id}`)).json, 'USD')).toBe(100000 - 1700);

    // USD synced at the end of Oct 10: the 5th and the 10th are already in the 100,000.
    const r = await a.patch(`/api/accounts/${acc.id}`, {
      currencies: [
        { currency: 'USD', openingBalance: 100000, balanceDate: '2026-10-10' },
        { currency: 'HKD', openingBalance: 5000 },
      ],
    });
    expect(r.json.currencies).toEqual([
      expect.objectContaining({ currency: 'USD', balanceDate: '2026-10-10', balance: 100000 - 200 }),
      expect.objectContaining({ currency: 'HKD', balanceDate: null, balance: 5000 - 300 }),
    ]);
    // Later transactions (and transfers) change it; earlier ones don't.
    await tx(100, '2026-10-12');
    await tx(999, '2026-10-01');
    const other = await account(a, inst, [{ currency: 'USD' }]);
    await a.post('/api/transactions', { type: 'transfer', fromAccountId: acc.id, toAccountId: other.id, amount: 400, occurredAt: '2026-10-09' });
    await a.post('/api/transactions', { type: 'transfer', fromAccountId: acc.id, toAccountId: other.id, amount: 600, occurredAt: '2026-10-13' });
    expect(bal((await a.get(`/api/accounts/${acc.id}`)).json, 'USD')).toBe(100000 - 200 - 100 - 600);
    // Recalculating gives the same, and all transactions still exist.
    await a.post('/api/accounts/recalc');
    const fresh = (await a.get(`/api/accounts/${acc.id}`)).json;
    expect(bal(fresh, 'USD')).toBe(100000 - 900);
    expect(fresh.currencies[0].transactionCount).toBe(7);
  });
});
