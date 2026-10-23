import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, openLibsql } from '../src/db/client.ts';
import { recalcUserOps } from '../src/lib/balances.ts';
import { runBatch } from '../src/lib/ledger.ts';
import { client, dbClient, login, makeUser, setup, withDbDir, type TestEnv } from './helpers.ts';

/** Optional transaction details (Phase 2B): time, time zone, purpose, channel, reference, source, verification. */

let t: TestEnv;
type C = ReturnType<typeof client>;

const DETAIL_KEYS = ['occurredTime', 'timeZone', 'purpose', 'paymentChannel', 'referenceNumber', 'evidenceSource', 'verificationStatus'] as const;
const NO_DETAILS = Object.fromEntries(DETAIL_KEYS.map((k) => [k, null]));
const FULL = {
  occurredTime: '14:30',
  timeZone: 'Asia/Shanghai',
  purpose: '季度服务器费用',
  paymentChannel: '支付宝',
  referenceNumber: 'ORD-2026-0001',
  evidenceSource: '银行电子回单',
  verificationStatus: 'verified',
} as const;

async function bank(c: C, name = 'HSBC', country = 'HK') {
  return (await c.post('/api/institutions', { name, country, type: 'bank' })).json.id as string;
}

async function account(c: C, institutionId: string, currencies: { currency: string; openingBalance?: number; balanceDate?: string }[], type = 'checking') {
  const r = await c.post('/api/accounts', { institutionId, name: currencies.map((x) => x.currency).join('/'), type, currencies, openingDate: '2026-01-01' });
  expect(r.status).toBe(201);
  return r.json.id as string;
}

const balance = async (c: C, id: string, cur: string) => {
  const a = (await c.get(`/api/accounts/${id}`)).json;
  const row = a.currencies.find((x: any) => x.currency === cur);
  return { balance: row.balance as number, count: row.transactionCount as number };
};

const pick = (o: any) => Object.fromEntries(DETAIL_KEYS.map((k) => [k, o[k]]));

describe('transaction details', () => {
  let a: C;
  let acc: string;
  beforeEach(async () => {
    t = await setup();
    a = await login(t, await makeUser(t, 'alice'));
    acc = await account(a, await bank(a), [{ currency: 'CNY', openingBalance: 100000 }]);
  });
  afterEach(() => t.cleanup());

  it('keeps working without the new fields and returns them as null', async () => {
    const r = await a.post('/api/transactions', { type: 'expense', accountId: acc, amount: 500, occurredAt: '2026-10-01', note: 'old client' });
    expect(r.status).toBe(201);
    expect(pick(r.json)).toEqual(NO_DETAILS);
    // A PUT from an old client (fields left out) works too, and still stores none.
    const put = await a.put(`/api/transactions/${r.json.id}`, { type: 'expense', accountId: acc, amount: 700, occurredAt: '2026-10-02' });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ amount: -700, occurredAt: '2026-10-02', ...NO_DETAILS });
    expect(await balance(a, acc, 'CNY')).toEqual({ balance: 100000 - 700, count: 1 });
    expect((await a.del(`/api/transactions/${r.json.id}`)).json).toEqual({ ok: true, deleted: 1 });
    expect(await balance(a, acc, 'CNY')).toEqual({ balance: 100000, count: 0 });
  });

  it('creates, reads and updates every detail on expenses and income', async () => {
    const created = await a.post('/api/transactions', { type: 'expense', accountId: acc, amount: 1200, occurredAt: '2026-10-03', ...FULL });
    expect(created.status).toBe(201);
    expect(pick(created.json)).toEqual(FULL);
    const id = created.json.id;
    expect(pick((await a.get(`/api/transactions/${id}`)).json)).toEqual(FULL);
    expect(pick((await a.get('/api/transactions')).json.items[0])).toEqual(FULL);

    // Change some, clear some (null or blank text), leave the rest out (kept).
    const put = await a.put(`/api/transactions/${id}`, {
      type: 'expense',
      accountId: acc,
      amount: 1200,
      occurredAt: '2026-10-03',
      occurredTime: '09:05',
      timeZone: null,
      purpose: '   ',
      verificationStatus: 'partial',
    });
    expect(put.status).toBe(200);
    expect(pick(put.json)).toEqual({ ...FULL, occurredTime: '09:05', timeZone: null, purpose: null, verificationStatus: 'partial' });

    // Income takes the same fields; time zones are stored in their canonical spelling.
    const income = await a.post('/api/transactions', { type: 'income', accountId: acc, amount: 300, occurredAt: '2026-10-04', timeZone: 'europe/london', paymentChannel: ' Wire ' });
    expect(pick(income.json)).toEqual({ ...NO_DETAILS, timeZone: 'Europe/London', paymentChannel: 'Wire' });
    expect(await balance(a, acc, 'CNY')).toEqual({ balance: 100000 - 1200 + 300, count: 2 });
  });

  it('gives both legs of a transfer the same details and keeps them in sync on edits', async () => {
    const hkd = await account(a, await bank(a, 'BOC HK'), [{ currency: 'HKD' }]);
    const x = await a.post('/api/transactions', { type: 'transfer', fromAccountId: acc, toAccountId: hkd, amount: 10000, toAmount: 10850, occurredAt: '2026-10-05', ...FULL });
    expect(x.status).toBe(201);
    const legs = async () => (await a.get('/api/transactions?type=transfer')).json.items as any[];
    let both = await legs();
    expect(both).toHaveLength(2);
    for (const l of both) expect(pick(l)).toEqual(FULL);

    // Edit through the receiving leg: both legs change together.
    const inLeg = both.find((l) => l.amount > 0);
    const put = await a.put(`/api/transactions/${inLeg.id}`, {
      type: 'transfer',
      fromAccountId: acc,
      toAccountId: hkd,
      amount: 10000,
      toAmount: 10850,
      occurredAt: '2026-10-05',
      referenceNumber: 'SWIFT-XYZ',
      verificationStatus: 'pending',
    });
    expect(put.status).toBe(200);
    both = await legs();
    expect(new Set(both.map((l) => l.id))).toEqual(new Set([x.json.id, inLeg.id]));
    for (const l of both) expect(pick(l)).toEqual({ ...FULL, referenceNumber: 'SWIFT-XYZ', verificationStatus: 'pending' });

    // Transfer → expense → transfer: the details travel with it and the new leg gets them too.
    const exp = await a.put(`/api/transactions/${x.json.id}`, { type: 'expense', accountId: acc, amount: 10000, occurredAt: '2026-10-05' });
    expect(pick(exp.json)).toEqual({ ...FULL, referenceNumber: 'SWIFT-XYZ', verificationStatus: 'pending' });
    expect((await a.get('/api/transactions')).json.total).toBe(1);
    await a.put(`/api/transactions/${x.json.id}`, { type: 'transfer', fromAccountId: acc, toAccountId: hkd, amount: 10000, toAmount: 10850, occurredAt: '2026-10-05', purpose: '学费' });
    both = await legs();
    expect(both).toHaveLength(2);
    for (const l of both) expect(pick(l)).toEqual({ ...FULL, referenceNumber: 'SWIFT-XYZ', verificationStatus: 'pending', purpose: '学费' });
    expect(await balance(a, acc, 'CNY')).toEqual({ balance: 90000, count: 1 });
    expect(await balance(a, hkd, 'HKD')).toEqual({ balance: 10850, count: 1 });

    // Deleting either leg removes both (the receiving leg was re-created above, so use the sending one).
    expect((await a.del(`/api/transactions/${x.json.id}`)).json.deleted).toBe(2);
    expect(await balance(a, acc, 'CNY')).toEqual({ balance: 100000, count: 0 });
  });

  it('sorts by date first; within a day timed entries come first, then by entry order', async () => {
    const add = async (occurredAt: string, occurredTime?: string) => {
      t.advance(1000); // distinct createdAt
      const r = await a.post('/api/transactions', { type: 'expense', accountId: acc, amount: 1, occurredAt, ...(occurredTime ? { occurredTime } : {}), note: `${occurredAt} ${occurredTime ?? '-'}` });
      expect(r.status).toBe(201);
    };
    await add('2026-10-02'); // old-style, no time
    await add('2026-10-03', '08:00');
    await add('2026-10-03');
    await add('2026-10-03', '23:59');
    await add('2026-10-01', '23:59');
    await add('2026-10-03', '12:00');
    await add('2026-10-04');
    const notes = (await a.get('/api/transactions')).json.items.map((x: any) => x.note);
    expect(notes).toEqual(['2026-10-04 -', '2026-10-03 23:59', '2026-10-03 12:00', '2026-10-03 08:00', '2026-10-03 -', '2026-10-02 -', '2026-10-01 23:59']);
    expect((await a.get('/api/dashboard')).json.recent.map((x: any) => x.note)).toEqual(notes);
  });

  it('never counts a transaction twice when only its time or details change', async () => {
    const r = await a.post('/api/transactions', { type: 'expense', accountId: acc, amount: 2500, occurredAt: '2026-10-06', occurredTime: '10:00' });
    const body = { type: 'expense', accountId: acc, amount: 2500, occurredAt: '2026-10-06' };
    for (const occurredTime of ['11:00', '00:00', '23:59', null]) {
      expect((await a.put(`/api/transactions/${r.json.id}`, { ...body, occurredTime, timeZone: 'Pacific/Kiritimati' })).status).toBe(200);
      expect(await balance(a, acc, 'CNY')).toEqual({ balance: 100000 - 2500, count: 1 });
    }
    await a.post('/api/accounts/recalc');
    expect(await balance(a, acc, 'CNY')).toEqual({ balance: 100000 - 2500, count: 1 });
  });

  it('keeps balance-date rules: back-filled history with details does not change a synced balance', async () => {
    const synced = await account(a, await bank(a, 'Chase', 'US'), [{ currency: 'USD', openingBalance: 50000, balanceDate: '2026-10-10' }]);
    expect(await balance(a, synced, 'USD')).toEqual({ balance: 50000, count: 0 });
    // History recorded afterwards, on or before the balance date — even late in the evening elsewhere.
    for (const [occurredAt, occurredTime, timeZone] of [
      ['2026-09-30', '09:00', 'America/New_York'],
      ['2026-10-10', '23:59', 'Pacific/Honolulu'],
      ['2026-10-10', '00:01', 'Asia/Tokyo'],
    ] as const) {
      const r = await a.post('/api/transactions', { type: 'expense', accountId: synced, amount: 1000, occurredAt, occurredTime, timeZone, evidenceSource: 'statement', verificationStatus: 'verified' });
      expect(r.json.occurredAt).toBe(occurredAt);
    }
    expect(await balance(a, synced, 'USD')).toEqual({ balance: 50000, count: 3 });
    // Only a later business date counts — however early the local time.
    const later = await a.post('/api/transactions', { type: 'expense', accountId: synced, amount: 700, occurredAt: '2026-10-11', occurredTime: '00:00', timeZone: 'Pacific/Kiritimati' });
    expect(await balance(a, synced, 'USD')).toEqual({ balance: 50000 - 700, count: 4 });
    // Editing details of the later one changes nothing either.
    await a.put(`/api/transactions/${later.json.id}`, { type: 'expense', accountId: synced, amount: 700, occurredAt: '2026-10-11', occurredTime: '23:00', purpose: 'x' });
    expect(await balance(a, synced, 'USD')).toEqual({ balance: 50000 - 700, count: 4 });
  });

  it('never moves the business date for a time zone: filters and statistics use occurredAt as entered', async () => {
    // 23:30 in Los Angeles is already the next day in UTC/Shanghai — the date must stay the 31st.
    const r = await a.post('/api/transactions', { type: 'expense', accountId: acc, amount: 900, occurredAt: '2026-08-31', occurredTime: '23:30', timeZone: 'America/Los_Angeles' });
    expect(r.json).toMatchObject({ occurredAt: '2026-08-31', occurredTime: '23:30', timeZone: 'America/Los_Angeles' });
    expect((await a.get('/api/transactions?from=2026-08-31&to=2026-08-31')).json.total).toBe(1);
    expect((await a.get('/api/transactions?from=2026-09-01&to=2026-09-30')).json.total).toBe(0);
    const s = (await a.get('/api/stats?from=2026-08-01&to=2026-09-30&currency=CNY')).json;
    expect(s.months).toEqual([
      { month: '2026-08', income: 0, expense: 900 },
      { month: '2026-09', income: 0, expense: 0 },
    ]);
  });

  it('leaves balances, sums and statistics identical with or without details', async () => {
    const plain = { type: 'expense', accountId: acc, amount: 4321, occurredAt: '2026-09-15' };
    await a.post('/api/transactions', plain);
    const before = {
      bal: await balance(a, acc, 'CNY'),
      sums: (await a.get('/api/transactions')).json.sums,
      stats: (await a.get('/api/stats?from=2026-09-01&to=2026-09-30&currency=CNY')).json.totals,
      dash: (await a.get('/api/dashboard')).json.totals,
    };
    const id = (await a.get('/api/transactions')).json.items[0].id;
    await a.put(`/api/transactions/${id}`, { ...plain, ...FULL });
    expect({
      bal: await balance(a, acc, 'CNY'),
      sums: (await a.get('/api/transactions')).json.sums,
      stats: (await a.get('/api/stats?from=2026-09-01&to=2026-09-30&currency=CNY')).json.totals,
      dash: (await a.get('/api/dashboard')).json.totals,
    }).toEqual(before);
  });

  it('finds transactions by purpose and reference number', async () => {
    await a.post('/api/transactions', { type: 'expense', accountId: acc, amount: 1, occurredAt: '2026-10-01', purpose: '年度域名续费' });
    await a.post('/api/transactions', { type: 'expense', accountId: acc, amount: 2, occurredAt: '2026-10-01', referenceNumber: 'TB-778899_1' });
    await a.post('/api/transactions', { type: 'expense', accountId: acc, amount: 3, occurredAt: '2026-10-01', note: 'unrelated' });
    expect((await a.get(`/api/transactions?q=${encodeURIComponent('域名')}`)).json.items.map((x: any) => x.amount)).toEqual([-1]);
    expect((await a.get('/api/transactions?q=778899_1')).json.items.map((x: any) => x.amount)).toEqual([-2]);
  });

  it('rejects invalid times, time zones, statuses and over-long text', async () => {
    const base = { type: 'expense', accountId: acc, amount: 1, occurredAt: '2026-10-01' };
    const bad: Record<string, unknown>[] = [
      { occurredTime: '24:00' },
      { occurredTime: '9:30' },
      { occurredTime: '12:60' },
      { occurredTime: '12:30:00' },
      { occurredTime: '' },
      { occurredTime: 1230 },
      { timeZone: '+08:00' },
      { timeZone: 'GMT+8' },
      { timeZone: 'Mars/Olympus_Mons' },
      { timeZone: `Asia/${'x'.repeat(70)}` },
      { verificationStatus: 'unmarked' },
      { verificationStatus: 'VERIFIED' },
      { verificationStatus: '' },
      { purpose: 'x'.repeat(501) },
      { paymentChannel: 'x'.repeat(65) },
      { referenceNumber: 'x'.repeat(129) },
      { evidenceSource: 'x'.repeat(501) },
    ];
    for (const extra of bad) {
      const r = await a.post('/api/transactions', { ...base, ...extra });
      expect([r.status, r.json.code], JSON.stringify(extra)).toEqual([400, 'VALIDATION']);
    }
    // The same checks guard updates and transfers.
    const ok = await a.post('/api/transactions', { ...base, purpose: 'x'.repeat(500), referenceNumber: 'x'.repeat(128), paymentChannel: 'x'.repeat(64), occurredTime: '00:00', timeZone: 'UTC' });
    expect(ok.status).toBe(201);
    expect((await a.put(`/api/transactions/${ok.json.id}`, { ...base, occurredTime: '25:00' })).status).toBe(400);
    const other = await account(a, await bank(a, 'X'), [{ currency: 'CNY' }]);
    expect((await a.post('/api/transactions', { type: 'transfer', fromAccountId: acc, toAccountId: other, amount: 1, occurredAt: '2026-10-01', verificationStatus: 'done' })).status).toBe(400);
    // Nothing invalid was written.
    expect(await balance(a, acc, 'CNY')).toEqual({ balance: 100000 - 1, count: 1 });
  });

  it('leaves credit card repayments and bill payments unchanged (no details there yet)', async () => {
    const credit = await account(a, await bank(a, 'CMB', 'CN'), [{ currency: 'CNY' }], 'credit');
    const card = (await a.post('/api/cards', { accountId: credit, last4: '8888', funding: 'credit', statementDay: 5, dueDay: 23 })).json.id;
    await a.post('/api/transactions', { type: 'expense', accountId: credit, cardId: card, amount: 30000, occurredAt: '2026-09-20', ...FULL });
    const st = (await a.post('/api/statements', { cardId: card, statementDate: '2026-10-05', dueDate: '2026-10-23', statementAmount: 30000 })).json;
    // The repayment form does not send details; extra keys are ignored rather than stored.
    const repay = await a.post(`/api/statements/${st.id}/repay`, { fromAccountId: acc, amount: 30000, occurredAt: '2026-10-15', purpose: 'ignored' });
    expect(repay.status).toBe(200);
    expect(repay.json.statement).toMatchObject({ status: 'paid', remaining: 0 });
    expect(pick(repay.json.transaction)).toEqual(NO_DETAILS);
    const legs = (await a.get('/api/transactions?type=transfer')).json.items;
    expect(legs).toHaveLength(2);
    for (const l of legs) expect(pick(l)).toEqual(NO_DETAILS);
    expect(legs.find((l: any) => l.amount > 0).statementId).toBe(st.id);
    expect(await balance(a, credit, 'CNY')).toEqual({ balance: 0, count: 2 });

    // Editing the repayment with details keeps its statement link.
    const inLeg = legs.find((l: any) => l.amount > 0);
    await a.put(`/api/transactions/${inLeg.id}`, { type: 'transfer', fromAccountId: acc, toAccountId: credit, amount: 30000, occurredAt: '2026-10-15', referenceNumber: 'RP-1' });
    expect((await a.get(`/api/transactions/${inLeg.id}`)).json).toMatchObject({ statementId: st.id, referenceNumber: 'RP-1' });
    expect((await a.get('/api/statements')).json[0]).toMatchObject({ status: 'paid', remaining: 0 });

    // Bill payments are created without details.
    const bill = await a.post('/api/bills', { name: 'Rent', kind: 'subscription', amount: 1000, currency: 'CNY', accountId: acc, freq: 'monthly', startDate: '2026-08-01' });
    expect(bill.json.past.recorded).toBe(3);
    const paid = (await a.get('/api/transactions?q=Rent')).json.items;
    expect(paid).toHaveLength(3);
    for (const p of paid) expect(pick(p)).toEqual(NO_DETAILS);
  });
});

describe('migration 0004', () => {
  it('adds the detail columns as null, keeping every row, link and cached balance', () =>
    withDbDir('zui-mig-', async (dir, track) => {
      // A migrations folder up to 0003 → a database exactly at the previous schema.
      const old = join(dir, 'migrations');
      mkdirSync(join(old, 'meta'), { recursive: true });
      const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'));
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 3);
      writeFileSync(join(old, 'meta/_journal.json'), JSON.stringify(journal));
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => /^000[0-3]_/.test(f))) copyFileSync(join(MIGRATIONS_DIR, f), join(old, f));

      const url = `file:${join(dir, 'old.db')}`;
      const raw = track(createClient({ url }));
      await migrate(drizzle(raw), { migrationsFolder: old });
      // Balances as the previous version cached them: USD synced at the end of 10-10, so t1 (10-05) is already in it.
      await raw.executeMultiple(`
        INSERT INTO users (id, username, display_name, role, status, webauthn_user_id, totp_enabled, created_at, updated_at) VALUES ('u1','alice','Alice','admin','active','w',0,0,0);
        INSERT INTO institutions (id, user_id, name, country, type, extra, sort, archived, created_at, updated_at) VALUES ('i1','u1','HSBC','HK','bank','{}',0,0,0,0);
        INSERT INTO accounts (id, user_id, institution_id, name, type, currency, opening_date, extra, sort, archived, created_at, updated_at) VALUES
          ('a1','u1','i1','USD','checking','USD','2026-01-01','{}',0,0,0,0),
          ('a2','u1','i1','HKD','checking','HKD','2026-01-01','{}',0,0,0,0);
        INSERT INTO account_currencies (account_id, user_id, currency, opening_balance, balance_date, include_in_total, sort, balance, tx_count) VALUES
          ('a1','u1','USD',100000,'2026-10-10',1,0,99000,3),
          ('a2','u1','HKD',0,NULL,1,0,7800,1);
        INSERT INTO tags (id, user_id, name) VALUES ('g1','u1','work');
        INSERT INTO transactions (id, user_id, account_id, type, amount, currency, occurred_at, note, transfer_group_id, extra, created_at, updated_at) VALUES
          ('t1','u1','a1','expense',-500,'USD','2026-10-05','before balance date',NULL,'{}',1,1),
          ('t2','u1','a1','transfer',-1000,'USD','2026-10-12',NULL,'grp',  '{}',2,2),
          ('t3','u1','a2','transfer',7800,'HKD','2026-10-12',NULL,'grp',  '{}',2,2),
          ('t4','u1','a1','income',0,'USD','2026-10-11','zero',NULL,'{}',3,3);
        INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('t1','g1');
      `);
      const before = (await raw.execute('SELECT * FROM transactions ORDER BY id')).rows;
      raw.close();

      const db = await openLibsql(url); // applies 0004
      track(dbClient(db));
      const check = track(createClient({ url }));
      const q = async (sqlText: string) => (await check.execute(sqlText)).rows;

      const cols = (await q('PRAGMA table_info(transactions)')).map((r) => r['name']);
      expect(cols).toEqual(expect.arrayContaining(['occurred_time', 'time_zone', 'purpose', 'payment_channel', 'reference_number', 'evidence_source', 'verification_status']));
      const after = await q('SELECT * FROM transactions ORDER BY id');
      expect(after).toHaveLength(before.length);
      for (const [i, row] of after.entries()) {
        // Every old value is untouched; nothing is invented for the new columns.
        for (const [k, v] of Object.entries(before[i]!)) expect(row[k], `${row['id']}.${k}`).toEqual(v);
        for (const k of ['occurred_time', 'time_zone', 'purpose', 'payment_channel', 'reference_number', 'evidence_source', 'verification_status']) expect(row[k]).toBeNull();
      }
      expect(await q('SELECT * FROM transaction_tags')).toHaveLength(1);

      const cached = async () => (await q('SELECT account_id, currency, balance, tx_count FROM account_currencies ORDER BY account_id')).map((r) => ({ account_id: r['account_id'], currency: r['currency'], balance: r['balance'], tx_count: r['tx_count'] }));
      const expected = [
        { account_id: 'a1', currency: 'USD', balance: 99000, tx_count: 3 },
        { account_id: 'a2', currency: 'HKD', balance: 7800, tx_count: 1 },
      ];
      expect(await cached()).toEqual(expected);
      // A full recomputation after the migration agrees with the cache.
      await runBatch(db, recalcUserOps(db, 'u1'));
      expect(await cached()).toEqual(expected);

      // The API layer reads the migrated rows with empty details.
      const { toDtos } = await import('../src/routes/transactions.ts');
      const { transactions } = await import('../src/db/schema.ts');
      const dtos = await toDtos(db, 'u1', await db.select().from(transactions));
      expect(dtos).toHaveLength(4);
      for (const d of dtos) expect(pick(d)).toEqual(NO_DETAILS);
      expect(dtos.find((d) => d.id === 't2')).toMatchObject({ counterpartAccountId: 'a2', counterpartAmount: 7800 });
    }));
});
