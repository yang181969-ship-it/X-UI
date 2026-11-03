// M2-B3: cards API (API_SPEC §3.4; TEST_PLAN C-1 – C-7, X-1 – X-5, U-1 – U-3, R-1 for cards, plus
// the expiry rules of expiry.ts). Every case runs twice with the same assertions: on libsql (a
// temporary file database opened by openV1Db) and on wrangler's local in-memory D1 (d1-app.ts —
// never a remote D1). Card links and payment channels have no API yet, so they are seeded with raw SQL.
// All names and numbers are fictional; the "card numbers" are well-known test PANs.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '../src/auth/middleware.ts';
import { startD1App, type D1App } from './d1-app.ts';
import { client, login, makeUser, setup, type TestEnv } from './helpers.ts';

type Rows = Record<string, unknown>[];
interface Engine {
  t: TestEnv;
  all: (sql: string, ...args: unknown[]) => Promise<Rows>;
  exec: (sql: string, ...args: unknown[]) => Promise<unknown>;
  ping: () => Promise<void>;
  dispose: () => Promise<void>;
}

async function libsqlEngine(): Promise<Engine> {
  const t = await setup();
  return {
    t,
    all: async (sql, ...args) => {
      const r = await t.client.execute({ sql, args: args as never });
      return r.rows.map((row) => Object.fromEntries(r.columns.map((col, i) => [col, row[i]])));
    },
    exec: (sql, ...args) => t.client.execute({ sql, args: args as never }),
    ping: async () => {},
    dispose: () => t.cleanup(),
  };
}

async function d1Engine(): Promise<Engine> {
  const h: D1App = await startD1App('xui-v1-cards-d1');
  return { t: h.t, all: h.all, exec: (sql, ...args) => h.d1.prepare(sql).bind(...args).run(), ping: h.ping, dispose: h.dispose };
}

const ENGINES = { libsql: libsqlEngine, d1: d1Engine };

const PANS = ['4111 1111 1111 1111', '4111-1111-1111-1111', '4111111111111111', '４１１１１１１１１１１１１１１１', '5555 5555 5555 4444', '378282246310005'];
const CODES = ['cvv 123', 'CVC:1234', 'PIN=0000', '安全码 123', 'cvv2 456'];
const FORBIDDEN_FIELDS = ['pan', 'cardNumber', 'number', 'bin', 'iin', 'cvv', 'cvc', 'cvv2', 'pin', 'holderName', 'track1', 'track2', 'trackData', 'cryptogram'];
/** The digits of every test PAN, to prove none of them was stored, answered or logged. */
const PAN_DIGITS = ['4111111111111111', '5555555555554444', '378282246310005'];

describe.each(['libsql', 'd1'] as const)('cards API on %s', (engine) => {
  let e: Engine;
  beforeAll(async () => {
    e = await ENGINES[engine]();
  }, 180_000);
  afterAll(async () => {
    await e?.dispose();
  });
  beforeEach(() => e.ping());

  // One database per engine, so every case signs in as users of its own.
  let seq = 0;
  async function signIn(prefix = 'user') {
    const u = await makeUser(e.t, `${engine}-${prefix}-${++seq}`);
    return { user: u.user, api: await login(e.t, u), again: () => login(e.t, u) };
  }
  type Api = Awaited<ReturnType<typeof login>>;

  /** Move the test clock forward to an instant (never back: TOTP steps and sessions must stay monotonic). */
  const setClock = (ms: number) => {
    expect(ms).toBeGreaterThanOrEqual(e.t.clock.t);
    e.t.clock.t = ms;
  };

  async function institution(api: Api, body: Record<string, unknown> = {}) {
    const r = await api.post('/api/institutions', { name: `Bank ${++seq}`, country: 'GB', institutionType: 'bank', ...body });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.id as string;
  }
  const cardBody = (issuerInstitutionId: string, extra: Record<string, unknown> = {}) => ({
    issuerInstitutionId,
    name: 'Contoso Debit',
    network: 'visa',
    cardType: 'debit',
    last4: '4321',
    issuingCountry: 'BE',
    ...extra,
  });
  async function createCard(api: Api, issuer: string, extra: Record<string, unknown> = {}) {
    const r = await api.post('/api/cards', cardBody(issuer, extra));
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.card as Record<string, any> & { id: string };
  }
  async function createAccount(api: Api, institutionId: string, extra: Record<string, unknown> = {}) {
    const r = await api.post('/api/accounts', { institutionId, name: `Account ${++seq}`, accountType: 'bank', accountCountry: 'SG', currencies: [{ code: 'SGD', isDefault: true }, { code: 'USD' }], ...extra });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.id as string;
  }

  const T = 1_700_000_000_000;
  async function seedLink(userId: string, cardId: string, accountId: string, opts: { currency?: string | null; role?: string; isDefault?: 0 | 1; status?: string; endedOn?: string } = {}) {
    const id = `link-${engine}-${++seq}`;
    await e.exec(
      'INSERT INTO account_card_links (id, user_id, card_id, account_id, currency, role, is_default, status, ended_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      userId,
      cardId,
      accountId,
      opts.currency ?? null,
      opts.role ?? 'spending_source',
      opts.isDefault ?? 0,
      opts.status ?? 'active',
      opts.endedOn ?? null,
      T + seq,
      T + seq,
    );
    return id;
  }
  async function seedChannelSource(userId: string, cardId: string, status = 'active') {
    const channel = `ch-${engine}-${++seq}`;
    await e.exec("INSERT INTO payment_channels (id, user_id, name, name_key, channel_type, created_at, updated_at) VALUES (?, ?, ?, ?, 'device_wallet', ?, ?)", channel, userId, `Wallet ${seq}`, `wallet ${seq}`, T, T);
    const source = `src-${engine}-${++seq}`;
    await e.exec('INSERT INTO payment_channel_sources (id, user_id, channel_id, card_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', source, userId, channel, cardId, status, T, T);
    return { channel, source };
  }

  /** The database error of a raw statement that must fail, as text (a retained libsql error keeps the file open on Windows). */
  const sqlError = (sql: string, ...args: unknown[]) =>
    e.exec(sql, ...args).then(
      () => 'no error',
      (err: unknown) => {
        const out: string[] = [];
        for (let cur: any = err, i = 0; cur && i < 6; cur = cur.cause, i++) out.push(String(cur.message ?? cur));
        return out.join(' | ');
      },
    );
  /** A raw INSERT of an otherwise valid card with one column set to `value`, bypassing the API. */
  const rawCard = (userId: string, issuer: string, col: string, value: unknown) => {
    const row: Record<string, unknown> = {
      id: `raw-${engine}-${++seq}`,
      user_id: userId,
      issuer_institution_id: issuer,
      name: 'Raw',
      network: 'visa',
      card_type: 'debit',
      last4: '1234',
      issuing_country: 'BE',
      created_at: 1,
      updated_at: 1,
      [col]: value,
    };
    const cols = Object.keys(row);
    return sqlError(`INSERT INTO cards (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...Object.values(row));
  };

  const cardRows = (userId: string) => e.all('SELECT * FROM cards WHERE user_id = ? ORDER BY rowid', userId);
  const auditRows = async (userId: string) =>
    (await e.all("SELECT action, detail FROM audit_log WHERE user_id = ? AND action LIKE 'card.%' ORDER BY rowid", userId)).map((a) => ({ action: a.action, detail: JSON.parse(String(a.detail)) }));

  /** Every row of every table, to prove a request wrote nothing — or only what it should. */
  async function snapshot() {
    const tables = (await e.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name")).map((r) => String(r.name));
    const out: Record<string, Rows> = {};
    for (const table of tables) out[table] = await e.all(`SELECT * FROM "${table}" ORDER BY rowid`);
    return out;
  }
  /** Every stored value of the database as one string (to look for leaked card numbers). */
  const dump = async () => JSON.stringify(await snapshot());

  // ================================================================== create and read

  it('C-1: creates debit and prepaid cards, physical and virtual; the DTO holds metadata only', async () => {
    const { api } = await signIn();
    const inst = await institution(api, { name: 'Contoso Bank', color: '#123abc' });
    const r = await api.post('/api/cards', cardBody(inst, { form: 'physical', expiresOn: '2028-07', status: 'active', notes: '日常消费', sort: 2 }));
    expect(r.status).toBe(201);
    expect(Object.keys(r.json)).toEqual(['card']);
    const card = r.json.card;
    expect(card).toEqual({
      id: expect.any(String),
      issuerInstitutionId: inst,
      issuer: { id: inst, name: 'Contoso Bank', institutionType: 'bank', color: '#123abc', status: 'active' },
      name: 'Contoso Debit',
      network: 'visa',
      cardType: 'debit',
      form: 'physical',
      last4: '4321',
      issuingCountry: 'BE',
      expiresOn: '2028-07',
      status: 'active',
      notes: '日常消费',
      sort: 2,
      createdAt: e.t.clock.t,
      updatedAt: e.t.clock.t,
    });
    const virtual = await createCard(api, inst, { name: 'Contoso Prepaid', cardType: 'prepaid', form: 'virtual', network: 'mastercard', last4: '0042' });
    expect(virtual).toMatchObject({ cardType: 'prepaid', form: 'virtual', last4: '0042', expiresOn: null, notes: null, status: 'active', sort: 0 });
    // Only the required fields: form defaults to physical.
    expect((await createCard(api, inst, { network: 'unionpay' })).form).toBe('physical');

    const detail = await api.get(`/api/cards/${card.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json).toEqual({ ...card, links: [], channels: [], channelSourceCounts: { active: 0, ended: 0 } });
    const list = await api.get('/api/cards');
    expect(list.json.map((c: { id: string }) => c.id)).toContain(virtual.id);
    expect(list.json.find((c: { id: string }) => c.id === card.id)).toEqual({ ...card, linkedAccounts: [] });
    // The issuer counts its cards.
    expect((await api.get(`/api/institutions/${inst}`)).json.cardCount).toBe(3);
  });

  it('C-2: only debit and prepaid — credit (or anything else) is 400 CARD_TYPE_UNSUPPORTED, on create and PATCH; the database refuses it too', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    for (const cardType of ['credit', 'charge', 'Debit', '']) {
      const r = await api.post('/api/cards', cardBody(inst, { cardType }));
      expect.soft(r.status, cardType).toBe(400);
      expect.soft(r.json.code, cardType).toBe('CARD_TYPE_UNSUPPORTED');
    }
    const { cardType: _omit, ...noType } = cardBody(inst);
    expect((await api.post('/api/cards', noType)).json.code).toBe('VALIDATION');
    expect(await cardRows(user.id)).toEqual([]);
    const card = await createCard(api, inst);
    const patch = await api.patch(`/api/cards/${card.id}`, { cardType: 'credit' });
    expect(patch.status).toBe(400);
    expect(patch.json.code).toBe('CARD_TYPE_UNSUPPORTED');
    expect((await api.get(`/api/cards/${card.id}`)).json.cardType).toBe('debit');
    expect(await rawCard(user.id, inst, 'card_type', 'credit')).toMatch(/CHECK constraint failed/);
  });

  it('C-3 / X-4: no card-number, BIN, CVV, PIN, track or holder field exists — and no bypass flag; nothing is written or echoed', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const before = await snapshot();
    for (const field of [...FORBIDDEN_FIELDS, 'force', 'allowSensitive', 'skipScan', 'userId', 'id', 'createdAt']) {
      const value = ['force', 'allowSensitive', 'skipScan'].includes(field) ? true : '4111111111111111';
      for (const [method, path, b] of [
        ['POST', '/api/cards', { ...cardBody(inst), [field]: value }],
        ['PATCH', `/api/cards/${card.id}`, { name: 'Renamed', [field]: value }],
      ] as const) {
        const r = await api.req(method, path, b);
        expect.soft(r.status, `${method} ${field}`).toBe(400);
        expect.soft(r.json.code, `${method} ${field}`).toBe('VALIDATION');
        expect.soft(JSON.stringify(r.json), `${method} ${field} echoes`).not.toContain('4111111111111111');
      }
    }
    expect(await snapshot()).toEqual(before);
    expect(await cardRows(user.id)).toHaveLength(1);
  });

  it('C-4: last4 is exactly four ASCII digits — a full number in last4 is refused without being echoed; the database agrees', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    expect((await createCard(api, inst, { last4: '0042' })).last4).toBe('0042');
    for (const last4 of ['42', '12345', 'abcd', '12a4', ' 1234', '1234 ', '１２３４', '4111111111111111', '4111 1111 1111 1111', '', null, 1234]) {
      const r = await api.post('/api/cards', cardBody(inst, { last4 }));
      expect.soft(r.status, String(last4)).toBe(400);
      expect.soft(r.json.code).toBe('VALIDATION');
      expect.soft(JSON.stringify(r.json)).not.toMatch(/4111\s?1111/);
    }
    const { last4: _omit, ...noLast4 } = cardBody(inst);
    expect((await api.post('/api/cards', noLast4)).status).toBe(400);
    expect(await cardRows(user.id)).toHaveLength(1);
    const card = (await cardRows(user.id))[0]!;
    expect((await api.patch(`/api/cards/${card.id}`, { last4: '4111111111111111' })).status).toBe(400);
    expect((await api.patch(`/api/cards/${card.id}`, { last4: '9876' })).json.last4).toBe('9876');
    for (const bad of ['42', '12345', 'abcd', '１２３４']) expect.soft(await rawCard(user.id, inst, 'last4', bad), bad).toMatch(/CHECK constraint failed/);
  });

  it('C-6: expiry is YYYY-MM with a real month (or null); the database CHECK agrees with the API', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    for (const expiresOn of ['2028-01', '2028-07', '2028-12', null]) expect.soft((await createCard(api, inst, { expiresOn })).expiresOn).toBe(expiresOn);
    for (const expiresOn of ['2028-00', '2028-13', '2028-1', '2028-7', '07/28', '2028-07-01', '28-07', '2028/07', '']) {
      const r = await api.post('/api/cards', cardBody(inst, { expiresOn }));
      expect.soft(r.status, expiresOn).toBe(400);
    }
    for (const bad of ['2028-00', '2028-13', '2028-1', '07/28']) expect.soft(await rawCard(user.id, inst, 'expires_on', bad), bad).toMatch(/CHECK constraint failed/);
    const card = (await cardRows(user.id))[0]!;
    expect((await api.patch(`/api/cards/${card.id}`, { expiresOn: '2029-13' })).status).toBe(400);
    expect((await api.patch(`/api/cards/${card.id}`, { expiresOn: null })).json.expiresOn).toBeNull();
  });

  it('enumerations: network, form and status accept only their own values (API and database)', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    for (const network of ['visa', 'mastercard', 'amex', 'unionpay', 'jcb', 'discover', 'diners', 'maestro', 'other']) expect.soft((await createCard(api, inst, { network })).network).toBe(network);
    const bad: [string, unknown][] = [
      ['network', 'VISA'],
      ['network', 'paypal'],
      ['form', 'metal'],
      ['status', 'expired'],
      ['status', 'suspended'],
      ['status', 'deleted'],
      ['issuingCountry', 'UK'],
      ['issuingCountry', 'be'],
      ['issuingCountry', 'BEL'],
    ];
    for (const [field, value] of bad) expect.soft((await api.post('/api/cards', cardBody(inst, { [field]: value }))).status, `${field}=${value}`).toBe(400);
    const card = (await cardRows(user.id))[0]!;
    expect((await api.patch(`/api/cards/${card.id}`, { status: 'expired' })).status).toBe(400);
    for (const [col, value] of [
      ['network', 'paypal'],
      ['form', 'metal'],
      ['status', 'expired'],
      ['issuing_country', 'bel'],
    ] as const) {
      expect.soft(await rawCard(user.id, inst, col, value), `${col}=${value}`).toMatch(/CHECK constraint failed/);
    }
  });

  it('regions stay apart: issuingCountry is required, never taken from the issuer, and does not follow it', async () => {
    const { api } = await signIn();
    const inst = await institution(api, { country: 'GB' });
    const { issuingCountry: _omit, ...noCountry } = cardBody(inst);
    const missing = await api.post('/api/cards', noCountry);
    expect(missing.status).toBe(400);
    expect(missing.json.details.some((i: { path: string[] }) => i.path[0] === 'issuingCountry')).toBe(true);
    const card = await createCard(api, inst, { issuingCountry: 'BE' });
    expect(card.issuingCountry).toBe('BE');
    await api.patch(`/api/institutions/${inst}`, { country: 'US' });
    const after = (await api.get(`/api/cards/${card.id}`)).json;
    expect(after.issuingCountry).toBe('BE');
    // The DTO has no field that would merge the regions (no "country" of its own besides issuingCountry).
    expect(Object.keys(after)).not.toContain('country');
    expect(Object.keys(after)).not.toContain('accountCountry');
  });

  // ================================================================== sensitive data

  it('X-1 / X-3: card numbers and security codes in name or notes are refused (create and PATCH) without being echoed; nothing is written', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const before = await snapshot();
    for (const text of [...PANS, ...CODES, `ref 12 ${PANS[0]}`]) {
      for (const field of ['name', 'notes']) {
        const create = await api.post('/api/cards', cardBody(inst, { [field]: text }));
        expect.soft(create.status, `${field}: ${text}`).toBe(400);
        expect.soft(create.json.code).toBe('SENSITIVE_DATA');
        expect.soft(create.json.details.fields).toEqual([{ field, kind: expect.stringMatching(/^(card_number|secret_code)$/) }]);
        const patch = await api.patch(`/api/cards/${card.id}`, { [field]: text });
        expect.soft(patch.json.code).toBe('SENSITIVE_DATA');
        for (const r of [create, patch]) {
          const answer = JSON.stringify(r.json).normalize('NFKC');
          for (const digits of PAN_DIGITS) expect.soft(answer.replace(/[\s-]/g, '')).not.toContain(digits);
          expect.soft(answer).not.toContain(text.normalize('NFKC'));
        }
      }
    }
    expect(await snapshot()).toEqual(before);
    const leaked = (await dump()).replace(/[\s-]/g, '');
    for (const digits of PAN_DIGITS) expect(leaked).not.toContain(digits);
    expect(await cardRows(user.id)).toHaveLength(1);
  });

  it('X-2: ordinary text and non-Luhn digit runs are allowed', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst, { name: 'Travel card 2028', notes: 'Order no. 4111 1111 1111 1112, hotline 400 123 4567, spin 1234' });
    expect(card.notes).toContain('4111 1111 1111 1112');
  });

  it('X-5: audit records hold the card id and last four digits only', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst, { name: 'Audit Canary Card', notes: 'audit-canary-notes', last4: '7777' });
    await api.patch(`/api/cards/${card.id}`, { notes: 'audit-canary-patch' });
    expect((await api.del(`/api/cards/${card.id}`)).status).toBe(200);
    expect(await auditRows(user.id)).toEqual([
      { action: 'card.create', detail: { id: card.id, last4: '7777' } },
      { action: 'card.delete', detail: { id: card.id, last4: '7777' } },
    ]);
    const all = JSON.stringify(await e.all('SELECT * FROM audit_log WHERE user_id = ?', user.id));
    for (const canary of ['Audit Canary Card', 'audit-canary-notes', 'audit-canary-patch', 'issuingCountry', 'visa']) expect(all).not.toContain(canary);
  });

  // ================================================================== PATCH and status

  it('PATCH updates the given fields only; empty, unknown and server-owned fields are refused', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst, { expiresOn: '2027-03', notes: 'old' });
    e.t.advance(1000);
    const r = await api.patch(`/api/cards/${card.id}`, { name: 'Renamed', network: 'jcb', form: 'virtual', issuingCountry: 'JP', notes: null, sort: -5 });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toEqual({ ...card, name: 'Renamed', network: 'jcb', form: 'virtual', issuingCountry: 'JP', notes: null, sort: -5, updatedAt: e.t.clock.t });
    expect((await api.patch(`/api/cards/${card.id}`, {})).status).toBe(400);
    for (const extra of [{ userId: 'u' }, { id: 'x' }, { createdAt: 1 }, { updatedAt: 1 }, { issuer: {} }, { linkedAccounts: [] }]) {
      expect.soft((await api.patch(`/api/cards/${card.id}`, extra)).status, JSON.stringify(extra)).toBe(400);
    }
    expect((await api.get(`/api/cards/${card.id}`)).json.name).toBe('Renamed');
  });

  it('freezing, closing and restoring never touch the links or their default flags; closed cards are hidden by default', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst, { expiresOn: '2020-01' });
    const acc = await createAccount(api, inst);
    const link = await seedLink(user.id, card.id, acc, { isDefault: 1 });
    const linkRow = async () => (await e.all('SELECT status, is_default, updated_at FROM account_card_links WHERE id = ?', link))[0];
    const original = await linkRow();
    for (const status of ['frozen', 'active', 'closed', 'active', 'closed'] as const) {
      const r = await api.patch(`/api/cards/${card.id}`, { status });
      expect.soft(r.json.status).toBe(status);
      expect.soft(await linkRow()).toEqual(original);
    }
    // closed: hidden from the default list, shown with status=closed / all; the detail still lists the link.
    expect((await api.get('/api/cards')).json.map((c: { id: string }) => c.id)).not.toContain(card.id);
    expect((await api.get('/api/cards?status=closed')).json.map((c: { id: string }) => c.id)).toEqual([card.id]);
    expect((await api.get('/api/cards?status=all')).json.map((c: { id: string }) => c.id)).toEqual([card.id]);
    expect((await api.get(`/api/cards/${card.id}`)).json.links).toHaveLength(1);
    // An expired card keeps the status the user gave it (expiry is derived, never written).
    await api.patch(`/api/cards/${card.id}`, { status: 'active' });
    expect((await cardRows(user.id))[0]!.status).toBe('active');
  });

  it("moving a card to another issuer needs an active institution of the caller's", async () => {
    const { api } = await signIn();
    const a = await institution(api);
    const b = await institution(api);
    const archived = await institution(api);
    const card = await createCard(api, a);
    expect((await api.patch(`/api/cards/${card.id}`, { issuerInstitutionId: b })).json).toMatchObject({ issuerInstitutionId: b, issuer: { id: b } });
    await api.patch(`/api/institutions/${archived}`, { status: 'archived' });
    const r = await api.patch(`/api/cards/${card.id}`, { issuerInstitutionId: archived });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: 'INSTITUTION_ARCHIVED', details: { institutionId: archived } });
    expect((await api.patch(`/api/cards/${card.id}`, { issuerInstitutionId: 'no-such-institution' })).status).toBe(404);
    expect((await api.get(`/api/cards/${card.id}`)).json.issuerInstitutionId).toBe(b);
    // Keeping an (archived) issuer while editing other fields is fine.
    await api.patch(`/api/institutions/${b}`, { status: 'archived' });
    expect((await api.patch(`/api/cards/${card.id}`, { issuerInstitutionId: b, name: 'Still here' })).status).toBe(200);
  });

  // ================================================================== institutions

  it('new cards need an active issuer: archived → 409 and nothing written; restored → created; existing cards stay editable', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    await api.patch(`/api/institutions/${inst}`, { status: 'archived' });
    const before = await snapshot();
    const r = await api.post('/api/cards', cardBody(inst));
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: expect.any(String), code: 'INSTITUTION_ARCHIVED', details: { institutionId: inst } });
    expect(await snapshot()).toEqual(before);
    // The existing card of the archived institution: readable, editable, listed (with the issuer marked archived).
    expect((await api.patch(`/api/cards/${card.id}`, { notes: 'still editable' })).status).toBe(200);
    expect((await api.get('/api/cards')).json[0].issuer.status).toBe('archived');
    await api.patch(`/api/institutions/${inst}`, { status: 'active' });
    expect((await api.post('/api/cards', cardBody(inst))).status).toBe(201);
    expect(await cardRows(user.id)).toHaveLength(2);
    // A referenced issuer can't be deleted (cards count as references).
    const del = await api.del(`/api/institutions/${inst}`);
    expect(del.status).toBe(409);
    expect(del.json.details.references.cards).toBe(2);
  });

  it('archived between the check and the batch: nothing is written and the answer is 409 (card alone and with a stored-value account)', async () => {
    const { api, user } = await signIn();
    for (const withAccount of [false, true]) {
      const inst = await institution(api);
      const before = await snapshot();
      const original = e.t.db.batch.bind(e.t.db);
      const spy = vi.spyOn(e.t.db, 'batch').mockImplementationOnce(async (batch) => {
        // The pre-check saw an active institution; it is archived right before the batch runs.
        await e.exec("UPDATE institutions SET status = 'archived' WHERE id = ?", inst);
        return original(batch as never);
      });
      const body = withAccount
        ? cardBody(inst, { cardType: 'prepaid', createStoredValueAccount: { name: 'Prepaid balance', accountCountry: 'HK', currency: 'HKD' } })
        : cardBody(inst);
      const r = await api.post('/api/cards', body);
      spy.mockRestore();
      expect(r.status, `withAccount=${withAccount}`).toBe(409);
      expect(r.json.code).toBe('INSTITUTION_ARCHIVED');
      const after = await snapshot();
      for (const table of ['cards', 'accounts', 'account_currencies', 'account_card_links', 'audit_log']) expect(after[table], table).toEqual(before[table]);
    }
    expect(await cardRows(user.id)).toEqual([]);
  });

  // ================================================================== prepaid card with a stored-value account (C-7)

  it('C-7: a prepaid card can create its stored-value account, default currency and default spending link in one batch', async () => {
    const { api, user } = await signIn();
    const issuer = await institution(api, { name: 'Contoso Prepaid Co', country: 'GB' });
    const r = await api.post('/api/cards', cardBody(issuer, { cardType: 'prepaid', issuingCountry: 'GB', createStoredValueAccount: { name: '预付卡余额', accountCountry: 'HK', currency: 'HKD' } }));
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const { card, account, link } = r.json;
    expect(card).toMatchObject({ cardType: 'prepaid', issuingCountry: 'GB' });
    // accountCountry is what the user entered — not the card's issuing country, not the institution's country.
    expect(account).toMatchObject({ name: '预付卡余额', accountType: 'stored_value', accountCountry: 'HK', institutionId: issuer, status: 'active', currencies: [{ currency: 'HKD', isDefault: true, status: 'active', sort: 0 }] });
    expect(link).toMatchObject({ cardId: card.id, accountId: account.id, currency: null, role: 'spending_source', isDefault: true, status: 'active', card: { id: card.id, last4: '4321' }, account: { id: account.id, accountCountry: 'HK' } });
    const detail = (await api.get(`/api/cards/${card.id}`)).json;
    expect(detail.links.map((l: { id: string }) => l.id)).toEqual([link.id]);
    const listed = (await api.get('/api/cards')).json.find((c: { id: string }) => c.id === card.id);
    expect(listed.linkedAccounts).toEqual([{ id: account.id, name: '预付卡余额', accountCountry: 'HK', status: 'active' }]);
    const accounts = (await api.get('/api/accounts')).json;
    expect(accounts.find((a: { id: string }) => a.id === account.id)).toMatchObject({ linkedCardCount: 1, linkedCards: [{ id: card.id }] });
    expect(await auditRows(user.id)).toEqual([{ action: 'card.create', detail: { id: card.id, last4: '4321', accountId: account.id, linkId: link.id } }]);

    // Another institution of the caller's may hold the account.
    const other = await institution(api);
    const r2 = await api.post('/api/cards', cardBody(issuer, { cardType: 'prepaid', createStoredValueAccount: { name: 'Elsewhere', institutionId: other, accountCountry: 'SG', currency: 'SGD' } }));
    expect(r2.json.account.institutionId).toBe(other);
  });

  it('C-7: any problem with the stored-value account creates neither the card nor the account', async () => {
    const { api, user } = await signIn();
    const { user: otherUser, api: otherApi } = await signIn('other');
    const issuer = await institution(api);
    const archived = await institution(api);
    await api.patch(`/api/institutions/${archived}`, { status: 'archived' });
    const foreign = await institution(otherApi);
    const sv = { name: 'Prepaid balance', accountCountry: 'HK', currency: 'HKD' };
    const before = await snapshot();
    const cases: [string, Record<string, unknown>, number, string][] = [
      ['no accountCountry', cardBody(issuer, { cardType: 'prepaid', createStoredValueAccount: { name: 'X', currency: 'HKD' } }), 400, 'VALIDATION'],
      ['debit card', cardBody(issuer, { createStoredValueAccount: sv }), 400, 'VALIDATION'],
      ['bad currency', cardBody(issuer, { cardType: 'prepaid', createStoredValueAccount: { ...sv, currency: 'XAU' } }), 400, 'VALIDATION'],
      ['unknown field', cardBody(issuer, { cardType: 'prepaid', createStoredValueAccount: { ...sv, balance: 100 } }), 400, 'VALIDATION'],
      ['card number in the name', cardBody(issuer, { cardType: 'prepaid', createStoredValueAccount: { ...sv, name: PANS[0] } }), 400, 'SENSITIVE_DATA'],
      ['archived institution', cardBody(issuer, { cardType: 'prepaid', createStoredValueAccount: { ...sv, institutionId: archived } }), 409, 'INSTITUTION_ARCHIVED'],
      ["another user's institution", cardBody(issuer, { cardType: 'prepaid', createStoredValueAccount: { ...sv, institutionId: foreign } }), 404, 'NOT_FOUND'],
    ];
    for (const [name, b, status, code] of cases) {
      const r = await api.post('/api/cards', b);
      expect.soft(r.status, name).toBe(status);
      expect.soft(r.json.code, name).toBe(code);
    }
    const sensitive = await api.post('/api/cards', cases[4]![1]);
    expect(sensitive.json.details.fields).toEqual([{ field: 'createStoredValueAccount.name', kind: 'card_number' }]);
    expect(await snapshot()).toEqual(before);
    expect(await cardRows(user.id)).toEqual([]);
    expect(await cardRows(otherUser.id)).toEqual([]);
  });

  it('C-7: a failure half-way through the batch (the link) rolls back the card, the account and its currency', async () => {
    const { api, user } = await signIn();
    const issuer = await institution(api);
    await e.exec("CREATE TRIGGER test_fail_link BEFORE INSERT ON account_card_links BEGIN SELECT RAISE(ABORT, 'TEST_INJECTED_FAILURE'); END");
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    let r;
    try {
      r = await api.post('/api/cards', cardBody(issuer, { cardType: 'prepaid', createStoredValueAccount: { name: 'Prepaid balance', accountCountry: 'HK', currency: 'HKD' } }));
    } finally {
      quiet.mockRestore();
      await e.exec('DROP TRIGGER test_fail_link');
    }
    expect(r.status).toBe(500);
    expect(await cardRows(user.id)).toEqual([]);
    expect(await e.all('SELECT id FROM accounts WHERE user_id = ?', user.id)).toEqual([]);
    expect(await e.all('SELECT account_id FROM account_currencies WHERE user_id = ?', user.id)).toEqual([]);
    expect(await auditRows(user.id)).toEqual([]);
  });

  // ================================================================== delete

  it('DELETE removes the card with its links (history included) and channel sources — never the accounts or channels', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const keep = await createCard(api, inst, { name: 'Keep me' });
    const acc = await createAccount(api, inst);
    await seedLink(user.id, card.id, acc, { isDefault: 1 });
    await seedLink(user.id, card.id, acc, { currency: 'USD', role: 'top_up_source' });
    await seedLink(user.id, card.id, acc, { status: 'ended', endedOn: '2025-01-01', role: 'other' });
    const keptLink = await seedLink(user.id, keep.id, acc);
    const { channel } = await seedChannelSource(user.id, card.id);
    await seedChannelSource(user.id, card.id, 'ended');
    const detail = (await api.get(`/api/cards/${card.id}`)).json;
    expect(detail.links).toHaveLength(3);
    expect(detail.channels.map((c: { id: string }) => c.id)).toEqual([channel]);

    const r = await api.del(`/api/cards/${card.id}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect((await api.get(`/api/cards/${card.id}`)).status).toBe(404);
    expect(await e.all('SELECT id FROM account_card_links WHERE card_id = ?', card.id)).toEqual([]);
    expect(await e.all('SELECT id FROM payment_channel_sources WHERE card_id = ?', card.id)).toEqual([]);
    expect((await e.all('SELECT id FROM account_card_links WHERE user_id = ?', user.id)).map((l) => l.id)).toEqual([keptLink]);
    expect(await e.all('SELECT id FROM accounts WHERE id = ?', acc)).toHaveLength(1);
    expect(await e.all('SELECT currency FROM account_currencies WHERE account_id = ? ORDER BY sort', acc)).toEqual([{ currency: 'SGD' }, { currency: 'USD' }]);
    expect(await e.all('SELECT id FROM payment_channels WHERE user_id = ?', user.id)).toHaveLength(2);
    expect(await e.all('PRAGMA foreign_key_check')).toEqual([]);
    // Deleting again, or editing the deleted card: 404.
    expect((await api.del(`/api/cards/${card.id}`)).status).toBe(404);
    expect((await api.patch(`/api/cards/${card.id}`, { name: 'Ghost' })).status).toBe(404);
    expect((await auditRows(user.id)).map((a) => a.action)).toEqual(['card.create', 'card.create', 'card.delete']);
  });

  it('concurrent deletes of one card: exactly one succeeds, the other is a 404; one audit record', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const results = await Promise.all([api.del(`/api/cards/${card.id}`), api.del(`/api/cards/${card.id}`)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(await cardRows(user.id)).toEqual([]);
    expect((await auditRows(user.id)).filter((a) => a.action === 'card.delete')).toHaveLength(1);
  });

  it('a PATCH racing a DELETE ends as a 404 or a 200 for a card that then disappears — never a resurrected card', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const [patch, del] = await Promise.all([api.patch(`/api/cards/${card.id}`, { name: 'Racing' }), api.del(`/api/cards/${card.id}`)]);
    expect(del.status).toBe(200);
    expect([200, 404]).toContain(patch.status);
    expect(await cardRows(user.id)).toEqual([]);
  });

  // ================================================================== list filters

  it('filters by q (name, issuer, last4 — NFKC like name_key), network, type, form, issuer, account and status', async () => {
    const { api, user } = await signIn();
    const contoso = await institution(api, { name: 'Contoso Bank' });
    const fabrikam = await institution(api, { name: 'Fabrikam EMI', institutionType: 'emi' });
    const a = await createCard(api, contoso, { name: 'Everyday Debit', network: 'visa', last4: '1111', sort: 1 });
    const b = await createCard(api, contoso, { name: 'Travel Virtual', network: 'mastercard', form: 'virtual', last4: '2222', sort: 2 });
    const c = await createCard(api, fabrikam, { name: '旅行预付卡', network: 'unionpay', cardType: 'prepaid', last4: '3333', sort: 3 });
    const d = await createCard(api, fabrikam, { name: 'Old Card', status: 'closed', last4: '4444', sort: 4 });
    const f = await createCard(api, fabrikam, { name: 'Frozen Card', status: 'frozen', last4: '5555', sort: 5 });
    const acc = await createAccount(api, contoso);
    await seedLink(user.id, b.id, acc);
    await seedLink(user.id, a.id, acc, { status: 'ended', endedOn: '2025-01-01' });
    const ids = async (qs: string) => {
      const r = await api.get(`/api/cards${qs}`);
      expect(r.status, `${qs} ${JSON.stringify(r.json)}`).toBe(200);
      return r.json.map((x: { id: string }) => x.id);
    };
    expect(await ids('')).toEqual([a.id, b.id, c.id, f.id]); // sort order; closed hidden
    expect(await ids('?status=all')).toEqual([a.id, b.id, c.id, d.id, f.id]);
    expect(await ids('?status=frozen')).toEqual([f.id]);
    expect(await ids('?q=travel')).toEqual([b.id]);
    expect(await ids(`?q=${encodeURIComponent('ＴＲＡＶＥＬ  virtual')}`)).toEqual([b.id]);
    expect(await ids(`?q=${encodeURIComponent('旅行')}`)).toEqual([c.id]);
    expect(await ids('?q=fabrikam')).toEqual([c.id, f.id]);
    expect(await ids('?q=3333')).toEqual([c.id]);
    expect(await ids('?q=%25')).toEqual([]);
    expect(await ids('?network=mastercard')).toEqual([b.id]);
    expect(await ids('?type=prepaid')).toEqual([c.id]);
    expect(await ids('?form=virtual')).toEqual([b.id]);
    expect(await ids(`?issuerId=${fabrikam}`)).toEqual([c.id, f.id]);
    expect(await ids(`?issuerId=${fabrikam}&status=all`)).toEqual([c.id, d.id, f.id]);
    // Only unfinished links count for the account filter and the linked-account summaries.
    expect(await ids(`?accountId=${acc}`)).toEqual([b.id]);
    const list = (await api.get('/api/cards')).json;
    expect(list.find((x: { id: string }) => x.id === a.id).linkedAccounts).toEqual([]);
    expect(list.find((x: { id: string }) => x.id === b.id).linkedAccounts.map((x: { id: string }) => x.id)).toEqual([acc]);
    for (const bad of ['?network=VISA', '?type=credit', '?form=metal', '?status=expired', '?sort=name', '?pan=4111111111111111', '?expiry=soon', '?expiringWithinDays=-1', '?expiringWithinDays=abc', '?expiringWithinDays=99999', '?today=2026-13-01', '?today=20261015']) {
      expect.soft((await api.get(`/api/cards${bad}`)).status, bad).toBe(400);
    }
  });

  // ================================================================== expiry

  it('expiry: this month, next month, across the year end, expired, none — classified on the calendar day, status untouched', async () => {
    // 2026-12-15 12:00 UTC: the same calendar day in UTC and in the test machine's zone.
    setClock(Date.UTC(2026, 11, 15, 12, 0));
    const { api, user } = await signIn();
    const inst = await institution(api);
    const mk = (name: string, expiresOn: string | null) => createCard(api, inst, { name, expiresOn });
    await mk('this month', '2026-12'); // 16 days left
    await mk('next month', '2027-01'); // 47 days — across the year end
    await mk('in two months', '2027-02'); // 75 days
    const lastMonth = await mk('last month', '2026-11'); // expired 15 days ago
    await mk('no expiry', null);
    await mk('far away', '2031-06');
    const ids = async (qs: string) => (await api.get(`/api/cards${qs}`)).json.map((x: { name: string }) => x.name);
    const today = '&today=2026-12-15';
    expect(await ids(`?expiry=expiring${today}`)).toEqual(['next month', 'this month']);
    expect(await ids(`?expiry=expired${today}`)).toEqual(['last month']);
    expect(await ids(`?expiry=none${today}`)).toEqual(['no expiry']);
    expect(await ids(`?expiry=valid${today}`)).toEqual(['far away', 'in two months']);
    // Without today= the server uses the UTC date — the same day here.
    expect(await ids('?expiry=expiring')).toEqual(['next month', 'this month']);
    // expiringWithinDays alone = expiring within N days; with expiry= it moves the threshold.
    expect(await ids('?expiringWithinDays=16')).toEqual(['this month']);
    expect(await ids('?expiringWithinDays=15')).toEqual([]);
    expect(await ids('?expiringWithinDays=75')).toEqual(['in two months', 'next month', 'this month']);
    expect(await ids('?expiry=valid&expiringWithinDays=75')).toEqual(['far away']);
    expect(await ids('?expiringWithinDays=0')).toEqual([]);
    // Expired cards keep their status (still listed by default, still 'active').
    expect((await api.get(`/api/cards/${lastMonth.id}`)).json.status).toBe('active');
    expect((await cardRows(user.id)).map((r) => r.status)).toEqual(['active', 'active', 'active', 'active', 'active', 'active']);
  });

  it('expiry: the last day of the month (leap years too) is still valid; the day after is expired', async () => {
    setClock(Date.UTC(2027, 1, 28, 12)); // 2027-02-28
    const me = await signIn();
    let api = me.api;
    const inst = await institution(api);
    await createCard(api, inst, { name: 'Feb 2027', expiresOn: '2027-02' }); // not a leap year: ends on the 28th
    await createCard(api, inst, { name: 'Feb 2028', expiresOn: '2028-02' }); // leap year: ends on the 29th
    const names = async (filter: string, today: string) => {
      const r = await api.get(`/api/cards?expiry=${filter}&today=${today}`);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json.map((x: { name: string }) => x.name);
    };
    expect(await names('expiring', '2027-02-28')).toEqual(['Feb 2027']); // last valid day: 0 days left
    expect(await names('expired', '2027-02-28')).toEqual([]);
    // today= must be the current date (± one day for time zones): a date far from the clock is refused.
    const far = await api.get('/api/cards?expiry=expired&today=2028-02-29');
    expect(far.status).toBe(400);
    expect(far.json.details[0].path).toEqual(['today']);

    setClock(Date.UTC(2027, 2, 1, 12)); // 2027-03-01
    expect(await names('expired', '2027-03-01')).toEqual(['Feb 2027']);
    // A year later the session has expired (30 days absolute): sign in again.
    setClock(Date.UTC(2028, 1, 29, 12)); // 2028-02-29
    api = await me.again();
    expect(await names('expiring', '2028-02-29')).toEqual(['Feb 2028']);
    expect(await names('expired', '2028-02-29')).toEqual(['Feb 2027']);
    setClock(Date.UTC(2028, 2, 1, 12)); // 2028-03-01
    expect(await names('expired', '2028-03-01')).toEqual(['Feb 2027', 'Feb 2028']);
  });

  it('expiry across time zones: the client sends its own calendar day, so list filter and tags agree; a day either side of UTC is accepted', async () => {
    // 2028-04-30 20:00 UTC = 2028-05-01 04:00 in Shanghai = 2028-04-30 13:00 in Los Angeles.
    setClock(Date.UTC(2028, 3, 30, 20, 0));
    const { api } = await signIn();
    const inst = await institution(api);
    await createCard(api, inst, { name: 'April 2028', expiresOn: '2028-04' });
    const status = async (today?: string) => {
      const filters = ['valid', 'expiring', 'expired', 'none'];
      const hits: string[] = [];
      for (const f of filters) if ((await api.get(`/api/cards?expiry=${f}${today ? `&today=${today}` : ''}`)).json.length) hits.push(f);
      return hits;
    };
    expect(await status('2028-05-01')).toEqual(['expired']); // Shanghai: already May
    expect(await status('2028-04-30')).toEqual(['expiring']); // Los Angeles: last valid day
    expect(await status()).toEqual(['expiring']); // no today= → the UTC date (2028-04-30)
    expect((await api.get('/api/cards?expiry=expired&today=2028-04-29')).status).toBe(200); // UTC−12 is still the 29th
    expect((await api.get('/api/cards?expiry=expired&today=2028-05-02')).status).toBe(400);
    expect((await api.get('/api/cards?expiry=expired&today=2028-04-28')).status).toBe(400);
  });

  // ================================================================== isolation

  it("U-1 / U-3: another user's cards are a 404 on every route, absent from every list, and unchanged", async () => {
    const { api: alice, user: aliceUser } = await signIn('alice');
    const { api: bob } = await signIn('bob');
    const inst = await institution(alice);
    const card = await createCard(alice, inst, { name: 'Alice Secret Card' });
    const acc = await createAccount(alice, inst);
    await seedLink(aliceUser.id, card.id, acc);
    const before = await snapshot();
    expect((await bob.get(`/api/cards/${card.id}`)).status).toBe(404);
    expect((await bob.patch(`/api/cards/${card.id}`, { name: 'Bob was here' })).status).toBe(404);
    expect((await bob.patch(`/api/cards/${card.id}`, { status: 'closed' })).status).toBe(404);
    expect((await bob.del(`/api/cards/${card.id}`)).status).toBe(404);
    for (const qs of ['', '?status=all', `?issuerId=${inst}`, `?accountId=${acc}`, '?q=alice', '?expiry=none']) expect.soft((await bob.get(`/api/cards${qs}`)).json, qs).toEqual([]);
    expect(JSON.stringify((await bob.get('/api/accounts?status=all')).json)).not.toContain(card.id);
    expect(await snapshot()).toEqual(before);
    expect((await alice.get(`/api/cards/${card.id}`)).json.name).toBe('Alice Secret Card');
  });

  it("U-2: cards cannot be issued by, or moved to, another user's institution (404, whatever its status)", async () => {
    const { api: alice } = await signIn('alice');
    const { api: bob, user: bobUser } = await signIn('bob');
    const aliceInst = await institution(alice);
    const aliceArchived = await institution(alice);
    await alice.patch(`/api/institutions/${aliceArchived}`, { status: 'archived' });
    for (const inst of [aliceInst, aliceArchived]) {
      const r = await bob.post('/api/cards', cardBody(inst));
      expect.soft(r.status).toBe(404);
      expect.soft(r.json.code).toBe('NOT_FOUND');
    }
    const bobInst = await institution(bob);
    const bobCard = await createCard(bob, bobInst);
    for (const inst of [aliceInst, aliceArchived]) expect.soft((await bob.patch(`/api/cards/${bobCard.id}`, { issuerInstitutionId: inst })).status).toBe(404);
    expect((await cardRows(bobUser.id)).map((r) => r.issuer_institution_id)).toEqual([bobInst]);
    // The composite foreign key refuses it at the database level too.
    expect(await sqlError('UPDATE cards SET issuer_institution_id = ? WHERE id = ?', aliceInst, bobCard.id)).toMatch(/FOREIGN KEY constraint failed/);
  });

  // ================================================================== atomicity of writes (M2-B3 final review)

  /** Run `fn` while every insert into `table` (optionally only when `when`) fails; console noise of the 500 is muted. */
  async function failingInsert<R>(table: string, when: string | null, fn: () => Promise<R>): Promise<R> {
    const name = `test_fail_${table}`;
    await e.exec(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table}${when ? ` WHEN ${when}` : ''} BEGIN SELECT RAISE(ABORT, 'TEST_INJECTED_FAILURE'); END`);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      return await fn();
    } finally {
      quiet.mockRestore();
      await e.exec(`DROP TRIGGER ${name}`);
    }
  }
  const svBody = (issuer: string, extra: Record<string, unknown> = {}) =>
    cardBody(issuer, { cardType: 'prepaid', last4: '6060', createStoredValueAccount: { name: 'Prepaid balance', accountCountry: 'HK', currency: 'HKD', ...extra } });

  /** Every row the prepaid creates wrote for this user, checked to belong together. */
  async function expectCompleteSets(userId: string, issuer: string, accountInstitution: string, sets: number) {
    const cardsOf = await e.all('SELECT id, user_id, issuer_institution_id, card_type FROM cards WHERE user_id = ? ORDER BY rowid', userId);
    const accountsOf = await e.all('SELECT id, user_id, institution_id, account_type, account_country FROM accounts WHERE user_id = ? ORDER BY rowid', userId);
    const currenciesOf = await e.all('SELECT account_id, user_id, currency, is_default, status FROM account_currencies WHERE user_id = ? ORDER BY rowid', userId);
    const linksOf = await e.all('SELECT id, user_id, card_id, account_id, currency, role, is_default, status FROM account_card_links WHERE user_id = ? ORDER BY rowid', userId);
    const audits = await auditRows(userId);
    for (const list of [cardsOf, accountsOf, currenciesOf, linksOf, audits]) expect(list).toHaveLength(sets);
    for (let i = 0; i < sets; i++) {
      const [card, account, currency, link, audit] = [cardsOf[i]!, accountsOf[i]!, currenciesOf[i]!, linksOf[i]!, audits[i]!];
      expect(card).toMatchObject({ user_id: userId, issuer_institution_id: issuer, card_type: 'prepaid' });
      expect(account).toMatchObject({ user_id: userId, institution_id: accountInstitution, account_type: 'stored_value', account_country: 'HK' });
      expect(currency).toEqual({ account_id: account.id, user_id: userId, currency: 'HKD', is_default: 1, status: 'active' });
      expect(link).toEqual({ id: link.id, user_id: userId, card_id: card.id, account_id: account.id, currency: null, role: 'spending_source', is_default: 1, status: 'active' });
      expect(audit).toEqual({ action: 'card.create', detail: { id: card.id, last4: '6060', accountId: account.id, linkId: link.id } });
    }
    // No orphans: every stored-value account has its card link, and every reference resolves.
    expect(await e.all("SELECT a.id FROM accounts a WHERE a.user_id = ? AND a.account_type = 'stored_value' AND NOT EXISTS (SELECT 1 FROM account_card_links l WHERE l.account_id = a.id)", userId)).toEqual([]);
    expect(await e.all('PRAGMA foreign_key_check')).toEqual([]);
  }

  it('prepaid + stored-value account: a failure at any step (card, account, currency, link, audit) leaves nothing; the retry creates exactly one complete set', async () => {
    const steps: [string, string | null][] = [
      ['cards', null],
      ['accounts', null],
      ['account_currencies', null],
      ['account_card_links', null],
      ['audit_log', "NEW.action = 'card.create'"],
    ];
    for (const [table, when] of steps) {
      const { api, user } = await signIn(`atomic-${table}`);
      const issuer = await institution(api);
      const before = await snapshot();
      const failed = await failingInsert(table, when, () => api.post('/api/cards', svBody(issuer)));
      expect(failed.status, table).toBe(500);
      expect(failed.json.code).toBe('INTERNAL');
      expect(await snapshot(), `nothing left after a failing ${table} insert`).toEqual(before);
      // The same request again, once the fault is gone: one complete set, nothing from the failed try.
      const retry = await api.post('/api/cards', svBody(issuer));
      expect(retry.status, table).toBe(201);
      expect(retry.json.link).toMatchObject({ cardId: retry.json.card.id, accountId: retry.json.account.id });
      await expectCompleteSets(user.id, issuer, issuer, 1);
      expect((await e.all('SELECT id FROM account_card_links WHERE user_id = ?', user.id))[0]!.id).toBe(retry.json.link.id);
    }
  });

  it('a card alone: a failing card or audit insert leaves neither; the audit never reports a create that did not happen', async () => {
    for (const [table, when] of [
      ['cards', null],
      ['audit_log', "NEW.action = 'card.create'"],
    ] as const) {
      const { api, user } = await signIn(`alone-${table}`);
      const issuer = await institution(api);
      const before = await snapshot();
      expect((await failingInsert(table, when, () => api.post('/api/cards', cardBody(issuer)))).status).toBe(500);
      expect(await snapshot()).toEqual(before);
      expect(await auditRows(user.id)).toEqual([]);
    }
  });

  it("the stored-value account may sit at another institution of the caller's (ids line up), never at another user's", async () => {
    const { api, user } = await signIn('owner');
    const { api: other, user: otherUser } = await signIn('intruder');
    const issuer = await institution(api);
    const holder = await institution(api);
    expect((await api.post('/api/cards', svBody(issuer, { institutionId: holder }))).status).toBe(201);
    await expectCompleteSets(user.id, issuer, holder, 1);
    // The other user names the owner's institutions — as the account's institution or as issuer: 404, nobody's data changes.
    const otherIssuer = await institution(other);
    const before = await snapshot();
    expect((await other.post('/api/cards', svBody(otherIssuer, { institutionId: holder }))).status).toBe(404);
    expect((await other.post('/api/cards', svBody(issuer))).status).toBe(404);
    expect(await snapshot()).toEqual(before);
    expect(await cardRows(otherUser.id)).toEqual([]);
  });

  it('POST /cards is not idempotent: repeating a request whose answer was lost creates a second, complete set (documented; no orphans)', async () => {
    const { api, user } = await signIn('retry');
    const issuer = await institution(api);
    // The first request commits; the client never sees the answer and sends the same body again.
    const first = await api.post('/api/cards', svBody(issuer));
    const second = await api.post('/api/cards', svBody(issuer));
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.json.card.id).not.toBe(first.json.card.id);
    await expectCompleteSets(user.id, issuer, issuer, 2);
  });

  it('DELETE: a failing audit insert rolls the delete back — the card, its links and channel sources stay', async () => {
    const { api, user } = await signIn('delete-audit');
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst);
    await seedLink(user.id, card.id, acc, { isDefault: 1 });
    await seedChannelSource(user.id, card.id);
    const before = await snapshot();
    expect((await failingInsert('audit_log', "NEW.action = 'card.delete'", () => api.del(`/api/cards/${card.id}`))).status).toBe(500);
    expect(await snapshot()).toEqual(before);
    expect((await api.del(`/api/cards/${card.id}`)).status).toBe(200);
    expect((await auditRows(user.id)).map((a) => a.action)).toEqual(['card.create', 'card.delete']);
  });

  it('DELETE removes only the card, its own links and channel sources: other cards, the accounts, channels and other users are untouched', async () => {
    const { api, user } = await signIn('scope');
    const { api: other, user: otherUser } = await signIn('bystander');
    const inst = await institution(api);
    const doomed = await createCard(api, inst, { name: 'Doomed' });
    const sibling = await createCard(api, inst, { name: 'Sibling' });
    const acc = await createAccount(api, inst);
    await seedLink(user.id, doomed.id, acc, { isDefault: 1 });
    await seedLink(user.id, doomed.id, acc, { status: 'ended', endedOn: '2025-01-01', role: 'other' });
    await seedLink(user.id, sibling.id, acc, { currency: 'USD' });
    const { channel } = await seedChannelSource(user.id, doomed.id);
    await e.exec('INSERT INTO payment_channel_sources (id, user_id, channel_id, card_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', `src-${engine}-${++seq}`, user.id, channel, doomed.id, 'ended', T, T);
    await e.exec('INSERT INTO payment_channel_sources (id, user_id, channel_id, card_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', `src-${engine}-${++seq}`, user.id, channel, sibling.id, 'active', T, T);
    const otherInst = await institution(other);
    const otherCard = await createCard(other, otherInst);
    const otherAcc = await createAccount(other, otherInst);
    await seedLink(otherUser.id, otherCard.id, otherAcc);
    expect((await api.get(`/api/cards/${doomed.id}`)).json.channelSourceCounts).toEqual({ active: 1, ended: 1 });

    const before = await snapshot();
    expect((await api.del(`/api/cards/${doomed.id}`)).status).toBe(200);
    const after = await snapshot();
    const without = (list: Rows, drop: (r: Record<string, unknown>) => boolean) => list.filter((r) => !drop(r));
    expect(after.cards).toEqual(without(before.cards!, (r) => r.id === doomed.id));
    expect(after.account_card_links).toEqual(without(before.account_card_links!, (r) => r.card_id === doomed.id));
    expect(after.payment_channel_sources).toEqual(without(before.payment_channel_sources!, (r) => r.card_id === doomed.id));
    expect(after.audit_log!.slice(0, before.audit_log!.length)).toEqual(before.audit_log);
    expect(after.audit_log!.slice(before.audit_log!.length).map((r) => [r.user_id, r.action, JSON.parse(String(r.detail))])).toEqual([[user.id, 'card.delete', { id: doomed.id, last4: '4321' }]]);
    for (const table of Object.keys(before).filter((name) => !['cards', 'account_card_links', 'payment_channel_sources', 'audit_log'].includes(name))) {
      expect(after[table], table).toEqual(before[table]);
    }
  });

  // ================================================================== PATCH: moving a card to another issuer, racing an archive

  /** PATCH the card while `sqlText` (bound to `to`) runs after the route's pre-check, right before its UPDATE batch. */
  async function patchRacing(api: Api, cardId: string, body: Record<string, unknown>, sqlText: string, to: string) {
    const real = e.t.db.batch.bind(e.t.db);
    const spy = vi.spyOn(e.t.db, 'batch').mockImplementationOnce(async (batch) => {
      await e.exec(sqlText, to);
      return real(batch as never);
    });
    try {
      return await api.patch(`/api/cards/${cardId}`, body);
    } finally {
      spy.mockRestore();
    }
  }

  it('moving to an issuer archived after the pre-check: 409 and every column of the card unchanged; once restored the move succeeds', async () => {
    const { api, user } = await signIn('mover');
    const { api: other } = await signIn('stranger');
    const from = await institution(api);
    const to = await institution(api);
    const card = await createCard(api, from, { expiresOn: '2029-01', notes: 'original' });
    const row = async () => (await e.all('SELECT * FROM cards WHERE id = ?', card.id))[0];
    const original = await row();
    e.t.advance(1000);
    const body = { issuerInstitutionId: to, name: 'Moved', notes: 'changed', status: 'frozen' };

    const archived = await patchRacing(api, card.id, body, "UPDATE institutions SET status = 'archived' WHERE id = ?", to);
    expect(archived.status).toBe(409);
    expect(archived.json).toMatchObject({ code: 'INSTITUTION_ARCHIVED', details: { institutionId: to } });
    expect(await row()).toEqual(original);
    // While archived, a plain request is refused as well; another user's institution is a 404.
    expect((await api.patch(`/api/cards/${card.id}`, body)).status).toBe(409);
    const foreign = await institution(other);
    expect((await api.patch(`/api/cards/${card.id}`, { ...body, issuerInstitutionId: foreign })).status).toBe(404);
    expect(await row()).toEqual(original);
    // Restored: the move goes through, with the other fields.
    await api.patch(`/api/institutions/${to}`, { status: 'active' });
    const moved = await api.patch(`/api/cards/${card.id}`, body);
    expect(moved.status).toBe(200);
    expect(moved.json).toMatchObject({ issuerInstitutionId: to, name: 'Moved', notes: 'changed', status: 'frozen' });
    expect((await cardRows(user.id))[0]).toMatchObject({ issuer_institution_id: to, name: 'Moved', updated_at: e.t.clock.t });
  });

  it('moving to an issuer deleted after the pre-check: 404 and the card unchanged', async () => {
    const { api } = await signIn('mover2');
    const from = await institution(api);
    const to = await institution(api);
    const card = await createCard(api, from);
    const original = (await e.all('SELECT * FROM cards WHERE id = ?', card.id))[0];
    const r = await patchRacing(api, card.id, { issuerInstitutionId: to, name: 'Moved' }, 'DELETE FROM institutions WHERE id = ?', to);
    expect(r.status).toBe(404);
    expect((await e.all('SELECT * FROM cards WHERE id = ?', card.id))[0]).toEqual(original);
  });

  // ================================================================== authentication

  it('R-1: every card route needs a session; writes need the CSRF header and an allowed Origin', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const anon = client(e.t);
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/cards'],
      ['POST', '/api/cards', cardBody(inst)],
      ['GET', `/api/cards/${card.id}`],
      ['PATCH', `/api/cards/${card.id}`, { name: 'X' }],
      ['DELETE', `/api/cards/${card.id}`],
    ];
    for (const [method, path, b] of routes) {
      const r = await anon.req(method, path, b);
      expect.soft(r.status, `${method} ${path}`).toBe(401);
      expect.soft(r.json.code).toBe('UNAUTHENTICATED');
    }
    const before = await snapshot();
    for (const [method, path, b] of routes.filter(([m]) => m !== 'GET')) {
      const evil = await api.req(method, path, b, { origin: 'https://evil.example' });
      expect.soft(evil.status, `${method} origin`).toBe(403);
      expect.soft(evil.json.code).toBe('BAD_ORIGIN');
      const noCsrf = await api.req(method, path, b, { [CSRF_HEADER]: '' });
      expect.soft(noCsrf.status, `${method} csrf`).toBe(403);
      expect.soft(noCsrf.json.code).toBe('CSRF');
    }
    expect(await snapshot()).toEqual(before);
    const list = await api.get('/api/cards');
    expect(list.res.headers.get('cache-control')).toBe('no-store');
    // Unknown ids: 404 everywhere.
    const missing = 'x'.repeat(26);
    expect((await api.get(`/api/cards/${missing}`)).json.code).toBe('NOT_FOUND');
    expect((await api.patch(`/api/cards/${missing}`, { name: 'X' })).status).toBe(404);
    expect((await api.del(`/api/cards/${missing}`)).status).toBe(404);
  });
});
