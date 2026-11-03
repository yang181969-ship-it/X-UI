// M2-B2.2 on D1: the accounts API running unchanged on wrangler's local in-memory D1 (workerd via
// getPlatformProxy — persist: false, remoteBindings: false; no remote D1 is ever contacted).
// Proves the multi-statement writes are D1 batches: all-or-nothing, and within D1's limit of 100
// bound parameters per statement (30 currencies), and that the database guards hold on D1 too.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorText, startD1App, type D1, type D1App } from './d1-app.ts';
import { login, makeUser, type TestEnv } from './helpers.ts';

let harness: D1App | undefined;
let d1: D1;
let t: TestEnv;
let all: D1App['all'];

beforeAll(async () => {
  harness = await startD1App('xui-v1-accounts-d1');
  ({ d1, t, all } = harness);
}, 180_000);

afterAll(async () => {
  await harness?.dispose();
});

// See m2-schema.test.ts: the proxy's keep-alive socket can go stale between cases.
beforeEach(() => harness!.ping());

let users = 0;
async function signIn() {
  const u = await makeUser(t, `d1user${++users}`);
  return { user: u.user, api: await login(t, u) };
}
type Api = Awaited<ReturnType<typeof login>>;

const currencies = (accountId: string) => all('SELECT currency, is_default, status, sort FROM account_currencies WHERE account_id = ? ORDER BY sort', accountId);

async function institution(api: Api, name = 'Wise') {
  const r = await api.post('/api/institutions', { name, country: 'GB', institutionType: 'emi' });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.id as string;
}
const body = (institutionId: string, list: { code: string; isDefault?: boolean; status?: string }[], name = 'Wise 多币种账户') => ({
  institutionId,
  name,
  accountType: 'e_money',
  accountCountry: 'BE',
  currencies: list,
});

/** A trigger that makes inserting one currency fail (scoped by account name / id so cases don't interfere). */
async function failOnCurrency(code: string) {
  await d1.prepare(`CREATE TRIGGER test_fail_${code} BEFORE INSERT ON account_currencies WHEN NEW.currency = '${code}' BEGIN SELECT RAISE(ABORT, 'TEST_INJECTED_FAILURE'); END`).run();
  return () => d1.prepare(`DROP TRIGGER test_fail_${code}`).run();
}

describe('accounts API on local D1', () => {
  it('creates an account with 30 currencies in one batch (one INSERT each, within the 100-parameter limit)', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const codes = ['USD', 'EUR', 'GBP', 'HKD', 'CNY', 'JPY', 'SGD', 'AUD', 'CAD', 'CHF', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'TRY', 'ZAR', 'MXN', 'BRL', 'INR', 'IDR', 'THB', 'MYR', 'PHP', 'KRW', 'TWD', 'MOP'];
    const r = await api.post('/api/accounts', body(inst, codes.map((code, i) => ({ code, isDefault: i === 0 }))));
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect((await currencies(r.json.id)).map((c) => c.currency)).toEqual(codes);
    const list = (await api.get('/api/accounts')).json;
    expect(list).toHaveLength(1);
    expect(list[0].currencies).toHaveLength(30);
  });

  it('POST: a failure in the middle of the batch leaves no account and no currency', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const drop = await failOnCurrency('GBP');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await api.post('/api/accounts', body(inst, [{ code: 'USD', isDefault: true }, { code: 'EUR' }, { code: 'GBP' }]));
    quiet.mockRestore();
    await drop();
    expect(r.status).toBe(500);
    expect(await all('SELECT id FROM accounts WHERE user_id = ?', user.id)).toEqual([]);
    expect(await all('SELECT account_id FROM account_currencies WHERE user_id = ?', user.id)).toEqual([]);
  });

  it('PUT: replaces the list atomically (default switch, removal, close, insert), and rolls back completely on failure', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const acc = (await api.post('/api/accounts', body(inst, [{ code: 'USD', isDefault: true }, { code: 'EUR' }, { code: 'GBP' }]))).json;
    const ok = await api.req('PUT', `/api/accounts/${acc.id}/currencies`, { currencies: [{ code: 'HKD' }, { code: 'EUR', isDefault: true }, { code: 'USD', status: 'closed' }] });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(await currencies(acc.id)).toEqual([
      { currency: 'HKD', is_default: 0, status: 'active', sort: 0 },
      { currency: 'EUR', is_default: 1, status: 'active', sort: 1 },
      { currency: 'USD', is_default: 0, status: 'closed', sort: 2 },
    ]);

    const before = await currencies(acc.id);
    const drop = await failOnCurrency('JPY');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = await api.req('PUT', `/api/accounts/${acc.id}/currencies`, { currencies: [{ code: 'USD', isDefault: true }, { code: 'JPY' }] });
    quiet.mockRestore();
    await drop();
    expect(bad.status).toBe(500);
    expect(await currencies(acc.id)).toEqual(before);
  });

  it('PUT: a currency referenced by a card link → 409 CURRENCY_IN_USE; closing it keeps the link', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const acc = (await api.post('/api/accounts', body(inst, [{ code: 'USD', isDefault: true }, { code: 'EUR' }]))).json;
    const card = `card-${user.id}`;
    await d1
      .prepare(`INSERT INTO cards (id, user_id, issuer_institution_id, name, network, card_type, last4, issuing_country, created_at, updated_at) VALUES (?, ?, ?, 'Debit', 'visa', 'debit', '4321', 'BE', 1, 1)`)
      .bind(card, user.id, inst)
      .run();
    await d1
      .prepare(`INSERT INTO account_card_links (id, user_id, card_id, account_id, currency, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, 'EUR', 1, 1, 1)`)
      .bind(`link-${user.id}`, user.id, card, acc.id)
      .run();
    const r = await api.req('PUT', `/api/accounts/${acc.id}/currencies`, { currencies: [{ code: 'USD', isDefault: true }] });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: 'CURRENCY_IN_USE', details: { currencies: ['EUR'] } });
    const closed = await api.req('PUT', `/api/accounts/${acc.id}/currencies`, { currencies: [{ code: 'USD', isDefault: true }, { code: 'EUR', status: 'closed' }] });
    expect(closed.status).toBe(200);
    expect(await all('SELECT status, is_default FROM account_card_links WHERE account_id = ?', acc.id)).toEqual([{ status: 'active', is_default: 1 }]);
    // Deleting the account cascades through the currency-scoped link in one statement.
    expect((await api.del(`/api/accounts/${acc.id}`)).status).toBe(200);
    expect(await all('SELECT id FROM account_card_links WHERE account_id = ?', acc.id)).toEqual([]);
    expect(await all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('PATCH refuses institutionId; raw SQL is stopped by the trigger; another user gets 404', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const other = await institution(api, 'Wise Europe');
    const acc = (await api.post('/api/accounts', body(inst, [{ code: 'USD', isDefault: true }]))).json;
    const r = await api.patch(`/api/accounts/${acc.id}`, { institutionId: other });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('VALIDATION');
    const err = await d1
      .prepare('UPDATE accounts SET institution_id = ? WHERE id = ?')
      .bind(other, acc.id)
      .run()
      .then(
        () => 'no error',
        (e: unknown) => errorText(e),
      );
    expect(err).toMatch(/ACCOUNT_INSTITUTION_IMMUTABLE/);
    expect((await api.patch(`/api/accounts/${acc.id}`, { status: 'frozen', accountCountry: 'LT' })).json).toMatchObject({ institutionId: inst, status: 'frozen', accountCountry: 'LT' });
    const bob = await signIn();
    expect((await bob.api.get(`/api/accounts/${acc.id}`)).status).toBe(404);
    expect((await bob.api.post('/api/accounts', body(inst, [{ code: 'USD', isDefault: true }]))).status).toBe(404);
  });

  it('new accounts need an active institution: archived → 409, restored → 201, another user → 404', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    await api.patch(`/api/institutions/${inst}`, { status: 'archived' });
    const r = await api.post('/api/accounts', body(inst, [{ code: 'USD', isDefault: true }]));
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: 'INSTITUTION_ARCHIVED', details: { institutionId: inst } });
    expect(await all('SELECT id FROM accounts WHERE user_id = ?', user.id)).toEqual([]);
    const bob = await signIn();
    expect((await bob.api.post('/api/accounts', body(inst, [{ code: 'USD', isDefault: true }]))).json.code).toBe('NOT_FOUND');
    await api.patch(`/api/institutions/${inst}`, { status: 'active' });
    expect((await api.post('/api/accounts', body(inst, [{ code: 'USD', isDefault: true }]))).status).toBe(201);
  });

  it('archived between the check and the batch: the D1 batch writes nothing → 409', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const original = t.db.batch.bind(t.db);
    const spy = vi.spyOn(t.db, 'batch').mockImplementationOnce(async (batch) => {
      await d1.prepare(`UPDATE institutions SET status = 'archived' WHERE id = ?`).bind(inst).run();
      return original(batch as never);
    });
    const r = await api.post('/api/accounts', body(inst, [{ code: 'USD', isDefault: true }, { code: 'EUR' }]));
    spy.mockRestore();
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('INSTITUTION_ARCHIVED');
    expect(await all('SELECT id FROM accounts WHERE user_id = ?', user.id)).toEqual([]);
    expect(await all('SELECT account_id FROM account_currencies WHERE user_id = ?', user.id)).toEqual([]);
  });

  it('PUT failing at a middle step rolls back everything: currencies, default USD, updated_at, links', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const acc = (await api.post('/api/accounts', body(inst, [{ code: 'USD', isDefault: true }, { code: 'EUR' }, { code: 'HKD' }]))).json;
    const card = `card-${user.id}`;
    await d1
      .prepare(`INSERT INTO cards (id, user_id, issuer_institution_id, name, network, card_type, last4, issuing_country, created_at, updated_at) VALUES (?, ?, ?, 'Debit', 'visa', 'debit', '4321', 'BE', 1, 1)`)
      .bind(card, user.id, inst)
      .run();
    await d1.prepare(`INSERT INTO account_card_links (id, user_id, card_id, account_id, currency, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, 'EUR', 1, 1, 1)`).bind(`l1-${user.id}`, user.id, card, acc.id).run();
    await d1
      .prepare(`INSERT INTO account_card_links (id, user_id, card_id, account_id, currency, role, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 'top_up_source', 2, 2)`)
      .bind(`l2-${user.id}`, user.id, card, acc.id)
      .run();
    const currenciesBefore = await all('SELECT * FROM account_currencies WHERE account_id = ? ORDER BY sort', acc.id);
    const accountBefore = await all('SELECT * FROM accounts WHERE id = ?', acc.id);
    const linksBefore = await all('SELECT * FROM account_card_links WHERE account_id = ? ORDER BY id', acc.id);

    for (const trigger of [
      `CREATE TRIGGER test_fail_step BEFORE INSERT ON account_currencies WHEN NEW.currency = 'JPY' BEGIN SELECT RAISE(ABORT, 'TEST_INJECTED_FAILURE'); END`,
      `CREATE TRIGGER test_fail_step BEFORE UPDATE OF status ON account_currencies WHEN NEW.currency = 'HKD' AND NEW.status = 'closed' BEGIN SELECT RAISE(ABORT, 'TEST_INJECTED_FAILURE'); END`,
    ]) {
      await d1.prepare(trigger).run();
      t.advance(60_000); // a committed batch would move updated_at
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
      const r = await api.req('PUT', `/api/accounts/${acc.id}/currencies`, { currencies: [{ code: 'EUR', isDefault: true }, { code: 'HKD', status: 'closed' }, { code: 'JPY' }] });
      quiet.mockRestore();
      await d1.prepare('DROP TRIGGER test_fail_step').run();
      expect(r.status).toBe(500);
      const after = await all('SELECT * FROM account_currencies WHERE account_id = ? ORDER BY sort', acc.id);
      expect(after).toEqual(currenciesBefore);
      expect(after.filter((c) => c.is_default === 1).map((c) => c.currency)).toEqual(['USD']);
      expect(await all('SELECT * FROM accounts WHERE id = ?', acc.id)).toEqual(accountBefore);
      expect(await all('SELECT * FROM account_card_links WHERE account_id = ? ORDER BY id', acc.id)).toEqual(linksBefore);
    }
    expect((await currencies(acc.id)).map((c) => c.currency)).toEqual(['USD', 'EUR', 'HKD']);
  });
});
