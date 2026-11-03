// M2-B2.2: accounts API (API_SPEC §3.3; TEST_PLAN A-1 – A-12, D-1, D-4, D-7, X-1 – X-4, U-1 – U-3, R-1).
// Cards, card links and payment channels have no API yet, so they are seeded with raw SQL.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '../src/auth/middleware.ts';
import { auditLog } from '../src/db/schema.ts';
import { client, login, makeUser, setup, type TestEnv } from './helpers.ts';

let t: TestEnv;
beforeEach(async () => {
  t = await setup();
});
afterEach(() => t.cleanup());

type Api = Awaited<ReturnType<typeof login>>;
type Currency = { code: string; isDefault?: boolean; status?: 'active' | 'closed' };

async function signIn(name = 'alice') {
  const u = await makeUser(t, name);
  return { user: u.user, api: await login(t, u) };
}

async function institution(api: Api, body: Record<string, unknown> = { name: 'Wise', country: 'GB', institutionType: 'emi' }) {
  const r = await api.post('/api/institutions', body);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.id as string;
}

const CURRENCIES: Currency[] = [{ code: 'USD', isDefault: true }, { code: 'EUR' }, { code: 'GBP' }];
const accountBody = (institutionId: string, extra: Record<string, unknown> = {}) => ({
  institutionId,
  name: 'Wise 多币种账户',
  accountType: 'e_money',
  accountCountry: 'BE',
  currencies: CURRENCIES,
  ...extra,
});

async function createAccount(api: Api, institutionId: string, extra: Record<string, unknown> = {}) {
  const r = await api.post('/api/accounts', accountBody(institutionId, extra));
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json as { id: string; currencies: { currency: string; isDefault: boolean; status: string; sort: number }[] } & Record<string, any>;
}

const putCurrencies = (api: Api, id: string, currencies: Currency[]) => api.req('PUT', `/api/accounts/${id}/currencies`, { currencies });

let seq = 0;
const T = 1_700_000_000_000;
const exec = (sql: string, args: unknown[] = []) => t.client.execute({ sql, args: args as never });
/** Result rows as plain objects keyed by column name. */
const rows = async (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> => {
  const r = await exec(sql, args);
  return r.rows.map((row) => Object.fromEntries(r.columns.map((col, i) => [col, row[i]])));
};

/** Raw-SQL rows for objects whose API arrives in a later step. */
async function seedCard(userId: string, institutionId: string, name = `Card ${++seq}`) {
  const id = `card-${++seq}`;
  await exec(
    `INSERT INTO cards (id, user_id, issuer_institution_id, name, network, card_type, last4, issuing_country, created_at, updated_at) VALUES (?, ?, ?, ?, 'visa', 'debit', '4321', 'BE', ?, ?)`,
    [id, userId, institutionId, name, T, T],
  );
  return id;
}
async function seedLink(userId: string, cardId: string, accountId: string, opts: { currency?: string | null; role?: string; isDefault?: 0 | 1; status?: string } = {}) {
  const id = `link-${++seq}`;
  await exec(
    `INSERT INTO account_card_links (id, user_id, card_id, account_id, currency, role, is_default, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, cardId, accountId, opts.currency ?? null, opts.role ?? 'spending_source', opts.isDefault ?? 0, opts.status ?? 'active', T + seq, T + seq],
  );
  return id;
}
async function seedChannel(userId: string, opts: { balanceAccountId?: string; type?: string } = {}) {
  const id = `ch-${++seq}`;
  await exec(
    `INSERT INTO payment_channels (id, user_id, name, name_key, channel_type, balance_account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, `Channel ${seq}`, `channel ${seq}`, opts.type ?? 'payment_service', opts.balanceAccountId ?? null, T, T],
  );
  return id;
}
async function seedSource(userId: string, channelId: string, accountId: string, status = 'active') {
  const id = `src-${++seq}`;
  await exec(`INSERT INTO payment_channel_sources (id, user_id, channel_id, account_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    id,
    userId,
    channelId,
    accountId,
    status,
    T,
    T,
  ]);
  return id;
}

/** The database error of a statement that must fail, as text (a retained libsql error keeps the file open on Windows). */
const sqlError = (p: Promise<unknown>) =>
  p.then(
    () => 'no error',
    (e: unknown) => String((e as { message?: unknown }).message ?? e),
  );

const M2_TABLES = ['institutions', 'accounts', 'account_currencies', 'cards', 'account_card_links', 'payment_channels', 'payment_channel_sources', 'user_preferences'];
/** Every M2 row, to prove a request changed nothing (or only what it should). */
async function snapshot() {
  const out: Record<string, unknown[]> = {};
  for (const table of M2_TABLES) out[table] = await rows(`SELECT * FROM ${table} ORDER BY rowid`);
  return out;
}
const currencyRows = (accountId: string) =>
  rows('SELECT currency, is_default, status, sort, created_at FROM account_currencies WHERE account_id = ? ORDER BY sort', [accountId]) as Promise<
    { currency: string; is_default: number; status: string; sort: number; created_at: number }[]
  >;

/** A trigger that makes inserting one currency fail, to break a batch half-way. */
async function failOnCurrency(code: string) {
  await exec(`CREATE TRIGGER test_fail_currency BEFORE INSERT ON account_currencies WHEN NEW.currency = '${code}' BEGIN SELECT RAISE(ABORT, 'TEST_INJECTED_FAILURE'); END`);
}

// ================================================================== create and read

describe('create and read (A-1, A-5)', () => {
  it('A-1: creates a multi-currency account in one request; the detail returns the currencies with USD as the default', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const created = await api.post('/api/accounts', {
      ...accountBody(inst),
      depositKind: null,
      numberHint: '1234',
      status: 'active',
      openedOn: '2024-03-01',
      notes: '测试账户',
      sort: 3,
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      institutionId: inst,
      institution: { id: inst, name: 'Wise', institutionType: 'emi', color: null, status: 'active' },
      name: 'Wise 多币种账户',
      accountType: 'e_money',
      depositKind: null,
      accountCountry: 'BE',
      numberHint: '1234',
      status: 'active',
      openedOn: '2024-03-01',
      closedOn: null,
      notes: '测试账户',
      sort: 3,
    });
    expect(created.json.currencies).toEqual([
      { currency: 'USD', isDefault: true, status: 'active', sort: 0 },
      { currency: 'EUR', isDefault: false, status: 'active', sort: 1 },
      { currency: 'GBP', isDefault: false, status: 'active', sort: 2 },
    ]);
    const id = created.json.id as string;
    expect(id).toMatch(/^[0-9a-z]{26}$/);
    const [row] = await rows('SELECT name_key FROM accounts WHERE id = ?', [id]);
    expect(row!.name_key).toBe('wise 多币种账户');

    const detail = await api.get(`/api/accounts/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ id, links: [], balanceOfChannels: [], sourceOfChannels: [] });
    expect(detail.json.currencies.filter((c: { isDefault: boolean }) => c.isDefault).map((c: { currency: string }) => c.currency)).toEqual(['USD']);

    const list = await api.get('/api/accounts');
    expect(list.json).toHaveLength(1);
    expect(list.json[0]).toMatchObject({ id, linkedCardCount: 0, linkedCards: [] });
    expect(list.json[0].currencies).toHaveLength(3);
  });

  it('A-5: only the required fields are needed; no amount or balance field exists in any DTO', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const r = await api.post('/api/accounts', { institutionId: inst, name: 'Minimal', accountType: 'other', accountCountry: 'HK', currencies: [{ code: 'HKD', isDefault: true }] });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ depositKind: null, numberHint: null, status: 'active', openedOn: null, closedOn: null, notes: null, sort: 0 });
    const keys = ['accountCountry', 'accountType', 'closedOn', 'createdAt', 'currencies', 'depositKind', 'id', 'institution', 'institutionId', 'name', 'notes', 'numberHint', 'openedOn', 'sort', 'status', 'updatedAt'];
    expect(Object.keys(r.json).sort()).toEqual(keys);
    const detail = (await api.get(`/api/accounts/${r.json.id}`)).json;
    const listItem = (await api.get('/api/accounts')).json[0];
    for (const dto of [r.json, detail, listItem, ...r.json.currencies]) {
      // balanceOfChannels (API_SPEC DTO) lists channels, not an amount.
      expect(JSON.stringify(Object.keys(dto).filter((k) => k !== 'balanceOfChannels'))).not.toMatch(/balance|amount|total|limit/i);
    }
    for (const extra of [{ balance: 100 }, { openingBalance: 0 }, { currentBalance: 1 }, { includeInTotal: true }, { creditLimit: 1000 }]) {
      const bad = await api.post('/api/accounts', { ...accountBody(inst), ...extra });
      expect.soft(bad.status, JSON.stringify(extra)).toBe(400);
      expect.soft(bad.json.code).toBe('VALIDATION');
    }
    expect(await rows('SELECT id FROM accounts')).toHaveLength(1);
  });

  it('accepts 30 currencies (each one its own INSERT in the batch) and refuses 31', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const codes = ['USD', 'EUR', 'GBP', 'HKD', 'CNY', 'JPY', 'SGD', 'AUD', 'CAD', 'CHF', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'TRY', 'ZAR', 'MXN', 'BRL', 'INR', 'IDR', 'THB', 'MYR', 'PHP', 'KRW', 'TWD', 'MOP', 'AED'];
    const list = (n: number) => codes.slice(0, n).map((code, i) => ({ code, isDefault: i === 0 }));
    const ok = await api.post('/api/accounts', accountBody(inst, { currencies: list(30) }));
    expect(ok.status).toBe(201);
    expect(ok.json.currencies).toHaveLength(30);
    expect(ok.json.currencies.map((c: { currency: string }) => c.currency)).toEqual(codes.slice(0, 30));
    expect((await api.post('/api/accounts', accountBody(inst, { currencies: list(31) }))).status).toBe(400);
  });
});

// ================================================================== validation

describe('validation (A-2, A-6 – A-9)', () => {
  it('A-2: currency lists must have 1–30 distinct ISO codes, exactly one default, and the default active', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const lists: unknown[] = [
      undefined,
      [],
      [{ code: 'USD' }, { code: 'EUR' }],
      [{ code: 'USD', isDefault: true }, { code: 'EUR', isDefault: true }],
      [{ code: 'USD', isDefault: true }, { code: 'USD' }],
      [{ code: 'XAU', isDefault: true }],
      [{ code: 'XXX', isDefault: true }],
      [{ code: 'usd', isDefault: true }],
      [{ code: 'US', isDefault: true }],
      [{ code: 'USD', isDefault: true, status: 'closed' }],
      [{ code: 'USD', isDefault: true, status: 'frozen' }],
      [{ code: 'USD', isDefault: true, balance: 10 }],
      ['USD'],
      'USD',
    ];
    for (const currencies of lists) {
      const r = await api.post('/api/accounts', { ...accountBody(inst), currencies });
      expect.soft(r.status, JSON.stringify(currencies)).toBe(400);
      expect.soft(r.json.code, JSON.stringify(currencies)).toBe('VALIDATION');
    }
    expect(await rows('SELECT id FROM accounts')).toHaveLength(0);
    expect(await rows('SELECT account_id FROM account_currencies')).toHaveLength(0);
  });

  it('A-6 / A-7: institutionId and accountCountry are required; accountCountry is never filled from the institution', async () => {
    const { api } = await signIn();
    const inst = await institution(api, { name: 'Example Bank', country: 'HK', institutionType: 'bank' });
    const { institutionId: _i, ...noInstitution } = accountBody(inst);
    const { accountCountry: _c, ...noCountry } = accountBody(inst);
    for (const b of [noInstitution, noCountry, { ...accountBody(inst), accountCountry: null }, { ...accountBody(inst), accountCountry: 'be' }, { ...accountBody(inst), accountCountry: 'BEL' }]) {
      const r = await api.post('/api/accounts', b);
      expect.soft(r.status, JSON.stringify(b)).toBe(400);
      expect.soft(r.json.code).toBe('VALIDATION');
    }
    expect(await rows('SELECT id FROM accounts')).toHaveLength(0);

    // HK institution, account contracted with a BE entity: stays BE.
    const acc = await createAccount(api, inst, { accountCountry: 'BE' });
    expect(acc.accountCountry).toBe('BE');
    expect((await api.patch(`/api/institutions/${inst}`, { country: 'SG' })).status).toBe(200);
    expect((await api.get(`/api/accounts/${acc.id}`)).json.accountCountry).toBe('BE');
  });

  it('A-8: only bank / e_money / stored_value / other; depositKind only for bank accounts', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    for (const accountType of ['credit', 'investment', 'cash', 'brokerage', 'loan', '']) {
      const r = await api.post('/api/accounts', accountBody(inst, { accountType }));
      expect.soft(r.status, accountType).toBe(400);
    }
    for (const depositKind of ['current', 'savings', 'fixed', 'other']) {
      expect.soft((await api.post('/api/accounts', accountBody(inst, { accountType: 'bank', depositKind }))).status, depositKind).toBe(201);
      expect.soft((await api.post('/api/accounts', accountBody(inst, { accountType: 'e_money', depositKind }))).status, depositKind).toBe(400);
    }
    expect((await api.post('/api/accounts', accountBody(inst, { accountType: 'bank', depositKind: 'checking' }))).status).toBe(400);
    for (const accountType of ['bank', 'e_money', 'stored_value', 'other']) expect.soft((await api.post('/api/accounts', accountBody(inst, { accountType }))).status).toBe(201);
    // The database refuses a credit account inserted behind the API's back.
    const uid = ((await rows('SELECT user_id FROM accounts LIMIT 1'))[0] as { user_id: string }).user_id;
    const err = await sqlError(
      exec(`INSERT INTO accounts (id, user_id, institution_id, name, name_key, account_type, account_country, created_at, updated_at) VALUES ('raw', ?, ?, 'X', 'x', 'credit', 'BE', 1, 1)`, [uid, inst]),
    );
    expect(err).toMatch(/CHECK constraint failed: accounts_type_ck/);
  });

  it('A-8: PATCH checks depositKind against the stored type too', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const bank = await createAccount(api, inst, { accountType: 'bank', depositKind: 'savings' });
    // Turning it into an e-money account while it keeps its deposit kind is refused…
    const r = await api.patch(`/api/accounts/${bank.id}`, { accountType: 'e_money' });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('VALIDATION');
    expect(r.json.details[0].path).toEqual(['depositKind']);
    // …clearing it in the same request works.
    expect((await api.patch(`/api/accounts/${bank.id}`, { accountType: 'e_money', depositKind: null })).json).toMatchObject({ accountType: 'e_money', depositKind: null });
    const emoney = await createAccount(api, inst);
    expect((await api.patch(`/api/accounts/${emoney.id}`, { depositKind: 'current' })).status).toBe(400);
  });

  it('A-9: number hints are 1–4 letters or digits', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    for (const numberHint of ['1234', 'AB12', '7', 'z9']) expect.soft((await api.post('/api/accounts', accountBody(inst, { numberHint }))).status, numberHint).toBe(201);
    for (const numberHint of ['12345', 'GB33BUKB20201555555555', '12 3', '12-3', '12.3', '', '１２３４５']) {
      expect.soft((await api.post('/api/accounts', accountBody(inst, { numberHint }))).status, numberHint).toBe(400);
    }
  });

  it('dates must be real calendar dates, closedOn not before openedOn (create and merged PATCH)', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    for (const b of [{ openedOn: '2024-02-30' }, { openedOn: '2024/03/01' }, { openedOn: '2024-03-01', closedOn: '2024-02-01' }]) {
      expect.soft((await api.post('/api/accounts', accountBody(inst, b))).status, JSON.stringify(b)).toBe(400);
    }
    const acc = await createAccount(api, inst, { openedOn: '2024-03-01' });
    const r = await api.patch(`/api/accounts/${acc.id}`, { closedOn: '2024-01-01' });
    expect(r.status).toBe(400);
    expect(r.json.details[0].path).toEqual(['closedOn']);
    expect((await api.patch(`/api/accounts/${acc.id}`, { closedOn: '2025-01-01', status: 'closed' })).json).toMatchObject({ closedOn: '2025-01-01', status: 'closed' });
  });

  it('rejects unknown fields, server-owned fields and bad list queries', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    for (const extra of [{ id: 'mine' }, { userId: 'x' }, { nameKey: 'x' }, { createdAt: 1 }, { accountNumber: '12345678' }, { iban: 'GB33BUKB20201555555555' }, { currency: 'USD' }]) {
      expect.soft((await api.post('/api/accounts', accountBody(inst, extra))).status, JSON.stringify(extra)).toBe(400);
    }
    for (const qs of ['type=credit', 'country=be', 'currency=usd', 'currency=XAU', 'status=deleted', 'unknown=1', `q=${'x'.repeat(81)}`]) {
      const r = await api.get(`/api/accounts?${qs}`);
      expect.soft(r.status, qs).toBe(400);
      expect.soft(r.json.code, qs).toBe('VALIDATION');
    }
    const badJson = await api.req('POST', '/api/accounts', undefined, { 'content-type': 'application/json' });
    expect(badJson.status).toBe(400);
    expect(await rows('SELECT id FROM accounts')).toHaveLength(0);
  });
});

// ================================================================== PATCH and the immutable institution

describe('PATCH (A-12, D-7, status)', () => {
  it('updates the allowed fields, recomputes name_key and answers the full DTO', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    t.advance(1000);
    const r = await api.patch(`/api/accounts/${acc.id}`, { name: '  ＷＩＳＥ  Main ', numberHint: '9876', notes: 'n', sort: -2 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ name: 'ＷＩＳＥ  Main', numberHint: '9876', notes: 'n', sort: -2, institutionId: inst });
    expect(r.json.currencies).toHaveLength(3);
    expect(r.json.updatedAt).toBeGreaterThan(r.json.createdAt);
    expect((await rows('SELECT name_key FROM accounts'))[0]!.name_key).toBe('wise main');
    expect((await api.patch(`/api/accounts/${acc.id}`, { notes: null, numberHint: null })).json).toMatchObject({ notes: null, numberHint: null });
  });

  it('A-12: PATCH with institutionId — alone or with other fields — is a 400 and changes nothing', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const other = await institution(api, { name: 'Wise Europe', country: 'BE', institutionType: 'emi' });
    const acc = await createAccount(api, inst);
    const before = await snapshot();
    for (const b of [{ institutionId: other }, { name: 'Moved', institutionId: other }, { institutionId: inst }, { institutionId: null }, { institution_id: other }, {}, { currencies: CURRENCIES }]) {
      const r = await api.patch(`/api/accounts/${acc.id}`, b);
      expect.soft(r.status, JSON.stringify(b)).toBe(400);
      expect.soft(r.json.code, JSON.stringify(b)).toBe('VALIDATION');
    }
    expect(await snapshot()).toEqual(before);
  });

  it('A-12: raw SQL cannot move the account to another institution either (trigger)', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const other = await institution(api, { name: 'Wise Europe', country: 'BE', institutionType: 'emi' });
    const acc = await createAccount(api, inst);
    const err = await sqlError(exec('UPDATE accounts SET institution_id = ?, name = ? WHERE id = ?', [other, 'Moved', acc.id]));
    expect(err).toMatch(/ACCOUNT_INSTITUTION_IMMUTABLE/);
    expect((await api.get(`/api/accounts/${acc.id}`)).json).toMatchObject({ institutionId: inst, name: 'Wise 多币种账户' });
  });

  it('freezes, closes and restores; links and their default flag are left alone (D-1)', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    const card = await seedCard(user.id, inst);
    const link = await seedLink(user.id, card, acc.id, { isDefault: 1 });
    const linkRow = async () => (await rows('SELECT status, is_default FROM account_card_links WHERE id = ?', [link]))[0];
    for (const status of ['frozen', 'closed', 'active', 'closed', 'frozen', 'active'] as const) {
      const r = await api.patch(`/api/accounts/${acc.id}`, { status });
      expect(r.json.status).toBe(status);
      expect(await linkRow()).toEqual({ status: 'active', is_default: 1 });
      expect((await api.get(`/api/accounts/${acc.id}`)).json.links).toHaveLength(1);
    }
    expect((await api.patch(`/api/accounts/${acc.id}`, { status: 'deleted' })).status).toBe(400);
  });

  it('D-7: changing accountCountry changes only that account row', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    const other = await createAccount(api, inst, { name: 'Other' });
    await seedLink(user.id, await seedCard(user.id, inst), acc.id, { currency: 'EUR' });
    const before = await snapshot();
    t.advance(1000);
    expect((await api.patch(`/api/accounts/${acc.id}`, { accountCountry: 'LT' })).json.accountCountry).toBe('LT');
    const after = await snapshot();
    for (const table of M2_TABLES.filter((x) => x !== 'accounts')) expect(after[table], table).toEqual(before[table]);
    const changed = (s: Record<string, unknown[]>) => (s.accounts as { id: string }[]).find((r) => r.id === acc.id);
    expect(changed(after)).toEqual({ ...(changed(before) as object), account_country: 'LT', updated_at: t.clock.t });
    expect((after.accounts as { id: string }[]).find((r) => r.id === other.id)).toEqual((before.accounts as { id: string }[]).find((r) => r.id === other.id));
  });

  it('a payment-channel balance account cannot become a bank account (400 BALANCE_ACCOUNT_KIND)', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    const channel = await seedChannel(user.id, { balanceAccountId: acc.id });
    for (const accountType of ['bank', 'other']) {
      const r = await api.patch(`/api/accounts/${acc.id}`, { accountType });
      expect.soft(r.status).toBe(400);
      expect.soft(r.json.code).toBe('BALANCE_ACCOUNT_KIND');
      expect.soft(r.json.details.channels).toEqual([{ id: channel, name: expect.any(String), channelType: 'payment_service', status: 'active' }]);
    }
    expect((await api.patch(`/api/accounts/${acc.id}`, { accountType: 'stored_value' })).json.accountType).toBe('stored_value');
    await exec('UPDATE payment_channels SET balance_account_id = NULL WHERE id = ?', [channel]);
    expect((await api.patch(`/api/accounts/${acc.id}`, { accountType: 'bank' })).json.accountType).toBe('bank');
  });
});

// ================================================================== currencies

describe('PUT /accounts/:id/currencies (A-3, A-4, D-2)', () => {
  it('A-4: adds, removes, reorders, switches the default and closes currencies; kept rows keep created_at', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    const createdAt = (await currencyRows(acc.id)).find((r) => r.currency === 'EUR')!.created_at;
    t.advance(5000);
    const r = await putCurrencies(api, acc.id, [{ code: 'HKD' }, { code: 'EUR', isDefault: true }, { code: 'USD', status: 'closed' }]);
    expect(r.status).toBe(200);
    expect(r.json.currencies).toEqual([
      { currency: 'HKD', isDefault: false, status: 'active', sort: 0 },
      { currency: 'EUR', isDefault: true, status: 'active', sort: 1 },
      { currency: 'USD', isDefault: false, status: 'closed', sort: 2 },
    ]);
    expect(r.json.updatedAt).toBe(t.clock.t);
    const stored = await currencyRows(acc.id);
    expect(stored.find((x) => x.currency === 'EUR')!.created_at).toBe(createdAt);
    expect(stored.find((x) => x.currency === 'HKD')!.created_at).toBe(t.clock.t);
    expect(stored.map((x) => x.currency)).not.toContain('GBP');
    // Reopening a closed currency and making it the default again.
    const back = await putCurrencies(api, acc.id, [{ code: 'USD', isDefault: true }, { code: 'EUR' }]);
    expect(back.json.currencies).toEqual([
      { currency: 'USD', isDefault: true, status: 'active', sort: 0 },
      { currency: 'EUR', isDefault: false, status: 'active', sort: 1 },
    ]);
  });

  it('A-2 / A-4: the replacement list is validated like a create; nothing changes on a 400', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    const before = await currencyRows(acc.id);
    for (const currencies of [[], [{ code: 'USD' }], [{ code: 'USD', isDefault: true }, { code: 'EUR', isDefault: true }], [{ code: 'USD', isDefault: true }, { code: 'USD' }], [{ code: 'USD', isDefault: true, status: 'closed' }, { code: 'EUR' }], [{ code: 'XAU', isDefault: true }]]) {
      const r = await putCurrencies(api, acc.id, currencies as Currency[]);
      expect.soft(r.status, JSON.stringify(currencies)).toBe(400);
    }
    expect((await api.req('PUT', `/api/accounts/${acc.id}/currencies`, { currencies: CURRENCIES, force: true })).status).toBe(400);
    expect(await currencyRows(acc.id)).toEqual(before);
  });

  it('A-4: a currency used by a card link cannot be removed (409 CURRENCY_IN_USE) but can be closed, keeping the link', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    const card = await seedCard(user.id, inst);
    const link = await seedLink(user.id, card, acc.id, { currency: 'EUR', isDefault: 1 });
    const before = await snapshot();
    const r = await putCurrencies(api, acc.id, [{ code: 'USD', isDefault: true }, { code: 'GBP' }]);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('CURRENCY_IN_USE');
    expect(r.json.details).toEqual({ currencies: ['EUR'] });
    expect(await snapshot()).toEqual(before);

    // Closing it is allowed: the link, its scope and its default flag stay (D-2).
    const closed = await putCurrencies(api, acc.id, [{ code: 'USD', isDefault: true }, { code: 'EUR', status: 'closed' }, { code: 'GBP' }]);
    expect(closed.status).toBe(200);
    expect(closed.json.currencies.find((c: { currency: string }) => c.currency === 'EUR').status).toBe('closed');
    expect((await rows('SELECT currency, status, is_default FROM account_card_links WHERE id = ?', [link]))[0]).toEqual({ currency: 'EUR', status: 'active', is_default: 1 });
    const detail = (await api.get(`/api/accounts/${acc.id}`)).json;
    expect(detail.links).toEqual([expect.objectContaining({ id: link, currency: 'EUR', status: 'active', isDefault: true })]);

    // Ended links are history and still reference the currency.
    await exec(`UPDATE account_card_links SET status = 'ended', is_default = 0 WHERE id = ?`, [link]);
    expect((await putCurrencies(api, acc.id, [{ code: 'USD', isDefault: true }])).json.code).toBe('CURRENCY_IN_USE');
    // Once the link record is gone (deleted as a mistake), the currency can be removed.
    await exec('DELETE FROM account_card_links WHERE id = ?', [link]);
    expect((await putCurrencies(api, acc.id, [{ code: 'USD', isDefault: true }])).json.currencies).toHaveLength(1);
  });

  it('A-4: all-currency links (currency = NULL) do not pin any currency', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    await seedLink(user.id, await seedCard(user.id, inst), acc.id, { currency: null, isDefault: 1 });
    expect((await putCurrencies(api, acc.id, [{ code: 'JPY', isDefault: true }])).status).toBe(200);
  });

  it('A-4: a link created between the check and the batch is caught by the foreign key — 409 and nothing changes', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    const card = await seedCard(user.id, inst);
    const before = await currencyRows(acc.id);
    // Simulate the race: the link appears right after the reference check ran.
    const original = t.db.batch.bind(t.db);
    const spy = vi.spyOn(t.db, 'batch').mockImplementationOnce(async (batch) => {
      await seedLink(user.id, card, acc.id, { currency: 'GBP' });
      return original(batch as never);
    });
    const r = await putCurrencies(api, acc.id, [{ code: 'EUR', isDefault: true }]);
    spy.mockRestore();
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: 'CURRENCY_IN_USE', details: { currencies: ['GBP'] } });
    expect(await currencyRows(acc.id)).toEqual(before);
  });

  it('A-3: the database allows one default per account', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    const err = await sqlError(exec(`INSERT INTO account_currencies (account_id, user_id, currency, is_default, created_at) VALUES (?, ?, 'JPY', 1, 1)`, [acc.id, user.id]));
    expect(err).toMatch(/UNIQUE constraint failed/);
    expect(await sqlError(exec(`UPDATE account_currencies SET is_default = 1 WHERE account_id = ? AND currency = 'EUR'`, [acc.id]))).toMatch(/UNIQUE constraint failed/);
    expect(await sqlError(exec(`UPDATE account_currencies SET status = 'closed' WHERE account_id = ? AND currency = 'USD'`, [acc.id]))).toMatch(/account_currencies_default_active_ck/);
    expect((await currencyRows(acc.id)).filter((c) => c.is_default === 1).map((c) => c.currency)).toEqual(['USD']);
  });

  it('404 for unknown accounts and for accounts of another user', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bob');
    const acc = await createAccount(alice.api, await institution(alice.api));
    const before = await currencyRows(acc.id);
    expect((await putCurrencies(alice.api, 'x'.repeat(26), CURRENCIES)).status).toBe(404);
    const r = await putCurrencies(bob.api, acc.id, [{ code: 'JPY', isDefault: true }]);
    expect(r.status).toBe(404);
    expect(await currencyRows(acc.id)).toEqual(before);
  });
});

// ================================================================== batch atomicity

describe('batch atomicity (D1-compatible writes)', () => {
  it('POST: a failing currency insert rolls back the account and the currencies before it', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    await failOnCurrency('GBP');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await api.post('/api/accounts', accountBody(inst)); // USD, EUR succeed, GBP fails
    quiet.mockRestore();
    expect(r.status).toBe(500);
    expect(await rows('SELECT id FROM accounts')).toHaveLength(0);
    expect(await rows('SELECT account_id FROM account_currencies')).toHaveLength(0);
    // Without GBP the same request succeeds.
    expect((await api.post('/api/accounts', accountBody(inst, { currencies: [{ code: 'USD', isDefault: true }, { code: 'EUR' }] }))).status).toBe(201);
  });

  it('PUT: a failure half-way through restores the old default, the removed currencies and the old order', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    const before = await snapshot();
    await failOnCurrency('JPY');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    // clear default → delete USD → EUR becomes the default → GBP moves → JPY insert fails.
    const r = await putCurrencies(api, acc.id, [{ code: 'EUR', isDefault: true }, { code: 'GBP', status: 'closed' }, { code: 'JPY' }]);
    quiet.mockRestore();
    expect(r.status).toBe(500);
    expect(await snapshot()).toEqual(before);
  });

  // USD (default), EUR, HKD with two links; the replacement fails at a middle step of the batch.
  const MIDDLE_FAILURES = {
    // after: clear default → delete USD → EUR becomes the default → HKD closed; then the JPY insert fails.
    'inserting JPY': `CREATE TRIGGER test_fail_step BEFORE INSERT ON account_currencies WHEN NEW.currency = 'JPY' BEGIN SELECT RAISE(ABORT, 'TEST_INJECTED_FAILURE'); END`,
    // after: clear default → delete USD → EUR becomes the default; then closing HKD fails.
    'closing HKD': `CREATE TRIGGER test_fail_step BEFORE UPDATE OF status ON account_currencies WHEN NEW.currency = 'HKD' AND NEW.status = 'closed' BEGIN SELECT RAISE(ABORT, 'TEST_INJECTED_FAILURE'); END`,
  };
  it.each(Object.entries(MIDDLE_FAILURES))('PUT failing at %s rolls back everything: currencies, default USD, updated_at, links', async (_step, trigger) => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst, { currencies: [{ code: 'USD', isDefault: true }, { code: 'EUR' }, { code: 'HKD' }] });
    const card = await seedCard(user.id, inst);
    await seedLink(user.id, card, acc.id, { currency: 'EUR', isDefault: 1 });
    await seedLink(user.id, card, acc.id, { currency: null, role: 'top_up_source' });
    const currenciesBefore = await currencyRows(acc.id);
    const accountBefore = await rows('SELECT * FROM accounts WHERE id = ?', [acc.id]);
    const linksBefore = await rows('SELECT * FROM account_card_links ORDER BY id');
    const before = await snapshot();
    await exec(trigger);
    t.advance(60_000); // a committed batch would move updated_at
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await putCurrencies(api, acc.id, [{ code: 'EUR', isDefault: true }, { code: 'HKD', status: 'closed' }, { code: 'JPY' }]);
    quiet.mockRestore();
    expect(r.status).toBe(500);

    const currenciesAfter = await currencyRows(acc.id);
    expect(currenciesAfter).toEqual(currenciesBefore);
    expect(currenciesAfter.map((c) => c.currency)).toEqual(['USD', 'EUR', 'HKD']);
    expect(currenciesAfter.filter((c) => c.is_default === 1).map((c) => c.currency)).toEqual(['USD']);
    expect(currenciesAfter.every((c) => c.status === 'active')).toBe(true);
    expect(await rows('SELECT * FROM accounts WHERE id = ?', [acc.id])).toEqual(accountBefore);
    expect((await api.get(`/api/accounts/${acc.id}`)).json.updatedAt).toBe(acc.updatedAt);
    expect(await rows('SELECT * FROM account_card_links ORDER BY id')).toEqual(linksBefore);
    expect(await snapshot()).toEqual(before);

    // Without the injected failure the same replacement goes through.
    await exec('DROP TRIGGER test_fail_step');
    expect((await putCurrencies(api, acc.id, [{ code: 'EUR', isDefault: true }, { code: 'HKD', status: 'closed' }, { code: 'JPY' }])).status).toBe(200);
  });

  it('POST: the institution deleted between the check and the batch → 404, nothing written', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const original = t.db.batch.bind(t.db);
    const spy = vi.spyOn(t.db, 'batch').mockImplementationOnce(async (batch) => {
      await exec('DELETE FROM institutions WHERE id = ?', [inst]);
      return original(batch as never);
    });
    const r = await api.post('/api/accounts', accountBody(inst));
    spy.mockRestore();
    expect(r.status).toBe(404);
    expect(await rows('SELECT id FROM accounts')).toHaveLength(0);
    expect(await rows('SELECT account_id FROM account_currencies')).toHaveLength(0);
  });
});

// ================================================================== delete

describe('DELETE (A-10, A-11, D-4)', () => {
  it('A-10 / A-11: cascades to currencies, links (also currency-scoped ones) and channel sources; audited with the id only', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    const keep = await createAccount(api, inst, { name: 'Keep' });
    const card = await seedCard(user.id, inst);
    await seedLink(user.id, card, acc.id, { currency: 'EUR', isDefault: 1 });
    await seedLink(user.id, card, acc.id, { currency: null, role: 'top_up_source' });
    await seedLink(user.id, card, keep.id, { currency: 'USD' });
    const channel = await seedChannel(user.id);
    await seedSource(user.id, channel, acc.id);

    const r = await api.del(`/api/accounts/${acc.id}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect((await api.get(`/api/accounts/${acc.id}`)).status).toBe(404);
    expect(await rows('SELECT * FROM account_currencies WHERE account_id = ?', [acc.id])).toHaveLength(0);
    expect(await rows('SELECT * FROM account_card_links WHERE account_id = ?', [acc.id])).toHaveLength(0);
    expect(await rows('SELECT * FROM payment_channel_sources WHERE account_id = ?', [acc.id])).toHaveLength(0);
    // Everything else stays: the card, the channel, the other account and its link.
    expect(await rows('SELECT id FROM cards')).toHaveLength(1);
    expect(await rows('SELECT id FROM payment_channels')).toHaveLength(1);
    expect(await rows('SELECT id FROM account_card_links WHERE account_id = ?', [keep.id])).toHaveLength(1);
    expect(await currencyRows(keep.id)).toHaveLength(3);
    expect(await rows('PRAGMA foreign_key_check')).toHaveLength(0);
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.action, 'account.delete'));
    expect(audits.map((a) => a.detail)).toEqual([{ id: acc.id }]);
  });

  it('D-4: the balance account of a channel cannot be deleted (409 IN_USE naming the channel); raw SQL fails too', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    const channel = await seedChannel(user.id, { balanceAccountId: acc.id });
    const r = await api.del(`/api/accounts/${acc.id}`);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('IN_USE');
    expect(r.json.details).toEqual({ references: { balanceOfChannels: 1 }, channels: [{ id: channel, name: expect.any(String), channelType: 'payment_service', status: 'active' }] });
    expect(await sqlError(exec('DELETE FROM accounts WHERE id = ?', [acc.id]))).toMatch(/FOREIGN KEY/);
    expect((await api.get(`/api/accounts/${acc.id}`)).status).toBe(200);
    expect(await t.db.select().from(auditLog).where(eq(auditLog.action, 'account.delete'))).toHaveLength(0);
    // Closing is the alternative.
    expect((await api.patch(`/api/accounts/${acc.id}`, { status: 'closed' })).status).toBe(200);
    // Once released, it can be deleted.
    await exec('UPDATE payment_channels SET balance_account_id = NULL WHERE id = ?', [channel]);
    expect((await api.del(`/api/accounts/${acc.id}`)).status).toBe(200);
  });

  it('a balance account taken between the check and the delete is refused by the foreign key → 409', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    const original = t.db.delete.bind(t.db);
    const spy = vi.spyOn(t.db, 'delete').mockImplementationOnce((table) => {
      // Runs before the DELETE statement is awaited: a channel takes the account now.
      void seedChannel(user.id, { balanceAccountId: acc.id });
      return original(table as never);
    });
    const r = await api.del(`/api/accounts/${acc.id}`);
    spy.mockRestore();
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('IN_USE');
    expect((await api.get(`/api/accounts/${acc.id}`)).status).toBe(200);
  });

  it('the account keeps its institution referenced: the institution cannot be deleted until the account is', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    const blocked = await api.del(`/api/institutions/${inst}`);
    expect(blocked.json).toMatchObject({ code: 'IN_USE', details: { references: { accounts: 1, cards: 0, channels: 0 } } });
    await api.del(`/api/accounts/${acc.id}`);
    expect((await api.del(`/api/institutions/${inst}`)).status).toBe(200);
  });
});

// ================================================================== list, filters and detail

describe('list, filters and detail', () => {
  it('filters by q, institution, type, country, currency, status and card; sorted by sort then name', async () => {
    const { api, user } = await signIn();
    const wise = await institution(api);
    const hsbc = await institution(api, { name: 'HSBC Hong Kong', country: 'HK', institutionType: 'bank' });
    const a = await createAccount(api, wise, { name: 'Wise 多币种', numberHint: 'AB12' });
    const b = await createAccount(api, hsbc, { name: 'HSBC One', accountType: 'bank', depositKind: 'savings', accountCountry: 'HK', currencies: [{ code: 'HKD', isDefault: true }, { code: 'USD' }] });
    const c = await createAccount(api, hsbc, { name: 'Pay_100%', accountType: 'stored_value', accountCountry: 'HK', currencies: [{ code: 'HKD', isDefault: true }], sort: -1 });
    const closed = await createAccount(api, wise, { name: 'Old Wise', status: 'closed', currencies: [{ code: 'JPY', isDefault: true }] });
    const frozen = await createAccount(api, hsbc, { name: 'Frozen HKD', accountType: 'bank', accountCountry: 'HK', status: 'frozen', currencies: [{ code: 'HKD', isDefault: true }] });
    const names = async (qs = '') => ((await api.get(`/api/accounts${qs}`)).json as { name: string }[]).map((x) => x.name);

    // Closed accounts are hidden by default; frozen ones are not. sort first, then name.
    expect(await names()).toEqual(['Pay_100%', 'Frozen HKD', 'HSBC One', 'Wise 多币种']);
    expect(await names('?status=all')).toEqual(['Pay_100%', 'Frozen HKD', 'HSBC One', 'Old Wise', 'Wise 多币种']);
    expect(await names('?status=closed')).toEqual(['Old Wise']);
    expect(await names('?status=frozen')).toEqual(['Frozen HKD']);
    expect(await names('?status=active')).toEqual(['Pay_100%', 'HSBC One', 'Wise 多币种']);
    // q: account name (normalized), institution name, number hint; LIKE wildcards are literal.
    expect(await names(`?q=${encodeURIComponent(' ＷＩＳＥ ')}`)).toEqual(['Wise 多币种']);
    expect(await names('?q=hong%20kong')).toEqual(['Pay_100%', 'Frozen HKD', 'HSBC One']);
    expect(await names('?q=ab12')).toEqual(['Wise 多币种']);
    expect(await names(`?q=${encodeURIComponent('_')}`)).toEqual(['Pay_100%']);
    expect(await names(`?q=${encodeURIComponent('%')}`)).toEqual(['Pay_100%']);
    expect(await names('?q=nothing')).toEqual([]);
    expect(await names(`?institutionId=${wise}&status=all`)).toEqual(['Old Wise', 'Wise 多币种']);
    expect(await names('?type=bank')).toEqual(['Frozen HKD', 'HSBC One']);
    expect(await names('?country=BE')).toEqual(['Wise 多币种']);
    expect(await names('?currency=USD')).toEqual(['HSBC One', 'Wise 多币种']);
    expect(await names('?currency=JPY')).toEqual([]);
    expect(await names('?currency=JPY&status=all')).toEqual(['Old Wise']);
    expect(await names('?type=bank&country=HK&currency=HKD&status=active')).toEqual(['HSBC One']);
    // A closed currency still counts for the currency filter.
    await putCurrencies(api, a.id, [{ code: 'EUR', isDefault: true }, { code: 'USD', status: 'closed' }]);
    expect(await names('?currency=USD')).toEqual(['HSBC One', 'Wise 多币种']);
    // cardId: unfinished links only.
    const card = await seedCard(user.id, wise);
    await seedLink(user.id, card, b.id);
    await seedLink(user.id, card, c.id, { status: 'ended' });
    expect(await names(`?cardId=${card}`)).toEqual(['HSBC One']);
    expect([closed, frozen]).toHaveLength(2);
  });

  it('list items count unfinished linked cards and show the first three; the detail lists every link, ended ones too', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    const cardIds = [];
    for (const name of ['D card', 'A card', 'C card', 'B card', 'E card']) cardIds.push(await seedCard(user.id, inst, name));
    await seedLink(user.id, cardIds[0]!, acc.id, { isDefault: 1 });
    await seedLink(user.id, cardIds[0]!, acc.id, { role: 'top_up_source' }); // same card twice: counted once
    await seedLink(user.id, cardIds[1]!, acc.id, { currency: 'EUR' });
    await seedLink(user.id, cardIds[2]!, acc.id, { status: 'suspended' });
    await seedLink(user.id, cardIds[3]!, acc.id);
    const ended = await seedLink(user.id, cardIds[4]!, acc.id, { status: 'ended' });

    const [item] = (await api.get('/api/accounts')).json;
    expect(item.linkedCardCount).toBe(4);
    expect(item.linkedCards.map((c: { name: string }) => c.name)).toEqual(['A card', 'B card', 'C card']);
    expect(item.linkedCards[0]).toEqual({ id: cardIds[1], name: 'A card', network: 'visa', last4: '4321', cardType: 'debit', status: 'active' });

    const detail = (await api.get(`/api/accounts/${acc.id}`)).json;
    expect(detail.links).toHaveLength(6);
    expect(detail.links.find((l: { id: string }) => l.id === ended)).toMatchObject({ status: 'ended', card: { name: 'E card' }, account: { id: acc.id, name: 'Wise 多币种账户', accountCountry: 'BE', status: 'active' } });
    expect(Object.keys(detail.links[0]).sort()).toEqual(['account', 'accountId', 'card', 'cardId', 'createdAt', 'currency', 'endedOn', 'id', 'isDefault', 'notes', 'priority', 'role', 'startedOn', 'status', 'updatedAt']);
  });

  it('the detail lists channels using the account as balance account or as an active source', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    const balance = await seedChannel(user.id, { balanceAccountId: acc.id });
    const source = await seedChannel(user.id);
    await seedSource(user.id, source, acc.id);
    await seedSource(user.id, balance, acc.id, 'ended');
    const detail = (await api.get(`/api/accounts/${acc.id}`)).json;
    expect(detail.balanceOfChannels.map((c: { id: string }) => c.id)).toEqual([balance]);
    expect(detail.sourceOfChannels.map((c: { id: string }) => c.id)).toEqual([source]);
  });

  it('I-1 regression: the institution detail lists the accounts created through the API', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    for (const name of ['Wise EUR', 'Wise USD', 'Wise GBP']) await createAccount(api, inst, { name });
    const detail = (await api.get(`/api/institutions/${inst}`)).json;
    expect(detail.accountCount).toBe(3);
    expect(detail.accounts.map((a: { name: string }) => a.name).sort()).toEqual(['Wise EUR', 'Wise GBP', 'Wise USD']);
  });

  it('list items and details tell active and closed currencies apart; the currency filter includes closed ones', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst, { currencies: [{ code: 'USD', isDefault: true }, { code: 'EUR', status: 'closed' }, { code: 'HKD' }] });
    const expected = [
      { currency: 'USD', isDefault: true, status: 'active', sort: 0 },
      { currency: 'EUR', isDefault: false, status: 'closed', sort: 1 },
      { currency: 'HKD', isDefault: false, status: 'active', sort: 2 },
    ];
    expect(acc.currencies).toEqual(expected);
    expect((await api.get(`/api/accounts/${acc.id}`)).json.currencies).toEqual(expected);
    const [item] = (await api.get('/api/accounts?currency=EUR')).json;
    expect(item.id).toBe(acc.id);
    expect(item.currencies).toEqual(expected);
  });
});

// ================================================================== institution must be active

describe('new accounts need an active institution', () => {
  it('active: created; archived: 409 INSTITUTION_ARCHIVED and nothing written; restored: created again', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const first = await createAccount(api, inst, { name: 'Before archiving' });
    expect((await api.patch(`/api/institutions/${inst}`, { status: 'archived' })).status).toBe(200);
    const before = await snapshot();

    const r = await api.post('/api/accounts', accountBody(inst, { name: 'While archived' }));
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: expect.any(String), code: 'INSTITUTION_ARCHIVED', details: { institutionId: inst } });
    expect(await snapshot()).toEqual(before);

    // Existing accounts of the archived institution stay readable, editable and listed.
    expect((await api.get(`/api/accounts/${first.id}`)).json.institution.status).toBe('archived');
    expect((await api.patch(`/api/accounts/${first.id}`, { notes: 'still editable' })).status).toBe(200);
    expect((await putCurrencies(api, first.id, [{ code: 'USD', isDefault: true }, { code: 'EUR', status: 'closed' }])).status).toBe(200);
    expect(((await api.get('/api/accounts')).json as { id: string }[]).map((a) => a.id)).toEqual([first.id]);

    expect((await api.patch(`/api/institutions/${inst}`, { status: 'active' })).status).toBe(200);
    const after = await createAccount(api, inst, { name: 'After restoring' });
    expect(after.institution.status).toBe('active');
  });

  it("another user's institution is a 404 whether it is active or archived (its status is never revealed)", async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bob');
    const active = await institution(alice.api);
    const archived = await institution(alice.api, { name: 'Old Bank', institutionType: 'bank' });
    await alice.api.patch(`/api/institutions/${archived}`, { status: 'archived' });
    for (const id of [active, archived, 'x'.repeat(26)]) {
      const r = await bob.api.post('/api/accounts', accountBody(id));
      expect.soft(r.status, id).toBe(404);
      expect.soft(r.json, id).toEqual({ error: 'institution not found', code: 'NOT_FOUND' });
    }
    expect(await rows('SELECT id FROM accounts')).toHaveLength(0);
  });

  it('archived between the check and the batch: the batch writes nothing and answers 409', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const before = await snapshot();
    const original = t.db.batch.bind(t.db);
    const spy = vi.spyOn(t.db, 'batch').mockImplementationOnce(async (batch) => {
      // The pre-check saw an active institution; it is archived right before the batch runs.
      await exec(`UPDATE institutions SET status = 'archived' WHERE id = ?`, [inst]);
      return original(batch as never);
    });
    const r = await api.post('/api/accounts', accountBody(inst));
    spy.mockRestore();
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('INSTITUTION_ARCHIVED');
    const after = await snapshot();
    expect(after.accounts).toEqual(before.accounts);
    expect(after.account_currencies).toEqual(before.account_currencies);
  });
});

// ================================================================== sensitive data

describe('sensitive data (X-1 – X-4)', () => {
  const PANS = ['4111 1111 1111 1111', '4111-1111-1111-1111', '4111111111111111', '４１１１１１１１１１１１１１１１'];
  const CODES = ['cvv 123', 'CVC:1234', 'PIN=0000', '安全码 123'];

  it('rejects card numbers and CVV / PIN codes in the name and notes on create — nothing is written', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    for (const text of [...PANS, ...CODES]) {
      for (const field of ['name', 'notes'] as const) {
        const r = await api.post('/api/accounts', accountBody(inst, { [field]: `x ${text}` }));
        expect.soft(r.status, `${field}: ${text}`).toBe(400);
        expect.soft(r.json.code).toBe('SENSITIVE_DATA');
        expect.soft(r.json.details.fields).toEqual([{ field, kind: expect.any(String) }]);
        expect.soft(JSON.stringify(r.json)).not.toContain(text);
      }
    }
    expect(await rows('SELECT id FROM accounts')).toHaveLength(0);
    expect(await rows('SELECT account_id FROM account_currencies')).toHaveLength(0);
  });

  it('rejects them on PATCH, leaving the row unchanged; ordinary text and non-Luhn numbers pass (X-2)', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst, { notes: 'fine' });
    for (const b of [{ notes: '4111 1111 1111 1111' }, { name: 'Acc 5500 0000 0000 0004' }, { notes: 'pin 1234' }]) {
      const r = await api.patch(`/api/accounts/${acc.id}`, b);
      expect.soft(r.status).toBe(400);
      expect.soft(r.json.code).toBe('SENSITIVE_DATA');
    }
    expect((await api.get(`/api/accounts/${acc.id}`)).json).toMatchObject({ name: 'Wise 多币种账户', notes: 'fine' });
    for (const notes of ['4111 1111 1111 1112', 'IBAN ends 1234', 'spin 1234 times']) expect.soft((await api.patch(`/api/accounts/${acc.id}`, { notes })).status, notes).toBe(200);
  });

  it('X-4: there is no bypass flag', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    for (const flag of [{ force: true }, { allowSensitive: true }, { skipScan: true }]) {
      const r = await api.post('/api/accounts', accountBody(inst, { notes: '4111111111111111', ...flag }));
      expect.soft(r.status).toBe(400);
      expect.soft(r.json.code).toBe('VALIDATION');
    }
  });
});

// ================================================================== isolation

describe('isolation between users (U-1 – U-3)', () => {
  it("U-2: an account cannot be opened at another user's institution (404) or an unknown one", async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bob');
    const aliceInst = await institution(alice.api);
    for (const institutionId of [aliceInst, 'x'.repeat(26)]) {
      const r = await bob.api.post('/api/accounts', accountBody(institutionId));
      expect.soft(r.status).toBe(404);
      expect.soft(r.json.code).toBe('NOT_FOUND');
    }
    expect(await rows('SELECT id FROM accounts')).toHaveLength(0);
    // Even raw SQL can't: the composite foreign key refuses it.
    const err = await sqlError(
      exec(`INSERT INTO accounts (id, user_id, institution_id, name, name_key, account_type, account_country, created_at, updated_at) VALUES ('x', ?, ?, 'X', 'x', 'bank', 'BE', 1, 1)`, [bob.user.id, aliceInst]),
    );
    expect(err).toMatch(/FOREIGN KEY/);
  });

  it("U-1 / U-3: another user's accounts are 404 on every route, absent from lists, and unchanged", async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bob');
    const inst = await institution(alice.api);
    const acc = await createAccount(alice.api, inst);
    const before = await snapshot();
    const id = acc.id;
    expect((await bob.api.get(`/api/accounts/${id}`)).status).toBe(404);
    expect((await bob.api.patch(`/api/accounts/${id}`, { name: 'Taken' })).status).toBe(404);
    expect((await bob.api.patch(`/api/accounts/${id}`, { status: 'closed' })).status).toBe(404);
    expect((await putCurrencies(bob.api, id, [{ code: 'JPY', isDefault: true }])).status).toBe(404);
    expect((await bob.api.del(`/api/accounts/${id}`)).status).toBe(404);
    expect((await bob.api.get('/api/accounts?status=all')).json).toEqual([]);
    expect((await bob.api.get(`/api/accounts?institutionId=${inst}&status=all`)).json).toEqual([]);
    expect((await bob.api.get('/api/accounts?q=wise&status=all')).json).toEqual([]);
    expect(await snapshot()).toEqual(before);
    // Bob's own list only has his rows.
    const bobAcc = await createAccount(bob.api, await institution(bob.api));
    expect(((await bob.api.get('/api/accounts')).json as { id: string }[]).map((a) => a.id)).toEqual([bobAcc.id]);
    expect(((await alice.api.get('/api/accounts')).json as { id: string }[]).map((a) => a.id)).toEqual([id]);
  });

  it("links, cards and channels of another user never show up in lists, counts or details", async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bob');
    const aliceAcc = await createAccount(alice.api, await institution(alice.api));
    const bobInst = await institution(bob.api);
    const bobAcc = await createAccount(bob.api, bobInst);
    await seedLink(bob.user.id, await seedCard(bob.user.id, bobInst), bobAcc.id);
    const [item] = (await alice.api.get('/api/accounts')).json;
    expect(item.linkedCardCount).toBe(0);
    expect((await alice.api.get(`/api/accounts/${aliceAcc.id}`)).json.links).toEqual([]);
    // A cross-user link is refused by the composite keys.
    expect(await sqlError(seedLink(bob.user.id, await seedCard(bob.user.id, bobInst), aliceAcc.id))).toMatch(/FOREIGN KEY/);
  });
});

// ================================================================== auth

describe('authentication, CSRF and Origin (R-1)', () => {
  it('every account route needs a session', async () => {
    const { api } = await signIn();
    const acc = await createAccount(api, await institution(api));
    const anon = client(t);
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/accounts'],
      ['POST', '/api/accounts', accountBody('x')],
      ['GET', `/api/accounts/${acc.id}`],
      ['PATCH', `/api/accounts/${acc.id}`, { name: 'X' }],
      ['PUT', `/api/accounts/${acc.id}/currencies`, { currencies: CURRENCIES }],
      ['DELETE', `/api/accounts/${acc.id}`],
    ];
    for (const [method, path, b] of calls) {
      const r = await anon.req(method, path, b);
      expect.soft(r.status, `${method} ${path}`).toBe(401);
      expect.soft(r.json.code).toBe('UNAUTHENTICATED');
    }
    expect((await anon.req('GET', '/api/accounts', undefined, { cookie: 'xui_session=forged' })).status).toBe(401);
  });

  it('writes need the x-xui-csrf header and an allowed Origin; nothing changes otherwise', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    const before = await snapshot();
    const writes: [string, string, unknown?][] = [
      ['POST', '/api/accounts', accountBody(inst)],
      ['PATCH', `/api/accounts/${acc.id}`, { name: 'Evil' }],
      ['PUT', `/api/accounts/${acc.id}/currencies`, { currencies: [{ code: 'JPY', isDefault: true }] }],
      ['DELETE', `/api/accounts/${acc.id}`],
    ];
    for (const [method, path, b] of writes) {
      const evil = await api.req(method, path, b, { origin: 'https://evil.example' });
      expect.soft(evil.status, `${method} origin`).toBe(403);
      expect.soft(evil.json.code).toBe('BAD_ORIGIN');
      const noCsrf = await api.req(method, path, b, { [CSRF_HEADER]: '' });
      expect.soft(noCsrf.status, `${method} csrf`).toBe(403);
      expect.soft(noCsrf.json.code).toBe('CSRF');
      const legacyCsrf = await api.req(method, path, b, { [CSRF_HEADER]: '', 'x-zui-csrf': '1' });
      expect.soft(legacyCsrf.json.code).toBe('CSRF');
    }
    expect(await snapshot()).toEqual(before);
    expect((await api.get('/api/accounts')).res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 404 for unknown ids on every route', async () => {
    const { api } = await signIn();
    const missing = 'x'.repeat(26);
    expect((await api.get(`/api/accounts/${missing}`)).json.code).toBe('NOT_FOUND');
    expect((await api.patch(`/api/accounts/${missing}`, { name: 'X' })).status).toBe(404);
    expect((await api.del(`/api/accounts/${missing}`)).status).toBe(404);
    expect((await putCurrencies(api, missing, CURRENCIES)).status).toBe(404);
  });
});
