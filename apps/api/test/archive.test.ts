import { createClient } from '@libsql/client';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, openLibsql } from '../src/db/client.ts';
import { historicalRecords, transactions } from '../src/db/schema.ts';
import { runBatch } from '../src/lib/ledger.ts';
import { insertLegOps, insertLegOpsWhen } from '../src/routes/transactions.ts';
import { ACCEPTED_ROWS, REFUSED_ROWS } from './archive-rows.ts';
import { client, dbClient, login, makeUser, setup, withDbDir, type TestEnv } from './helpers.ts';
import { account, failsWith, ledger } from './archive-util.ts';
import { interleave } from './interleave.ts';
import { BILL_RESETS, strayLegs } from './bill-resets.ts';
import { LINK_RACES, linkProblems } from './link-races.ts';
import { schemaDrift, type Query } from './schema-check.ts';

/** Historical records (Phase 2D): kept apart from the ledger until linked or converted. */

let t: TestEnv;
type C = ReturnType<typeof client>;

const txCount = async () => (await t.db.select().from(transactions)).length;


describe('historical records', () => {
  let a: C;
  let bank: string;
  let cny: string;
  let hkd: string;
  let multi: string;

  const rec = async (b: Record<string, unknown>, c: C = a) => {
    const r = await c.post('/api/archive', b);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json;
  };
  const tx = async (b: Record<string, unknown>) => {
    const r = await a.post('/api/transactions', b);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json;
  };
  const balance = async (id: string, cur: string) => (await a.get(`/api/accounts/${id}`)).json.currencies.find((x: any) => x.currency === cur).balance as number;
  /** A record that passes every conversion check (as a verified expense of 12.34 CNY on 2023-05-06). */
  const ready = (extra: Record<string, unknown> = {}) => ({
    title: 'Ready',
    recordType: 'expense',
    datePrecision: 'day',
    dateFrom: '2023-05-06',
    dateTo: '2023-05-06',
    amount: 1234,
    currency: 'CNY',
    accountId: cny,
    verificationStatus: 'verified',
    ...extra,
  });

  beforeEach(async () => {
    t = await setup();
    a = await login(t, await makeUser(t, 'alice'));
    bank = (await a.post('/api/institutions', { name: 'HSBC', country: 'HK', type: 'bank' })).json.id;
    cny = await account(a, bank, 'CNY', [{ currency: 'CNY', openingBalance: 100_000 }]);
    hkd = await account(a, bank, 'HKD', [{ currency: 'HKD', openingBalance: 0 }], 'savings');
    multi = await account(a, bank, 'Multi', [
      { currency: 'CNY', openingBalance: 50_000 },
      { currency: 'USD', openingBalance: 10_000 },
    ]);
  });
  afterEach(() => t.cleanup());

  it('saves a record with only a title: unknown type and date, nothing filled in', async () => {
    const r = await rec({ title: '  某笔记不清的旧账  ' });
    expect(r).toMatchObject({
      title: '某笔记不清的旧账',
      recordType: 'unknown',
      status: 'open',
      datePrecision: 'unknown',
      dateFrom: null,
      dateTo: null,
      occurredTime: null,
      timeZone: null,
      amount: null,
      currency: null,
      accountId: null,
      purpose: null,
      verificationStatus: 'pending',
      linkedTransactionId: null,
      convertedAt: null,
      linkLostAt: null,
      linkedTransactions: [],
    });
    expect(r.convertBlockers).toEqual(['type']);
    expect((await a.get(`/api/archive/${r.id}`)).json).toEqual(r);
    // A blank title is not a title.
    expect((await a.post('/api/archive', { title: '   ' })).status).toBe(400);
    expect((await a.post('/api/archive', {})).status).toBe(400);
  });

  it('stores each date precision in its one shape and returns it unchanged', async () => {
    const day = await rec({ title: 'day', datePrecision: 'day', dateFrom: '2024-03-10', dateTo: '2024-03-10', occurredTime: '02:30', timeZone: 'america/new_york' });
    // 02:30 on New York's DST day does not exist there; the text is kept exactly as entered.
    expect(day).toMatchObject({ dateFrom: '2024-03-10', dateTo: '2024-03-10', occurredTime: '02:30', timeZone: 'America/New_York' });
    const month = await rec({ title: 'month', datePrecision: 'month', dateFrom: '2024-02-01', dateTo: '2024-02-29' });
    expect(month).toMatchObject({ datePrecision: 'month', dateFrom: '2024-02-01', dateTo: '2024-02-29', occurredTime: null });
    const year = await rec({ title: 'year', datePrecision: 'year', dateFrom: '2019-01-01', dateTo: '2019-12-31' });
    expect(year).toMatchObject({ dateFrom: '2019-01-01', dateTo: '2019-12-31' });
    const range = await rec({ title: 'range', datePrecision: 'range', dateFrom: '2021-11-20', dateTo: '2022-01-05' });
    expect(range).toMatchObject({ dateFrom: '2021-11-20', dateTo: '2022-01-05' });
    for (const r of [day, month, year, range]) expect((await a.get(`/api/archive/${r.id}`)).json).toEqual(r);
    // Only the exact day can be converted as far as the date goes.
    expect(day.convertBlockers).not.toContain('date');
    for (const r of [month, year, range]) expect(r.convertBlockers).toEqual(['type']);
    const asExpense = await rec({ title: 'month expense', recordType: 'expense', datePrecision: 'month', dateFrom: '2024-02-01', dateTo: '2024-02-29' });
    expect(asExpense.convertBlockers).toContain('date');

    const bad = [
      { datePrecision: 'day', dateFrom: '2024-03-10', dateTo: '2024-03-11' },
      { datePrecision: 'day', dateFrom: '2024-03-10' },
      { datePrecision: 'month', dateFrom: '2024-02-01', dateTo: '2024-02-28' }, // 2024 is a leap year
      { datePrecision: 'month', dateFrom: '2024-02-05', dateTo: '2024-02-29' },
      { datePrecision: 'year', dateFrom: '2019-01-01', dateTo: '2019-12-30' },
      { datePrecision: 'range', dateFrom: '2022-01-05', dateTo: '2021-11-20' },
      { datePrecision: 'range', dateFrom: '2022-01-05' },
      { datePrecision: 'unknown', dateFrom: '2022-01-05', dateTo: '2022-01-05' },
      { datePrecision: 'month', dateFrom: '2024-02-01', dateTo: '2024-02-29', occurredTime: '10:00' },
      { datePrecision: 'year', dateFrom: '2019-01-01', dateTo: '2019-12-31', timeZone: 'Asia/Shanghai' },
      { datePrecision: 'unknown', occurredTime: '10:00' },
      { datePrecision: 'day', dateFrom: '2024-02-30', dateTo: '2024-02-30' },
      { datePrecision: 'day', dateFrom: '2024-03-10', dateTo: '2024-03-10', occurredTime: '24:00' },
    ];
    for (const b of bad) expect((await a.post('/api/archive', { title: 'bad', ...b })).status, JSON.stringify(b)).toBe(400);

    // The table refuses the same shapes even without the API — real calendar dates included.
    const userId = (await a.get('/api/auth/me')).json.user.id as string;
    let n = 0;
    const raw = (v: Record<string, unknown>) =>
      t.db.insert(historicalRecords).values({ id: `raw${n++}`, userId, title: 'raw', recordType: 'unknown', datePrecision: 'unknown', createdAt: 1, updatedAt: 1, ...v } as never);
    for (const [name, v] of REFUSED_ROWS) await failsWith(raw(v), /CHECK constraint failed/).catch((e) => Promise.reject(new Error(`${name}: ${e.message}`)));
    for (const [, v] of ACCEPTED_ROWS) await raw(v);
  });

  it('saves records with the amount, currency or account missing — but never an amount without its currency', async () => {
    const noAmount = await rec({ title: 'no amount', recordType: 'expense', accountId: cny, currency: 'CNY' });
    expect(noAmount).toMatchObject({ amount: null, currency: 'CNY', accountId: cny });
    expect(noAmount.convertBlockers).toEqual(expect.arrayContaining(['unverified', 'date', 'amount']));
    const noAccount = await rec({ title: 'no account', recordType: 'income', amount: 500, currency: 'USD' });
    expect(noAccount).toMatchObject({ amount: 500, currency: 'USD', accountId: null });
    expect(noAccount.convertBlockers).toContain('account');
    const noCurrency = await rec({ title: 'currency only', recordType: 'transfer', currency: 'HKD' });
    expect(noCurrency.convertBlockers).toEqual(expect.arrayContaining(['amount', 'fromAccount', 'toAccount', 'toCurrency']));

    for (const b of [{ amount: 100 }, { toAmount: 100 }, { feeAmount: 5 }]) expect((await a.post('/api/archive', { title: 'x', ...b })).status).toBe(400);
    for (const b of [{ amount: 0, currency: 'CNY' }, { amount: -5, currency: 'CNY' }, { amount: 1.5, currency: 'CNY' }, { currency: 'XXX' }, { assetQuantity: '1e5' }, { assetQuantity: '0' }]) {
      expect((await a.post('/api/archive', { title: 'x', ...b })).status, JSON.stringify(b)).toBe(400);
    }
  });

  it('never changes balances, net worth, statistics or the transaction views', async () => {
    await tx({ type: 'expense', accountId: cny, amount: 2000, occurredAt: '2026-10-01', counterparty: 'Shop' });
    await tx({ type: 'income', accountId: multi, currency: 'USD', amount: 3000, occurredAt: '2026-10-02' });
    const linkable = await tx({ type: 'expense', accountId: cny, amount: 700, occurredAt: '2026-10-03', counterparty: 'Cafe' });
    const before = await ledger(a);
    const n = await txCount();

    const r1 = await rec(ready({ title: 'big expense', amount: 9_999_999, dateFrom: '2026-10-05', dateTo: '2026-10-05' }));
    const r2 = await rec({ title: 'old salary', recordType: 'income', amount: 500_000, currency: 'USD', accountId: multi, datePrecision: 'month', dateFrom: '2026-10-01', dateTo: '2026-10-31' });
    const r3 = await rec({ title: 'transfer', recordType: 'transfer', amount: 100, currency: 'CNY', fromAccountId: cny, toAccountId: hkd, toAmount: 110, toCurrency: 'HKD' });
    await a.put(`/api/archive/${r1.id}`, ready({ title: 'big expense (edited)', amount: 1, note: 'n' }));
    await a.patch(`/api/archive/${r2.id}/verification`, { verificationStatus: 'partial' });
    await a.post(`/api/archive/${r3.id}/dismiss`);
    await a.post(`/api/archive/${r3.id}/reopen`);
    expect((await a.post(`/api/archive/${r1.id}/link`, { transactionId: linkable.id })).status).toBe(200);
    expect((await a.post(`/api/archive/${r1.id}/unlink`)).status).toBe(200);
    expect((await a.post(`/api/archive/${r1.id}/link`, { transactionId: linkable.id })).status).toBe(200);
    // Refused conversions leave nothing behind either.
    expect((await a.post(`/api/archive/${r2.id}/convert`)).status).toBe(400);

    expect(await ledger(a)).toEqual(before);
    expect(await txCount()).toBe(n);
  });

  it('keeps every user to their own records, accounts and transactions', async () => {
    const b = await login(t, await makeUser(t, 'bob'));
    const bobBank = (await b.post('/api/institutions', { name: 'CMB', country: 'CN', type: 'bank' })).json.id;
    const bobAcc = await account(b, bobBank, 'Bob CNY', [{ currency: 'CNY', openingBalance: 1000 }]);
    const bobTx = (await b.post('/api/transactions', { type: 'expense', accountId: bobAcc, amount: 100, occurredAt: '2026-10-01' })).json;
    const mine = await rec(ready());
    const aliceTx = await tx({ type: 'expense', accountId: cny, amount: 100, occurredAt: '2026-10-01' });

    // Bob can't see or touch Alice's record: it doesn't exist for him.
    expect((await b.get('/api/archive?status=all')).json).toMatchObject({ items: [], total: 0, counts: { open: 0, linked: 0, converted: 0, dismissed: 0 } });
    for (const [method, path, body] of [
      ['GET', `/api/archive/${mine.id}`, undefined],
      ['PUT', `/api/archive/${mine.id}`, { title: 'hijack' }],
      ['PATCH', `/api/archive/${mine.id}/verification`, { verificationStatus: 'pending' }],
      ['POST', `/api/archive/${mine.id}/dismiss`, {}],
      ['POST', `/api/archive/${mine.id}/link`, { transactionId: bobTx.id }],
      ['POST', `/api/archive/${mine.id}/unlink`, {}],
      ['POST', `/api/archive/${mine.id}/convert`, {}],
    ] as const) {
      expect((await b.req(method, path, body)).status, `${method} ${path}`).toBe(404);
    }
    // Alice can't reference Bob's account or link Bob's transaction; Bob can't link Alice's.
    expect((await a.post('/api/archive', { title: 'x', accountId: bobAcc })).status).toBe(404);
    expect((await a.post('/api/archive', { title: 'x', recordType: 'transfer', fromAccountId: cny, toAccountId: bobAcc })).status).toBe(404);
    expect((await a.put(`/api/archive/${mine.id}`, ready({ accountId: bobAcc }))).status).toBe(404);
    expect((await a.post(`/api/archive/${mine.id}/link`, { transactionId: bobTx.id })).status).toBe(404);
    const bobRec = await rec({ title: 'bob', recordType: 'expense' }, b);
    expect((await b.post(`/api/archive/${bobRec.id}/link`, { transactionId: aliceTx.id })).status).toBe(404);

    const after = (await a.get(`/api/archive/${mine.id}`)).json;
    expect(after).toEqual(mine);
    expect((await b.get(`/api/accounts/${bobAcc}`)).json.currencies[0].balance).toBe(900);
  });

  it('links an existing transaction once, by type, without booking anything', async () => {
    const expense = await tx({ type: 'expense', accountId: cny, amount: 800, occurredAt: '2026-09-01' });
    const income = await tx({ type: 'income', accountId: cny, amount: 900, occurredAt: '2026-09-02' });
    const before = await ledger(a);
    const r = await rec({ title: 'receipt', recordType: 'expense' });
    const other = await rec({ title: 'same receipt again', recordType: 'expense' });

    expect((await a.post(`/api/archive/${r.id}/link`, { transactionId: income.id })).json.code).toBe('ARCHIVE_TYPE_MISMATCH');
    expect((await a.post(`/api/archive/${r.id}/link`, { transactionId: 'nope' })).status).toBe(404);
    const linked = await a.post(`/api/archive/${r.id}/link`, { transactionId: expense.id });
    expect(linked.status).toBe(200);
    expect(linked.json).toMatchObject({ status: 'linked', linkedTransactionId: expense.id, convertedAt: null });
    expect(linked.json.linkedTransactions.map((x: any) => x.id)).toEqual([expense.id]);
    expect(linked.json.convertBlockers).toContain('status');

    // Not twice: neither another record nor the same one again.
    const dup = await a.post(`/api/archive/${other.id}/link`, { transactionId: expense.id });
    expect([dup.status, dup.json.code]).toEqual([409, 'ARCHIVE_TX_TAKEN']);
    expect((await a.post(`/api/archive/${r.id}/link`, { transactionId: income.id })).json.code).toBe('ARCHIVE_STATUS');
    // The unique index backs this up below the API.
    await failsWith(t.db.update(historicalRecords).set({ status: 'linked', linkedTransactionId: expense.id }).where(eq(historicalRecords.id, other.id)), /UNIQUE/);
    // An other / unknown record may match any ordinary entry.
    const unknown = await rec({ title: 'something' });
    expect((await a.post(`/api/archive/${unknown.id}/link`, { transactionId: income.id })).json.status).toBe('linked');
    // Dismissed records are not linked; unlinking gives the record back.
    await a.post(`/api/archive/${other.id}/dismiss`);
    expect((await a.post(`/api/archive/${other.id}/link`, { transactionId: expense.id })).json.code).toBe('ARCHIVE_STATUS');
    const un = await a.post(`/api/archive/${r.id}/unlink`);
    expect(un.json).toMatchObject({ status: 'open', linkedTransactionId: null, linkLostAt: null, linkedTransactions: [] });
    expect((await a.post(`/api/archive/${r.id}/unlink`)).json.code).toBe('ARCHIVE_STATUS');
    expect(await ledger(a)).toEqual(before);
  });

  it('links a transfer through its sending leg, whichever leg was picked', async () => {
    const x = await tx({ type: 'transfer', fromAccountId: cny, toAccountId: hkd, amount: 1000, toAmount: 1080, occurredAt: '2026-09-03' });
    const legs = (await a.get('/api/transactions?type=transfer')).json.items;
    const inLeg = legs.find((l: any) => l.amount > 0);
    const r = await rec({ title: 'wire', recordType: 'transfer' });
    const linked = (await a.post(`/api/archive/${r.id}/link`, { transactionId: inLeg.id })).json;
    expect(linked.linkedTransactionId).toBe(x.id);
    expect(linked.linkedTransactions.map((l: any) => [l.id, l.amount])).toEqual([
      [x.id, -1000],
      [inLeg.id, 1080],
    ]);
    // The other leg belongs to the same entry, so it is taken too.
    const again = await rec({ title: 'wire copy', recordType: 'transfer' });
    expect((await a.post(`/api/archive/${again.id}/link`, { transactionId: x.id })).json.code).toBe('ARCHIVE_TX_TAKEN');
    expect((await a.post(`/api/archive/${again.id}/link`, { transactionId: inLeg.id })).json.code).toBe('ARCHIVE_TX_TAKEN');
  });

  it('refuses to convert what is unverified, not exact to the day, incomplete or not open', async () => {
    const n = await txCount();
    const cases: [Record<string, unknown>, string[]][] = [
      [{ verificationStatus: 'pending' }, ['unverified']],
      [{ verificationStatus: 'partial' }, ['unverified']],
      [{ datePrecision: 'month', dateFrom: '2023-05-01', dateTo: '2023-05-31' }, ['date']],
      [{ datePrecision: 'range', dateFrom: '2023-05-01', dateTo: '2023-05-03' }, ['date']],
      [{ datePrecision: 'unknown', dateFrom: null, dateTo: null }, ['date']],
      [{ accountId: null }, ['account']],
      [{ amount: null }, ['amount']],
      [{ amount: null, currency: null }, ['amount', 'currency']],
      [{ feeAmount: 100, feeCurrency: 'CNY' }, ['fee']],
      [{ recordType: 'transfer', accountId: null, fromAccountId: cny }, ['toAccount', 'toCurrency']],
      [{ recordType: 'transfer', accountId: null, fromAccountId: cny, toAccountId: hkd, toCurrency: 'HKD' }, ['toAmount']],
      [{ recordType: 'transfer', accountId: null, fromAccountId: cny, toAccountId: multi, toCurrency: 'CNY', toAmount: 999 }, ['toAmount']],
    ];
    for (const [patch, blockers] of cases) {
      const r = await rec(ready(patch));
      expect(r.convertBlockers, JSON.stringify(patch)).toEqual(blockers);
      const res = await a.post(`/api/archive/${r.id}/convert`);
      expect([res.status, res.json.code, res.json.details], JSON.stringify(patch)).toEqual([400, 'ARCHIVE_NOT_READY', blockers]);
      expect((await a.get(`/api/archive/${r.id}`)).json).toEqual(r);
    }
    // Ledger rules still apply: the currency must be held by the account.
    const usd = await rec(ready({ currency: 'USD' }));
    expect(usd.convertBlockers).toEqual([]);
    expect((await a.post(`/api/archive/${usd.id}/convert`)).json.code).toBe('CURRENCY_NOT_HELD');
    // Dismissed records are kept, not converted.
    const dismissed = await rec(ready());
    await a.post(`/api/archive/${dismissed.id}/dismiss`);
    expect((await a.post(`/api/archive/${dismissed.id}/convert`)).json).toMatchObject({ code: 'ARCHIVE_STATUS' });
    expect(await txCount()).toBe(n);
    expect(await balance(cny, 'CNY')).toBe(100_000);
  });

  it('converts an expense and an income into one transaction each, with their details', async () => {
    const e = await rec(
      ready({
        title: '年费',
        dateFrom: '2026-03-08',
        dateTo: '2026-03-08',
        occurredTime: '02:30',
        timeZone: 'America/New_York',
        counterparty: 'Bank',
        purpose: 'card fee',
        paymentChannel: 'card',
        referenceNumber: 'REF-1',
        evidenceSource: 'statement',
        note: 'from the 2026 statement',
        exchangeRate: '7.123456789',
      }),
    );
    const converted = await a.post(`/api/archive/${e.id}/convert`);
    expect(converted.status, JSON.stringify(converted.json)).toBe(200);
    const [txDto] = converted.json.linkedTransactions;
    expect(converted.json).toMatchObject({ status: 'converted', linkedTransactionId: txDto.id, convertedAt: t.clock.t, convertBlockers: ['status'] });
    expect(converted.json.linkedTransactions).toHaveLength(1);
    expect(txDto).toMatchObject({
      type: 'expense',
      accountId: cny,
      amount: -1234,
      currency: 'CNY',
      occurredAt: '2026-03-08',
      occurredTime: '02:30',
      timeZone: 'America/New_York',
      counterparty: 'Bank',
      purpose: 'card fee',
      paymentChannel: 'card',
      referenceNumber: 'REF-1',
      evidenceSource: 'statement',
      verificationStatus: 'verified',
      note: 'from the 2026 statement',
      transferGroupId: null,
      categoryId: null,
      tagIds: [],
    });
    expect(await balance(cny, 'CNY')).toBe(100_000 - 1234);

    const i = await rec(ready({ title: 'refund', recordType: 'income', amount: 5000, currency: 'USD', accountId: multi, dateFrom: '2026-10-01', dateTo: '2026-10-01' }));
    const income = (await a.post(`/api/archive/${i.id}/convert`)).json.linkedTransactions[0];
    expect(income).toMatchObject({ type: 'income', accountId: multi, currency: 'USD', amount: 5000, occurredAt: '2026-10-01', occurredTime: null });
    expect(await balance(multi, 'USD')).toBe(15_000);
    expect(await balance(multi, 'CNY')).toBe(50_000);
    // From now on it is an ordinary entry: listed, counted in the statistics.
    const stats = (await a.get('/api/stats?from=2026-01-01&to=2026-12-31&currency=USD')).json;
    expect(stats.totals.income).toBe(5000);
  });

  it('converts same-currency and cross-currency transfers into exactly one pair of legs', async () => {
    const n = await txCount();
    const same = await rec(ready({ recordType: 'transfer', accountId: null, fromAccountId: cny, toAccountId: multi, currency: 'CNY', toCurrency: 'CNY', amount: 3000, dateFrom: '2025-01-02', dateTo: '2025-01-02' }));
    const s = (await a.post(`/api/archive/${same.id}/convert`)).json;
    expect(s.linkedTransactions.map((l: any) => [l.accountId, l.amount, l.currency])).toEqual([
      [cny, -3000, 'CNY'],
      [multi, 3000, 'CNY'],
    ]);
    expect(s.linkedTransactionId).toBe(s.linkedTransactions[0].id);
    expect(new Set(s.linkedTransactions.map((l: any) => l.transferGroupId)).size).toBe(1);

    const cross = await rec(ready({ recordType: 'transfer', accountId: null, fromAccountId: multi, toAccountId: hkd, currency: 'USD', toCurrency: 'HKD', amount: 1000, toAmount: 7_800, dateFrom: '2025-02-03', dateTo: '2025-02-03' }));
    const x = (await a.post(`/api/archive/${cross.id}/convert`)).json;
    expect(x.linkedTransactions.map((l: any) => [l.accountId, l.amount, l.currency, l.counterpartAmount])).toEqual([
      [multi, -1000, 'USD', 7800],
      [hkd, 7800, 'HKD', -1000],
    ]);
    // Same account, two of its currencies: allowed like a manual transfer.
    const exchange = await rec(ready({ recordType: 'transfer', accountId: null, fromAccountId: multi, toAccountId: multi, currency: 'CNY', toCurrency: 'USD', amount: 7_000, toAmount: 1_000 }));
    expect((await a.post(`/api/archive/${exchange.id}/convert`)).status).toBe(200);

    const rows = await t.db.select().from(transactions);
    expect(rows).toHaveLength(n + 6);
    expect(new Set(rows.map((r) => r.transferGroupId)).size).toBe(3);
    expect(await balance(cny, 'CNY')).toBe(97_000);
    expect(await balance(multi, 'CNY')).toBe(50_000 + 3000 - 7000);
    expect(await balance(multi, 'USD')).toBe(10_000 - 1000 + 1000);
    expect(await balance(hkd, 'HKD')).toBe(7800);
    // Transfers stay out of income / expense.
    const stats = (await a.get('/api/stats?from=2025-01-01&to=2025-12-31')).json;
    expect(stats.totals).toMatchObject({ income: 0, expense: 0 });
  });

  it('books a record once, however often (or concurrently) convert is sent', async () => {
    const n = await txCount();
    const r = await rec(ready());
    const results = await Promise.all([1, 2, 3].map(() => a.post(`/api/archive/${r.id}/convert`)));
    expect(results.map((x) => x.status).sort()).toEqual([200, 409, 409]);
    for (const x of results.filter((x) => x.status === 409)) expect(['ARCHIVE_CHANGED', 'ARCHIVE_STATUS']).toContain(x.json.code);
    expect((await a.post(`/api/archive/${r.id}/convert`)).json.code).toBe('ARCHIVE_STATUS');
    expect(await txCount()).toBe(n + 1);
    expect(await balance(cny, 'CNY')).toBe(100_000 - 1234);

    // Same for a transfer: one pair, never two.
    const x = await rec(ready({ recordType: 'transfer', accountId: null, fromAccountId: cny, toAccountId: hkd, toCurrency: 'HKD', toAmount: 1300 }));
    await Promise.all([1, 2].map(() => a.post(`/api/archive/${x.id}/convert`)));
    expect(await txCount()).toBe(n + 3);
    // A link racing a conversion: only one wins.
    const y = await rec(ready());
    const existing = await tx({ type: 'expense', accountId: cny, amount: 1, occurredAt: '2026-01-01' });
    const race = await Promise.all([a.post(`/api/archive/${y.id}/convert`), a.post(`/api/archive/${y.id}/link`, { transactionId: existing.id })]);
    expect(race.filter((res) => res.status === 200)).toHaveLength(1);
    const final = (await a.get(`/api/archive/${y.id}`)).json;
    expect(['converted', 'linked']).toContain(final.status);
    expect(await txCount()).toBe(n + 4 + (final.status === 'converted' ? 1 : 0));
  });

  describe('requests acting on an older version of a record', () => {
    type Res = { status: number; json: any };
    /** `run`'s request, with `other` landing between its read and its write, in the same millisecond. */
    const meanwhile = async (other: () => Promise<unknown>, run: () => Promise<Res>): Promise<Res> => {
      let res: Res | undefined;
      expect(await interleave(t.deps, other, async () => (res = await run()))).toBe(true);
      return res!;
    };
    const get = async (id: string) => (await a.get(`/api/archive/${id}`)).json;

    it('refuses a conversion when the amount and verification changed in the same millisecond', async () => {
      const r = await rec(ready({ amount: 100 }));
      const before = await ledger(a);
      const n = await txCount();
      const res = await meanwhile(
        () => a.put(`/api/archive/${r.id}`, ready({ amount: 900, verificationStatus: 'pending' })),
        () => a.post(`/api/archive/${r.id}/convert`),
      );
      expect([res.status, res.json.code]).toEqual([409, 'ARCHIVE_CHANGED']);
      // No transaction, no balance, net worth or statistics change.
      expect(await txCount()).toBe(n);
      expect(await ledger(a)).toEqual(before);
      // The record holds the other request's content, still open, in the same millisecond.
      expect(await get(r.id)).toMatchObject({ status: 'open', amount: 900, verificationStatus: 'pending', linkedTransactionId: null, convertedAt: null, version: 2, updatedAt: r.updatedAt });
    });

    it('refuses a conversion when only the verification changed, or only a note', async () => {
      const r = await rec(ready());
      const before = await ledger(a);
      const n = await txCount();
      const res = await meanwhile(() => a.patch(`/api/archive/${r.id}/verification`, { verificationStatus: 'partial' }), () => a.post(`/api/archive/${r.id}/convert`));
      expect([res.status, res.json.code]).toEqual([409, 'ARCHIVE_CHANGED']);
      expect(await get(r.id)).toMatchObject({ status: 'open', verificationStatus: 'partial', version: 2 });
      // Still convertible after the change, but the user hasn't seen it: refused all the same.
      const s = await rec(ready());
      const res2 = await meanwhile(() => a.put(`/api/archive/${s.id}`, ready({ note: 'added meanwhile' })), () => a.post(`/api/archive/${s.id}/convert`));
      expect([res2.status, res2.json.code]).toEqual([409, 'ARCHIVE_CHANGED']);
      expect(await txCount()).toBe(n);
      expect(await ledger(a)).toEqual(before);
      // Once re-read, the conversion goes through, with what the record says now.
      const ok = await a.post(`/api/archive/${s.id}/convert`, { version: 2 });
      expect(ok.status).toBe(200);
      expect(ok.json.linkedTransactions[0]).toMatchObject({ amount: -1234, note: 'added meanwhile' });
    });

    it('never writes one leg of a cross-currency transfer without the other', async () => {
      const body = ready({ recordType: 'transfer', accountId: null, fromAccountId: multi, toAccountId: hkd, currency: 'USD', toCurrency: 'HKD', amount: 1000, toAmount: 7800 });
      const r = await rec(body);
      const before = await ledger(a);
      const legs = async () => (await t.db.select().from(transactions).where(eq(transactions.type, 'transfer'))).length;
      const res = await meanwhile(() => a.put(`/api/archive/${r.id}`, { ...body, toAmount: 7900 }), () => a.post(`/api/archive/${r.id}/convert`));
      expect([res.status, res.json.code]).toEqual([409, 'ARCHIVE_CHANGED']);
      expect(await legs()).toBe(0);
      expect(await ledger(a)).toEqual(before);
      const ok = (await a.post(`/api/archive/${r.id}/convert`)).json;
      expect(ok.linkedTransactions.map((l: any) => [l.accountId, l.amount, l.currency])).toEqual([
        [multi, -1000, 'USD'],
        [hkd, 7900, 'HKD'],
      ]);
      expect(await legs()).toBe(2);
    });

    it('guards a conversion twice: the legs alone write nothing for a stale version, and a failing status guard rolls back legs written without one', async () => {
      const r = await rec(ready());
      const userId = (await a.get('/api/auth/me')).json.user.id as string;
      const before = await ledger(a);
      const n = await txCount();
      const now = t.clock.t;
      const base = { cardId: null, categoryId: null, counterparty: null, note: null, extra: { k: 'v' }, occurredAt: '2026-01-01' };
      const transfer = [
        { ...base, role: 'from', type: 'transfer', accountId: multi, currency: 'USD', amount: -100 },
        { ...base, role: 'to', type: 'transfer', accountId: hkd, currency: 'HKD', amount: 780 },
      ] as never[];
      const stale = sql`exists (select 1 from ${historicalRecords} where ${historicalRecords.id} = ${r.id} and ${historicalRecords.version} = ${r.version + 1})`;
      // 1. Conditional legs at a version the record isn't at: nothing written, even with no other guard.
      await runBatch(t.db, insertLegOpsWhen(t.db, userId, transfer, now, stale).ops);
      expect(await txCount()).toBe(n);
      expect(await ledger(a)).toEqual(before);
      // 2. Unconditional legs followed by the status guard at a stale version: the batch fails and both legs are rolled back.
      const guard = t.db
        .update(historicalRecords)
        .set({ status: sql`case when ${historicalRecords.version} = ${r.version + 1} then 'converted' else null end` })
        .where(eq(historicalRecords.id, r.id));
      await failsWith(runBatch(t.db, [...insertLegOps(t.db, userId, transfer, [], now).ops, guard]), /NOT NULL constraint failed: historical_records\.status/);
      expect(await txCount()).toBe(n);
      expect(await ledger(a)).toEqual(before);
      // 3. At the right version the conditional legs are written in full, exactly like a plain insert.
      const current = sql`exists (select 1 from ${historicalRecords} where ${historicalRecords.id} = ${r.id} and ${historicalRecords.version} = ${r.version})`;
      const written = insertLegOpsWhen(t.db, userId, transfer, now, current);
      await runBatch(t.db, written.ops);
      const stored = await t.db.select().from(transactions).where(eq(transactions.transferGroupId, written.rows[0]!.transferGroupId!));
      expect(stored.map((s) => [s.accountId, s.amount, s.currency, s.extra, s.occurredTime])).toEqual(
        expect.arrayContaining([
          [multi, -100, 'USD', { k: 'v' }, null],
          [hkd, 780, 'HKD', { k: 'v' }, null],
        ]),
      );
      expect(stored).toHaveLength(2);
      expect(await balance(hkd, 'HKD')).toBe(780);
    });

    it('refuses every action sent with a version the record has moved past', async () => {
      const r = await rec(ready());
      const existing = await tx({ type: 'expense', accountId: cny, amount: 1, occurredAt: '2026-01-01' });
      await a.put(`/api/archive/${r.id}`, ready({ note: 'v2' }));
      const before = await ledger(a);
      const stale = { version: 1 };
      for (const [method, path, b] of [
        ['PUT', `/api/archive/${r.id}`, { ...ready({ note: 'overwrite' }), ...stale }],
        ['PATCH', `/api/archive/${r.id}/verification`, { verificationStatus: 'pending', ...stale }],
        ['POST', `/api/archive/${r.id}/dismiss`, stale],
        ['POST', `/api/archive/${r.id}/link`, { transactionId: existing.id, ...stale }],
        ['POST', `/api/archive/${r.id}/convert`, stale],
      ] as const) {
        const res = await a.req(method, path, b);
        expect([res.status, res.json.code], `${method} ${path}`).toEqual([409, 'ARCHIVE_CHANGED']);
      }
      expect(await get(r.id)).toMatchObject({ version: 2, note: 'v2', status: 'open', verificationStatus: 'verified' });
      expect(await ledger(a)).toEqual(before);
      // The current version works.
      expect((await a.post(`/api/archive/${r.id}/dismiss`, { version: 2 })).json).toMatchObject({ status: 'dismissed', version: 3 });
    });

    it('refuses single-statement writes (edit, link, dismiss, unlink) that lost the race', async () => {
      const r = await rec(ready());
      const e1 = await tx({ type: 'expense', accountId: cny, amount: 1, occurredAt: '2026-01-01' });
      // A link loses to an edit…
      let res = await meanwhile(() => a.put(`/api/archive/${r.id}`, ready({ note: 'edited' })), () => a.post(`/api/archive/${r.id}/link`, { transactionId: e1.id }));
      expect([res.status, res.json.code]).toEqual([409, 'ARCHIVE_CHANGED']);
      expect(await get(r.id)).toMatchObject({ status: 'open', linkedTransactionId: null, note: 'edited', version: 2 });
      // …an edit loses to a dismissal…
      res = await meanwhile(() => a.post(`/api/archive/${r.id}/dismiss`), () => a.put(`/api/archive/${r.id}`, ready({ note: 'late edit' })));
      expect([res.status, res.json.code]).toEqual([409, 'ARCHIVE_CHANGED']);
      expect(await get(r.id)).toMatchObject({ status: 'dismissed', note: 'edited', version: 3 });
      // …and an unlink loses to the transaction being deleted.
      await a.post(`/api/archive/${r.id}/reopen`);
      await a.post(`/api/archive/${r.id}/link`, { transactionId: e1.id });
      res = await meanwhile(() => a.del(`/api/transactions/${e1.id}`), () => a.post(`/api/archive/${r.id}/unlink`));
      expect([res.status, res.json.code]).toEqual([409, 'ARCHIVE_CHANGED']);
      expect(await get(r.id)).toMatchObject({ status: 'open', linkedTransactionId: null, linkLostAt: t.clock.t, version: 6 });
    });

    it('increments the version on every write, and only on writes', async () => {
      const v = async (id: string) => (await get(id)).version as number;
      const r = await rec(ready());
      expect(r.version).toBe(1);
      const steps: [string, () => Promise<unknown>][] = [
        ['edit', () => a.put(`/api/archive/${r.id}`, ready({ note: 'n' }))],
        ['verification', () => a.patch(`/api/archive/${r.id}/verification`, { verificationStatus: 'partial' })],
        ['dismiss', () => a.post(`/api/archive/${r.id}/dismiss`)],
        ['reopen', () => a.post(`/api/archive/${r.id}/reopen`)],
      ];
      let expected = 1;
      for (const [name, step] of steps) {
        await step();
        expect(await v(r.id), name).toBe(++expected);
      }
      // Link → unlink → link again → the transaction deleted (release).
      const e1 = await tx({ type: 'expense', accountId: cny, amount: 1, occurredAt: '2026-01-01' });
      await a.post(`/api/archive/${r.id}/link`, { transactionId: e1.id });
      expect(await v(r.id)).toBe(++expected);
      await a.post(`/api/archive/${r.id}/unlink`);
      expect(await v(r.id)).toBe(++expected);
      await a.post(`/api/archive/${r.id}/link`, { transactionId: e1.id });
      expect(await v(r.id)).toBe(++expected);
      await a.del(`/api/transactions/${e1.id}`);
      expect(await v(r.id)).toBe(++expected);
      // Convert → the transaction deleted (release).
      await a.patch(`/api/archive/${r.id}/verification`, { verificationStatus: 'verified' });
      expected++;
      const conv = (await a.post(`/api/archive/${r.id}/convert`)).json;
      expect(conv.version).toBe(++expected);
      await a.del(`/api/transactions/${conv.linkedTransactionId}`);
      expect(await v(r.id)).toBe(++expected);
      // A transfer edited into an expense from its receiving leg: the link follows (re-anchored).
      const x = await tx({ type: 'transfer', fromAccountId: cny, toAccountId: hkd, amount: 600, toAmount: 650, occurredAt: '2026-09-04' });
      const xIn = (await a.get('/api/transactions?type=transfer')).json.items.find((l: any) => l.amount > 0);
      const u = await rec({ title: 'follows', recordType: 'unknown' });
      await a.post(`/api/archive/${u.id}/link`, { transactionId: x.id });
      expect(await v(u.id)).toBe(2);
      await a.put(`/api/transactions/${xIn.id}`, { type: 'expense', accountId: hkd, amount: 650, occurredAt: '2026-09-04' });
      expect(await get(u.id)).toMatchObject({ status: 'linked', linkedTransactionId: xIn.id, version: 3 });
      // The transaction edited into a type the record doesn't fit (release).
      const e2 = await tx({ type: 'expense', accountId: cny, amount: 2, occurredAt: '2026-01-02' });
      const w = await rec({ title: 'expense only', recordType: 'expense' });
      await a.post(`/api/archive/${w.id}/link`, { transactionId: e2.id });
      await a.put(`/api/transactions/${e2.id}`, { type: 'income', accountId: cny, amount: 2, occurredAt: '2026-01-02' });
      expect(await v(w.id)).toBe(3);
      // A bill payment undone (release).
      const bill = (await a.post('/api/bills', { name: 'Rent', kind: 'once', amount: 300, currency: 'CNY', accountId: cny, startDate: '2026-10-01', pastPolicy: 'record' })).json;
      const occ = (await a.get('/api/bills/occurrences')).json.find((o: any) => o.billId === bill.id);
      const b = await rec({ title: 'rent', recordType: 'expense' });
      await a.post(`/api/archive/${b.id}/link`, { transactionId: occ.transactionId });
      await a.post(`/api/bills/occurrences/${occ.id}/reset`);
      expect(await v(b.id)).toBe(3);

      // Refused requests and edits of other records change nothing.
      const before = await v(r.id);
      expect((await a.post(`/api/archive/${r.id}/reopen`)).status).toBe(409);
      expect((await a.put(`/api/archive/${r.id}`, ready({ amount: -1 }))).status).toBe(400);
      expect((await a.patch(`/api/archive/${r.id}/verification`, { verificationStatus: 'bogus' })).status).toBe(400);
      await a.put(`/api/archive/${w.id}`, { title: 'other record' });
      expect(await v(r.id)).toBe(before);
    });
  });

  const q: Query = async (sqlText) => (await dbClient(t.db).execute(sqlText)).rows as unknown as Record<string, unknown>[];

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
      b = await login(t, await makeUser(t, 'bob'));
      await account(b, (await b.post('/api/institutions', { name: 'CMB', country: 'CN', type: 'bank' })).json.id, 'Bob', [{ currency: 'CNY', openingBalance: 1000 }]);
    });
    afterEach(async () => expect(await linkProblems(q)).toEqual([]));
    for (const [name, run] of LINK_RACES) it(name, () => run({ a, b, deps: t.deps, q, cny, hkd }));
  });

  it('keeps a linked record to kinds that fit its transaction; unlinking lets it change', async () => {
    const e = await tx({ type: 'expense', accountId: cny, amount: 800, occurredAt: '2026-09-01' });
    const body = { title: 'receipt', recordType: 'expense', amount: 800, currency: 'CNY', accountId: cny, purpose: 'lunch' };
    const r = await rec(body);
    await a.post(`/api/archive/${r.id}/link`, { transactionId: e.id });
    const before = await ledger(a);
    for (const recordType of ['investment', 'crypto', 'income', 'transfer']) {
      const res = await a.put(`/api/archive/${r.id}`, { ...body, recordType });
      expect([res.status, res.json.code, res.json.details], recordType).toEqual([409, 'ARCHIVE_LINK_INCOMPATIBLE', { transactionType: 'expense' }]);
    }
    expect((await a.get(`/api/archive/${r.id}`)).json).toMatchObject({ recordType: 'expense', status: 'linked', linkedTransactionId: e.id, version: 2 });
    // Kinds that fit an expense are fine, and stay linked.
    for (const recordType of ['other', 'unknown', 'expense']) {
      expect((await a.put(`/api/archive/${r.id}`, { ...body, recordType })).json, recordType).toMatchObject({ recordType, status: 'linked', linkedTransactionId: e.id });
    }
    // Unlink: content kept, open again, the transaction and the ledger untouched.
    const linked = (await a.get(`/api/archive/${r.id}`)).json;
    const un = (await a.post(`/api/archive/${r.id}/unlink`)).json;
    const { status: _s, linkedTransactionId: _l, linkedTransactions: _t, version: _v, convertBlockers: _b, ...content } = linked;
    expect(un).toMatchObject({ ...content, status: 'open', linkedTransactionId: null, linkedTransactions: [], version: linked.version + 1 });
    expect((await a.get(`/api/transactions/${e.id}`)).json).toMatchObject({ id: e.id, amount: -800 });
    expect(await ledger(a)).toEqual(before);
    // Now any kind is allowed.
    expect((await a.put(`/api/archive/${r.id}`, { ...body, recordType: 'investment' })).json).toMatchObject({ recordType: 'investment', status: 'open' });

    // A transfer link doesn't fit an expense record either.
    const x = await tx({ type: 'transfer', fromAccountId: cny, toAccountId: hkd, amount: 100, toAmount: 110, occurredAt: '2026-09-02' });
    const w = await rec({ title: 'wire', recordType: 'transfer' });
    await a.post(`/api/archive/${w.id}/link`, { transactionId: x.id });
    expect((await a.put(`/api/archive/${w.id}`, { title: 'wire', recordType: 'expense' })).json.code).toBe('ARCHIVE_LINK_INCOMPATIBLE');
    // A converted record keeps its kind locked as before.
    const c = await rec(ready());
    await a.post(`/api/archive/${c.id}/convert`);
    expect((await a.put(`/api/archive/${c.id}`, ready({ recordType: 'other' }))).json.code).toBe('ARCHIVE_LOCKED');
  });

  it('releases a linked record when its transaction is edited into a type the record does not fit', async () => {
    const e = await tx({ type: 'expense', accountId: cny, amount: 300, occurredAt: '2026-09-01' });
    const strict = await rec({ title: 'expense record', recordType: 'expense' });
    await a.post(`/api/archive/${strict.id}/link`, { transactionId: e.id });
    t.advance(1000);
    await a.put(`/api/transactions/${e.id}`, { type: 'income', accountId: cny, amount: 300, occurredAt: '2026-09-01' });
    expect((await a.get(`/api/archive/${strict.id}`)).json).toMatchObject({ status: 'open', linkedTransactionId: null, linkLostAt: t.clock.t, version: 3 });
    expect((await a.get(`/api/transactions/${e.id}`)).json.type).toBe('income');
    // An unknown record fits the new type and stays linked.
    const loose = await rec({ title: 'whatever it was' });
    await a.post(`/api/archive/${loose.id}/link`, { transactionId: e.id });
    await a.put(`/api/transactions/${e.id}`, { type: 'expense', accountId: cny, amount: 300, occurredAt: '2026-09-01' });
    expect((await a.get(`/api/archive/${loose.id}`)).json).toMatchObject({ status: 'linked', linkedTransactionId: e.id });
    // A converted record stays converted: its transaction is the copy that counts (no second
    // booking), so changing that transaction to a type the record doesn't fit is refused.
    const c = await rec(ready());
    const txId = (await a.post(`/api/archive/${c.id}/convert`)).json.linkedTransactionId;
    const res = await a.put(`/api/transactions/${txId}`, { type: 'income', accountId: cny, amount: 1234, occurredAt: '2023-05-06' });
    expect([res.status, res.json.code]).toEqual([409, 'TX_FROM_ARCHIVE']);
    expect((await a.get(`/api/transactions/${txId}`)).json).toMatchObject({ type: 'expense', amount: -1234 });
    expect((await a.get(`/api/archive/${c.id}`)).json).toMatchObject({ status: 'converted', linkedTransactionId: txId });
  });

  it('treats a fee of 0 as known-none (convertible), unknown as not blocking, and a real fee as blocking', async () => {
    const zero = await rec(ready({ feeAmount: 0 }));
    expect(zero).toMatchObject({ feeAmount: 0, feeCurrency: null, convertBlockers: [] });
    const zeroTx = (await a.post(`/api/archive/${zero.id}/convert`)).json.linkedTransactions;
    expect(zeroTx.map((x: any) => x.amount)).toEqual([-1234]);
    const unknown = await rec(ready());
    expect(unknown).toMatchObject({ feeAmount: null, convertBlockers: [] });
    const fee = await rec(ready({ feeAmount: 150, feeCurrency: 'CNY' }));
    expect(fee.convertBlockers).toEqual(['fee']);
    const n = await txCount();
    expect((await a.post(`/api/archive/${fee.id}/convert`)).json).toMatchObject({ code: 'ARCHIVE_NOT_READY', details: ['fee'] });
    expect(await txCount()).toBe(n);
    // The fee stays on the record, as entered.
    expect((await a.get(`/api/archive/${fee.id}`)).json).toMatchObject({ feeAmount: 150, feeCurrency: 'CNY', status: 'open' });
    expect((await a.post('/api/archive', ready({ feeAmount: -1, feeCurrency: 'CNY' }))).status).toBe(400);
    expect((await a.post('/api/archive', ready({ feeAmount: 150 }))).status).toBe(400);
    expect(await balance(cny, 'CNY')).toBe(100_000 - 1234);
  });

  it('names an otherwise anonymous transaction after the record, never overwriting what is there', async () => {
    const note = async (extra: Record<string, unknown>) => (await a.post(`/api/archive/${(await rec(ready({ title: '旧相机', ...extra }))).id}/convert`)).json;
    expect((await note({})).linkedTransactions[0]).toMatchObject({ note: '旧相机', counterparty: null, purpose: null });
    expect((await note({ note: '原备注' })).linkedTransactions[0]).toMatchObject({ note: '原备注' });
    expect((await note({ counterparty: 'Shop' })).linkedTransactions[0]).toMatchObject({ note: null, counterparty: 'Shop' });
    expect((await note({ purpose: '摄影' })).linkedTransactions[0]).toMatchObject({ note: null, purpose: '摄影' });
    // Both legs of a transfer get it.
    const x = await note({ recordType: 'transfer', accountId: null, fromAccountId: cny, toAccountId: multi, toCurrency: 'CNY' });
    expect(x.linkedTransactions.map((l: any) => l.note)).toEqual(['旧相机', '旧相机']);
    // The record keeps its title, transaction id and conversion time.
    expect(x).toMatchObject({ title: '旧相机', linkedTransactionId: x.linkedTransactions[0].id, convertedAt: t.clock.t });
  });

  it('freezes the financial fields of a converted record and points at the transaction instead', async () => {
    const r = await rec(ready({ purpose: 'p' }));
    const conv = (await a.post(`/api/archive/${r.id}/convert`)).json;
    const body = ready({ purpose: 'p' });
    for (const change of [{ amount: 1 }, { accountId: multi }, { dateFrom: '2023-05-07', dateTo: '2023-05-07' }, { recordType: 'income' }, { verificationStatus: 'partial' }, { occurredTime: '10:00' }]) {
      const res = await a.put(`/api/archive/${r.id}`, { ...body, ...change });
      expect([res.status, res.json.code], JSON.stringify(change)).toEqual([409, 'ARCHIVE_LOCKED']);
    }
    // Leaving a field out of a full replace clears it — a change too.
    expect((await a.put(`/api/archive/${r.id}`, { title: 'only a title' })).json.code).toBe('ARCHIVE_LOCKED');
    // Descriptive fields stay editable.
    const edited = await a.put(`/api/archive/${r.id}`, { ...body, title: 'renamed', note: 'n', evidenceSource: 'receipt scan' });
    expect(edited.status).toBe(200);
    expect(edited.json).toMatchObject({ title: 'renamed', note: 'n', evidenceSource: 'receipt scan', status: 'converted', linkedTransactionId: conv.linkedTransactionId, convertedAt: conv.convertedAt });
    expect((await a.patch(`/api/archive/${r.id}/verification`, { verificationStatus: 'pending' })).json.code).toBe('ARCHIVE_LOCKED');
    expect((await a.post(`/api/archive/${r.id}/unlink`)).json.code).toBe('ARCHIVE_CONVERTED');
    expect((await a.post(`/api/archive/${r.id}/dismiss`)).json.code).toBe('ARCHIVE_STATUS');
    // The transaction itself is edited as usual and stays linked.
    const txId = conv.linkedTransactionId;
    expect((await a.put(`/api/transactions/${txId}`, { type: 'expense', accountId: cny, amount: 2000, occurredAt: '2023-05-06' })).status).toBe(200);
    expect((await a.get(`/api/archive/${r.id}`)).json).toMatchObject({ status: 'converted', linkedTransactionId: txId, amount: 1234 });
    expect(await balance(cny, 'CNY')).toBe(98_000);
  });

  it('goes back to open when its transaction is deleted, from any path, and can be dealt with again', async () => {
    // Converted expense → transaction deleted.
    const r = await rec(ready());
    const txId = (await a.post(`/api/archive/${r.id}/convert`)).json.linkedTransactionId;
    t.advance(60_000);
    expect((await a.del(`/api/transactions/${txId}`)).json.deleted).toBe(1);
    const back = (await a.get(`/api/archive/${r.id}`)).json;
    expect(back).toMatchObject({ status: 'open', linkedTransactionId: null, convertedAt: null, linkLostAt: t.clock.t, verificationStatus: 'verified', amount: 1234, linkedTransactions: [] });
    expect(back.convertBlockers).toEqual([]);
    expect(await balance(cny, 'CNY')).toBe(100_000);
    // It can be converted again — once.
    const again = (await a.post(`/api/archive/${r.id}/convert`)).json;
    expect(again).toMatchObject({ status: 'converted', linkLostAt: null });
    expect(await balance(cny, 'CNY')).toBe(100_000 - 1234);

    // Linked transfer → deleted through its receiving leg.
    const x = await tx({ type: 'transfer', fromAccountId: cny, toAccountId: hkd, amount: 500, toAmount: 540, occurredAt: '2026-09-03' });
    const inLeg = (await a.get('/api/transactions?type=transfer')).json.items.find((l: any) => l.amount > 0);
    const w = await rec({ title: 'wire', recordType: 'transfer' });
    await a.post(`/api/archive/${w.id}/link`, { transactionId: x.id });
    expect((await a.del(`/api/transactions/${inLeg.id}`)).json.deleted).toBe(2);
    expect((await a.get(`/api/archive/${w.id}`)).json).toMatchObject({ status: 'open', linkedTransactionId: null });

    // A transfer edited into an expense from its receiving side: the record follows the entry.
    const y = await tx({ type: 'transfer', fromAccountId: cny, toAccountId: hkd, amount: 600, toAmount: 650, occurredAt: '2026-09-04' });
    const yIn = (await a.get('/api/transactions?type=transfer')).json.items.find((l: any) => l.amount > 0);
    const v = await rec({ title: 'became an expense', recordType: 'unknown' });
    await a.post(`/api/archive/${v.id}/link`, { transactionId: y.id });
    expect((await a.put(`/api/transactions/${yIn.id}`, { type: 'expense', accountId: hkd, amount: 650, occurredAt: '2026-09-04' })).status).toBe(200);
    expect((await a.get(`/api/archive/${v.id}`)).json).toMatchObject({ status: 'linked', linkedTransactionId: yIn.id });

    // A bill payment undone on the bills page.
    const bill = (await a.post('/api/bills', { name: 'Rent', kind: 'once', amount: 300, currency: 'CNY', accountId: cny, startDate: '2026-10-01', pastPolicy: 'record' })).json;
    const occ = (await a.get('/api/bills/occurrences')).json.find((o: any) => o.billId === bill.id);
    expect(occ.transactionId).toBeTruthy();
    const rent = await rec({ title: 'rent receipt', recordType: 'expense' });
    await a.post(`/api/archive/${rent.id}/link`, { transactionId: occ.transactionId });
    expect((await a.post(`/api/bills/occurrences/${occ.id}/reset`)).status).toBe(200);
    expect((await a.get(`/api/archive/${rent.id}`)).json).toMatchObject({ status: 'open', linkedTransactionId: null });

    // A delete that skipped the release would fail rather than leave a dangling link.
    const z = await rec({ title: 'guarded', recordType: 'expense' });
    const plain = await tx({ type: 'expense', accountId: cny, amount: 5, occurredAt: '2026-01-01' });
    await a.post(`/api/archive/${z.id}/link`, { transactionId: plain.id });
    await failsWith(t.db.delete(transactions).where(eq(transactions.id, plain.id)), /FOREIGN KEY/);
    expect((await a.get(`/api/archive/${z.id}`)).json.status).toBe('linked');
    // The record itself is never deleted with its account: the account can't go while it is named.
    const spare = await account(a, bank, 'Spare', [{ currency: 'CNY' }]);
    await rec({ title: 'names spare', accountId: spare });
    expect((await a.del(`/api/accounts/${spare}`)).json.code).toBe('HAS_CHILDREN');
  });

  it('keeps investment and crypto records searchable but never turns them into ordinary entries', async () => {
    const shares = await rec({
      title: 'bought shares',
      recordType: 'investment',
      datePrecision: 'day',
      dateFrom: '2021-06-01',
      dateTo: '2021-06-01',
      amount: 100_000,
      currency: 'CNY',
      accountId: cny,
      assetCode: 'aapl',
      assetQuantity: '3.5',
      verificationStatus: 'verified',
    });
    const coins = await rec({
      title: 'bought BTC',
      recordType: 'crypto',
      datePrecision: 'day',
      dateFrom: '2017-12-17',
      dateTo: '2017-12-17',
      amount: 50_000,
      currency: 'CNY',
      accountId: cny,
      assetCode: 'BTC',
      assetQuantity: '0.123456789012345678',
      feeAmount: 25,
      feeCurrency: 'CNY',
      exchangeRate: '0.000002469135780246',
      verificationStatus: 'verified',
    });
    expect(shares).toMatchObject({ assetCode: 'AAPL', assetQuantity: '3.5', convertBlockers: ['type'] });
    expect(coins).toMatchObject({ assetQuantity: '0.123456789012345678', exchangeRate: '0.000002469135780246', convertBlockers: ['type'] });
    const n = await txCount();
    const expense = await tx({ type: 'expense', accountId: cny, amount: 100_000, occurredAt: '2021-06-01' });
    for (const r of [shares, coins]) {
      expect((await a.post(`/api/archive/${r.id}/convert`)).json.code).toBe('ARCHIVE_TYPE_NOT_CONVERTIBLE');
      expect((await a.post(`/api/archive/${r.id}/link`, { transactionId: expense.id })).json.code).toBe('ARCHIVE_TYPE_DEFERRED');
    }
    expect(await txCount()).toBe(n + 1);
    expect((await a.get('/api/archive?recordType=crypto')).json.items.map((x: any) => x.id)).toEqual([coins.id]);
    expect((await a.get('/api/archive?q=BTC')).json.items.map((x: any) => x.id)).toEqual([coins.id]);
  });

  it('lists open records by default; filters, searches and pages the rest', async () => {
    const empty = (await a.get('/api/archive')).json;
    expect(empty).toEqual({ items: [], total: 0, page: 1, pageSize: 30, counts: { open: 0, linked: 0, converted: 0, dismissed: 0 } });

    const day = await rec({ title: 'Taxi', recordType: 'expense', datePrecision: 'day', dateFrom: '2024-05-02', dateTo: '2024-05-02', counterparty: 'DiDi' });
    const month = await rec({ title: 'Salary', recordType: 'income', datePrecision: 'month', dateFrom: '2024-04-01', dateTo: '2024-04-30', purpose: '四月工资', verificationStatus: 'partial' });
    const year = await rec({ title: 'Tax', recordType: 'other', datePrecision: 'year', dateFrom: '2023-01-01', dateTo: '2023-12-31', referenceNumber: 'TAX-2023' });
    const unknown = await rec({ title: 'Mystery', note: 'cash 100% gone_' });
    const dismissed = await rec({ title: 'Duplicate taxi', recordType: 'expense' });
    await a.post(`/api/archive/${dismissed.id}/dismiss`);
    const conv = await rec(ready({ title: 'Converted one' }));
    await a.post(`/api/archive/${conv.id}/convert`);

    const ids = (r: any) => r.json.items.map((x: any) => x.id);
    // Default: open only — latest date first, unknown dates last.
    const open = await a.get('/api/archive');
    expect(ids(open)).toEqual([day.id, month.id, year.id, unknown.id]);
    expect(open.json.counts).toEqual({ open: 4, linked: 0, converted: 1, dismissed: 1 });
    expect(ids(await a.get('/api/archive?status=dismissed'))).toEqual([dismissed.id]);
    expect(ids(await a.get('/api/archive?status=converted'))).toEqual([conv.id]);
    expect((await a.get('/api/archive?status=all')).json.total).toBe(6);
    expect(ids(await a.get('/api/archive?recordType=income'))).toEqual([month.id]);
    expect(ids(await a.get('/api/archive?datePrecision=year'))).toEqual([year.id]);
    expect(ids(await a.get('/api/archive?datePrecision=unknown'))).toEqual([unknown.id]);
    expect(ids(await a.get('/api/archive?verificationStatus=partial'))).toEqual([month.id]);
    expect(ids(await a.get('/api/archive?status=all&verificationStatus=verified'))).toEqual([conv.id]);

    // Search: title, counterparty, purpose, reference number, note; % and _ are literal.
    expect(ids(await a.get('/api/archive?q=taxi&status=all'))).toEqual([day.id, dismissed.id]);
    expect(ids(await a.get('/api/archive?q=didi'))).toEqual([day.id]);
    expect(ids(await a.get(`/api/archive?q=${encodeURIComponent('四月')}`))).toEqual([month.id]);
    expect(ids(await a.get('/api/archive?q=TAX-2023'))).toEqual([year.id]);
    expect(ids(await a.get(`/api/archive?q=${encodeURIComponent('100%')}`))).toEqual([unknown.id]);
    expect(ids(await a.get(`/api/archive?q=${encodeURIComponent('%')}`))).toEqual([unknown.id]);
    expect(ids(await a.get('/api/archive?q=_'))).toEqual([unknown.id]);
    expect((await a.get('/api/archive?q=nothing-like-this')).json).toMatchObject({ items: [], total: 0 });

    // Pages: every open record exactly once.
    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const r = await a.get(`/api/archive?pageSize=2&page=${page}`);
      expect(r.json.total).toBe(4);
      seen.push(...ids(r));
    }
    expect(seen).toEqual([day.id, month.id, year.id, unknown.id]);
    for (const bad of ['status=nope', 'recordType=stock', 'pageSize=500', 'page=0']) expect((await a.get(`/api/archive?${bad}`)).status, bad).toBe(400);
  });
});

describe('migration chain', () => {
  it('builds exactly the Drizzle schema from an empty database (0000 → latest)', () =>
    withDbDir('zui-chain-', async (dir, track) => {
      const db = await openLibsql(`file:${join(dir, 'fresh.db')}`);
      const c = track(dbClient(db));
      const applied = (await c.execute('select count(*) as n from __drizzle_migrations')).rows[0]!['n'];
      const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'));
      expect(applied).toBe(journal.entries.length);
      expect(await schemaDrift(async (sqlText) => (await c.execute(sqlText)).rows as unknown as Record<string, unknown>[])).toEqual([]);
    }));
});

describe('migration 0005', () => {
  it('adds the archive table without touching any existing row or cached balance', () =>
    withDbDir('zui-mig5-', async (dir, track) => {
      // A migrations folder up to 0004 → a database exactly at the previous schema.
      const old = join(dir, 'migrations');
      mkdirSync(join(old, 'meta'), { recursive: true });
      const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'));
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 4);
      writeFileSync(join(old, 'meta/_journal.json'), JSON.stringify(journal));
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => /^000[0-4]_/.test(f))) copyFileSync(join(MIGRATIONS_DIR, f), join(old, f));

      const url = `file:${join(dir, 'old.db')}`;
      const raw = track(createClient({ url }));
      await migrate(drizzle(raw), { migrationsFolder: old });
      await raw.executeMultiple(`
        INSERT INTO users (id, username, display_name, role, status, webauthn_user_id, totp_enabled, created_at, updated_at) VALUES ('u1','alice','Alice','admin','active','w',0,0,0);
        INSERT INTO institutions (id, user_id, name, country, type, extra, sort, archived, created_at, updated_at) VALUES ('i1','u1','HSBC','HK','bank','{}',0,0,0,0);
        INSERT INTO accounts (id, user_id, institution_id, name, type, currency, opening_date, extra, sort, archived, created_at, updated_at) VALUES ('a1','u1','i1','USD','checking','USD','2026-01-01','{}',0,0,0,0);
        INSERT INTO account_currencies (account_id, user_id, currency, opening_balance, balance_date, include_in_total, sort, balance, tx_count) VALUES ('a1','u1','USD',100000,NULL,1,0,99500,1);
        INSERT INTO transactions (id, user_id, account_id, type, amount, currency, occurred_at, occurred_time, purpose, verification_status, extra, created_at, updated_at) VALUES
          ('t1','u1','a1','expense',-500,'USD','2026-10-05','09:30','lunch','verified','{}',1,1);
      `);
      const snapshot = async (c: ReturnType<typeof createClient>) => ({
        tx: (await c.execute('SELECT * FROM transactions ORDER BY id')).rows,
        cur: (await c.execute('SELECT * FROM account_currencies')).rows,
        accounts: (await c.execute('SELECT * FROM accounts')).rows,
      });
      const before = await snapshot(raw);
      raw.close();

      const db = await openLibsql(url); // applies 0005
      track(dbClient(db));
      const check = track(createClient({ url }));
      expect(await snapshot(check)).toEqual(before);
      const cols = (await check.execute('PRAGMA table_info(historical_records)')).rows.map((r) => r['name']);
      expect(cols).toEqual(expect.arrayContaining(['date_precision', 'date_from', 'date_to', 'asset_quantity', 'linked_transaction_id', 'converted_at', 'link_lost_at', 'version']));
      expect((await check.execute('SELECT count(*) AS n FROM historical_records')).rows[0]!['n']).toBe(0);
      expect((await check.execute('PRAGMA foreign_key_check')).rows).toHaveLength(0);
      // Rows written by the new version link to the old data.
      await db.insert(historicalRecords).values({ id: 'h1', userId: 'u1', title: 'lunch', recordType: 'expense', datePrecision: 'day', dateFrom: '2026-10-05', dateTo: '2026-10-05', status: 'linked', linkedTransactionId: 't1', createdAt: 2, updatedAt: 2 });
      expect(await snapshot(check)).toEqual(before);
    }));
});
