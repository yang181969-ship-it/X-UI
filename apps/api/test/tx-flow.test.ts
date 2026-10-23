import { asc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountCurrencies, transactions, transactionTags } from '../src/db/schema.ts';
import { client, login, makeUser, setup, type TestEnv } from './helpers.ts';

/** Transactions list views (Phase 2C): ?flow=outflow (money leaving an account) and ?flow=all. */

let t: TestEnv;
type C = ReturnType<typeof client>;

async function account(c: C, institutionId: string, name: string, currencies: { currency: string; openingBalance?: number }[], type = 'checking') {
  const r = await c.post('/api/accounts', { institutionId, name, type, currencies, openingDate: '2026-01-01' });
  expect(r.status).toBe(201);
  return r.json.id as string;
}

/** Every page of a listing, fetched with a small page size. */
async function allPages(c: C, qs: string, pageSize = 2) {
  const items: any[] = [];
  const totals = new Set<number>();
  for (let page = 1; ; page++) {
    const r = await c.get(`/api/transactions?${qs}&page=${page}&pageSize=${pageSize}`);
    expect(r.status).toBe(200);
    totals.add(r.json.total);
    items.push(...r.json.items);
    if (r.json.items.length < pageSize) break;
  }
  return { items, totals: [...totals] };
}

const names = (items: any[]) => items.map((x) => x.counterparty).sort();

describe('transactions list views', () => {
  let a: C;
  let bankId: string;
  let otherBank: string;
  let checking: string;
  let savings: string;
  let credit: string;
  let food: string;
  let salary: string;
  let work: string;
  let hidden: string;

  const tx = async (b: Record<string, unknown>) => {
    const r = await a.post('/api/transactions', b);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json;
  };
  const list = async (qs = '') => {
    const r = await a.get(`/api/transactions?${qs}`);
    expect(r.status).toBe(200);
    return r.json;
  };

  beforeEach(async () => {
    t = await setup();
    a = await login(t, await makeUser(t, 'alice'));
    bankId = (await a.post('/api/institutions', { name: 'HSBC', country: 'HK', type: 'bank' })).json.id;
    otherBank = (await a.post('/api/institutions', { name: 'CMB', country: 'CN', type: 'bank' })).json.id;
    checking = await account(a, bankId, 'Checking', [
      { currency: 'CNY', openingBalance: 1_000_000 },
      { currency: 'USD', openingBalance: 1_000_000 },
    ]);
    savings = await account(a, otherBank, 'Savings', [{ currency: 'CNY', openingBalance: 0 }], 'savings');
    credit = await account(a, otherBank, 'Card', [{ currency: 'CNY', openingBalance: 0 }], 'credit');
    const broker = await account(a, bankId, 'Broker', [{ currency: 'USD' }], 'investment');
    food = (await a.post('/api/categories', { kind: 'expense', name: 'Food' })).json.id;
    salary = (await a.post('/api/categories', { kind: 'income', name: 'Salary' })).json.id;
    work = (await a.post('/api/tags', { name: 'Work' })).json.id;
    hidden = (await a.post('/api/tags', { name: 'Hidden' })).json.id;

    await tx({ type: 'expense', accountId: checking, currency: 'CNY', amount: 5000, occurredAt: '2026-10-01', counterparty: 'Grocer', categoryId: food, tagIds: [work] });
    await tx({ type: 'income', accountId: checking, currency: 'CNY', amount: 800000, occurredAt: '2026-10-02', counterparty: 'Employer', categoryId: salary });
    await tx({ type: 'transfer', fromAccountId: checking, toAccountId: savings, fromCurrency: 'CNY', toCurrency: 'CNY', amount: 20000, occurredAt: '2026-10-03', counterparty: 'Save' });
    await tx({ type: 'transfer', fromAccountId: checking, toAccountId: savings, fromCurrency: 'USD', toCurrency: 'CNY', amount: 1000, toAmount: 7100, occurredAt: '2026-10-04', counterparty: 'FX' });
    await tx({ type: 'adjustment', accountId: checking, currency: 'CNY', amount: -300, occurredAt: '2026-10-05', counterparty: 'AdjDown' });
    await tx({ type: 'adjustment', accountId: checking, currency: 'CNY', amount: 200, occurredAt: '2026-10-05', counterparty: 'AdjUp' });
    await tx({ type: 'expense', accountId: checking, currency: 'CNY', amount: 2000, occurredAt: '2026-10-06', counterparty: 'Coffee', tagIds: [hidden] });
    await tx({ type: 'expense', accountId: checking, currency: 'USD', amount: 1500, occurredAt: '2026-09-15', counterparty: 'Old', purpose: 'yearly fee' });
    // A card purchase and its later repayment: two outflows from two accounts, not twice the spending.
    await tx({ type: 'expense', accountId: credit, currency: 'CNY', amount: 10000, occurredAt: '2026-10-09', counterparty: 'Shop', categoryId: food });
    await tx({ type: 'transfer', fromAccountId: checking, toAccountId: credit, fromCurrency: 'CNY', toCurrency: 'CNY', amount: 10000, occurredAt: '2026-10-10', counterparty: 'Repay' });
    const buy = await a.post('/api/invest/trades', { accountId: broker, cashAccountId: checking, symbol: 'AAPL', side: 'buy', quantity: '2', price: '150', tradeDate: '2026-10-07' });
    expect(buy.status).toBe(201);
    const sell = await a.post('/api/invest/trades', { accountId: broker, cashAccountId: checking, symbol: 'AAPL', side: 'sell', quantity: '1', price: '160', tradeDate: '2026-10-08' });
    expect(sell.status).toBe(201);
    // A trade without a cash account moves no money and creates no transaction.
    await a.post('/api/invest/trades', { accountId: broker, symbol: 'MSFT', side: 'buy', quantity: '1', price: '100', tradeDate: '2026-10-08' });
  });
  afterEach(() => t.cleanup());

  it('outflow keeps expenses, sending transfer legs and stock-buy payments only', async () => {
    const r = await list('flow=outflow');
    // Income, receiving legs, adjustments (either sign), the sell proceeds and hidden spending are out.
    expect(names(r.items)).toEqual(['BUY AAPL × 2', 'FX', 'Grocer', 'Old', 'Repay', 'Save', 'Shop'].sort());
    expect(r.items.every((x: any) => x.amount < 0)).toBe(true);
    expect(r.total).toBe(7);
    expect(new Set(r.items.map((x: any) => x.type))).toEqual(new Set(['expense', 'transfer', 'trade']));
    expect(r.items.find((x: any) => x.counterparty === 'BUY AAPL × 2')).toMatchObject({ type: 'trade', amount: -30000, currency: 'USD', accountId: checking });

    // Transfers: only the sending leg, still linked to the other side with its own amount/currency.
    const fx = r.items.find((x: any) => x.counterparty === 'FX');
    expect(fx).toMatchObject({ accountId: checking, amount: -1000, currency: 'USD', counterpartAccountId: savings, counterpartAmount: 7100, counterpartCurrency: 'CNY' });
    expect(fx.transferGroupId).toBeTruthy();
    const save = r.items.find((x: any) => x.counterparty === 'Save');
    expect(save).toMatchObject({ accountId: checking, amount: -20000, counterpartAccountId: savings, counterpartAmount: 20000 });
    expect(r.items.filter((x: any) => x.accountId === savings)).toEqual([]);

    // No income/expense totals: the rows mix spending with transfers and share purchases.
    expect(r.sums).toEqual([]);
  });

  it('combines the outflow view with every other filter on the server', async () => {
    const outflow = async (qs: string) => names((await list(`flow=outflow&${qs}`)).items);
    expect(await outflow('from=2026-10-01&to=2026-10-07')).toEqual(['BUY AAPL × 2', 'FX', 'Grocer', 'Save'].sort());
    expect(await outflow(`accountId=${checking}`)).toEqual(['BUY AAPL × 2', 'FX', 'Grocer', 'Old', 'Repay', 'Save'].sort());
    expect(await outflow(`accountId=${savings}`)).toEqual([]); // it only ever received money
    expect(await outflow(`accountId=${credit}`)).toEqual(['Shop']); // the repayment arrived here, so it is not listed
    expect(await outflow(`institutionId=${otherBank}`)).toEqual(['Shop']);
    expect(await outflow('currency=USD')).toEqual(['BUY AAPL × 2', 'FX', 'Old'].sort());
    expect(await outflow(`categoryId=${food}`)).toEqual(['Grocer', 'Shop']);
    expect(await outflow(`tagId=${work}`)).toEqual(['Grocer']);
    expect(await outflow('q=Groc')).toEqual(['Grocer']);
    expect(await outflow('q=yearly')).toEqual(['Old']); // search covers purpose too
    expect(await outflow('type=transfer')).toEqual(['FX', 'Repay', 'Save']);
    expect(await outflow('type=trade')).toEqual(['BUY AAPL × 2']);
    expect(await outflow(`type=expense&currency=CNY&from=2026-10-01&accountId=${checking}`)).toEqual(['Grocer']);
    // Types that are never outflows give an empty (not an erroring) result.
    for (const type of ['income', 'adjustment']) {
      const r = await list(`flow=outflow&type=${type}`);
      expect(r).toMatchObject({ items: [], total: 0 });
    }
    expect(await outflow(`categoryId=${salary}`)).toEqual([]);
  });

  it('honours the hidden switch in every view', async () => {
    expect(names((await list('flow=outflow')).items)).not.toContain('Coffee');
    expect(names((await list('flow=outflow&hidden=1')).items)).toContain('Coffee');
    expect(names((await list(`flow=outflow&hidden=1&tagId=${hidden}`)).items)).toEqual(['Coffee']);
    expect(names((await list('flow=all')).items)).not.toContain('Coffee');
    expect(names((await list('flow=all&hidden=1')).items)).toContain('Coffee');
  });

  it('pages over the same filtered set the total counts', async () => {
    for (const qs of ['flow=outflow', 'flow=outflow&currency=CNY', 'flow=all', 'flow=all&hidden=1', '']) {
      const full = await list(`${qs}&pageSize=200`);
      const paged = await allPages(a, qs);
      expect(paged.totals, qs).toEqual([full.total]);
      expect(paged.items.map((x) => x.id), qs).toEqual(full.items.map((x: any) => x.id));
      expect(full.items).toHaveLength(full.total);
    }
    // A page past the end is empty but still reports the total.
    expect(await list('flow=outflow&page=9&pageSize=5')).toMatchObject({ items: [], total: 7 });
  });

  it('all lists every type, stock-trade cash legs, both transfer legs and adjustments included', async () => {
    const r = await list('flow=all&pageSize=200');
    expect(new Set(r.items.map((x: any) => x.type))).toEqual(new Set(['income', 'expense', 'transfer', 'adjustment', 'trade']));
    // 15 rows in the ledger (3 transfers × 2 legs, 2 trade cash legs), less the hidden coffee.
    const rows = await t.db.select().from(transactions);
    expect(rows).toHaveLength(15);
    expect(r.total).toBe(14);
    expect((await list('flow=all&hidden=1')).total).toBe(15);
    expect(names(r.items.filter((x: any) => x.type === 'trade'))).toEqual(['BUY AAPL × 2', 'SELL AAPL × 1']);
    expect(r.items.filter((x: any) => x.counterparty === 'Save').map((x: any) => x.amount).sort()).toEqual([-20000, 20000]);
    expect(names(r.items.filter((x: any) => x.type === 'adjustment'))).toEqual(['AdjDown', 'AdjUp']);
    // Income/expense totals keep their meaning here (transfers, trades and adjustments not counted).
    expect(r.sums).toEqual([
      { currency: 'CNY', income: 800000, expense: 15000 },
      { currency: 'USD', income: 0, expense: 1500 },
    ]);
    // Filters still apply, e.g. one type or one account.
    expect(names((await list('flow=all&type=income')).items)).toEqual(['Employer']);
    expect(names((await list(`flow=all&accountId=${savings}`)).items)).toEqual(['FX', 'Save']);
    // `trades` has no say once a view is chosen.
    expect((await list('flow=all&trades=0')).total).toBe(14);
    expect((await list('flow=outflow&trades=0')).total).toBe(7);
  });

  it('keeps the original behaviour when flow is left out', async () => {
    const r = await list('pageSize=200');
    // Every type but stock-trade cash legs, hidden left out, with the usual income/expense totals.
    expect(r.items.some((x: any) => x.type === 'trade')).toBe(false);
    expect(r.total).toBe(12);
    expect(names(r.items.filter((x: any) => x.counterparty === 'Save'))).toEqual(['Save', 'Save']);
    expect(r.sums).toEqual([
      { currency: 'CNY', income: 800000, expense: 15000 },
      { currency: 'USD', income: 0, expense: 1500 },
    ]);
    expect((await list('trades=1')).total).toBe(14);
    expect((await list('type=trade')).total).toBe(2);
    expect((await list(`accountId=${checking}&hidden=1&trades=1`)).total).toBe(11);
    expect((await list('type=income')).total).toBe(1);
    // The dashboard's recent list is unchanged too (no trades, nothing hidden).
    const recent = (await a.get('/api/dashboard')).json.recent;
    expect(recent.some((x: any) => x.type === 'trade' || x.counterparty === 'Coffee')).toBe(false);
  });

  it('rejects an unknown view', async () => {
    expect((await a.get('/api/transactions?flow=spending')).status).toBe(400);
  });

  it('only reads: rows, transfer links and balances stay the same', async () => {
    const snapshot = async () => ({
      rows: await t.db.select().from(transactions).orderBy(asc(transactions.id)),
      tags: await t.db.select().from(transactionTags).orderBy(asc(transactionTags.transactionId), asc(transactionTags.tagId)),
      balances: await t.db.select().from(accountCurrencies).orderBy(asc(accountCurrencies.accountId), asc(accountCurrencies.currency)),
      accounts: (await a.get('/api/accounts')).json,
    });
    const before = await snapshot();
    for (const qs of ['flow=outflow', 'flow=outflow&hidden=1', 'flow=all', 'flow=all&hidden=1', 'flow=outflow&type=transfer', '']) await list(qs);
    expect(await snapshot()).toEqual(before);
    // Sanity: what the views show is what the balances hold.
    const cny = before.balances.find((b) => b.accountId === checking && b.currency === 'CNY');
    expect(cny?.balance).toBe(1_000_000 - 5000 + 800000 - 20000 - 300 + 200 - 2000 - 10000);
  });
});
