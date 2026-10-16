import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cards } from '../src/db/schema.ts';
import { client, login, makeUser, repoConfig, setup, type TestEnv } from './helpers.ts';

let t: TestEnv;
afterEach(() => t.cleanup());

/** Balance of the account's primary currency. */
const balanceOf = (a: any): number => a.currencies.find((c: any) => c.currency === a.currency).balance;

async function bank(c: ReturnType<typeof client>, name = '招商银行', country = 'CN') {
  const r = await c.post('/api/institutions', { name, country, type: 'bank' });
  expect(r.status).toBe(201);
  return r.json.id as string;
}

async function account(c: ReturnType<typeof client>, institutionId: string, currency = 'CNY', openingBalance = 0, type = 'checking') {
  const r = await c.post('/api/accounts', { institutionId, name: `${currency} ${type}`, type, currencies: [{ currency, openingBalance }], openingDate: '2026-01-01' });
  expect(r.status).toBe(201);
  return r.json.id as string;
}

describe('ledger', () => {
  beforeEach(async () => {
    t = await setup();
  });

  it('isolates members from each other', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const b = await login(t, await makeUser(t, 'bob', 'admin'));
    const inst = await bank(a);
    const acc = await account(a, inst, 'CNY', 10000);
    const card = (await a.post('/api/cards', { accountId: acc, last4: '1234', funding: 'debit' })).json.id;
    const tx = (await a.post('/api/transactions', { type: 'expense', accountId: acc, amount: 500, occurredAt: '2026-10-01' })).json.id;
    const cat = (await a.get('/api/categories')).json[0].id;

    // Bob — even as admin — sees none of Alice's data and cannot touch it by id.
    for (const p of ['/api/institutions', '/api/accounts', '/api/cards', '/api/transactions', '/api/bills', '/api/statements']) {
      const r = await b.get(p);
      expect(Array.isArray(r.json) ? r.json : r.json.items, p).toEqual([]);
    }
    expect((await b.get(`/api/accounts/${acc}`)).status).toBe(404);
    expect((await b.get(`/api/transactions/${tx}`)).status).toBe(404);
    expect((await b.patch(`/api/institutions/${inst}`, { name: 'x' })).status).toBe(404);
    expect((await b.del(`/api/cards/${card}`)).status).toBe(404);
    expect((await b.post(`/api/cards/${card}/reveal`)).status).toBe(404);
    expect((await b.put(`/api/transactions/${tx}`, { type: 'income', accountId: acc, amount: 1, occurredAt: '2026-10-01' })).status).toBe(404);
    // Bob cannot attach his records to Alice's objects either.
    const bInst = await bank(b);
    expect((await b.post('/api/accounts', { institutionId: inst, name: 'x', type: 'cash', currencies: [{ currency: 'CNY' }], openingDate: '2026-01-01' })).status).toBe(404);
    const bAcc = await account(b, bInst);
    expect((await b.post('/api/transactions', { type: 'expense', accountId: bAcc, amount: 1, occurredAt: '2026-10-01', categoryId: cat })).status).toBe(404);
    expect((await b.post('/api/transactions', { type: 'transfer', fromAccountId: bAcc, toAccountId: acc, amount: 1, occurredAt: '2026-10-01' })).status).toBe(404);
    expect(balanceOf((await a.get(`/api/accounts/${acc}`)).json)).toBe(9500);
  });

  it('computes balances, transfers and per-currency dashboard totals', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const cn = await bank(a, '招商银行', 'CN');
    const hk = await bank(a, 'HSBC HK', 'HK');
    const cny = await account(a, cn, 'CNY', 100000);
    const hkd = await account(a, hk, 'HKD', 0);
    const credit = await account(a, cn, 'CNY', 0, 'credit');
    const cats = (await a.get('/api/categories')).json;
    const food = cats.find((x: any) => x.name === '餐饮').id;
    const salary = cats.find((x: any) => x.name === '工资').id;

    expect((await a.post('/api/transactions', { type: 'income', accountId: cny, amount: 50000, occurredAt: '2026-10-02', categoryId: salary })).status).toBe(201);
    expect((await a.post('/api/transactions', { type: 'expense', accountId: credit, amount: 3000, occurredAt: '2026-10-03', categoryId: food })).status).toBe(201);
    // Category kind must match.
    expect((await a.post('/api/transactions', { type: 'expense', accountId: cny, amount: 1, occurredAt: '2026-10-03', categoryId: salary })).json.code).toBe('CATEGORY_KIND');
    // Cross-currency transfer needs the received amount.
    expect((await a.post('/api/transactions', { type: 'transfer', fromAccountId: cny, toAccountId: hkd, amount: 10000, occurredAt: '2026-10-04' })).json.code).toBe('TO_AMOUNT_REQUIRED');
    const xfer = await a.post('/api/transactions', { type: 'transfer', fromAccountId: cny, toAccountId: hkd, amount: 10000, toAmount: 10850, occurredAt: '2026-10-04' });
    expect(xfer.status).toBe(201);
    expect(xfer.json).toMatchObject({ amount: -10000, currency: 'CNY', counterpartAccountId: hkd, counterpartAmount: 10850 });

    const accs = (await a.get('/api/accounts')).json;
    const bal = (id: string) => balanceOf(accs.find((x: any) => x.id === id));
    expect(bal(cny)).toBe(100000 + 50000 - 10000);
    expect(bal(hkd)).toBe(10850);
    expect(bal(credit)).toBe(-3000);

    const dash = (await a.get('/api/dashboard')).json;
    expect(dash.totals.find((x: any) => x.currency === 'CNY')).toMatchObject({ assets: 140000, liabilities: 3000, net: 137000, accountCount: 2 });
    expect(dash.totals.find((x: any) => x.currency === 'HKD')).toMatchObject({ net: 10850 });
    expect(dash.tree.map((n: any) => n.country)).toEqual(['CN', 'HK']);
    expect(dash.month.find((x: any) => x.currency === 'CNY')).toEqual({ currency: 'CNY', income: 50000, expense: 3000 });

    // Editing a transfer updates both legs; deleting removes both.
    const edited = await a.put(`/api/transactions/${xfer.json.id}`, { type: 'transfer', fromAccountId: cny, toAccountId: hkd, amount: 20000, toAmount: 21700, occurredAt: '2026-10-05' });
    expect(edited.status).toBe(200);
    expect(edited.json.id).toBe(xfer.json.id);
    expect(balanceOf((await a.get(`/api/accounts/${hkd}`)).json)).toBe(21700);
    expect((await a.del(`/api/transactions/${xfer.json.id}`)).json.deleted).toBe(2);
    expect(balanceOf((await a.get(`/api/accounts/${hkd}`)).json)).toBe(0);
    expect(balanceOf((await a.get(`/api/accounts/${cny}`)).json)).toBe(150000);
  });

  it('filters transactions and tags them', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const acc = await account(a, await bank(a));
    const tag = (await a.post('/api/tags', { name: '旅行' })).json.id;
    expect((await a.post('/api/tags', { name: '旅行' })).status).toBe(409);
    await a.post('/api/transactions', { type: 'expense', accountId: acc, amount: 100, occurredAt: '2026-09-01', note: '东京 拉面', tagIds: [tag] });
    await a.post('/api/transactions', { type: 'expense', accountId: acc, amount: 200, occurredAt: '2026-10-01', note: '超市' });
    await a.post('/api/transactions', { type: 'income', accountId: acc, amount: 900, occurredAt: '2026-10-02' });
    expect((await a.get(`/api/transactions?tagId=${tag}`)).json.items.map((x: any) => x.note)).toEqual(['东京 拉面']);
    expect((await a.get('/api/transactions?q=拉面')).json.total).toBe(1);
    expect((await a.get('/api/transactions?q=%25')).json.total).toBe(0); // LIKE wildcards are escaped
    const oct = (await a.get('/api/transactions?from=2026-10-01&to=2026-10-31')).json;
    expect(oct.total).toBe(2);
    expect(oct.sums).toEqual([{ currency: 'CNY', income: 900, expense: 200 }]);
    expect((await a.get('/api/tags')).json[0]).toMatchObject({ name: '旅行', count: 1 });
  });
});

describe('cards', () => {
  beforeEach(async () => {
    t = await setup();
  });

  it('encrypts the full number and reveals it only after step-up', async () => {
    const u = await makeUser(t, 'alice');
    const a = await login(t, u);
    const acc = await account(a, await bank(a));
    expect((await a.post('/api/cards', { accountId: acc, pan: '4242 4242 4242 4241', funding: 'credit' })).json.code).toBe('BAD_PAN');
    const r = await a.post('/api/cards', { accountId: acc, pan: '4242 4242 4242 4242', funding: 'credit', expMonth: 12, expYear: 2030, holderName: 'ALICE' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ brand: 'visa', bin: '424242', last4: '4242', hasPan: true });
    expect(JSON.stringify(r.json)).not.toContain('4242424242424242');
    expect(JSON.stringify((await a.get('/api/cards')).json)).not.toContain('4242424242424242');
    const [row] = await t.db.select().from(cards).where(eq(cards.id, r.json.id));
    expect(row!.panEnc).toMatch(/^v1\./);
    expect(row!.panEnc).not.toContain('4242424242424242');

    expect((await a.post(`/api/cards/${r.json.id}/reveal`)).json.pan).toBe('4242424242424242');
    t.advance(6 * 60_000);
    expect((await a.post(`/api/cards/${r.json.id}/reveal`)).json.code).toBe('STEP_UP_REQUIRED');
    await a.post('/api/auth/step-up/totp', { code: u.code() });
    expect((await a.post(`/api/cards/${r.json.id}/reveal`)).json.pan).toBe('4242424242424242');
    expect((await a.get('/api/auth/audit')).json.filter((e: any) => e.action === 'card.reveal')).toHaveLength(2);

    // Forget the number but keep the card.
    const forgot = await a.patch(`/api/cards/${r.json.id}`, { pan: null });
    expect(forgot.json).toMatchObject({ hasPan: false, last4: '4242' });
  });
});

describe('custom fields', () => {
  it('validates values against the config and keeps values of removed fields', async () => {
    const cfg = repoConfig();
    cfg.customFields.account = [
      { key: 'status', label: '账户状态', type: 'select', options: [{ value: 'active', label: '正常' }, { value: 'frozen', label: '冻结' }], showInTable: true, required: false, order: 0 },
    ];
    t = await setup(cfg);
    const a = await login(t, await makeUser(t, 'alice'));
    const inst = await bank(a);
    const base = { institutionId: inst, name: 'x', type: 'checking', currencies: [{ currency: 'CNY' }], openingDate: '2026-01-01' };
    expect((await a.post('/api/accounts', { ...base, extra: { status: 'gone' } })).json.code).toBe('CUSTOM_FIELDS');
    const acc = (await a.post('/api/accounts', { ...base, extra: { status: 'frozen' } })).json;
    expect(acc.extra).toEqual({ status: 'frozen' });

    // Field removed from the config: the stored value survives other edits.
    const next = structuredClone(cfg);
    next.customFields.account = [];
    await t.deps.config.save(next);
    const after = await a.patch(`/api/accounts/${acc.id}`, { name: 'renamed', extra: {} });
    expect(after.json.extra).toEqual({ status: 'frozen' });
  });

  it('only a recently verified admin can save the config', async () => {
    t = await setup();
    const adminU = await makeUser(t, 'root', 'admin');
    const admin = await login(t, adminU);
    const cfg = (await admin.get('/api/config')).json;
    cfg.customFields.account.push({ key: 'status', label: '账户状态', type: 'text' });
    const preview = await admin.post('/api/config/preview', { config: cfg });
    expect(preview.json.summary).toBe('add account field 账户状态');
    expect((await admin.put('/api/config', { config: { ...cfg, version: 2 } })).json.code).toBe('VALIDATION');
    t.advance(6 * 60_000);
    expect((await admin.put('/api/config', { config: cfg })).json.code).toBe('STEP_UP_REQUIRED');
    await admin.post('/api/auth/step-up/totp', { code: adminU.code() });
    const saved = await admin.put('/api/config', { config: cfg });
    expect(saved.json.changed).toBe(true);
    expect((await admin.get('/api/config')).json.customFields.account[0].label).toBe('账户状态');
  });
});

describe('bills, statements and reminders', () => {
  beforeEach(async () => {
    t = await setup();
  });

  it('materializes monthly occurrences, pays and un-pays them', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const acc = await account(a, await bank(a), 'CNY', 100000);
    const bill = await a.post('/api/bills', { name: 'Netflix', kind: 'subscription', amount: 6800, currency: 'CNY', accountId: acc, freq: 'monthly', startDate: '2026-07-31', remindDaysBefore: 3, pastPolicy: 'pending' });
    expect(bill.status).toBe(201);
    expect(bill.json.nextDueDate).toBe('2026-07-31'); // earliest unpaid, i.e. overdue

    const occ = (await a.get('/api/bills/occurrences?from=2026-07-01&to=2026-12-31')).json;
    expect(occ.map((o: any) => o.dueDate)).toEqual(['2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31']);

    // Today is 2026-10-15 and the lookahead is 14 days, so 10-31 is not listed yet.
    const reminders = (await a.get('/api/reminders')).json;
    expect(reminders.filter((r: any) => r.kind === 'bill').map((r: any) => [r.date, r.severity])).toEqual([
      ['2026-07-31', 'overdue'],
      ['2026-08-31', 'overdue'],
      ['2026-09-30', 'overdue'],
    ]);
    for (let d = 0; d < 13; d++) {
      t.advance(24 * 3600_000); // walk to 10-28 (keeping the session alive)
      await a.get('/api/auth/me');
    }
    expect((await a.get('/api/reminders')).json.find((r: any) => r.date === '2026-10-31')).toMatchObject({ severity: 'soon', daysLeft: 3 });
    t.advance(-13 * 24 * 3600_000);

    const paid = await a.post(`/api/bills/occurrences/${occ[0].id}/pay`, {});
    expect(paid.status).toBe(200);
    expect(paid.json.transaction).toMatchObject({ amount: -6800, occurredAt: '2026-07-31', counterparty: 'Netflix' });
    expect(balanceOf((await a.get(`/api/accounts/${acc}`)).json)).toBe(100000 - 6800);
    expect((await a.post(`/api/bills/occurrences/${occ[0].id}/pay`, {})).status).toBe(409);
    await a.post(`/api/bills/occurrences/${occ[1].id}/skip`);
    expect((await a.get('/api/bills')).json[0].nextDueDate).toBe('2026-09-30');

    await a.post(`/api/bills/occurrences/${occ[0].id}/reset`);
    expect(balanceOf((await a.get(`/api/accounts/${acc}`)).json)).toBe(100000);

    // Dismissed reminders stay hidden.
    await a.post('/api/reminders/dismiss', { key: `bill:${occ[2].id}` });
    expect((await a.get('/api/reminders')).json.some((r: any) => r.key === `bill:${occ[2].id}`)).toBe(false);
  });

  it('tracks credit card statements and repayments', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const inst = await bank(a);
    const debit = await account(a, inst, 'CNY', 500000);
    const credit = await account(a, inst, 'CNY', 0, 'credit');
    const card = (await a.post('/api/cards', { accountId: credit, last4: '8888', funding: 'credit', statementDay: 5, dueDay: 23, nickname: '招行信用卡' })).json.id;

    // No statement entered yet: the due day itself produces a reminder.
    const before = (await a.get('/api/reminders')).json;
    expect(before.find((r: any) => r.kind === 'card_due')).toMatchObject({ title: '招行信用卡', date: '2026-10-23', daysLeft: 8 });

    await a.post('/api/transactions', { type: 'expense', accountId: credit, cardId: card, amount: 120000, occurredAt: '2026-09-20' });
    const st = await a.post('/api/statements', { cardId: card, statementDate: '2026-10-05', dueDate: '2026-10-23', statementAmount: 120000, minPayment: 12000 });
    expect(st.json).toMatchObject({ status: 'unpaid', remaining: 120000, currency: 'CNY' });

    const after = (await a.get('/api/reminders')).json;
    expect(after.some((r: any) => r.kind === 'card_due')).toBe(false);
    expect(after.find((r: any) => r.kind === 'statement')).toMatchObject({ amount: 120000, daysLeft: 8, severity: 'upcoming' });

    const repay = await a.post(`/api/statements/${st.json.id}/repay`, { fromAccountId: debit, amount: 50000, occurredAt: '2026-10-15' });
    expect(repay.json.statement).toMatchObject({ status: 'partial', paidAmount: 50000, remaining: 70000 });
    await a.post(`/api/statements/${st.json.id}/repay`, { fromAccountId: debit, amount: 70000, occurredAt: '2026-10-16' });
    expect((await a.get('/api/statements')).json[0]).toMatchObject({ status: 'paid', remaining: 0 });
    expect(balanceOf((await a.get(`/api/accounts/${credit}`)).json)).toBe(0);
    expect(balanceOf((await a.get(`/api/accounts/${debit}`)).json)).toBe(500000 - 120000);
    expect((await a.get('/api/reminders')).json.some((r: any) => r.kind === 'statement')).toBe(false);
  });
});
