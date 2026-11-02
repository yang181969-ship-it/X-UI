// M2-B2.1: financial institutions API (API_SPEC §3.2, TEST_PLAN §3.1, X-1–X-4, U-1–U-3, R-1).
// Accounts, cards and channels have no API yet, so references are seeded with raw SQL.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../src/auth/middleware.ts';
import { auditLog, institutions } from '../src/db/schema.ts';
import { client, login, makeUser, ORIGIN, setup, type TestEnv } from './helpers.ts';

let t: TestEnv;
beforeEach(async () => {
  t = await setup();
});
afterEach(() => t.cleanup());

type Api = Awaited<ReturnType<typeof login>>;

async function signIn(name = 'alice') {
  const u = await makeUser(t, name);
  return { user: u.user, api: await login(t, u) };
}

const WISE = { name: 'Wise', country: 'GB', institutionType: 'emi' } as const;

async function create(api: Api, body: Record<string, unknown>) {
  const r = await api.post('/api/institutions', body);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json as { id: string; name: string; country: string | null };
}

let seq = 0;
const T = 1_700_000_000_000;
/** Raw-SQL rows referencing an institution (the account / card / channel APIs come later). */
async function seedAccount(userId: string, institutionId: string, name = `Account ${++seq}`) {
  const id = `acc-${++seq}`;
  await t.client.execute({
    sql: `INSERT INTO accounts (id, user_id, institution_id, name, name_key, account_type, account_country, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'e_money', 'BE', ?, ?)`,
    args: [id, userId, institutionId, name, name.toLowerCase(), T, T],
  });
  return id;
}
async function seedCard(userId: string, institutionId: string) {
  const id = `card-${++seq}`;
  await t.client.execute({
    sql: `INSERT INTO cards (id, user_id, issuer_institution_id, name, network, card_type, last4, issuing_country, created_at, updated_at) VALUES (?, ?, ?, 'Debit', 'visa', 'debit', '4321', 'BE', ?, ?)`,
    args: [id, userId, institutionId, T, T],
  });
  return id;
}
async function seedChannel(userId: string, institutionId: string) {
  const id = `ch-${++seq}`;
  await t.client.execute({
    sql: `INSERT INTO payment_channels (id, user_id, name, name_key, channel_type, provider_institution_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'payment_service', ?, ?, ?)`,
    args: [id, userId, `Channel ${seq}`, `channel ${seq}`, institutionId, T, T],
  });
  return id;
}

/**
 * The database error of a statement that must fail, as text. The error object is not kept: on
 * Windows a retained libsql error keeps the database file open and the cleanup can't delete it.
 */
const sqlError = (p: Promise<unknown>) => p.then(
  () => 'no error',
  (e: unknown) => String((e as { message?: unknown }).message ?? e),
);

const institutionRows = async () => (await t.client.execute('SELECT * FROM institutions ORDER BY id')).rows;

describe('CRUD', () => {
  it('creates, reads, lists, updates and deletes an institution', async () => {
    const { api } = await signIn();
    const created = await api.post('/api/institutions', {
      name: '  Example Bank  ',
      country: 'HK',
      institutionType: 'bank',
      website: 'https://bank.example.com',
      color: '#1677FF',
      notes: 'Opened at the branch',
      sort: 5,
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      name: 'Example Bank',
      country: 'HK',
      institutionType: 'bank',
      website: 'https://bank.example.com',
      color: '#1677ff',
      notes: 'Opened at the branch',
      status: 'active',
      sort: 5,
    });
    const id = created.json.id as string;
    expect(id).toMatch(/^[0-9a-z]{26}$/);
    const [row] = await t.db.select().from(institutions).where(eq(institutions.id, id));
    expect(row!.nameKey).toBe('example bank');

    const detail = await api.get(`/api/institutions/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ id, accountCount: 0, cardCount: 0, channelCount: 0, accounts: [], cards: [], channels: [] });

    const list = await api.get('/api/institutions');
    expect(list.status).toBe(200);
    expect(list.json).toHaveLength(1);
    expect(list.json[0]).toMatchObject({ id, accountCount: 0, cardCount: 0, channelCount: 0 });

    t.advance(1000);
    const patched = await api.patch(`/api/institutions/${id}`, { name: 'Example Bank HK', website: null, notes: null, color: '#00AA00' });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({ name: 'Example Bank HK', website: null, notes: null, color: '#00aa00', country: 'HK' });
    expect(patched.json.updatedAt).toBeGreaterThan(patched.json.createdAt);
    const [renamed] = await t.db.select().from(institutions).where(eq(institutions.id, id));
    expect(renamed!.nameKey).toBe('example bank hk');

    const removed = await api.del(`/api/institutions/${id}`);
    expect(removed.status).toBe(200);
    expect(removed.json).toEqual({ ok: true });
    expect((await api.get(`/api/institutions/${id}`)).status).toBe(404);
    expect(await institutionRows()).toHaveLength(0);
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.action, 'institution.delete'));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detail).toEqual({ id });
  });

  it('only needs a name and a type; country, website, colour and notes are optional', async () => {
    const { api } = await signIn();
    const r = await api.post('/api/institutions', { name: 'Minimal', institutionType: 'other' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ country: null, website: null, color: null, notes: null, status: 'active', sort: 0 });
    // The DTO has no amount or balance of any kind.
    expect(Object.keys(r.json).sort()).toEqual(['color', 'country', 'createdAt', 'id', 'institutionType', 'name', 'notes', 'sort', 'status', 'updatedAt', 'website']);
  });

  it('answers 404 for unknown ids on every route', async () => {
    const { api } = await signIn();
    const missing = 'x'.repeat(26);
    expect((await api.get(`/api/institutions/${missing}`)).json.code).toBe('NOT_FOUND');
    expect((await api.patch(`/api/institutions/${missing}`, { name: 'X' })).status).toBe(404);
    expect((await api.del(`/api/institutions/${missing}`)).status).toBe(404);
  });

  it('I-1: one institution, several accounts, cards and channels — counts and summaries', async () => {
    const { api, user } = await signIn();
    const inst = await create(api, WISE);
    for (const name of ['Wise EUR', 'Wise USD', 'Wise GBP']) await seedAccount(user.id, inst.id, name);
    await seedCard(user.id, inst.id);
    await seedChannel(user.id, inst.id);
    await t.client.execute({ sql: `UPDATE accounts SET status = 'closed' WHERE name = 'Wise GBP'`, args: [] });

    const detail = await api.get(`/api/institutions/${inst.id}`);
    expect(detail.json).toMatchObject({ accountCount: 3, cardCount: 1, channelCount: 1 });
    expect(detail.json.accounts.map((a: { name: string }) => a.name).sort()).toEqual(['Wise EUR', 'Wise GBP', 'Wise USD']);
    expect(detail.json.accounts[0]).toEqual({ id: expect.any(String), name: expect.any(String), accountCountry: 'BE', status: expect.any(String) });
    expect(detail.json.cards).toEqual([{ id: expect.any(String), name: 'Debit', network: 'visa', last4: '4321', cardType: 'debit', status: 'active' }]);
    expect(detail.json.channels).toEqual([{ id: expect.any(String), name: expect.any(String), channelType: 'payment_service', status: 'active' }]);
    const [item] = (await api.get('/api/institutions')).json;
    expect(item).toMatchObject({ accountCount: 3, cardCount: 1, channelCount: 1 });
  });
});

describe('validation (strict zod)', () => {
  it('rejects unknown fields, bad enums, bad countries, bad URLs, colours and lengths', async () => {
    const { api } = await signIn();
    const cases: Record<string, unknown>[] = [
      {},
      { institutionType: 'bank' },
      { name: '', institutionType: 'bank' },
      { name: '   ', institutionType: 'bank' },
      { name: 'x'.repeat(81), institutionType: 'bank' },
      { name: 'Broker', institutionType: 'broker' },
      { name: 'Crypto', institutionType: 'crypto' },
      { name: 'A', institutionType: 'bank', country: 'hk' },
      { name: 'A', institutionType: 'bank', country: 'UK' },
      { name: 'A', institutionType: 'bank', country: 'CHN' },
      { name: 'A', institutionType: 'bank', website: 'http://insecure.example.com' },
      { name: 'A', institutionType: 'bank', website: 'javascript:alert(1)' },
      { name: 'A', institutionType: 'bank', website: `https://example.com/${'a'.repeat(200)}` },
      { name: 'A', institutionType: 'bank', color: 'red' },
      { name: 'A', institutionType: 'bank', color: '#12345' },
      { name: 'A', institutionType: 'bank', notes: 'x'.repeat(1001) },
      { name: 'A', institutionType: 'bank', status: 'deleted' },
      { name: 'A', institutionType: 'bank', sort: 1.5 },
      { name: 'A', institutionType: 'bank', logo: 'data:image/png;base64,AAAA' },
      { name: 'A', institutionType: 'bank', userId: 'someone-else' },
      { name: 'A', institutionType: 'bank', id: 'chosen-id' },
      { name: 'A', institutionType: 'bank', nameKey: 'a' },
      { name: 'A', institutionType: 'bank', balance: 100 },
    ];
    for (const b of cases) {
      const r = await api.post('/api/institutions', b);
      expect.soft(r.status, JSON.stringify(b)).toBe(400);
      expect.soft(r.json.code, JSON.stringify(b)).toBe('VALIDATION');
    }
    const badJson = await api.req('POST', '/api/institutions', undefined, { 'content-type': 'application/json' });
    expect(badJson.status).toBe(400);
    expect(await institutionRows()).toHaveLength(0);
  });

  it('PATCH is strict too and refuses an empty body', async () => {
    const { api } = await signIn();
    const inst = await create(api, WISE);
    for (const b of [{}, { userId: 'x' }, { id: 'x' }, { nameKey: 'x' }, { country: 'gb' }, { institutionType: 'credit' }, { name: '' }, { createdAt: 1 }]) {
      const r = await api.patch(`/api/institutions/${inst.id}`, b);
      expect.soft(r.status, JSON.stringify(b)).toBe(400);
      expect.soft(r.json.code).toBe('VALIDATION');
    }
    const [row] = await institutionRows();
    expect(row).toMatchObject({ name: 'Wise', name_key: 'wise', country: 'GB', institution_type: 'emi' });
  });

  it('validates list query parameters', async () => {
    const { api } = await signIn();
    for (const qs of ['type=broker', 'country=gb', 'country=GBR', 'status=deleted', 'unknown=1', `q=${'x'.repeat(81)}`]) {
      const r = await api.get(`/api/institutions?${qs}`);
      expect.soft(r.status, qs).toBe(400);
      expect.soft(r.json.code, qs).toBe('VALIDATION');
    }
  });
});

describe('name normalization and duplicates', () => {
  it('normalizes with NFKC → trim → collapse whitespace → lower case', async () => {
    const { api } = await signIn();
    const inst = await create(api, { name: 'ＨＳＢＣ　 Hong   Kong ', institutionType: 'bank', country: 'HK' });
    const [row] = await t.db.select().from(institutions).where(eq(institutions.id, inst.id));
    expect(row!.name).toBe('ＨＳＢＣ　 Hong   Kong'); // stored as entered (trimmed)
    expect(row!.nameKey).toBe('hsbc hong kong');
  });

  it('I-2: same normalized name + same country is a 409 DUPLICATE with existingId; another country is allowed', async () => {
    const { api } = await signIn();
    const wise = await create(api, WISE);
    for (const name of ['Wise', ' wise ', 'WISE', 'ＷＩＳＥ', 'Ｗｉｓｅ', 'wise\t', ' Wise ']) {
      const r = await api.post('/api/institutions', { name, country: 'GB', institutionType: 'emi' });
      expect.soft(r.status, name).toBe(409);
      expect.soft(r.json.code, name).toBe('DUPLICATE');
      expect.soft(r.json.details, name).toEqual({ existingId: wise.id });
    }
    // The type does not matter for the duplicate check.
    expect((await api.post('/api/institutions', { name: 'wise', country: 'GB', institutionType: 'bank' })).status).toBe(409);
    // Same name, other countries (other legal entities) and no country: all allowed.
    const be = await create(api, { name: 'Wise', country: 'BE', institutionType: 'emi' });
    const us = await create(api, { name: 'WISE', country: 'US', institutionType: 'emi' });
    const none = await create(api, { name: 'wise', institutionType: 'emi' });
    expect(new Set([wise.id, be.id, us.id, none.id]).size).toBe(4);
    expect(await institutionRows()).toHaveLength(4);
    // A different name with the same country is fine too.
    await create(api, { name: 'Wise Business', country: 'GB', institutionType: 'emi' });
  });

  it('I-3: two institutions with the same name and no country are duplicates', async () => {
    const { api } = await signIn();
    const first = await create(api, { name: 'Local Credit Union', institutionType: 'bank' });
    const second = await api.post('/api/institutions', { name: 'local credit union', institutionType: 'bank', country: null });
    expect(second.status).toBe(409);
    expect(second.json.details.existingId).toBe(first.id);
  });

  it('archived institutions still count as duplicates', async () => {
    const { api } = await signIn();
    const wise = await create(api, WISE);
    await api.patch(`/api/institutions/${wise.id}`, { status: 'archived' });
    const r = await api.post('/api/institutions', WISE);
    expect(r.status).toBe(409);
    expect(r.json.details.existingId).toBe(wise.id);
  });

  it('renaming or changing the country is checked like a create', async () => {
    const { api } = await signIn();
    const gb = await create(api, WISE);
    const be = await create(api, { ...WISE, country: 'BE' });
    const other = await create(api, { name: 'Other EMI', country: 'GB', institutionType: 'emi' });

    const moved = await api.patch(`/api/institutions/${be.id}`, { country: 'GB' });
    expect(moved.status).toBe(409);
    expect(moved.json.details.existingId).toBe(gb.id);
    const renamed = await api.patch(`/api/institutions/${other.id}`, { name: ' ＷＩＳＥ ' });
    expect(renamed.status).toBe(409);
    expect(renamed.json.details.existingId).toBe(gb.id);
    const both = await api.patch(`/api/institutions/${other.id}`, { name: 'wise', country: 'BE' });
    expect(both.json.details.existingId).toBe(be.id);

    // Re-saving its own name (any spelling) is not a duplicate of itself.
    expect((await api.patch(`/api/institutions/${gb.id}`, { name: 'WISE', country: 'GB' })).status).toBe(200);
    // Clearing the country is allowed while no country-less "wise" exists…
    expect((await api.patch(`/api/institutions/${be.id}`, { country: null })).json.country).toBeNull();
    // …and then a second one is refused.
    expect((await api.patch(`/api/institutions/${gb.id}`, { country: null })).json.details.existingId).toBe(be.id);
    const rows = await institutionRows();
    expect(rows.map((r) => [r.name, r.country]).sort()).toEqual([
      ['Other EMI', 'GB'],
      ['WISE', 'GB'],
      ['Wise', null],
    ]);
  });

  it('the unique index backs the API check (raw SQL duplicate fails)', async () => {
    const { api, user } = await signIn();
    await create(api, { name: 'No Country', institutionType: 'bank' });
    const err = await sqlError(
      t.client.execute({
        sql: `INSERT INTO institutions (id, user_id, name, name_key, institution_type, created_at, updated_at) VALUES ('dup', ?, 'NO COUNTRY', 'no country', 'bank', 1, 1)`,
        args: [user.id],
      }),
    );
    expect(err).toMatch(/UNIQUE/);
  });
});

describe('delete and archive (I-4, I-5)', () => {
  it.each(['account', 'card', 'channel'] as const)('a %s reference blocks DELETE with 409 IN_USE; archiving works', async (kind) => {
    const { api, user } = await signIn();
    const inst = await create(api, WISE);
    const seed = { account: seedAccount, card: seedCard, channel: seedChannel }[kind];
    await seed(user.id, inst.id);

    const r = await api.del(`/api/institutions/${inst.id}`);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('IN_USE');
    expect(r.json.details.references).toEqual({ accounts: kind === 'account' ? 1 : 0, cards: kind === 'card' ? 1 : 0, channels: kind === 'channel' ? 1 : 0 });
    expect(await institutionRows()).toHaveLength(1);
    expect(await t.db.select().from(auditLog).where(eq(auditLog.action, 'institution.delete'))).toHaveLength(0);

    const archived = await api.patch(`/api/institutions/${inst.id}`, { status: 'archived' });
    expect(archived.status).toBe(200);
    expect(archived.json.status).toBe('archived');
    // Still referenced, still not deletable.
    expect((await api.del(`/api/institutions/${inst.id}`)).status).toBe(409);
    // Restoring works as well.
    expect((await api.patch(`/api/institutions/${inst.id}`, { status: 'active' })).json.status).toBe('active');
  });

  it('closed accounts still count as references', async () => {
    const { api, user } = await signIn();
    const inst = await create(api, WISE);
    const acc = await seedAccount(user.id, inst.id);
    await t.client.execute({ sql: `UPDATE accounts SET status = 'closed' WHERE id = ?`, args: [acc] });
    expect((await api.del(`/api/institutions/${inst.id}`)).json.code).toBe('IN_USE');
  });

  it('can be deleted once the references are gone', async () => {
    const { api, user } = await signIn();
    const inst = await create(api, WISE);
    const acc = await seedAccount(user.id, inst.id);
    expect((await api.del(`/api/institutions/${inst.id}`)).status).toBe(409);
    await t.client.execute({ sql: `DELETE FROM accounts WHERE id = ?`, args: [acc] });
    expect((await api.del(`/api/institutions/${inst.id}`)).status).toBe(200);
  });

  it('I-5: raw SQL delete of a referenced institution is refused by the NO ACTION foreign key', async () => {
    const { api, user } = await signIn();
    const inst = await create(api, WISE);
    await seedCard(user.id, inst.id);
    expect(await sqlError(t.client.execute({ sql: 'DELETE FROM institutions WHERE id = ?', args: [inst.id] }))).toMatch(/FOREIGN KEY/);
    expect(await institutionRows()).toHaveLength(1);
  });

  it('archived institutions are hidden by default and listed with status=archived / all', async () => {
    const { api } = await signIn();
    const a = await create(api, { name: 'Active Bank', institutionType: 'bank' });
    const b = await create(api, { name: 'Old Bank', institutionType: 'bank' });
    await api.patch(`/api/institutions/${b.id}`, { status: 'archived' });
    const ids = async (qs = '') => ((await api.get(`/api/institutions${qs}`)).json as { id: string }[]).map((i) => i.id);
    expect(await ids()).toEqual([a.id]);
    expect(await ids('?status=active')).toEqual([a.id]);
    expect(await ids('?status=archived')).toEqual([b.id]);
    expect((await ids('?status=all')).sort()).toEqual([a.id, b.id].sort());
    // An archived institution is still readable.
    expect((await api.get(`/api/institutions/${b.id}`)).json.status).toBe('archived');
  });
});

describe('list: search, filters and order', () => {
  it('filters by q (normalized substring), type, country and status, sorted by sort then name', async () => {
    const { api } = await signIn();
    const hsbcHk = await create(api, { name: 'HSBC Hong Kong', country: 'HK', institutionType: 'bank' });
    const hsbcUk = await create(api, { name: 'HSBC UK', country: 'GB', institutionType: 'bank', sort: -1 });
    const wise = await create(api, WISE);
    const pay = await create(api, { name: 'Pay_100%', country: 'HK', institutionType: 'emi' });
    const misc = await create(api, { name: 'Misc', institutionType: 'other' });
    const names = async (qs: string) => ((await api.get(`/api/institutions${qs}`)).json as { name: string }[]).map((i) => i.name);

    // sort first (HSBC UK has sort -1), then name.
    expect(await names('')).toEqual(['HSBC UK', 'HSBC Hong Kong', 'Misc', 'Pay_100%', 'Wise']);
    expect(await names('?q=hsbc')).toEqual(['HSBC UK', 'HSBC Hong Kong']);
    expect(await names(`?q=${encodeURIComponent('  ＨＳＢＣ   hong ')}`)).toEqual(['HSBC Hong Kong']);
    // LIKE wildcards are literal.
    expect(await names(`?q=${encodeURIComponent('_')}`)).toEqual(['Pay_100%']);
    expect(await names(`?q=${encodeURIComponent('%')}`)).toEqual(['Pay_100%']);
    expect(await names('?q=nothing')).toEqual([]);
    expect(await names('?q=')).toHaveLength(5);
    expect(await names('?type=bank')).toEqual(['HSBC UK', 'HSBC Hong Kong']);
    expect(await names('?type=emi&country=HK')).toEqual(['Pay_100%']);
    expect(await names('?country=GB')).toEqual(['HSBC UK', 'Wise']);
    expect(await names('?type=other')).toEqual(['Misc']);
    await api.patch(`/api/institutions/${hsbcHk.id}`, { status: 'archived' });
    expect(await names('?q=hsbc')).toEqual(['HSBC UK']);
    expect(await names('?q=hsbc&status=all')).toEqual(['HSBC UK', 'HSBC Hong Kong']);
    expect([hsbcUk, wise, pay, misc]).toHaveLength(4);
  });
});

describe('sensitive data (X-1 – X-4)', () => {
  const PANS = ['4111 1111 1111 1111', '4111-1111-1111-1111', '4111111111111111', '４１１１１１１１１１１１１１１１', 'card 5500 0000 0000 0004 lost'];
  const CODES = ['cvv 123', 'CVC:1234', 'PIN=0000', '安全码 123', '密码123456', 'cvv2: 999'];

  it('rejects card numbers and CVV / PIN codes in name, notes and website on create — nothing is written', async () => {
    const { api } = await signIn();
    for (const text of [...PANS, ...CODES]) {
      for (const field of ['notes', 'name'] as const) {
        const value = field === 'name' ? text.slice(0, 80) : `note: ${text}`;
        const r = await api.post('/api/institutions', { name: 'Bank', institutionType: 'bank', [field]: value });
        expect.soft(r.status, `${field}: ${text}`).toBe(400);
        expect.soft(r.json.code, `${field}: ${text}`).toBe('SENSITIVE_DATA');
        expect.soft(r.json.details.fields, `${field}: ${text}`).toEqual([{ field, kind: expect.any(String) }]);
        // The matched text is not echoed back.
        expect.soft(JSON.stringify(r.json)).not.toContain(text);
      }
    }
    const web = await api.post('/api/institutions', { name: 'Bank', institutionType: 'bank', website: 'https://bank.example.com/card/4111111111111111' });
    expect(web.json.code).toBe('SENSITIVE_DATA');
    expect(await institutionRows()).toHaveLength(0);
  });

  it('rejects them on PATCH too, leaving the row unchanged', async () => {
    const { api } = await signIn();
    const inst = await create(api, { ...WISE, notes: 'fine' });
    for (const b of [{ notes: '4111 1111 1111 1111' }, { name: 'Wise 4111111111111111' }, { notes: 'PIN 1234' }, { name: 'Wise', notes: 'cvv 123' }]) {
      const r = await api.patch(`/api/institutions/${inst.id}`, b);
      expect.soft(r.status, JSON.stringify(b)).toBe(400);
      expect.soft(r.json.code).toBe('SENSITIVE_DATA');
    }
    const [row] = await institutionRows();
    expect(row).toMatchObject({ name: 'Wise', notes: 'fine' });
  });

  it('X-2: long numbers that fail Luhn, short numbers and ordinary text are allowed', async () => {
    const { api } = await signIn();
    for (const notes of ['4111 1111 1111 1112', 'SWIFT HSBCHKHH, branch 004', 'Customer number 12345678', 'pin the card to the board', 'spin 1234 times', '2024-03-05 opened']) {
      const r = await api.post('/api/institutions', { name: `Bank ${++seq}`, institutionType: 'bank', notes });
      expect.soft(r.status, notes).toBe(201);
    }
  });

  it('X-4: there is no bypass flag', async () => {
    const { api } = await signIn();
    for (const flag of [{ force: true }, { allowSensitive: true }, { skipScan: true }, { confirm: true }]) {
      const r = await api.post('/api/institutions', { name: 'Bank', institutionType: 'bank', notes: '4111111111111111', ...flag });
      expect.soft(r.status).toBe(400);
      expect.soft(r.json.code).toBe('VALIDATION');
    }
    expect(await institutionRows()).toHaveLength(0);
  });
});

describe('isolation between users (U-1 – U-3)', () => {
  it("another user's institutions are 404 on every route, absent from lists and not changed", async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bob');
    const inst = await create(alice.api, { ...WISE, notes: 'alice only' });
    await seedAccount(alice.user.id, inst.id);
    const before = await institutionRows();

    expect((await bob.api.get(`/api/institutions/${inst.id}`)).status).toBe(404);
    expect((await bob.api.patch(`/api/institutions/${inst.id}`, { name: 'Taken over' })).status).toBe(404);
    expect((await bob.api.patch(`/api/institutions/${inst.id}`, { status: 'archived' })).status).toBe(404);
    expect((await bob.api.del(`/api/institutions/${inst.id}`)).status).toBe(404);
    expect((await bob.api.get('/api/institutions?status=all')).json).toEqual([]);
    expect((await bob.api.get('/api/institutions?q=wise&status=all')).json).toEqual([]);
    expect(await institutionRows()).toEqual(before);
  });

  it("names are only duplicates within one user's institutions", async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bob');
    const a = await create(alice.api, WISE);
    const b = await create(bob.api, WISE);
    expect(a.id).not.toBe(b.id);
    // Bob's duplicate points at Bob's own row, never Alice's.
    expect((await bob.api.post('/api/institutions', WISE)).json.details.existingId).toBe(b.id);
    // Bob renaming into Alice's name/country is fine.
    const other = await create(bob.api, { name: 'Other', institutionType: 'bank', country: 'BE' });
    expect((await bob.api.patch(`/api/institutions/${other.id}`, { name: 'Wise' })).status).toBe(200);
  });

  it("counts only include the user's own references", async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bob');
    const a = await create(alice.api, WISE);
    const b = await create(bob.api, WISE);
    await seedAccount(alice.user.id, a.id);
    await seedAccount(bob.user.id, b.id);
    await seedAccount(bob.user.id, b.id);
    expect((await alice.api.get(`/api/institutions/${a.id}`)).json.accountCount).toBe(1);
    expect((await bob.api.get('/api/institutions')).json[0].accountCount).toBe(2);
    // A raw-SQL cross-user reference is refused by the composite foreign key.
    expect(await sqlError(seedAccount(bob.user.id, a.id))).toMatch(/FOREIGN KEY/);
  });
});

describe('authentication, CSRF and Origin (R-1)', () => {
  it('every institution route needs a session', async () => {
    const { api } = await signIn();
    const inst = await create(api, WISE);
    const anon = client(t);
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/institutions'],
      ['POST', '/api/institutions', WISE],
      ['GET', `/api/institutions/${inst.id}`],
      ['PATCH', `/api/institutions/${inst.id}`, { name: 'X' }],
      ['DELETE', `/api/institutions/${inst.id}`],
    ];
    for (const [method, path, b] of calls) {
      const r = await anon.req(method, path, b);
      expect.soft(r.status, `${method} ${path}`).toBe(401);
      expect.soft(r.json.code).toBe('UNAUTHENTICATED');
    }
    // A forged cookie is not a session either.
    expect((await anon.req('GET', '/api/institutions', undefined, { cookie: 'xui_session=forged' })).status).toBe(401);
    expect(await institutionRows()).toHaveLength(1);
  });

  it('writes need the x-xui-csrf header and an allowed Origin, even when signed in', async () => {
    const { api } = await signIn();
    const inst = await create(api, WISE);
    const writes: [string, string, unknown?][] = [
      ['POST', '/api/institutions', { name: 'Evil', institutionType: 'bank' }],
      ['PATCH', `/api/institutions/${inst.id}`, { name: 'Evil' }],
      ['DELETE', `/api/institutions/${inst.id}`],
    ];
    for (const [method, path, b] of writes) {
      const evil = await api.req(method, path, b, { origin: 'https://evil.example' });
      expect.soft(evil.status, `${method} origin`).toBe(403);
      expect.soft(evil.json.code).toBe('BAD_ORIGIN');
      const legacyOrigin = await api.req(method, path, b, { origin: 'http://localhost:5173' });
      expect.soft(legacyOrigin.json.code).toBe('BAD_ORIGIN');
      const noCsrf = await api.req(method, path, b, { [CSRF_HEADER]: '' });
      expect.soft(noCsrf.status, `${method} csrf`).toBe(403);
      expect.soft(noCsrf.json.code).toBe('CSRF');
      const legacyCsrf = await api.req(method, path, b, { [CSRF_HEADER]: '', 'x-zui-csrf': '1' });
      expect.soft(legacyCsrf.json.code).toBe('CSRF');
    }
    // Reads need neither.
    expect((await api.req('GET', '/api/institutions', undefined, { origin: 'https://evil.example', [CSRF_HEADER]: '' })).status).toBe(200);
    const [row] = await institutionRows();
    expect(row).toMatchObject({ name: 'Wise' });
    expect(ORIGIN).toBe('http://localhost:5174');
  });

  it('responses are not cached', async () => {
    const { api } = await signIn();
    expect((await api.get('/api/institutions')).res.headers.get('cache-control')).toBe('no-store');
  });
});
