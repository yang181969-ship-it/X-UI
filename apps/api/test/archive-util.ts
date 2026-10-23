import { expect } from 'vitest';
import type { client } from './helpers.ts';

/** Helpers shared by the archive tests on libSQL (archive.test.ts) and on local D1 (d1.test.ts). */

type C = ReturnType<typeof client>;

export async function account(c: C, institutionId: string, name: string, currencies: { currency: string; openingBalance?: number }[], type = 'checking') {
  const r = await c.post('/api/accounts', { institutionId, name, type, currencies, openingDate: '2020-01-01' });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.id as string;
}

/** Everything the ledger shows: balances, net worth, statistics, both transaction views. */
export async function ledger(c: C) {
  const accounts = (await c.get('/api/accounts')).json.map((a: any) => [a.id, a.currencies.map((x: any) => [x.currency, x.balance, x.transactionCount])]);
  const dash = (await c.get('/api/dashboard')).json;
  const stats = (await c.get('/api/stats?from=2000-01-01&to=2030-12-31')).json;
  const all = (await c.get('/api/transactions?flow=all&pageSize=200')).json;
  const outflow = (await c.get('/api/transactions?flow=outflow&pageSize=200')).json;
  return {
    accounts,
    totals: dash.totals,
    converted: dash.converted,
    month: dash.month,
    recent: dash.recent.map((x: any) => x.id),
    stats: { totals: stats.totals, months: stats.months, byCategory: stats.byCategory },
    all: [all.total, all.sums, all.items.map((x: any) => x.id)],
    outflow: [outflow.total, outflow.items.map((x: any) => x.id)],
  };
}

/** Expect a database write to fail with `re` somewhere in its error chain (drizzle wraps the driver's error). */
export async function failsWith(write: PromiseLike<unknown>, re: RegExp) {
  const err = await Promise.resolve(write).then(
    () => null,
    (e: unknown) => e,
  );
  const messages: string[] = [];
  for (let e = err; e; e = (e as { cause?: unknown }).cause) messages.push(String((e as Error).message ?? e));
  expect(messages.join(' | ')).toMatch(re);
}
