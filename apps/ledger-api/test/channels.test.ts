// M2-B5: payment channels and their funding sources (API_SPEC §3.6, §3.7; DATA_MODEL §3.6, §3.7,
// §4; TEST_PLAN P-1 – P-6, and X-1 / X-4 / U-1 / U-2 / U-3 / U-4 / I-4 / A-10 / D-4 / R-1 for
// channels). Every case runs twice with the same assertions: on libsql (a temporary file database
// opened by openV1Db) and on wrangler's local in-memory D1 (d1-app.ts — never a remote D1).
// All names are fictional.
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
  const h: D1App = await startD1App('xui-v1-channels-d1');
  return { t: h.t, all: h.all, exec: (sql, ...args) => h.d1.prepare(sql).bind(...args).run(), ping: h.ping, dispose: h.dispose };
}

const ENGINES = { libsql: libsqlEngine, d1: d1Engine };
const CARD_NUMBER = '4111 1111 1111 1111';

describe.each(['libsql', 'd1'] as const)('payment channels on %s', (engine) => {
  let e: Engine;
  beforeAll(async () => {
    e = await ENGINES[engine]();
  }, 180_000);
  afterAll(async () => {
    await e?.dispose();
  });
  beforeEach(() => e.ping());

  let seq = 0;
  async function signIn(prefix = 'user') {
    const u = await makeUser(e.t, `${engine}-${prefix}-${++seq}`);
    return { user: u.user, api: await login(e.t, u) };
  }
  type Api = Awaited<ReturnType<typeof login>>;

  async function institution(api: Api, body: Record<string, unknown> = {}) {
    const r = await api.post('/api/institutions', { name: `Provider ${++seq}`, country: 'LU', institutionType: 'emi', ...body });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.id as string;
  }
  async function createAccount(api: Api, inst: string, accountType = 'e_money', extra: Record<string, unknown> = {}) {
    const r = await api.post('/api/accounts', { institutionId: inst, name: `Account ${++seq}`, accountType, accountCountry: 'LU', currencies: [{ code: 'EUR', isDefault: true }], ...extra });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.id as string;
  }
  async function createCard(api: Api, inst: string, extra: Record<string, unknown> = {}) {
    const r = await api.post('/api/cards', { issuerInstitutionId: inst, name: `Card ${++seq}`, network: 'visa', cardType: 'debit', last4: '4321', issuingCountry: 'BE', ...extra });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.card.id as string;
  }
  async function channel(api: Api, body: Record<string, unknown> = {}) {
    const r = await api.post('/api/payment-channels', { name: `Channel ${++seq}`, channelType: 'payment_service', ...body });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json as Record<string, any> & { id: string };
  }
  async function source(api: Api, channelId: string, body: Record<string, unknown>) {
    e.t.advance(1); // sources are listed oldest first: one per millisecond keeps the creation order
    const r = await api.post(`/api/payment-channels/${channelId}/sources`, body);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json as Record<string, any> & { id: string };
  }
  const detail = async (api: Api, id: string) => {
    const r = await api.get(`/api/payment-channels/${id}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json;
  };

  const sourceRow = async (id: string) => (await e.all('SELECT status, is_default, notes, card_id, account_id FROM payment_channel_sources WHERE id = ?', id))[0];
  const defaults = async (channelId: string) => (await e.all('SELECT id FROM payment_channel_sources WHERE channel_id = ? AND is_default = 1 ORDER BY id', channelId)).map((r) => r.id);
  const auditRows = async (userId: string) =>
    (await e.all("SELECT action, detail FROM audit_log WHERE user_id = ? AND action LIKE 'channel%' ORDER BY rowid", userId)).map((a) => ({ action: a.action, detail: JSON.parse(String(a.detail)) }));

  const sqlError = (sql: string, ...args: unknown[]) =>
    e.exec(sql, ...args).then(
      () => 'no error',
      (err: unknown) => {
        const out: string[] = [];
        for (let cur: any = err, i = 0; cur && i < 6; cur = cur.cause, i++) out.push(String(cur.message ?? cur));
        return out.join(' | ');
      },
    );

  async function snapshot() {
    const tables = (await e.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name")).map((r) => String(r.name));
    const out: Record<string, Rows> = {};
    for (const table of tables) out[table] = await e.all(`SELECT * FROM "${table}" ORDER BY rowid`);
    return out;
  }
  /** Business tables only (sessions and login bookkeeping change with every sign-in). */
  async function m2Snapshot() {
    const all = await snapshot();
    return Object.fromEntries(['institutions', 'accounts', 'account_currencies', 'cards', 'account_card_links', 'payment_channels', 'payment_channel_sources', 'audit_log'].map((t) => [t, all[t]]));
  }

  /** Run `fn` while every `event` on `table` (optionally only `when`) fails; console noise of the 500 is muted. */
  async function failing<R>(event: 'INSERT' | 'UPDATE' | 'DELETE', table: string, when: string | null, fn: () => Promise<R>): Promise<R> {
    const name = `test_fail_${event.toLowerCase()}_${table}`;
    await e.exec(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table}${when ? ` WHEN ${when}` : ''} BEGIN SELECT RAISE(ABORT, 'TEST_INJECTED_FAILURE'); END`);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      return await fn();
    } finally {
      quiet.mockRestore();
      await e.exec(`DROP TRIGGER ${name}`);
    }
  }
  /** Run `before` right before the next db.batch() (after the route's own reads) — a concurrent request landing in between. */
  function beforeNextBatch(before: () => Promise<unknown>) {
    const original = e.t.db.batch.bind(e.t.db);
    return vi.spyOn(e.t.db, 'batch').mockImplementationOnce(async (batch) => {
      await before();
      return original(batch as never);
    });
  }

  // ================================================================== channels (P-1, P-2)

  it('P-1: device_wallet, payment_service and other are accepted; bank_transfer (or anything else) is 400 and the database CHECK refuses it', async () => {
    const { api, user } = await signIn();
    const provider = await institution(api);
    const wallet = await channel(api, { name: 'Apple Pay', channelType: 'device_wallet', region: 'HK', notes: '手机' });
    expect(wallet).toEqual({
      id: expect.any(String),
      name: 'Apple Pay',
      channelType: 'device_wallet',
      providerInstitutionId: null,
      provider: null,
      balanceAccountId: null,
      balanceAccount: null,
      region: 'HK',
      status: 'active',
      notes: '手机',
      sort: 0,
      createdAt: e.t.clock.t,
      updatedAt: e.t.clock.t,
    });
    const service = await channel(api, { name: 'PayPal', channelType: 'payment_service', providerInstitutionId: provider });
    expect(service.provider).toEqual({ id: provider, name: expect.any(String), institutionType: 'emi', color: null, status: 'active' });
    expect((await channel(api, { name: 'Gift voucher', channelType: 'other' })).channelType).toBe('other');
    const before = await snapshot();
    for (const channelType of ['bank_transfer', 'swift', 'credit', '', null]) {
      const r = await api.post('/api/payment-channels', { name: `Wire ${channelType}`, channelType });
      expect(r.status, String(channelType)).toBe(400);
      expect(r.json.code).toBe('VALIDATION');
    }
    expect(await snapshot()).toEqual(before);
    expect(await sqlError("INSERT INTO payment_channels (id, user_id, name, name_key, channel_type, created_at, updated_at) VALUES ('wire', ?, 'Wire', 'wire', 'bank_transfer', 1, 1)", user.id)).toMatch(
      /CHECK constraint failed/,
    );
  });

  it('names are unique per user (normalized like name_key) — 409 DUPLICATE with existingId, archived channels included; another user may use the same name', async () => {
    // Another user's PayPal exists first: existingId must still be the caller's own channel.
    const b = await signIn('b');
    const bPaypal = await channel(b.api, { name: 'PayPal' });
    const { api } = await signIn();
    const paypal = await channel(api, { name: 'PayPal' });
    for (const name of ['PayPal', ' paypal ', 'ＰＡＹＰＡＬ']) {
      const r = await api.post('/api/payment-channels', { name, channelType: 'other' });
      expect(r.status, name).toBe(409);
      expect(r.json).toMatchObject({ code: 'DUPLICATE', details: { existingId: paypal.id } });
    }
    const other = await channel(api, { name: 'Alipay' });
    const rename = await api.patch(`/api/payment-channels/${other.id}`, { name: 'paypal' });
    expect(rename.status).toBe(409);
    expect(rename.json.details.existingId).toBe(paypal.id);
    // Renaming to its own name (another case) is fine.
    expect((await api.patch(`/api/payment-channels/${paypal.id}`, { name: 'PAYPAL' })).json.name).toBe('PAYPAL');
    await api.patch(`/api/payment-channels/${paypal.id}`, { status: 'archived' });
    const archivedDup = await api.post('/api/payment-channels', { name: 'PayPal', channelType: 'other' });
    expect(archivedDup.status).toBe(409);
    expect(archivedDup.json.details.existingId).toBe(paypal.id);
    expect(JSON.stringify([rename.json, archivedDup.json])).not.toContain(bPaypal.id);
  });

  it('P-2: only a payment_service may have a balance account (400 BALANCE_ACCOUNT_KIND, also when PATCH changes the type); nothing is written', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const emoney = await createAccount(api, inst, 'e_money');
    const before = await snapshot();
    for (const channelType of ['device_wallet', 'other']) {
      const r = await api.post('/api/payment-channels', { name: `X ${channelType}`, channelType, balanceAccountId: emoney });
      expect(r.status, channelType).toBe(400);
      expect(r.json.code, channelType).toBe('BALANCE_ACCOUNT_KIND');
    }
    expect(await snapshot()).toEqual(before);
    const paypal = await channel(api, { balanceAccountId: emoney });
    expect(paypal.balanceAccount).toEqual({ id: emoney, name: expect.any(String), accountCountry: 'LU', status: 'active' });
    // Changing the type away from payment_service while the balance account stays: refused, nothing written.
    const unchanged = await m2Snapshot();
    const r = await api.patch(`/api/payment-channels/${paypal.id}`, { channelType: 'other' });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: expect.any(String), code: 'BALANCE_ACCOUNT_KIND' });
    // Also when another rule fails in the same request (an archived new provider): the type rule is reported.
    const archived = await institution(api, { status: 'archived' });
    const both = await m2Snapshot();
    const r2 = await api.patch(`/api/payment-channels/${paypal.id}`, { channelType: 'other', providerInstitutionId: archived, notes: 'x' });
    expect(r2.status).toBe(400);
    expect(r2.json.code).toBe('BALANCE_ACCOUNT_KIND');
    expect(await m2Snapshot()).toEqual(both);
    expect(both.payment_channels).toEqual(unchanged.payment_channels);
    expect(both.audit_log).toEqual(unchanged.audit_log);
    expect((await api.patch(`/api/payment-channels/${paypal.id}`, { channelType: 'device_wallet', balanceAccountId: emoney })).json.code).toBe('BALANCE_ACCOUNT_KIND');
    // Releasing it in the same request is fine.
    const released = await api.patch(`/api/payment-channels/${paypal.id}`, { channelType: 'other', balanceAccountId: null });
    expect(released.status).toBe(200);
    expect(released.json).toMatchObject({ channelType: 'other', balanceAccountId: null, balanceAccount: null });
    // And a non-payment_service can't take one later either.
    expect((await api.patch(`/api/payment-channels/${paypal.id}`, { balanceAccountId: emoney })).json.code).toBe('BALANCE_ACCOUNT_KIND');
  });

  it('P-2: the balance account must be e_money or stored_value (API 400 BALANCE_ACCOUNT_KIND; the triggers back it up on INSERT, UPDATE and when the account type changes)', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const bank = await createAccount(api, inst, 'bank');
    const other = await createAccount(api, inst, 'other');
    const stored = await createAccount(api, inst, 'stored_value');
    const before = await snapshot();
    for (const acc of [bank, other]) {
      const r = await api.post('/api/payment-channels', { name: `Svc ${acc}`, channelType: 'payment_service', balanceAccountId: acc });
      expect(r.status).toBe(400);
      expect(r.json.code).toBe('BALANCE_ACCOUNT_KIND');
    }
    expect(await snapshot()).toEqual(before);
    const svc = await channel(api, { balanceAccountId: stored });
    expect(svc.balanceAccountId).toBe(stored);
    const r = await api.patch(`/api/payment-channels/${svc.id}`, { balanceAccountId: bank });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('BALANCE_ACCOUNT_KIND');
    expect((await e.all('SELECT balance_account_id FROM payment_channels WHERE id = ?', svc.id))[0]!.balance_account_id).toBe(stored);
    // The account used as a balance account can't become a bank account (accounts route + trigger).
    const kind = await api.patch(`/api/accounts/${stored}`, { accountType: 'bank' });
    expect(kind.status).toBe(400);
    expect(kind.json).toMatchObject({ code: 'BALANCE_ACCOUNT_KIND', details: { channels: [expect.objectContaining({ id: svc.id })] } });
    // Raw SQL past the API: the triggers.
    expect(await sqlError("INSERT INTO payment_channels (id, user_id, name, name_key, channel_type, balance_account_id, created_at, updated_at) VALUES ('raw', ?, 'Raw', 'raw', 'payment_service', ?, 1, 1)", user.id, bank)).toMatch(
      /BALANCE_ACCOUNT_KIND/,
    );
    expect(await sqlError('UPDATE payment_channels SET balance_account_id = ? WHERE id = ?', bank, svc.id)).toMatch(/BALANCE_ACCOUNT_KIND/);
    expect(await sqlError("UPDATE accounts SET account_type = 'bank' WHERE id = ?", stored)).toMatch(/BALANCE_ACCOUNT_KIND/);
    // The CHECK: a balance account on a non-payment_service.
    expect(await sqlError("UPDATE payment_channels SET channel_type = 'other' WHERE id = ?", svc.id)).toMatch(/CHECK constraint failed/);
  });

  it('P-2: an account is the balance account of at most one channel — 409 DUPLICATE naming that channel (create and PATCH); released, another may take it; the unique index refuses raw SQL', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    const first = await channel(api, { balanceAccountId: acc });
    let r = await api.post('/api/payment-channels', { name: 'Second', channelType: 'payment_service', balanceAccountId: acc });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: 'DUPLICATE', details: { existingId: first.id } });
    const second = await channel(api, { name: 'Second' });
    r = await api.patch(`/api/payment-channels/${second.id}`, { balanceAccountId: acc });
    expect(r.status).toBe(409);
    expect(r.json.details.existingId).toBe(first.id);
    // Setting the same account again on its own channel is no conflict.
    expect((await api.patch(`/api/payment-channels/${first.id}`, { balanceAccountId: acc, notes: 'same' })).status).toBe(200);
    expect(await sqlError("INSERT INTO payment_channels (id, user_id, name, name_key, channel_type, balance_account_id, created_at, updated_at) VALUES ('raw2', ?, 'Raw2', 'raw2', 'payment_service', ?, 1, 1)", user.id, acc)).toMatch(
      /UNIQUE constraint failed/,
    );
    await api.patch(`/api/payment-channels/${first.id}`, { balanceAccountId: null });
    expect((await api.patch(`/api/payment-channels/${second.id}`, { balanceAccountId: acc })).json.balanceAccountId).toBe(acc);
    // The account detail and delete protection follow the balance account (A-10, D-4).
    expect((await api.get(`/api/accounts/${acc}`)).json.balanceOfChannels).toEqual([{ id: second.id, name: 'Second', channelType: 'payment_service', status: 'active' }]);
    const del = await api.del(`/api/accounts/${acc}`);
    expect(del.status).toBe(409);
    expect(del.json).toMatchObject({ code: 'IN_USE', details: { references: { balanceOfChannels: 1 } } });
    await api.patch(`/api/payment-channels/${second.id}`, { balanceAccountId: null });
    expect((await api.del(`/api/accounts/${acc}`)).status).toBe(200);
  });

  it('balance accounts that are frozen or closed may be recorded (status is not a rule here); the summary shows the status', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const frozen = await createAccount(api, inst, 'e_money', { status: 'frozen' });
    const svc = await channel(api, { balanceAccountId: frozen });
    expect(svc.balanceAccount.status).toBe('frozen');
    await api.patch(`/api/accounts/${frozen}`, { status: 'closed' });
    expect((await detail(api, svc.id)).balanceAccount.status).toBe('closed');
  });

  it('provider: an institution of the caller’s; a new or changed provider must be active (409 INSTITUTION_ARCHIVED), keeping an archived one is fine; referenced institutions cannot be deleted (I-4)', async () => {
    const { api } = await signIn();
    const active = await institution(api);
    const archived = await institution(api, { status: 'archived' });
    const before = await snapshot();
    let r = await api.post('/api/payment-channels', { name: 'Svc', channelType: 'payment_service', providerInstitutionId: archived });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: 'INSTITUTION_ARCHIVED', details: { institutionId: archived } });
    r = await api.post('/api/payment-channels', { name: 'Svc', channelType: 'payment_service', providerInstitutionId: 'x'.repeat(26) });
    expect(r.status).toBe(404);
    expect(await snapshot()).toEqual(before);
    const svc = await channel(api, { providerInstitutionId: active });
    r = await api.patch(`/api/payment-channels/${svc.id}`, { providerInstitutionId: archived });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('INSTITUTION_ARCHIVED');
    expect((await detail(api, svc.id)).providerInstitutionId).toBe(active);
    // The provider archived after the fact: the channel keeps it and stays editable.
    await api.patch(`/api/institutions/${active}`, { status: 'archived' });
    r = await api.patch(`/api/payment-channels/${svc.id}`, { providerInstitutionId: active, notes: 'still here' });
    expect(r.status).toBe(200);
    expect(r.json.provider).toMatchObject({ id: active, status: 'archived' });
    // Referenced: the institution can't be deleted; its detail lists the channel.
    const del = await api.del(`/api/institutions/${active}`);
    expect(del.status).toBe(409);
    expect(del.json.details.references.channels).toBe(1);
    expect((await api.get(`/api/institutions/${active}`)).json).toMatchObject({ channelCount: 1, channels: [{ id: svc.id, name: svc.name, channelType: 'payment_service', status: 'active' }] });
    // Clearing the provider releases it.
    expect((await api.patch(`/api/payment-channels/${svc.id}`, { providerInstitutionId: null })).json.provider).toBeNull();
    expect((await api.del(`/api/institutions/${active}`)).status).toBe(200);
  });

  it('list: default hides archived channels, status=all / archived show them; type and q filters (channel or provider name, literal % and _); sourceCount counts active sources; unknown parameters are 400', async () => {
    const { api } = await signIn();
    const wise = await institution(api, { name: 'Wise Europe' });
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const card2 = await createCard(api, inst);
    const balance = await createAccount(api, inst);
    const apple = await channel(api, { name: 'Apple Pay', channelType: 'device_wallet', sort: 1 });
    const paypal = await channel(api, { name: 'PayPal 100%', channelType: 'payment_service', balanceAccountId: balance, sort: 2 });
    const wiseSvc = await channel(api, { name: 'Jars', channelType: 'payment_service', providerInstitutionId: wise, sort: 3 });
    const old = await channel(api, { name: 'Old_wallet', channelType: 'other', sort: 4, status: 'archived' });
    await source(api, apple.id, { cardId: card });
    const ended = await source(api, apple.id, { cardId: card2 });
    await api.post(`/api/payment-channel-sources/${ended.id}/end`);
    const ids = async (qs = '') => (await api.get(`/api/payment-channels${qs}`)).json.map((c: any) => c.id);
    expect(await ids()).toEqual([apple.id, paypal.id, wiseSvc.id]);
    expect(await ids('?status=all')).toEqual([apple.id, paypal.id, wiseSvc.id, old.id]);
    expect(await ids('?status=archived')).toEqual([old.id]);
    expect(await ids('?type=payment_service')).toEqual([paypal.id, wiseSvc.id]);
    expect(await ids('?q=apple')).toEqual([apple.id]);
    expect(await ids('?q=WISE')).toEqual([wiseSvc.id]);
    expect(await ids('?q=%25')).toEqual([paypal.id]);
    expect(await ids('?q=_&status=all')).toEqual([old.id]);
    const list = (await api.get('/api/payment-channels')).json;
    expect(list.find((c: any) => c.id === apple.id).sourceCount).toBe(1);
    expect(list.find((c: any) => c.id === paypal.id)).toMatchObject({ sourceCount: 0, balanceAccount: { id: balance } });
    for (const qs of ['?type=bank_transfer', '?status=closed', '?balanceAccountId=x', '?q=' + 'x'.repeat(81)]) expect((await api.get(`/api/payment-channels${qs}`)).status, qs).toBe(400);
  });

  it('PATCH: partial update of every field; empty body and unknown or immutable fields are 400; archiving keeps every source', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const svc = await channel(api, { name: 'Svc' });
    const s = await source(api, svc.id, { cardId: card, isDefault: true });
    const old = await source(api, svc.id, { accountId: await createAccount(api, inst) });
    await api.post(`/api/payment-channel-sources/${old.id}/end`);
    e.t.advance(1000);
    const r = await api.patch(`/api/payment-channels/${svc.id}`, { name: 'Svc 2', region: 'GB', notes: 'n', sort: 7, providerInstitutionId: inst });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ name: 'Svc 2', region: 'GB', notes: 'n', sort: 7, providerInstitutionId: inst, updatedAt: e.t.clock.t });
    for (const b of [{}, { id: 'x' }, { userId: 'x' }, { createdAt: 1 }, { balance: 0 }, { region: 'gb' }, { region: 'UK' }, { name: '' }, { sort: 1.5 }, { status: 'closed' }]) {
      const bad = await api.patch(`/api/payment-channels/${svc.id}`, b);
      expect(bad.status, JSON.stringify(b)).toBe(400);
      expect(bad.json.code).toBe('VALIDATION');
    }
    const archived = await api.patch(`/api/payment-channels/${svc.id}`, { status: 'archived' });
    expect(archived.json.status).toBe('archived');
    // Archiving loses nothing: the active source (still the default) and the ended history.
    expect((await detail(api, svc.id)).sources).toEqual([
      expect.objectContaining({ id: s.id, status: 'active', isDefault: true }),
      expect.objectContaining({ id: old.id, status: 'ended', isDefault: false }),
    ]);
    // Archived channels stay manageable (only hidden from the default list).
    const card2 = await createCard(api, inst);
    expect((await source(api, svc.id, { cardId: card2 })).status).toBe('active');
    expect((await api.patch(`/api/payment-channels/${svc.id}`, { status: 'active' })).json.status).toBe('active');
  });

  // ================================================================== sources (P-3, P-4, P-5)

  it('P-3: Apple Pay (device_wallet) takes two cards; an account is 400 CHANNEL_SOURCE_KIND with nothing written. PayPal takes a card and an account', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const k1 = await createCard(api, inst);
    const k2 = await createCard(api, inst, { form: 'virtual' });
    const acc = await createAccount(api, inst, 'bank');
    const apple = await channel(api, { name: 'Apple Pay', channelType: 'device_wallet' });
    const s1 = await source(api, apple.id, { cardId: k1, isDefault: true, notes: '主卡' });
    expect(s1).toEqual({
      id: expect.any(String),
      channelId: apple.id,
      cardId: k1,
      accountId: null,
      card: { id: k1, name: expect.any(String), network: 'visa', last4: '4321', cardType: 'debit', status: 'active' },
      account: null,
      isDefault: true,
      status: 'active',
      notes: '主卡',
      createdAt: e.t.clock.t,
      updatedAt: e.t.clock.t,
    });
    await source(api, apple.id, { cardId: k2 });
    const before = await snapshot();
    const r = await api.post(`/api/payment-channels/${apple.id}/sources`, { accountId: acc });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('CHANNEL_SOURCE_KIND');
    expect(await snapshot()).toEqual(before);

    const paypal = await channel(api, { name: 'PayPal' });
    const viaCard = await source(api, paypal.id, { cardId: k1 });
    const viaAccount = await source(api, paypal.id, { accountId: acc });
    expect(viaAccount).toMatchObject({ cardId: null, accountId: acc, card: null, account: { id: acc, accountCountry: 'LU', status: 'active' } });
    expect((await detail(api, paypal.id)).sources.map((s: any) => s.id)).toEqual([viaCard.id, viaAccount.id]);
    // The other sides list the channels with an active source.
    expect((await api.get(`/api/cards/${k1}`)).json.channels.map((c: any) => c.id).sort()).toEqual([apple.id, paypal.id].sort());
    expect((await api.get(`/api/accounts/${acc}`)).json.sourceOfChannels).toEqual([{ id: paypal.id, name: 'PayPal', channelType: 'payment_service', status: 'active' }]);
    const other = await channel(api, { channelType: 'other' });
    expect((await source(api, other.id, { accountId: acc })).accountId).toBe(acc);
  });

  it('device wallet: an active account source refuses the type change (400 CHANNEL_SOURCE_KIND, counts by status); the channel, its sources and the audit log stay unchanged', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst, 'bank');
    const svc = await channel(api);
    await source(api, svc.id, { cardId: card, isDefault: true });
    const s = await source(api, svc.id, { accountId: acc });
    const before = await m2Snapshot();
    for (const b of [{ channelType: 'device_wallet' }, { channelType: 'device_wallet', name: 'renamed', notes: 'n', status: 'archived' }]) {
      const r = await api.patch(`/api/payment-channels/${svc.id}`, b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.json).toEqual({
        error: expect.stringMatching(/active account sources.*create a new device-wallet channel and archive this one/),
        code: 'CHANNEL_SOURCE_KIND',
        details: { accountSources: 1, activeAccountSources: 1, endedAccountSources: 0 },
      });
      // Nothing about deleting history is suggested.
      expect(r.json.error).not.toMatch(/delete/i);
    }
    // Nothing changed: the channel (name, notes, status, updated_at), its sources and the audit log.
    expect(await m2Snapshot()).toEqual(before);
    expect(await sourceRow(s.id)).toMatchObject({ status: 'active', account_id: acc });
    expect(await auditRows(user.id)).toEqual([]);
  });

  it('device wallet: ended account sources alone still refuse the change — the history is kept as recorded and never needs deleting; the advice is a new channel', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const svc = await channel(api, { name: 'Old service' });
    const sa = await source(api, svc.id, { accountId: await createAccount(api, inst, 'bank') });
    const sb = await source(api, svc.id, { accountId: await createAccount(api, inst) });
    await source(api, svc.id, { cardId: card, isDefault: true });
    for (const s of [sa, sb]) await api.post(`/api/payment-channel-sources/${s.id}/end`);
    const before = await m2Snapshot();
    const r = await api.patch(`/api/payment-channels/${svc.id}`, { channelType: 'device_wallet', notes: 'x' });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({
      error: expect.stringMatching(/ended account sources \(history, kept as recorded\).*create a new device-wallet channel and archive this one/),
      code: 'CHANNEL_SOURCE_KIND',
      details: { accountSources: 2, activeAccountSources: 0, endedAccountSources: 2 },
    });
    expect(r.json.error).not.toMatch(/delete/i);
    expect(await m2Snapshot()).toEqual(before);
    // The way forward needs no deletion: a new device wallet with the same card, and the old channel archived — history intact.
    const wallet = await channel(api, { name: 'New wallet', channelType: 'device_wallet' });
    await source(api, wallet.id, { cardId: card, isDefault: true });
    expect((await api.patch(`/api/payment-channels/${svc.id}`, { status: 'archived' })).status).toBe(200);
    expect((await detail(api, svc.id)).sources.map((s: any) => [s.id, s.status])).toEqual([
      [sa.id, 'ended'],
      [sb.id, 'ended'],
      [expect.any(String), 'active'],
    ]);
    expect(await auditRows(user.id)).toEqual([]);
  });

  it('device wallet: when every source is a card (active or ended), the type change is allowed; other changes are not affected by account sources', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const k1 = await createCard(api, inst);
    const k2 = await createCard(api, inst);
    const svc = await channel(api, { channelType: 'other' });
    await source(api, svc.id, { cardId: k1, isDefault: true });
    const ended = await source(api, svc.id, { cardId: k2 });
    await api.post(`/api/payment-channel-sources/${ended.id}/end`);
    let r = await api.patch(`/api/payment-channels/${svc.id}`, { channelType: 'device_wallet' });
    expect(r.status).toBe(200);
    expect(r.json.channelType).toBe('device_wallet');
    expect((await detail(api, svc.id)).sources.map((s: any) => [s.cardId, s.status, s.isDefault])).toEqual([
      [k1, 'active', true],
      [k2, 'ended', false],
    ]);
    // Back to a payment service, then other: account sources are compatible with both.
    const withAccount = await channel(api);
    await source(api, withAccount.id, { accountId: await createAccount(api, inst, 'bank') });
    for (const channelType of ['other', 'payment_service']) {
      r = await api.patch(`/api/payment-channels/${withAccount.id}`, { channelType });
      expect(r.status, channelType).toBe(200);
    }
    expect((await api.patch(`/api/payment-channels/${svc.id}`, { channelType: 'payment_service' })).json.channelType).toBe('payment_service');
  });

  it('P-4: a source is exactly one of a card and an account (API 400; the XOR CHECK refuses raw SQL)', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst);
    const svc = await channel(api);
    const before = await snapshot();
    for (const b of [{ cardId: card, accountId: acc }, {}, { isDefault: true }, { cardId: null }, { cardId: card, status: 'ended' }, { cardId: card, channelId: svc.id }]) {
      const r = await api.post(`/api/payment-channels/${svc.id}/sources`, b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.json.code).toBe('VALIDATION');
    }
    expect(await snapshot()).toEqual(before);
    const insert = (id: string, cardId: string | null, accountId: string | null) =>
      sqlError('INSERT INTO payment_channel_sources (id, user_id, channel_id, card_id, account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)', id, user.id, svc.id, cardId, accountId);
    expect(await insert('both', card, acc)).toMatch(/CHECK constraint failed/);
    expect(await insert('neither', null, null)).toMatch(/CHECK constraint failed/);
    expect(await insert('card-only', card, null)).toBe('no error');
  });

  it('P-5: a second active record of the same source is 409 DUPLICATE (existingId); after ending it, the source may be added again', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst);
    const svc = await channel(api);
    const sc = await source(api, svc.id, { cardId: card });
    const sa = await source(api, svc.id, { accountId: acc });
    for (const [b, existing] of [
      [{ cardId: card }, sc.id],
      [{ accountId: acc, isDefault: true }, sa.id],
    ] as const) {
      const before = await snapshot();
      const r = await api.post(`/api/payment-channels/${svc.id}/sources`, b);
      expect(r.status).toBe(409);
      expect(r.json).toMatchObject({ code: 'DUPLICATE', details: { existingId: existing } });
      expect(await snapshot()).toEqual(before);
    }
    await api.post(`/api/payment-channel-sources/${sc.id}/end`);
    const again = await source(api, svc.id, { cardId: card });
    // A new record: the ended one is not reactivated.
    expect(again.id).not.toBe(sc.id);
    expect(await sourceRow(sc.id)).toMatchObject({ status: 'ended', is_default: 0, card_id: card });
    expect((await detail(api, svc.id)).sources.map((s: any) => [s.id, s.status])).toEqual([
      [sc.id, 'ended'],
      [sa.id, 'active'],
      [again.id, 'active'],
    ]);
    // The same card on another channel is a different source.
    expect((await source(api, (await channel(api)).id, { cardId: card })).cardId).toBe(card);
  });

  it('P-5: one default per channel — a new default replaces the old one atomically (create and PATCH); isDefault false clears it; the database refuses a second', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const svc = await channel(api);
    const s1 = await source(api, svc.id, { cardId: await createCard(api, inst), isDefault: true });
    const s2 = await source(api, svc.id, { cardId: await createCard(api, inst), isDefault: true });
    expect(await defaults(svc.id)).toEqual([s2.id]);
    let r = await api.patch(`/api/payment-channel-sources/${s1.id}`, { isDefault: true, notes: 'back' });
    expect(r.json).toMatchObject({ isDefault: true, notes: 'back' });
    expect(await defaults(svc.id)).toEqual([s1.id]);
    // Already the default: fine, still one.
    expect((await api.patch(`/api/payment-channel-sources/${s1.id}`, { isDefault: true })).status).toBe(200);
    expect(await defaults(svc.id)).toEqual([s1.id]);
    // Defaults are per channel.
    const other = await channel(api);
    const s3 = await source(api, other.id, { accountId: await createAccount(api, inst), isDefault: true });
    expect(await defaults(svc.id)).toEqual([s1.id]);
    expect(await defaults(other.id)).toEqual([s3.id]);
    r = await api.patch(`/api/payment-channel-sources/${s1.id}`, { isDefault: false });
    expect(r.json.isDefault).toBe(false);
    expect(await defaults(svc.id)).toEqual([]);
    // Clearing the default keeps the source itself (active, same record).
    expect(await sourceRow(s1.id)).toMatchObject({ status: 'active', is_default: 0 });
    expect((await detail(api, svc.id)).sources.map((s: any) => s.id)).toEqual([s1.id, s2.id]);
    await api.patch(`/api/payment-channel-sources/${s2.id}`, { isDefault: true });
    expect(
      await sqlError(
        'INSERT INTO payment_channel_sources (id, user_id, channel_id, card_id, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, 1)',
        `raw-${engine}`,
        user.id,
        svc.id,
        await createCard(api, inst),
      ),
    ).toMatch(/UNIQUE constraint failed/);
    for (const b of [{}, { status: 'ended' }, { cardId: 'x' }, { isDefault: 'yes' }]) expect((await api.patch(`/api/payment-channel-sources/${s1.id}`, b)).status, JSON.stringify(b)).toBe(400);
  });

  it('P-5: ending keeps the record as history and clears the default; ended is final — making it the default or ending it again is 409 LINK_STATE, notes may still change; the database ties the default to active', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const svc = await channel(api);
    const s = await source(api, svc.id, { cardId: card, isDefault: true });
    e.t.advance(5000);
    const r = await api.post(`/api/payment-channel-sources/${s.id}/end`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: s.id, status: 'ended', isDefault: false, updatedAt: e.t.clock.t });
    expect(await defaults(svc.id)).toEqual([]);
    const before = await snapshot();
    for (const [method, path, b] of [
      ['POST', `/api/payment-channel-sources/${s.id}/end`, {}],
      ['PATCH', `/api/payment-channel-sources/${s.id}`, { isDefault: true }],
      ['PATCH', `/api/payment-channel-sources/${s.id}`, { isDefault: true, notes: 'lost' }],
    ] as const) {
      const x = await api.req(method, path, b);
      expect(x.status, `${method} ${JSON.stringify(b)}`).toBe(409);
      expect(x.json).toMatchObject({ code: 'LINK_STATE', details: { status: 'ended' } });
    }
    expect(await snapshot()).toEqual(before);
    expect((await api.patch(`/api/payment-channel-sources/${s.id}`, { notes: '已停用' })).json).toMatchObject({ status: 'ended', notes: '已停用' });
    expect((await api.patch(`/api/payment-channel-sources/${s.id}`, { isDefault: false })).json.status).toBe('ended');
    // History: the card side counts it as ended, no longer lists the channel as active.
    expect((await api.get(`/api/cards/${card}`)).json).toMatchObject({ channels: [], channelSourceCounts: { active: 0, ended: 1 } });
    expect((await detail(api, svc.id)).sources).toEqual([expect.objectContaining({ id: s.id, status: 'ended', isDefault: false })]);
    expect(await sqlError('UPDATE payment_channel_sources SET is_default = 1 WHERE id = ?', s.id)).toMatch(/CHECK constraint failed/);
    expect(await sqlError("UPDATE payment_channel_sources SET status = 'paused' WHERE id = ?", s.id)).toMatch(/CHECK constraint failed/);
    // Ending is not audited (API_SPEC §3.7 lists channel.delete only).
    expect(await auditRows(user.id)).toEqual([]);
    for (const b of [{ endedOn: '2026-01-01' }, { force: true }]) expect((await api.post(`/api/payment-channel-sources/${s.id}/end`, b)).json.code).toBe('VALIDATION');
  });

  it('sources may record frozen or closed cards and accounts (history); their status shows on the source', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst, { status: 'closed' });
    const acc = await createAccount(api, inst, 'bank', { status: 'frozen' });
    const svc = await channel(api);
    expect((await source(api, svc.id, { cardId: card, isDefault: true })).card.status).toBe('closed');
    expect((await source(api, svc.id, { accountId: acc })).account.status).toBe('frozen');
    // Freezing a card changes no source.
    const k = await createCard(api, inst);
    const s = await source(api, svc.id, { cardId: k, isDefault: true });
    const a = await createAccount(api, inst, 'bank');
    const history = await source(api, svc.id, { accountId: a });
    await api.post(`/api/payment-channel-sources/${history.id}/end`);
    const live = await source(api, svc.id, { accountId: await createAccount(api, inst, 'bank') });
    // Freezing / closing cards and accounts (and reopening them) changes no source, active or ended.
    const before = await e.all('SELECT id, status, is_default, notes FROM payment_channel_sources WHERE channel_id = ? ORDER BY id', svc.id);
    await api.patch(`/api/cards/${k}`, { status: 'frozen' });
    await api.patch(`/api/cards/${k}`, { status: 'closed' });
    await api.patch(`/api/accounts/${a}`, { status: 'closed' });
    await api.patch(`/api/accounts/${live.accountId}`, { status: 'frozen' });
    await api.patch(`/api/cards/${k}`, { status: 'active' });
    expect(await e.all('SELECT id, status, is_default, notes FROM payment_channel_sources WHERE channel_id = ? ORDER BY id', svc.id)).toEqual(before);
    expect(await sourceRow(s.id)).toMatchObject({ status: 'active', is_default: 1 });
    expect(await sourceRow(history.id)).toMatchObject({ status: 'ended', is_default: 0 });
    expect((await detail(api, svc.id)).sources.find((x: any) => x.id === history.id).account.status).toBe('closed');
  });

  // ================================================================== delete (P-6)

  it('P-6: DELETE source removes only the record — card and account stay; any status; a second DELETE is 404; nothing is audited', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst);
    const svc = await channel(api);
    const sc = await source(api, svc.id, { cardId: card, isDefault: true });
    const sa = await source(api, svc.id, { accountId: acc });
    await api.post(`/api/payment-channel-sources/${sa.id}/end`);
    for (const id of [sc.id, sa.id]) {
      expect((await api.del(`/api/payment-channel-sources/${id}`)).json).toEqual({ ok: true });
      expect((await api.del(`/api/payment-channel-sources/${id}`)).status).toBe(404);
    }
    expect((await detail(api, svc.id)).sources).toEqual([]);
    expect((await api.get(`/api/cards/${card}`)).status).toBe(200);
    expect((await api.get(`/api/accounts/${acc}`)).status).toBe(200);
    expect(await auditRows(user.id)).toEqual([]);
  });

  it('P-6: deleting a card or an account removes its sources (the channels stay); deleting a channel removes its sources (cards, accounts and the balance account stay) and is audited as channel.delete { id }', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst, 'bank');
    const balance = await createAccount(api, inst);
    const keepCard = await createCard(api, inst);
    const svc = await channel(api, { name: 'Secret Svc', notes: 'secret-note', balanceAccountId: balance });
    const sCard = await source(api, svc.id, { cardId: card, isDefault: true });
    const sAcc = await source(api, svc.id, { accountId: acc });
    const sKeep = await source(api, svc.id, { cardId: keepCard });
    expect((await api.get(`/api/cards/${card}`)).json.channelSourceCounts).toEqual({ active: 1, ended: 0 });
    expect((await api.del(`/api/cards/${card}`)).status).toBe(200);
    expect(await sourceRow(sCard.id)).toBeUndefined();
    expect((await api.del(`/api/accounts/${acc}`)).status).toBe(200);
    expect(await sourceRow(sAcc.id)).toBeUndefined();
    expect((await detail(api, svc.id)).sources.map((s: any) => s.id)).toEqual([sKeep.id]);

    await api.post(`/api/payment-channel-sources/${sKeep.id}/end`);
    await source(api, svc.id, { cardId: keepCard });
    const r = await api.del(`/api/payment-channels/${svc.id}`);
    expect(r.json).toEqual({ ok: true });
    expect(await e.all('SELECT id FROM payment_channel_sources WHERE channel_id = ?', svc.id)).toEqual([]);
    expect((await api.get(`/api/payment-channels/${svc.id}`)).status).toBe(404);
    expect((await api.get(`/api/cards/${keepCard}`)).json).toMatchObject({ channels: [], channelSourceCounts: { active: 0, ended: 0 } });
    expect((await api.get(`/api/accounts/${balance}`)).json.balanceOfChannels).toEqual([]);
    expect((await api.del(`/api/payment-channels/${svc.id}`)).status).toBe(404);
    const audits = await auditRows(user.id);
    expect(audits).toEqual([{ action: 'channel.delete', detail: { id: svc.id } }]);
    const raw = JSON.stringify(await e.all("SELECT * FROM audit_log WHERE action = 'channel.delete'"));
    for (const secret of ['Secret Svc', 'secret-note', balance, keepCard]) expect(raw).not.toContain(secret);
    expect(await e.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  // ================================================================== sensitive data (X-1, X-4)

  it('X-1 / X-4: card numbers or security codes in channel names / notes and source notes are 400 SENSITIVE_DATA (no text echoed, nothing written); unknown fields and bypass flags are 400', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const svc = await channel(api);
    const s = await source(api, svc.id, { cardId: card });
    const before = await snapshot();
    const attempts: [string, string, unknown][] = [
      ['POST', '/api/payment-channels', { name: `Pay ${CARD_NUMBER}`, channelType: 'other' }],
      ['POST', '/api/payment-channels', { name: 'Pay', channelType: 'other', notes: 'cvv 123' }],
      ['PATCH', `/api/payment-channels/${svc.id}`, { notes: '4111-1111-1111-1111' }],
      ['PATCH', `/api/payment-channels/${svc.id}`, { name: 'PIN=0000' }],
      ['POST', `/api/payment-channels/${svc.id}/sources`, { accountId: await createAccount(api, inst), notes: '安全码 123' }],
      ['PATCH', `/api/payment-channel-sources/${s.id}`, { notes: '4111111111111111' }],
    ];
    const afterAccount = await snapshot();
    for (const [method, path, b] of attempts) {
      const r = await api.req(method, path, b);
      expect(r.status, `${method} ${path}`).toBe(400);
      expect(r.json.code).toBe('SENSITIVE_DATA');
      expect(JSON.stringify(r.json)).not.toMatch(/4111|cvv 123|0000|安全码/);
    }
    expect(await snapshot()).toEqual(afterAccount);
    expect(before.payment_channels).toEqual(afterAccount.payment_channels);
    // A non-Luhn 16-digit reference is fine (X-2).
    expect((await api.patch(`/api/payment-channels/${svc.id}`, { notes: 'ref 1234 5678 9012 3456' })).status).toBe(200);
    for (const [method, path, b] of [
      ['POST', '/api/payment-channels', { name: 'P', channelType: 'other', force: true }],
      ['POST', '/api/payment-channels', { name: 'P', channelType: 'other', balance: 100 }],
      ['PATCH', `/api/payment-channels/${svc.id}`, { allowSensitive: true, notes: 'x' }],
      ['POST', `/api/payment-channels/${svc.id}/sources`, { cardId: card, pan: CARD_NUMBER }],
      ['PATCH', `/api/payment-channel-sources/${s.id}`, { notes: 'x', force: true }],
    ] as const) {
      const r = await api.req(method, path, b);
      expect(r.status, `${method} ${path}`).toBe(400);
      expect(r.json.code).toBe('VALIDATION');
    }
    // DTOs carry no amount or balance.
    const text = JSON.stringify([await detail(api, svc.id), (await api.get('/api/payment-channels')).json]);
    expect(text).not.toMatch(/"(balance|amount|amounts|rate|fx)"\s*:/i);
  });

  // ================================================================== isolation (U-1, U-2, U-3, U-4)

  it("U-1 / U-3: another user's channels and sources are 404 on every route — nothing changes and nothing leaks; lists and counts are the caller's own", async () => {
    const owner = await signIn('owner');
    const inst = await institution(owner.api, { name: 'Owner Secret Provider' });
    const card = await createCard(owner.api, inst, { name: 'Owner Secret Card' });
    const acc = await createAccount(owner.api, inst, 'e_money', { name: 'Owner Secret Account' });
    const svc = await channel(owner.api, { name: 'Owner Secret Channel', notes: 'owner-private-note', providerInstitutionId: inst, balanceAccountId: acc });
    const s = await source(owner.api, svc.id, { cardId: card, isDefault: true, notes: 'owner-source-note' });
    const wallet = await channel(owner.api, { name: 'Owner Secret Wallet', channelType: 'device_wallet' });
    const intruder = await signIn('intruder');
    const iInst = await institution(intruder.api);
    const iCard = await createCard(intruder.api, iInst);
    const iAcc = await createAccount(intruder.api, iInst);
    const before = await m2Snapshot();
    // Adding a source to another user's channel looks exactly like a channel that does not exist —
    // the same status and body whatever the source (the intruder's own card or account, the owner's
    // card that is already a source there, a default) and whatever the channel type.
    const missing = 'x'.repeat(26);
    for (const target of [svc.id, wallet.id]) {
      for (const b of [{ cardId: iCard }, { accountId: iAcc }, { cardId: card }, { cardId: card, isDefault: true }, { accountId: acc }]) {
        const foreign = await intruder.api.post(`/api/payment-channels/${target}/sources`, b);
        const none = await intruder.api.post(`/api/payment-channels/${missing}/sources`, b);
        expect({ status: foreign.status, json: foreign.json }, JSON.stringify(b)).toEqual({ status: none.status, json: none.json });
        expect(foreign.json).toEqual({ error: 'payment channel not found', code: 'NOT_FOUND' });
      }
    }
    expect(await m2Snapshot()).toEqual(before);
    const attempts: [string, string, unknown?][] = [
      ['GET', `/api/payment-channels/${svc.id}`],
      ['PATCH', `/api/payment-channels/${svc.id}`, { notes: 'x' }],
      ['PATCH', `/api/payment-channels/${svc.id}`, { status: 'archived' }],
      ['DELETE', `/api/payment-channels/${svc.id}`],
      ['POST', `/api/payment-channels/${svc.id}/sources`, { cardId: iCard }],
      ['POST', `/api/payment-channels/${svc.id}/sources`, { cardId: card }],
      ['PATCH', `/api/payment-channel-sources/${s.id}`, { notes: 'x' }],
      ['PATCH', `/api/payment-channel-sources/${s.id}`, { isDefault: false }],
      ['PATCH', `/api/payment-channel-sources/${s.id}`, { isDefault: true }],
      ['POST', `/api/payment-channel-sources/${s.id}/end`, {}],
      ['DELETE', `/api/payment-channel-sources/${s.id}`],
    ];
    for (const [method, path, b] of attempts) {
      const r = await intruder.api.req(method, path, b);
      expect(r.status, `${method} ${path} ${JSON.stringify(b)}`).toBe(404);
      expect(r.json.code).toBe('NOT_FOUND');
      const text = JSON.stringify(r.json);
      for (const secret of ['Owner Secret', 'owner-private-note', 'owner-source-note', svc.id, s.id, card, acc, inst]) expect(text).not.toContain(secret);
    }
    expect(await m2Snapshot()).toEqual(before);
    const lists = JSON.stringify([
      (await intruder.api.get('/api/payment-channels?status=all')).json,
      (await intruder.api.get('/api/payment-channels?q=owner&status=all')).json,
      (await intruder.api.get(`/api/cards/${iCard}`)).json,
      (await intruder.api.get('/api/institutions?status=all')).json,
    ]);
    for (const secret of ['Owner Secret', svc.id, s.id]) expect(lists).not.toContain(secret);
    expect((await intruder.api.get('/api/payment-channels?status=all')).json).toEqual([]);
    // The owner's data is intact.
    expect((await detail(owner.api, svc.id)).sources).toEqual([expect.objectContaining({ id: s.id, isDefault: true, notes: 'owner-source-note' })]);
  });

  it("U-2: references to another user's card, account (as source or balance account) or institution are 404 — even when that account is the other user's balance account, never a 409", async () => {
    const owner = await signIn('owner');
    const oInst = await institution(owner.api);
    const oCard = await createCard(owner.api, oInst);
    const oUsed = await createAccount(owner.api, oInst);
    const oFree = await createAccount(owner.api, oInst);
    const oSvc = await channel(owner.api, { name: 'PayPal', balanceAccountId: oUsed });
    await source(owner.api, oSvc.id, { cardId: oCard });
    await source(owner.api, oSvc.id, { accountId: oFree });
    const intruder = await signIn('intruder');
    const iInst = await institution(intruder.api);
    const iAcc = await createAccount(intruder.api, iInst);
    const iSvc = await channel(intruder.api, { name: 'Mine' });
    const before = await m2Snapshot();
    const attempts: [string, string, unknown][] = [
      // The owner's balance account — in use by the owner's channel (the unique index would fire first) or free — and the owner's institution.
      ['POST', '/api/payment-channels', { name: 'X1', channelType: 'payment_service', balanceAccountId: oUsed }],
      ['POST', '/api/payment-channels', { name: 'X2', channelType: 'payment_service', balanceAccountId: oFree }],
      ['POST', '/api/payment-channels', { name: 'PayPal', channelType: 'payment_service', balanceAccountId: oUsed }],
      ['POST', '/api/payment-channels', { name: 'X3', channelType: 'payment_service', providerInstitutionId: oInst }],
      ['POST', '/api/payment-channels', { name: 'X4', channelType: 'payment_service', providerInstitutionId: oInst, balanceAccountId: iAcc }],
      ['PATCH', `/api/payment-channels/${iSvc.id}`, { balanceAccountId: oUsed }],
      ['PATCH', `/api/payment-channels/${iSvc.id}`, { balanceAccountId: oFree }],
      ['PATCH', `/api/payment-channels/${iSvc.id}`, { providerInstitutionId: oInst }],
      // Sources: the owner's card or account (both already sources of the owner's channel).
      ['POST', `/api/payment-channels/${iSvc.id}/sources`, { cardId: oCard }],
      ['POST', `/api/payment-channels/${iSvc.id}/sources`, { accountId: oFree }],
      ['POST', `/api/payment-channels/${iSvc.id}/sources`, { accountId: oUsed, isDefault: true }],
    ];
    for (const [method, path, b] of attempts) {
      const r = await intruder.api.req(method, path, b);
      expect(r.status, `${method} ${path} ${JSON.stringify(b)}`).toBe(404);
      expect(r.json.code).toBe('NOT_FOUND');
      const text = JSON.stringify(r.json);
      for (const secret of [oSvc.id, oUsed, oFree, oCard, oInst, 'PayPal']) expect(text).not.toContain(secret);
    }
    expect(await m2Snapshot()).toEqual(before);
    // And the intruder's own account works as a balance account.
    expect((await intruder.api.patch(`/api/payment-channels/${iSvc.id}`, { balanceAccountId: iAcc })).status).toBe(200);
  });

  it('U-4: the database refuses cross-user channels and sources (every composite foreign key) even when the API is bypassed', async () => {
    const a = await signIn('a');
    const b = await signIn('b');
    const aInst = await institution(a.api);
    const aCard = await createCard(a.api, aInst);
    const aAcc = await createAccount(a.api, aInst);
    const aSvc = await channel(a.api);
    const bInst = await institution(b.api);
    const bCard = await createCard(b.api, bInst);
    const bAcc = await createAccount(b.api, bInst);
    const bSvc = await channel(b.api);
    const channelInsert = (id: string, provider: string | null, balance: string | null) =>
      sqlError(
        "INSERT INTO payment_channels (id, user_id, name, name_key, channel_type, provider_institution_id, balance_account_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'payment_service', ?, ?, 1, 1)",
        id,
        b.user.id,
        id,
        id,
        provider,
        balance,
      );
    const sourceInsert = (id: string, channelId: string, cardId: string | null, accountId: string | null) =>
      sqlError('INSERT INTO payment_channel_sources (id, user_id, channel_id, card_id, account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)', id, b.user.id, channelId, cardId, accountId);
    expect(await channelInsert(`xp-${engine}`, aInst, null)).toMatch(/FOREIGN KEY constraint failed/);
    expect(await channelInsert(`xb-${engine}`, null, aAcc)).toMatch(/FOREIGN KEY constraint failed/);
    expect(await sourceInsert(`xc-${engine}`, aSvc.id, bCard, null)).toMatch(/FOREIGN KEY constraint failed/);
    expect(await sourceInsert(`xk-${engine}`, bSvc.id, aCard, null)).toMatch(/FOREIGN KEY constraint failed/);
    expect(await sourceInsert(`xa-${engine}`, bSvc.id, null, aAcc)).toMatch(/FOREIGN KEY constraint failed/);
    // Same user: accepted (the checks above are not false positives).
    expect(await channelInsert(`ok-${engine}`, bInst, bAcc)).toBe('no error');
    expect(await sourceInsert(`oks-${engine}`, bSvc.id, null, bAcc)).toBe('no error');
  });

  it.skipIf(engine === 'd1')('the channel detail stays the caller’s even with cross-user source rows forced in past the foreign keys (libsql: foreign_keys OFF; D1 cannot turn them off)', async () => {
    const a = await signIn('a');
    const b = await signIn('b');
    const aInst = await institution(a.api);
    const aSvc = await channel(a.api);
    const own = await source(a.api, aSvc.id, { cardId: await createCard(a.api, aInst) });
    const bInst = await institution(b.api);
    const bCard = await createCard(b.api, bInst, { name: 'B Secret Card' });
    const bAcc = await createAccount(b.api, bInst, 'e_money', { name: 'B Secret Account' });
    const bCard2 = await createCard(b.api, bInst, { name: 'B Secret Card 2' });
    const baseline = await detail(a.api, aSvc.id);
    try {
      await e.exec('PRAGMA foreign_keys = OFF');
      try {
        // Owned by A on A's channel but pointing at B's card / account; owned by B on A's channel.
        await e.exec("INSERT INTO payment_channel_sources (id, user_id, channel_id, card_id, created_at, updated_at) VALUES ('forced-a-card', ?, ?, ?, 9, 9)", a.user.id, aSvc.id, bCard);
        await e.exec("INSERT INTO payment_channel_sources (id, user_id, channel_id, account_id, created_at, updated_at) VALUES ('forced-a-acc', ?, ?, ?, 9, 9)", a.user.id, aSvc.id, bAcc);
        await e.exec("INSERT INTO payment_channel_sources (id, user_id, channel_id, card_id, created_at, updated_at) VALUES ('forced-b', ?, ?, ?, 9, 9)", b.user.id, aSvc.id, bCard2);
      } finally {
        await e.exec('PRAGMA foreign_keys = ON');
      }
      const d = await detail(a.api, aSvc.id);
      expect(d).toEqual(baseline);
      expect(d.sources.map((s: any) => s.id)).toEqual([own.id]);
      for (const secret of [bCard, bCard2, bAcc, 'B Secret', 'forced-']) expect(JSON.stringify(d)).not.toContain(secret);
      expect((await b.api.get(`/api/payment-channels/${aSvc.id}`)).status).toBe(404);
    } finally {
      await e.exec("DELETE FROM payment_channel_sources WHERE id IN ('forced-a-card', 'forced-a-acc', 'forced-b')");
    }
    expect(await e.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  // ================================================================== atomicity

  it('source create with isDefault: a failing insert or a failing new-default update leaves nothing — the old default stays; the retry writes once', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const svc = await channel(api);
    const old = await source(api, svc.id, { cardId: await createCard(api, inst), isDefault: true });
    const card = await createCard(api, inst);
    for (const [event, when] of [
      ['INSERT', null],
      // The new default is set after the old one was cleared: failing there must restore the old.
      ['UPDATE', 'NEW.is_default = 1'],
    ] as const) {
      const before = await snapshot();
      const r = await failing(event, 'payment_channel_sources', when, () => api.post(`/api/payment-channels/${svc.id}/sources`, { cardId: card, isDefault: true }));
      expect(r.status, event).toBe(500);
      expect(await snapshot(), event).toEqual(before);
      expect(await defaults(svc.id)).toEqual([old.id]);
    }
    const ok = await source(api, svc.id, { cardId: card, isDefault: true });
    expect(await defaults(svc.id)).toEqual([ok.id]);
    expect((await detail(api, svc.id)).sources).toHaveLength(2);
  });

  it('PATCH isDefault: the switch is one transaction — when setting the new default fails, the old one is still the default (and the notes are not saved)', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const svc = await channel(api);
    const a = await source(api, svc.id, { cardId: await createCard(api, inst), isDefault: true });
    const b = await source(api, svc.id, { cardId: await createCard(api, inst) });
    const before = await snapshot();
    const r = await failing('UPDATE', 'payment_channel_sources', `NEW.id = '${b.id}'`, () => api.patch(`/api/payment-channel-sources/${b.id}`, { isDefault: true, notes: 'x' }));
    expect(r.status).toBe(500);
    expect(await snapshot()).toEqual(before);
    expect(await defaults(svc.id)).toEqual([a.id]);
  });

  it('channel delete: a failing audit insert keeps the channel and its sources; a failing delete leaves no audit record', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const svc = await channel(api);
    await source(api, svc.id, { cardId: await createCard(api, inst), isDefault: true });
    for (const [event, table, when] of [
      ['INSERT', 'audit_log', "NEW.action = 'channel.delete'"],
      ['DELETE', 'payment_channels', null],
      // The cascade itself failing (the sources) rolls back the channel and the audit too.
      ['DELETE', 'payment_channel_sources', null],
    ] as const) {
      const before = await snapshot();
      expect((await failing(event, table, when, () => api.del(`/api/payment-channels/${svc.id}`))).status, `${event} ${table}`).toBe(500);
      expect(await snapshot(), `${event} ${table}`).toEqual(before);
    }
    expect(await auditRows(user.id)).toEqual([]);
    expect((await api.del(`/api/payment-channels/${svc.id}`)).status).toBe(200);
    expect(await auditRows(user.id)).toEqual([{ action: 'channel.delete', detail: { id: svc.id } }]);
  });

  it('end / PATCH / delete of a source: a failing write changes nothing', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const svc = await channel(api);
    const s = await source(api, svc.id, { cardId: await createCard(api, inst), isDefault: true });
    for (const [event, call] of [
      ['UPDATE', () => api.post(`/api/payment-channel-sources/${s.id}/end`)],
      ['UPDATE', () => api.patch(`/api/payment-channel-sources/${s.id}`, { isDefault: false, notes: 'x' })],
      ['DELETE', () => api.del(`/api/payment-channel-sources/${s.id}`)],
    ] as const) {
      const before = await snapshot();
      expect((await failing(event, 'payment_channel_sources', null, call)).status, event).toBe(500);
      expect(await snapshot(), event).toEqual(before);
    }
    expect(await sourceRow(s.id)).toMatchObject({ status: 'active', is_default: 1 });
  });

  // ================================================================== concurrency

  it('concurrent default switches and default creates on one channel: always exactly one default, and it is one of them', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const svc = await channel(api);
    const sources = [];
    for (let i = 0; i < 4; i++) sources.push(await source(api, svc.id, { cardId: await createCard(api, inst) }));
    for (let round = 0; round < 3; round++) {
      const results = await Promise.all(sources.map((s) => api.patch(`/api/payment-channel-sources/${s.id}`, { isDefault: true })));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      const d = await defaults(svc.id);
      expect(d).toHaveLength(1);
      expect(sources.map((s) => s.id)).toContain(d[0]);
    }
    const cardsForCreate = [await createCard(api, inst), await createCard(api, inst), await createCard(api, inst)];
    const created = await Promise.all(cardsForCreate.map((cardId) => api.post(`/api/payment-channels/${svc.id}/sources`, { cardId, isDefault: true })));
    expect(created.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(await defaults(svc.id)).toHaveLength(1);
  });

  it('ended or deleted between the read and the switch: 409 LINK_STATE / 404, and the old default is NOT cleared', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const svc = await channel(api);
    const old = await source(api, svc.id, { cardId: await createCard(api, inst), isDefault: true });
    const b = await source(api, svc.id, { cardId: await createCard(api, inst) });
    let spy = beforeNextBatch(() => e.exec("UPDATE payment_channel_sources SET status = 'ended' WHERE id = ?", b.id));
    let r = await api.patch(`/api/payment-channel-sources/${b.id}`, { isDefault: true });
    spy.mockRestore();
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: 'LINK_STATE', details: { status: 'ended' } });
    expect(await defaults(svc.id)).toEqual([old.id]);
    const c2 = await source(api, svc.id, { cardId: await createCard(api, inst) });
    spy = beforeNextBatch(() => e.exec('DELETE FROM payment_channel_sources WHERE id = ?', c2.id));
    r = await api.patch(`/api/payment-channel-sources/${c2.id}`, { isDefault: true });
    spy.mockRestore();
    expect(r.status).toBe(404);
    expect(await defaults(svc.id)).toEqual([old.id]);
    // The channel deleted in between: the source went with it.
    const doomed = await channel(api);
    const d = await source(api, doomed.id, { cardId: await createCard(api, inst) });
    spy = beforeNextBatch(() => e.exec('DELETE FROM payment_channels WHERE id = ?', doomed.id));
    expect((await api.patch(`/api/payment-channel-sources/${d.id}`, { isDefault: true })).status).toBe(404);
    spy.mockRestore();
  });

  it('source create racing other writes: the card, account or channel deleted, the channel made a device wallet, or a twin added after the route started — the right error, nothing written; an archive in between does not block', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const svc = await channel(api);
    const old = await source(api, svc.id, { cardId: await createCard(api, inst), isDefault: true });

    const expectRefused = async (sql: () => Promise<unknown>, b: Record<string, unknown>, status: number, code: string, channelId = svc.id) => {
      const spy = beforeNextBatch(sql);
      const before = await m2Snapshot();
      const r = await api.post(`/api/payment-channels/${channelId}/sources`, b);
      spy.mockRestore();
      expect(r.status, JSON.stringify(b)).toBe(status);
      expect(r.json.code).toBe(code);
      const after = await m2Snapshot();
      // (the concurrent write is the only difference)
      expect(after.audit_log).toEqual(before.audit_log);
      expect(await defaults(svc.id)).toEqual([old.id]);
      expect(await e.all('PRAGMA foreign_key_check')).toEqual([]);
      return r;
    };
    const card = await createCard(api, inst);
    await expectRefused(() => e.exec('DELETE FROM cards WHERE id = ?', card), { cardId: card, isDefault: true }, 404, 'NOT_FOUND');
    const acc = await createAccount(api, inst);
    await expectRefused(() => e.exec('DELETE FROM accounts WHERE id = ?', acc), { accountId: acc, isDefault: true }, 404, 'NOT_FOUND');
    const acc2 = await createAccount(api, inst);
    await expectRefused(() => e.exec("UPDATE payment_channels SET channel_type = 'device_wallet' WHERE id = ?", svc.id), { accountId: acc2, isDefault: true }, 400, 'CHANNEL_SOURCE_KIND');
    await e.exec("UPDATE payment_channels SET channel_type = 'payment_service' WHERE id = ?", svc.id);
    const twinCard = await createCard(api, inst);
    const r = await expectRefused(
      () => e.exec("INSERT INTO payment_channel_sources (id, user_id, channel_id, card_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)", `twin-${engine}`, user.id, svc.id, twinCard),
      { cardId: twinCard, isDefault: true },
      409,
      'DUPLICATE',
    );
    expect(r.json.details.existingId).toBe(`twin-${engine}`);
    const doomed = await channel(api);
    await expectRefused(() => e.exec('DELETE FROM payment_channels WHERE id = ?', doomed.id), { cardId: await createCard(api, inst) }, 404, 'NOT_FOUND', doomed.id);

    // Archived in between: archiving changes no source and blocks none.
    const k = await createCard(api, inst);
    const spy = beforeNextBatch(() => e.exec("UPDATE payment_channels SET status = 'archived' WHERE id = ?", svc.id));
    const ok = await api.post(`/api/payment-channels/${svc.id}/sources`, { cardId: k });
    spy.mockRestore();
    expect(ok.status).toBe(201);
    expect((await detail(api, svc.id)).status).toBe('archived');
  });

  it('channel writes racing other writes: the balance account deleted / retyped / taken, the provider archived or deleted, the channel deleted, account sources added, a balance account set — the right error, the channel unchanged', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const svc = await channel(api, { name: 'Racer' });
    const unchanged = async () => expect((await e.all('SELECT name, channel_type, balance_account_id, provider_institution_id, updated_at FROM payment_channels WHERE id = ?', svc.id))[0]).toEqual(
      expect.objectContaining({ name: 'Racer', channel_type: 'payment_service', balance_account_id: null, provider_institution_id: null }),
    );
    const race = async (sql: () => Promise<unknown>, call: () => ReturnType<Api['req']>, status: number, code: string) => {
      const spy = beforeNextBatch(sql);
      const r = await call();
      spy.mockRestore();
      expect(r.status, code).toBe(status);
      expect(r.json.code).toBe(code);
      return r;
    };
    const gone = await createAccount(api, inst);
    await race(() => e.exec('DELETE FROM accounts WHERE id = ?', gone), () => api.req('PATCH', `/api/payment-channels/${svc.id}`, { balanceAccountId: gone, name: 'X' }), 404, 'NOT_FOUND');
    await unchanged();
    const retyped = await createAccount(api, inst);
    await race(() => e.exec("UPDATE accounts SET account_type = 'bank' WHERE id = ?", retyped), () => api.req('PATCH', `/api/payment-channels/${svc.id}`, { balanceAccountId: retyped }), 400, 'BALANCE_ACCOUNT_KIND');
    await unchanged();
    const taken = await createAccount(api, inst);
    const other = await channel(api);
    const r = await race(() => e.exec('UPDATE payment_channels SET balance_account_id = ? WHERE id = ?', taken, other.id), () => api.req('PATCH', `/api/payment-channels/${svc.id}`, { balanceAccountId: taken }), 409, 'DUPLICATE');
    expect(r.json.details.existingId).toBe(other.id);
    await unchanged();
    const prov = await institution(api);
    await race(() => e.exec("UPDATE institutions SET status = 'archived' WHERE id = ?", prov), () => api.req('PATCH', `/api/payment-channels/${svc.id}`, { providerInstitutionId: prov }), 409, 'INSTITUTION_ARCHIVED');
    await unchanged();
    const prov2 = await institution(api);
    await race(() => e.exec('DELETE FROM institutions WHERE id = ?', prov2), () => api.req('PATCH', `/api/payment-channels/${svc.id}`, { providerInstitutionId: prov2 }), 404, 'NOT_FOUND');
    await unchanged();
    // Account source added after the type check: the UPDATE's own NOT EXISTS refuses the device wallet.
    const acc = await createAccount(api, inst, 'bank');
    await race(
      () => e.exec('INSERT INTO payment_channel_sources (id, user_id, channel_id, account_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)', `race-src-${engine}`, user.id, svc.id, acc),
      () => api.req('PATCH', `/api/payment-channels/${svc.id}`, { channelType: 'device_wallet' }),
      400,
      'CHANNEL_SOURCE_KIND',
    );
    await unchanged();
    // A balance account set after the read: the CHECK refuses the type change.
    const bal = await createAccount(api, inst);
    await race(() => e.exec('UPDATE payment_channels SET balance_account_id = ? WHERE id = ?', bal, svc.id), () => api.req('PATCH', `/api/payment-channels/${svc.id}`, { channelType: 'other' }), 400, 'BALANCE_ACCOUNT_KIND');
    expect((await detail(api, svc.id)).channelType).toBe('payment_service');
    await e.exec('UPDATE payment_channels SET balance_account_id = NULL WHERE id = ?', svc.id);
    // Deleted after the read.
    await race(() => e.exec('DELETE FROM payment_channels WHERE id = ?', svc.id), () => api.req('PATCH', `/api/payment-channels/${svc.id}`, { notes: 'x' }), 404, 'NOT_FOUND');

    // Create: the provider archived or deleted just before the write — nothing written.
    for (const [sql, status, code] of [
      ["UPDATE institutions SET status = 'archived' WHERE id = ?", 409, 'INSTITUTION_ARCHIVED'],
      ['DELETE FROM institutions WHERE id = ?', 404, 'NOT_FOUND'],
    ] as const) {
      const p = await institution(api);
      const before = await m2Snapshot();
      await race(() => e.exec(sql, p), () => api.req('POST', '/api/payment-channels', { name: `New ${code}`, channelType: 'payment_service', providerInstitutionId: p }), status, code);
      expect((await m2Snapshot()).payment_channels).toEqual(before.payment_channels);
    }
  });

  it('concurrent claims of one balance account, adds of one source, ends and deletes: one wins, the rest get 409 / 404 — and exactly one channel.delete audit', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    const claims = await Promise.all([0, 1, 2].map((i) => api.post('/api/payment-channels', { name: `Claim ${i}`, channelType: 'payment_service', balanceAccountId: acc })));
    expect(claims.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await e.all('SELECT id FROM payment_channels WHERE balance_account_id = ?', acc)).toHaveLength(1);
    const svc = await channel(api);
    const card = await createCard(api, inst);
    const adds = await Promise.all([0, 1, 2].map(() => api.post(`/api/payment-channels/${svc.id}/sources`, { cardId: card })));
    expect(adds.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const s = adds.find((r) => r.status === 201)!.json;
    const ends = await Promise.all([0, 1, 2].map(() => api.post(`/api/payment-channel-sources/${s.id}/end`)));
    expect(ends.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const dels = await Promise.all([0, 1, 2].map(() => api.del(`/api/payment-channel-sources/${s.id}`)));
    expect(dels.map((r) => r.status).sort()).toEqual([200, 404, 404]);
    const chDels = await Promise.all([0, 1, 2].map(() => api.del(`/api/payment-channels/${svc.id}`)));
    expect(chDels.map((r) => r.status).sort()).toEqual([200, 404, 404]);
    expect(await auditRows(user.id)).toEqual([{ action: 'channel.delete', detail: { id: svc.id } }]);
  });

  it('R-1: every channel route needs a session; writes need the CSRF header and an allowed Origin; missing ids are 404', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const svc = await channel(api);
    const s = await source(api, svc.id, { cardId: await createCard(api, inst) });
    const anon = client(e.t);
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/payment-channels'],
      ['POST', '/api/payment-channels', { name: 'X', channelType: 'other' }],
      ['GET', `/api/payment-channels/${svc.id}`],
      ['PATCH', `/api/payment-channels/${svc.id}`, { notes: 'x' }],
      ['DELETE', `/api/payment-channels/${svc.id}`],
      ['POST', `/api/payment-channels/${svc.id}/sources`, { accountId: 'x' }],
      ['PATCH', `/api/payment-channel-sources/${s.id}`, { notes: 'x' }],
      ['POST', `/api/payment-channel-sources/${s.id}/end`, {}],
      ['DELETE', `/api/payment-channel-sources/${s.id}`],
    ];
    for (const [method, path, b] of routes) {
      const r = await anon.req(method, path, b);
      expect.soft(r.status, `${method} ${path}`).toBe(401);
      expect.soft(r.json.code).toBe('UNAUTHENTICATED');
    }
    const before = await snapshot();
    for (const [method, path, b] of routes.filter(([m]) => m !== 'GET')) {
      const evil = await api.req(method, path, b, { origin: 'https://evil.example' });
      expect.soft(evil.status, `${method} ${path} origin`).toBe(403);
      const noCsrf = await api.req(method, path, b, { [CSRF_HEADER]: '' });
      expect.soft(noCsrf.status, `${method} ${path} csrf`).toBe(403);
    }
    expect(await snapshot()).toEqual(before);
    expect((await api.get('/api/payment-channels')).res.headers.get('cache-control')).toBe('no-store');
    const missing = 'x'.repeat(26);
    for (const [method, path, b] of [
      ['GET', `/api/payment-channels/${missing}`],
      ['PATCH', `/api/payment-channels/${missing}`, { notes: 'x' }],
      ['DELETE', `/api/payment-channels/${missing}`],
      ['POST', `/api/payment-channels/${missing}/sources`, { cardId: missing }],
      ['PATCH', `/api/payment-channel-sources/${missing}`, { notes: 'x' }],
      ['POST', `/api/payment-channel-sources/${missing}/end`, {}],
      ['DELETE', `/api/payment-channel-sources/${missing}`],
    ] as const) {
      expect((await api.req(method, path, b)).status, `${method} ${path}`).toBe(404);
    }
  });
});
