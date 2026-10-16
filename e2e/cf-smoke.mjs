#!/usr/bin/env node
/**
 * API smoke test against a running Worker (`wrangler dev`), i.e. the real Cloudflare runtime
 * with D1 — catches anything that only works on Node/libsql.
 *
 *   node e2e/cf-smoke.mjs http://localhost:8790 <SETUP_TOKEN>
 */
import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/package.json`);
const { TOTP, Secret } = require('otpauth');

const base = process.argv[2] ?? 'http://localhost:8790';
const token = process.argv[3];
let cookie = '';

async function api(method, path, body) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { origin: base, 'x-zui-csrf': '1', cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const [pair] = sc.split(';');
    if (/max-age=0/i.test(sc)) cookie = '';
    else cookie = pair;
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return json;
}

const step = async (name, fn) => {
  const t = performance.now();
  const r = await fn();
  console.log(`✓ ${name} (${Math.round(performance.now() - t)} ms)`);
  return r;
};

const totp = (secret) => new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate();

const page = await fetch(base + '/accounts');
console.log(`✓ SPA fallback served as static asset: ${page.status} ${page.headers.get('content-type')}`);
const robots = await (await fetch(base + '/robots.txt')).text();
if (!robots.includes('Disallow: /')) throw new Error('robots.txt missing');

await step('setup link valid', async () => {
  if (!(await api('GET', `/setup/${token}`)).valid) throw new Error('setup token not accepted');
});
const begin = await step('setup begin (PBKDF2 hash)', () => api('POST', `/setup/${token}/begin`, { username: 'myself', displayName: 'Me', password: 'a long admin password' }));
await step('setup confirm', () => api('POST', `/setup/${token}/confirm`, { code: totp(begin.secret) }));
if ((await api('GET', `/setup/${token}`)).valid) throw new Error('setup link still valid after setup');

const inst = await step('institution', () => api('POST', '/institutions', { name: 'Wise', country: 'ZZ', type: 'ewallet' }));
const acc = await step('multi-currency account', () =>
  api('POST', '/accounts', { institutionId: inst.id, name: 'Multi', type: 'ewallet', currencies: [{ currency: 'USD', openingBalance: 100000 }, { currency: 'HKD', openingBalance: 0 }], openingDate: '2026-01-01' }),
);
const cats = await step('categories seeded (chunked insert)', () => api('GET', '/categories'));
if (cats.length < 30) throw new Error(`only ${cats.length} categories`);
await step('expense + FX transfer inside the account', async () => {
  await api('POST', '/transactions', { type: 'expense', accountId: acc.id, amount: 2000, occurredAt: '2026-10-01', categoryId: cats[0].id, tagIds: [] });
  await api('POST', '/transactions', { type: 'transfer', fromAccountId: acc.id, toAccountId: acc.id, toCurrency: 'HKD', amount: 10000, toAmount: 78000, occurredAt: '2026-10-02' });
});
const bill = await step('subscription since 2022 (bulk history recorded)', () =>
  api('POST', '/bills', { name: 'ChatGPT', kind: 'subscription', amount: 2000, currency: 'USD', accountId: acc.id, freq: 'monthly', startDate: '2022-01-10' }),
);
console.log(`  past: ${JSON.stringify(bill.past)}`);
const accounts = await step('balances (cached)', () => api('GET', '/accounts'));
const usd = accounts[0].currencies.find((c) => c.currency === 'USD');
const expected = 100000 - 2000 - 10000 - bill.past.recorded * 2000;
if (usd.balance !== expected) throw new Error(`USD balance ${usd.balance} ≠ ${expected}`);
await step('recalc matches cache', async () => {
  await api('POST', '/accounts/recalc');
  const again = await api('GET', '/accounts');
  if (JSON.stringify(again) !== JSON.stringify(accounts)) throw new Error('cache drift');
});
await step('reminders + occurrences', async () => {
  await api('GET', '/reminders');
  await api('GET', '/bills/occurrences');
});
await step('stats', () => api('GET', '/stats?from=2022-01-01&to=2026-12-31'));
await step('fx manual rate', () => api('PUT', '/fx/HKD', { perUsd: 7.8 }));
const broker = await step('investment account', () =>
  api('POST', '/accounts', { institutionId: inst.id, name: 'Broker', type: 'investment', currencies: [{ currency: 'USD', openingBalance: 0 }], openingDate: '2026-01-01' }),
);
await step('stock trade paid from another account', () =>
  api('POST', '/invest/trades', { accountId: broker.id, cashAccountId: acc.id, symbol: 'APPL', side: 'buy', quantity: '2', price: '150', tradeDate: '2026-10-03' }),
);
await step('rename a mistyped ticker', () => api('POST', '/invest/symbols/APPL/rename', { to: 'AAPL' }));
await step('manual price', () => api('PUT', '/invest/prices/AAPL', { price: '200' }));
const brokerNow = await step('investment account valued at market', () => api('GET', `/accounts/${broker.id}`));
if (brokerNow.currencies[0].balance !== 40000) throw new Error(`broker balance ${brokerNow.currencies[0].balance} ≠ 40000`);
const dash = await step('dashboard', () => api('GET', '/dashboard'));
console.log(`  converted: ${JSON.stringify(dash.converted)} investments: ${JSON.stringify(dash.investments)}`);
const dashHkd = await step('dashboard in HKD', () => api('GET', '/dashboard?currency=HKD'));
if (dashHkd.converted.currency !== 'HKD') throw new Error('currency not switched');
await step('stats with stock gains', async () => {
  await api('POST', '/invest/trades', { accountId: broker.id, cashAccountId: acc.id, symbol: 'AAPL', side: 'sell', quantity: '1', price: '180', tradeDate: '2026-10-04' });
  const st = await api('GET', '/stats?from=2026-01-01&to=2026-12-31&currency=USD');
  if (st.invest?.gain !== 3000) throw new Error(`stock gain ${JSON.stringify(st.invest)}`);
});
await step('credit usage + over-limit reminder', async () => {
  const card = await api('POST', '/accounts', { institutionId: inst.id, name: 'Visa', type: 'credit', currencies: [{ currency: 'USD', openingBalance: -120000 }], openingDate: '2026-01-01', creditLimit: 100000 });
  if (!card.creditUsage?.over) throw new Error(JSON.stringify(card.creditUsage));
  if (!(await api('GET', '/reminders')).some((r) => r.kind === 'over_limit')) throw new Error('no over-limit reminder');
});
await step('hidden spending + trade legs left out of the list', async () => {
  const tag = await api('POST', '/tags', { name: 'hidden' });
  await api('POST', '/transactions', { type: 'expense', accountId: acc.id, amount: 300, occurredAt: '2026-10-05', counterparty: 'Snack', tagIds: [tag.id] });
  const list = await api('GET', '/transactions?pageSize=200');
  if (list.items.some((x) => x.counterparty === 'Snack' || x.type === 'trade')) throw new Error('hidden or trade rows listed');
  if (!(await api('GET', '/transactions?hidden=1&pageSize=200')).items.some((x) => x.counterparty === 'Snack')) throw new Error('hidden=1 missing row');
  const st = await api('GET', '/stats?from=2026-01-01&to=2026-12-31&currency=USD');
  if (!st.stockFlows || st.stockFlows.buy !== 30000) throw new Error(`stock flows ${JSON.stringify(st.stockFlows)}`);
});
await step('profile picture', () => api('PATCH', '/auth/profile', { avatar: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' }));
await step('config save (DB-backed)', async () => {
  const cfg = await api('GET', '/config');
  cfg.customFields.account.push({ key: 'status', label: '账户状态', type: 'text', showInTable: true, required: false, order: 0 });
  const r = await api('PUT', '/config', { config: cfg });
  if (!r.changed) throw new Error('config not saved');
});
console.log('\nAll Cloudflare runtime checks passed.');
