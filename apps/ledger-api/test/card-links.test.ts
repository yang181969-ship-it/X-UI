// M2-B4: card ↔ account links and the spending-source recommendation (API_SPEC §3.4.1, §3.5;
// DATA_MODEL §3.5, §5; TEST_PLAN L-1 – L-11, S-1 – S-13, D-1, D-2, X-1 / U-1 / U-2 / U-4 / R-1 for
// links). Every case runs twice with the same assertions: on libsql (a temporary file database
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
  const h: D1App = await startD1App('xui-v1-links-d1');
  return { t: h.t, all: h.all, exec: (sql, ...args) => h.d1.prepare(sql).bind(...args).run(), ping: h.ping, dispose: h.dispose };
}

const ENGINES = { libsql: libsqlEngine, d1: d1Engine };

describe.each(['libsql', 'd1'] as const)('card links on %s', (engine) => {
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
    const r = await api.post('/api/institutions', { name: `Bank ${++seq}`, country: 'GB', institutionType: 'bank', ...body });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.id as string;
  }
  async function createCard(api: Api, issuer: string, extra: Record<string, unknown> = {}) {
    const r = await api.post('/api/cards', { issuerInstitutionId: issuer, name: `Card ${++seq}`, network: 'visa', cardType: 'debit', last4: '4321', issuingCountry: 'BE', ...extra });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.card.id as string;
  }
  /** An account holding the given currencies (first = default). */
  async function createAccount(api: Api, inst: string, codes: string[] = ['SGD', 'USD'], extra: Record<string, unknown> = {}) {
    const r = await api.post('/api/accounts', {
      institutionId: inst,
      name: `Account ${++seq}`,
      accountType: 'e_money',
      accountCountry: 'BE',
      currencies: codes.map((code, i) => ({ code, isDefault: i === 0 })),
      ...extra,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.id as string;
  }
  /** Replace the account's currencies: [code, status] pairs, first = default. */
  async function setCurrencies(api: Api, acc: string, list: [string, 'active' | 'closed'][]) {
    const r = await api.req('PUT', `/api/accounts/${acc}/currencies`, { currencies: list.map(([code, status], i) => ({ code, status, isDefault: i === 0 })) });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  }
  async function link(api: Api, cardId: string, accountId: string, extra: Record<string, unknown> = {}) {
    e.t.advance(1); // links are listed and ranked oldest first: one per millisecond keeps the creation order
    const r = await api.post('/api/card-links', { cardId, accountId, ...extra });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json as Record<string, any> & { id: string };
  }
  const recommend = async (api: Api, card: string, currency: string) => {
    const r = await api.get(`/api/cards/${card}/spending-source?currency=${currency}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json;
  };
  /** The spec fields of a recommendation (without the explanation). */
  const pick = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'considered'));

  const linkRow = async (id: string) => (await e.all('SELECT status, is_default, role, priority, ended_on, notes FROM account_card_links WHERE id = ?', id))[0];
  const defaults = (cardId: string) => e.all('SELECT id, ifnull(currency, \'\') AS scope FROM account_card_links WHERE card_id = ? AND is_default = 1 ORDER BY id', cardId);
  const auditRows = async (userId: string) =>
    (await e.all("SELECT action, detail FROM audit_log WHERE user_id = ? AND action LIKE 'card_link.%' ORDER BY rowid", userId)).map((a) => ({ action: a.action, detail: JSON.parse(String(a.detail)) }));

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

  /** Run `fn` while every insert / update of `table` (optionally only `when`) fails; console noise of the 500 is muted. */
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
  /** Run `before` right before the next db.batch() (after the route's own checks) — a concurrent request landing in between. */
  function beforeNextBatch(before: () => Promise<unknown>) {
    const original = e.t.db.batch.bind(e.t.db);
    return vi.spyOn(e.t.db, 'batch').mockImplementationOnce(async (batch) => {
      await before();
      return original(batch as never);
    });
  }

  // ================================================================== many-to-many (L-1, L-2, L-7)

  it('L-1: one card links several accounts (spending and top-up); the card detail lists both with their roles', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const a = await createAccount(api, inst);
    const b = await createAccount(api, inst, ['HKD']);
    const spend = await link(api, card, a, { role: 'spending_source', isDefault: true, startedOn: '2026-01-02', priority: 1, notes: '日常' });
    expect(spend).toEqual({
      id: expect.any(String),
      cardId: card,
      accountId: a,
      currency: null,
      role: 'spending_source',
      isDefault: true,
      priority: 1,
      status: 'active',
      startedOn: '2026-01-02',
      endedOn: null,
      notes: '日常',
      card: { id: card, name: expect.any(String), network: 'visa', last4: '4321', cardType: 'debit', status: 'active' },
      account: { id: a, name: expect.any(String), accountCountry: 'BE', status: 'active' },
      createdAt: e.t.clock.t,
      updatedAt: e.t.clock.t,
    });
    const topUp = await link(api, card, b, { role: 'top_up_source' });
    expect(topUp).toMatchObject({ role: 'top_up_source', isDefault: false, priority: null, startedOn: null, notes: null });
    const detail = (await api.get(`/api/cards/${card}`)).json;
    expect(detail.links.map((l: any) => [l.accountId, l.role, l.isDefault])).toEqual([
      [a, 'spending_source', true],
      [b, 'top_up_source', false],
    ]);
    // The list summaries and filters follow the links.
    expect((await api.get('/api/cards')).json.find((c: any) => c.id === card).linkedAccounts.map((x: any) => x.id).sort()).toEqual([a, b].sort());
    expect((await api.get(`/api/accounts?cardId=${card}`)).json.map((x: any) => x.id).sort()).toEqual([a, b].sort());
    // The same card and account may also be linked with another role or currency scope.
    await link(api, card, a, { role: 'top_up_source' });
    await link(api, card, a, { currency: 'USD' });
    expect((await api.get(`/api/cards/${card}`)).json.links).toHaveLength(4);
  });

  it('L-2: one account backs several cards (a physical and two virtual); the account detail lists all three', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const acc = await createAccount(api, inst);
    const cards = [await createCard(api, inst), await createCard(api, inst, { form: 'virtual' }), await createCard(api, inst, { form: 'virtual' })];
    for (const card of cards) await link(api, card, acc, { isDefault: true });
    const detail = (await api.get(`/api/accounts/${acc}`)).json;
    expect(detail.links.map((l: any) => l.cardId)).toEqual(cards);
    // Each card has its own default: defaults are per card and currency scope.
    expect(detail.links.every((l: any) => l.isDefault)).toBe(true);
    const item = (await api.get('/api/accounts')).json.find((a: any) => a.id === acc);
    expect(item.linkedCardCount).toBe(3);
    expect((await api.get(`/api/cards?accountId=${acc}`)).json.map((c: any) => c.id).sort()).toEqual([...cards].sort());
  });

  it("L-7: a prepaid card's stored-value account is its spending source; a bank account tops it up", async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const created = await api.post('/api/cards', {
      issuerInstitutionId: inst,
      name: 'Prepaid',
      network: 'visa',
      cardType: 'prepaid',
      last4: '1111',
      issuingCountry: 'HK',
      createStoredValueAccount: { name: 'Prepaid balance', accountCountry: 'HK', currency: 'HKD' },
    });
    expect(created.status).toBe(201);
    const card = created.json.card.id;
    const bank = await createAccount(api, inst, ['HKD', 'USD'], { accountType: 'bank' });
    const topUp = await link(api, card, bank, { role: 'top_up_source' });
    expect(topUp.role).toBe('top_up_source');
    const links = (await api.get(`/api/cards/${card}`)).json.links;
    expect(links.map((l: any) => [l.accountId, l.role, l.isDefault])).toEqual([
      [created.json.account.id, 'spending_source', true],
      [bank, 'top_up_source', false],
    ]);
    // The top-up account is never the funding source of a purchase, even in its own currency.
    expect(pick(await recommend(api, card, 'USD'))).toEqual({ match: 'conversion_required', eventCurrency: 'USD', accountId: created.json.account.id, linkId: links[0].id, fundingCurrency: null, candidateCurrencies: ['HKD'] });
  });

  // ================================================================== create rules (L-3, L-4, L-5, L-6, X-1)

  it('L-3: a currency scope must be an active currency of the account (else 400 CURRENCY_NOT_ON_ACCOUNT, nothing written)', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst, ['SGD', 'EUR', 'JPY']);
    await setCurrencies(api, acc, [
      ['SGD', 'active'],
      ['EUR', 'active'],
      ['JPY', 'closed'],
    ]);
    expect((await link(api, card, acc, { currency: 'EUR' })).currency).toBe('EUR');
    const before = await snapshot();
    for (const currency of ['USD', 'JPY']) {
      const r = await api.post('/api/card-links', { cardId: card, accountId: acc, currency });
      expect(r.status, currency).toBe(400);
      expect(r.json.code).toBe('CURRENCY_NOT_ON_ACCOUNT');
    }
    for (const currency of ['eur', 'XAU', 'EURO']) expect((await api.post('/api/card-links', { cardId: card, accountId: acc, currency })).json.code, currency).toBe('VALIDATION');
    expect(await snapshot()).toEqual(before);
    // currency null = every currency of the account.
    expect((await link(api, card, acc, { currency: null })).currency).toBeNull();
  });

  it('L-4: a second unfinished link with the same card, account, scope and role is 409 DUPLICATE (existingId); after ending it, a new one may be created', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst);
    const first = await link(api, card, acc);
    const eur = await link(api, card, acc, { currency: 'USD', role: 'top_up_source' });
    const before = await snapshot();
    for (const [body, existing] of [
      [{}, first.id],
      [{ currency: null, role: 'spending_source' }, first.id],
      [{ currency: 'USD', role: 'top_up_source' }, eur.id],
    ] as const) {
      const r = await api.post('/api/card-links', { cardId: card, accountId: acc, ...body });
      expect(r.status).toBe(409);
      expect(r.json).toMatchObject({ code: 'DUPLICATE', details: { existingId: existing } });
    }
    // Suspended links are unfinished too.
    expect((await api.patch(`/api/card-links/${first.id}`, { status: 'suspended' })).status).toBe(200);
    expect((await api.post('/api/card-links', { cardId: card, accountId: acc })).json.details).toEqual({ existingId: first.id });
    expect((await snapshot()).account_card_links).toHaveLength(before.account_card_links!.length);
    // Ended: the history stays and a new link can be made.
    expect((await api.post(`/api/card-links/${first.id}/end`)).status).toBe(200);
    const again = await link(api, card, acc);
    expect(again.id).not.toBe(first.id);
    expect((await api.get(`/api/cards/${card}`)).json.links.map((l: any) => [l.id, l.status])).toEqual([
      [first.id, 'ended'],
      [eur.id, 'active'],
      [again.id, 'active'],
    ]);
    // The database agrees (expression index on ifnull(currency, '')).
    const err = await sqlError(
      "INSERT INTO account_card_links (id, user_id, card_id, account_id, currency, role, created_at, updated_at) SELECT 'dup', user_id, card_id, account_id, NULL, 'spending_source', 1, 1 FROM account_card_links WHERE id = ?",
      again.id,
    );
    expect(err).toMatch(/UNIQUE constraint failed/);
  });

  it('L-5: one default per card and currency scope — a new default replaces the old one atomically; other scopes keep theirs; the database refuses a second', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const a = await createAccount(api, inst, ['USD', 'EUR']);
    const b = await createAccount(api, inst, ['USD', 'GBP']);
    const la = await link(api, card, a, { isDefault: true });
    const lb = await link(api, card, b, { isDefault: true });
    expect(await defaults(card)).toEqual([{ id: lb.id, scope: '' }]);
    expect((await api.get(`/api/cards/${card}`)).json.links.map((l: any) => l.isDefault)).toEqual([false, true]);
    // POST /default switches back.
    const r = await api.post(`/api/card-links/${la.id}/default`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: la.id, isDefault: true });
    expect(await defaults(card)).toEqual([{ id: la.id, scope: '' }]);
    // Setting the current default again changes nothing.
    const stamp = (await e.all('SELECT updated_at FROM account_card_links WHERE id = ?', la.id))[0];
    e.t.advance(1000);
    expect((await api.post(`/api/card-links/${la.id}/default`, {})).status).toBe(200);
    expect((await e.all('SELECT updated_at FROM account_card_links WHERE id = ?', la.id))[0]).toEqual(stamp);
    // A currency-specific default lives next to the all-currency one.
    const usd = await link(api, card, b, { currency: 'USD', isDefault: true });
    expect(await defaults(card)).toEqual([la.id, usd.id].sort().map((id) => ({ id, scope: id === usd.id ? 'USD' : '' })));
    // Another card's defaults are independent.
    const other = await createCard(api, inst);
    await link(api, other, a, { isDefault: true });
    expect(await defaults(card)).toHaveLength(2);
    // The partial unique index is the last line of defence.
    expect(await sqlError('UPDATE account_card_links SET is_default = 1 WHERE id = ?', lb.id)).toMatch(/UNIQUE constraint failed/);
    expect((await api.post('/api/card-links', { cardId: card, accountId: a, isDefault: 'yes' })).json.code).toBe('VALIDATION');
  });

  it('L-6: only spending sources can be defaults (create, POST /default); the database CHECK agrees', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst);
    for (const role of ['top_up_source', 'other']) {
      const r = await api.post('/api/card-links', { cardId: card, accountId: acc, role, isDefault: true });
      expect(r.status, role).toBe(400);
      expect(r.json.code).toBe('VALIDATION');
      const l = await link(api, card, acc, { role });
      const d = await api.post(`/api/card-links/${l.id}/default`);
      expect(d.status, role).toBe(400);
      expect(d.json.code).toBe('VALIDATION');
      expect((await linkRow(l.id))!.is_default).toBe(0);
      expect(await sqlError('UPDATE account_card_links SET is_default = 1 WHERE id = ?', l.id)).toMatch(/CHECK constraint failed/);
    }
  });

  it('X-1 / X-4: card numbers or security codes in notes are refused (create and PATCH); unknown fields and bypass flags are 400', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst);
    const before = await snapshot();
    for (const notes of ['4111 1111 1111 1111', 'cvv 123']) {
      const r = await api.post('/api/card-links', { cardId: card, accountId: acc, notes });
      expect(r.json).toEqual({ error: expect.any(String), code: 'SENSITIVE_DATA', details: { fields: [{ field: 'notes', kind: expect.any(String) }] } });
      expect(JSON.stringify(r.json)).not.toContain('4111');
    }
    for (const extra of [{ force: true }, { allowSensitive: true }, { status: 'ended' }, { userId: 'x' }, { id: 'x' }, { endedOn: '2026-01-01' }, { pan: '4111111111111111' }]) {
      expect((await api.post('/api/card-links', { cardId: card, accountId: acc, ...extra })).json.code, JSON.stringify(extra)).toBe('VALIDATION');
    }
    expect(await snapshot()).toEqual(before);
    const l = await link(api, card, acc);
    expect((await api.patch(`/api/card-links/${l.id}`, { notes: 'ref 4111-1111-1111-1111' })).json.code).toBe('SENSITIVE_DATA');
    // Card, account and currency scope are fixed (end and re-create instead); defaults go through /default; ended through /end.
    for (const patch of [{}, { currency: 'USD' }, { cardId: card }, { accountId: acc }, { isDefault: true }, { status: 'ended' }, { endedOn: '2026-01-01' }, { userId: 'x' }, { priority: 0 }]) {
      expect((await api.patch(`/api/card-links/${l.id}`, patch)).json.code, JSON.stringify(patch)).toBe('VALIDATION');
    }
    expect((await api.post(`/api/card-links/${l.id}/default`, { force: true })).json.code).toBe('VALIDATION');
    expect((await api.post(`/api/card-links/${l.id}/end`, { status: 'ended' })).json.code).toBe('VALIDATION');
    expect((await linkRow(l.id))!.notes).toBeNull();
  });

  // ================================================================== lifecycle (L-8, L-9, L-10, L-11)

  it('PATCH changes role, priority and notes; a role change that would duplicate another unfinished link is 409', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst);
    const l = await link(api, card, acc, { isDefault: true, priority: 3 });
    e.t.advance(5000);
    const r = await api.patch(`/api/card-links/${l.id}`, { priority: 1, notes: '首选' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ priority: 1, notes: '首选', isDefault: true, role: 'spending_source', updatedAt: e.t.clock.t, createdAt: l.createdAt });
    expect((await api.patch(`/api/card-links/${l.id}`, { priority: null })).json.priority).toBeNull();
    // Leaving spending_source clears the default (only spending sources can be defaults).
    const toTopUp = await api.patch(`/api/card-links/${l.id}`, { role: 'top_up_source' });
    expect(toTopUp.json).toMatchObject({ role: 'top_up_source', isDefault: false });
    // Back to spending: the default is not restored.
    expect((await api.patch(`/api/card-links/${l.id}`, { role: 'spending_source' })).json).toMatchObject({ role: 'spending_source', isDefault: false });
    const twin = await link(api, card, acc, { role: 'other' });
    const dup = await api.patch(`/api/card-links/${l.id}`, { role: 'other' });
    expect(dup.status).toBe(409);
    expect(dup.json).toMatchObject({ code: 'DUPLICATE', details: { existingId: twin.id } });
    expect((await linkRow(l.id))!.role).toBe('spending_source');
  });

  it('L-9: suspending clears the default; resuming does not restore it; a suspended link cannot become the default (409 LINK_STATE)', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst);
    const l = await link(api, card, acc, { isDefault: true });
    const s = await api.patch(`/api/card-links/${l.id}`, { status: 'suspended' });
    expect(s.json).toMatchObject({ status: 'suspended', isDefault: false });
    const d = await api.post(`/api/card-links/${l.id}/default`);
    expect(d.status).toBe(409);
    expect(d.json).toMatchObject({ code: 'LINK_STATE', details: { status: 'suspended' } });
    expect((await api.patch(`/api/card-links/${l.id}`, { status: 'active' })).json).toMatchObject({ status: 'active', isDefault: false });
    expect((await api.post(`/api/card-links/${l.id}/default`)).json.isDefault).toBe(true);
    // Suspend → end is allowed.
    await api.patch(`/api/card-links/${l.id}`, { status: 'suspended' });
    expect((await api.post(`/api/card-links/${l.id}/end`)).json.status).toBe('ended');
  });

  it('L-8: ending keeps the record as history (endedOn, default cleared) on both sides; ended is final — only notes may change; it is audited', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst);
    const l = await link(api, card, acc, { isDefault: true, startedOn: '2026-01-10' });
    // endedOn defaults to today (UTC) — the web app sends the user's own date.
    const today = new Date(e.t.clock.t).toISOString().slice(0, 10);
    const r = await api.post(`/api/card-links/${l.id}/end`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'ended', endedOn: today, isDefault: false, startedOn: '2026-01-10' });
    for (const path of [`/api/cards/${card}`, `/api/accounts/${acc}`]) expect((await api.get(path)).json.links.find((x: any) => x.id === l.id)).toMatchObject({ status: 'ended', endedOn: today });
    // Not listed as a current link (list summaries and filters ignore ended links).
    expect((await api.get(`/api/accounts?cardId=${card}`)).json).toEqual([]);
    const before = await snapshot();
    for (const [method, path, b] of [
      ['PATCH', `/api/card-links/${l.id}`, { status: 'active' }],
      ['PATCH', `/api/card-links/${l.id}`, { status: 'suspended' }],
      ['PATCH', `/api/card-links/${l.id}`, { role: 'other' }],
      ['PATCH', `/api/card-links/${l.id}`, { priority: 2 }],
      ['POST', `/api/card-links/${l.id}/default`, {}],
      ['POST', `/api/card-links/${l.id}/end`, { endedOn: today }],
    ] as const) {
      const x = await api.req(method, path, b);
      expect(x.status, `${method} ${JSON.stringify(b)}`).toBe(409);
      expect(x.json).toMatchObject({ code: 'LINK_STATE', details: { status: 'ended' } });
    }
    expect(await snapshot()).toEqual(before);
    expect((await api.patch(`/api/card-links/${l.id}`, { notes: '已换卡' })).json).toMatchObject({ status: 'ended', notes: '已换卡', endedOn: today });
    expect(await auditRows(user.id)).toEqual([
      { action: 'card_link.create', detail: { id: l.id, cardId: card, accountId: acc } },
      { action: 'card_link.end', detail: { id: l.id, cardId: card, accountId: acc } },
    ]);
  });

  it('L-8: endedOn is a real date, not before startedOn and not in the future (a day of time-zone slack)', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst);
    const today = new Date(e.t.clock.t).toISOString().slice(0, 10);
    const tomorrow = new Date(e.t.clock.t + 86_400_000).toISOString().slice(0, 10);
    const later = new Date(e.t.clock.t + 2 * 86_400_000).toISOString().slice(0, 10);
    const l = await link(api, card, acc, { startedOn: '2026-03-01' });
    for (const endedOn of ['2026-02-28', later, '2026-02-30', '2026/03/02', '']) {
      const r = await api.post(`/api/card-links/${l.id}/end`, { endedOn });
      expect(r.status, endedOn).toBe(400);
      expect(r.json.code).toBe('VALIDATION');
    }
    expect((await linkRow(l.id))!.status).toBe('active');
    expect((await api.post(`/api/card-links/${l.id}/end`, { endedOn: tomorrow })).json.endedOn).toBe(tomorrow);
    const m = await link(api, card, acc);
    expect((await api.post(`/api/card-links/${m.id}/end`, { endedOn: '2020-05-05' })).json).toMatchObject({ endedOn: '2020-05-05', startedOn: null });
    const n = await link(api, card, acc);
    expect((await api.post(`/api/card-links/${n.id}/end`, { endedOn: today })).json.endedOn).toBe(today);
  });

  it('L-8: dates — ending on the start day is allowed; before it is refused and writes nothing; an omitted endedOn stores today (UTC); the database itself only ties ended_on to the ended status', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst);
    const today = new Date(e.t.clock.t).toISOString().slice(0, 10);
    const row = async (id: string) => (await e.all('SELECT status, is_default, started_on, ended_on FROM account_card_links WHERE id = ?', id))[0];
    const endAudits = async () => (await auditRows(user.id)).filter((a) => a.action === 'card_link.end').map((a) => a.detail.id);

    // Normal end and same-day end (endedOn = startedOn), today and in the past.
    const normal = await link(api, card, acc, { startedOn: '2026-03-01', role: 'other' });
    expect((await api.post(`/api/card-links/${normal.id}/end`, { endedOn: '2026-06-30' })).json).toMatchObject({ status: 'ended', startedOn: '2026-03-01', endedOn: '2026-06-30' });
    const sameDayPast = await link(api, card, acc, { startedOn: '2026-03-01', role: 'other' });
    expect((await api.post(`/api/card-links/${sameDayPast.id}/end`, { endedOn: '2026-03-01' })).json).toMatchObject({ status: 'ended', endedOn: '2026-03-01' });
    const sameDayToday = await link(api, card, acc, { startedOn: today, isDefault: true });
    expect((await api.post(`/api/card-links/${sameDayToday.id}/end`, { endedOn: today })).status).toBe(200);
    expect(await row(sameDayToday.id)).toEqual({ status: 'ended', is_default: 0, started_on: today, ended_on: today });

    // Before the start: 400 on endedOn, the link and the audit log unchanged.
    const early = await link(api, card, acc, { startedOn: '2026-03-01', currency: 'USD' });
    const before = await snapshot();
    const r = await api.post(`/api/card-links/${early.id}/end`, { endedOn: '2026-02-28' });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ code: 'VALIDATION', details: [{ path: ['endedOn'] }] });
    expect(await snapshot()).toEqual(before);
    expect(await row(early.id)).toEqual({ status: 'active', is_default: 0, started_on: '2026-03-01', ended_on: null });

    // Omitted endedOn — an empty object or no body at all — is the server's UTC date, stored as such.
    const noField = await link(api, card, acc, { role: 'top_up_source' });
    expect((await api.post(`/api/card-links/${noField.id}/end`, {})).json.endedOn).toBe(today);
    expect((await api.req('POST', `/api/card-links/${early.id}/end`)).json).toMatchObject({ status: 'ended', startedOn: '2026-03-01', endedOn: today });
    expect(await row(early.id)).toMatchObject({ status: 'ended', ended_on: today });
    expect(await endAudits()).toEqual([normal.id, sameDayPast.id, sameDayToday.id, noField.id, early.id]);

    // Database constraints as frozen: ended_on only on an ended link (CHECK); the start / end order is the API's check, not the database's.
    const open = await link(api, card, acc, { role: 'other', currency: 'USD' });
    expect(await sqlError("UPDATE account_card_links SET ended_on = '2026-01-01' WHERE id = ?", open.id)).toMatch(/CHECK constraint failed/);
    expect(await sqlError("UPDATE account_card_links SET status = 'ended', ended_on = '2026-01-01', started_on = '2026-05-01' WHERE id = ?", open.id)).toBe('no error');
  });

  it('L-10: DELETE removes only the record (for correcting mistakes) — card and account stay; audited; a second DELETE is 404', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst);
    const keep = await link(api, card, acc, { currency: 'USD' });
    for (const status of ['active', 'suspended', 'ended'] as const) {
      const l = await link(api, card, acc, { role: 'other' });
      if (status === 'suspended') await api.patch(`/api/card-links/${l.id}`, { status });
      if (status === 'ended') await api.post(`/api/card-links/${l.id}/end`);
      const r = await api.del(`/api/card-links/${l.id}`);
      expect(r.status, status).toBe(200);
      expect(r.json).toEqual({ ok: true });
      expect(await e.all('SELECT id FROM account_card_links WHERE id = ?', l.id)).toEqual([]);
      expect((await api.del(`/api/card-links/${l.id}`)).status).toBe(404);
    }
    expect((await api.get(`/api/cards/${card}`)).json.links.map((l: any) => l.id)).toEqual([keep.id]);
    expect((await api.get(`/api/accounts/${acc}`)).status).toBe(200);
    expect((await auditRows(user.id)).filter((a) => a.action === 'card_link.delete')).toHaveLength(3);
    expect(await e.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('L-11 / D-1 / D-2: freezing or closing the account, closing a currency, freezing or closing the card change no link; recommendations skip them until restored', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const w = await createAccount(api, inst, ['USD', 'EUR']);
    const l = await link(api, card, w, { isDefault: true });
    const usd = await link(api, card, w, { currency: 'USD', priority: 1 });
    const linksBefore = await e.all('SELECT * FROM account_card_links WHERE card_id = ? ORDER BY id', card);
    // Both links hold USD; the default ranks first (DATA_MODEL §5: is_default before currency-specific).
    const exact = { match: 'exact_currency', eventCurrency: 'USD', accountId: w, linkId: l.id, fundingCurrency: 'USD' };
    expect(pick(await recommend(api, card, 'USD'))).toEqual(exact);
    const changes: [string, () => Promise<unknown>, () => Promise<unknown>, Record<string, unknown>][] = [
      ['account frozen', () => api.patch(`/api/accounts/${w}`, { status: 'frozen' }), () => api.patch(`/api/accounts/${w}`, { status: 'active' }), { match: 'no_match', eventCurrency: 'USD', reason: 'no_eligible_link' }],
      ['account closed', () => api.patch(`/api/accounts/${w}`, { status: 'closed' }), () => api.patch(`/api/accounts/${w}`, { status: 'active' }), { match: 'no_match', eventCurrency: 'USD', reason: 'no_eligible_link' }],
      [
        'USD closed',
        () => setCurrencies(api, w, [['EUR', 'active'], ['USD', 'closed']]),
        () => setCurrencies(api, w, [['USD', 'active'], ['EUR', 'active']]),
        { match: 'conversion_required', eventCurrency: 'USD', accountId: w, linkId: l.id, fundingCurrency: null, candidateCurrencies: ['EUR'] },
      ],
      ['card frozen', () => api.patch(`/api/cards/${card}`, { status: 'frozen' }), () => api.patch(`/api/cards/${card}`, { status: 'active' }), { match: 'no_match', eventCurrency: 'USD', reason: 'card_inactive' }],
      ['card closed', () => api.patch(`/api/cards/${card}`, { status: 'closed' }), () => api.patch(`/api/cards/${card}`, { status: 'active' }), { match: 'no_match', eventCurrency: 'USD', reason: 'card_inactive' }],
    ];
    for (const [what, change, restore, expected] of changes) {
      await change();
      expect(pick(await recommend(api, card, 'USD')), what).toEqual(expected);
      const now = await e.all('SELECT * FROM account_card_links WHERE card_id = ? ORDER BY id', card);
      expect(now, `${what}: links unchanged`).toEqual(linksBefore);
      for (const path of [`/api/cards/${card}`, `/api/accounts/${w}`]) expect((await api.get(path)).json.links.map((x: any) => [x.id, x.status, x.isDefault]), what).toEqual([[l.id, 'active', true], [usd.id, 'active', false]]);
      await restore();
      expect(pick(await recommend(api, card, 'USD')), `${what} restored`).toEqual(exact);
    }
  });

  // ================================================================== spending source (S-1 – S-13)

  /** TEST_PLAN §3.5 fixture: Wise, multi-currency account W, debit card K, one all-currency default spending link K→W; another account B. */
  async function wise(wCurrencies: string[], bCurrencies: string[] = ['SGD']) {
    const { api, user } = await signIn('wise');
    const inst = await institution(api, { name: `Wise ${++seq}`, institutionType: 'emi', country: 'BE' });
    const W = await createAccount(api, inst, wCurrencies);
    const B = await createAccount(api, inst, bCurrencies, { accountType: 'bank', accountCountry: 'SG' });
    const K = await createCard(api, inst);
    const KW = await link(api, K, W, { isDefault: true });
    return { api, user, inst, W, B, K, KW: KW.id };
  }

  it('S-1: exact match — W holds USD → exact_currency, W, fundingCurrency USD; the explanation names the link', async () => {
    const { api, W, K, KW } = await wise(['USD', 'EUR', 'GBP']);
    const r = await recommend(api, K, 'USD');
    expect(pick(r)).toEqual({ match: 'exact_currency', eventCurrency: 'USD', accountId: W, linkId: KW, fundingCurrency: 'USD' });
    expect(r.considered).toEqual([
      { linkId: KW, account: { id: W, name: expect.any(String), accountCountry: 'BE', status: 'active' }, currency: null, role: 'spending_source', status: 'active', isDefault: true, priority: null, scope: ['USD', 'EUR', 'GBP'], skipped: null, exact: true },
    ]);
  });

  it('S-2 / S-3: Wise USD purchase funded from HKD — conversion_required, fundingCurrency null, candidates [HKD, EUR]; the default currency is never taken as the event or funding currency', async () => {
    const { api, W, K, KW } = await wise(['HKD', 'EUR']);
    const r = await recommend(api, K, 'USD');
    expect(pick(r)).toEqual({ match: 'conversion_required', eventCurrency: 'USD', accountId: W, linkId: KW, fundingCurrency: null, candidateCurrencies: ['HKD', 'EUR'] });
    expect(r.fundingCurrency).not.toBe('HKD');
    expect(r.eventCurrency).not.toBe('HKD');
    for (const currency of ['JPY', 'SGD', 'CHF']) {
      const x = await recommend(api, K, currency);
      expect(x).toMatchObject({ match: 'conversion_required', eventCurrency: currency, fundingCurrency: null, candidateCurrencies: ['HKD', 'EUR'] });
    }
    // Candidates: default first, then the account's own order.
    await setCurrencies(api, W, [['EUR', 'active'], ['HKD', 'active'], ['CHF', 'closed']]);
    expect((await recommend(api, K, 'USD')).candidateCurrencies).toEqual(['EUR', 'HKD']);
  });

  it('S-4: only top-up / other links → no_match no_eligible_link (and the explanation says why)', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst, ['USD']);
    const l = await link(api, card, acc, { role: 'top_up_source' });
    await link(api, card, acc, { role: 'other' });
    const r = await recommend(api, card, 'USD');
    expect(pick(r)).toEqual({ match: 'no_match', eventCurrency: 'USD', reason: 'no_eligible_link' });
    expect(r.considered.map((c: any) => [c.role, c.skipped, c.exact])).toEqual([
      ['top_up_source', 'not_spending_source', false],
      ['other', 'not_spending_source', false],
    ]);
    expect(r.considered[0].linkId).toBe(l.id);
    // No links at all.
    expect(pick(await recommend(api, await createCard(api, inst), 'USD'))).toEqual({ match: 'no_match', eventCurrency: 'USD', reason: 'no_eligible_link' });
  });

  it('S-5: a frozen or closed card → no_match card_inactive, even with everything else valid; an expired but active card is still considered (expiry is not status)', async () => {
    const { api, K, W, KW } = await wise(['USD']);
    for (const status of ['frozen', 'closed']) {
      await api.patch(`/api/cards/${K}`, { status });
      expect(await recommend(api, K, 'USD'), status).toEqual({ match: 'no_match', eventCurrency: 'USD', reason: 'card_inactive', considered: [] });
    }
    await api.patch(`/api/cards/${K}`, { status: 'active', expiresOn: '2020-01' });
    expect(pick(await recommend(api, K, 'USD'))).toEqual({ match: 'exact_currency', eventCurrency: 'USD', accountId: W, linkId: KW, fundingCurrency: 'USD' });
  });

  it('S-6: a suspended or ended default is skipped — the next eligible link is returned, else no_match', async () => {
    const { api, B, K, KW } = await wise(['USD'], ['USD']);
    const KB = await link(api, K, B);
    await api.patch(`/api/card-links/${KW}`, { status: 'suspended' });
    let r = await recommend(api, K, 'USD');
    expect(pick(r)).toMatchObject({ match: 'exact_currency', accountId: B, linkId: KB.id });
    expect(r.considered.map((c: any) => [c.linkId, c.skipped])).toEqual([
      [KB.id, null],
      [KW, 'link_suspended'],
    ]);
    await api.post(`/api/card-links/${KW}/end`);
    r = await recommend(api, K, 'USD');
    expect(r.linkId).toBe(KB.id);
    // Ended links are history: not considered at all.
    expect(r.considered.map((c: any) => c.linkId)).toEqual([KB.id]);
    await api.patch(`/api/card-links/${KB.id}`, { status: 'suspended' });
    expect(pick(await recommend(api, K, 'USD'))).toEqual({ match: 'no_match', eventCurrency: 'USD', reason: 'no_eligible_link' });
  });

  it('S-7: a frozen or closed W is not recommended — B is', async () => {
    const { api, W, B, K } = await wise(['USD'], ['USD']);
    const KB = await link(api, K, B);
    for (const status of ['frozen', 'closed']) {
      await api.patch(`/api/accounts/${W}`, { status });
      const r = await recommend(api, K, 'USD');
      expect(pick(r), status).toMatchObject({ match: 'exact_currency', accountId: B, linkId: KB.id });
      expect(r.considered.find((c: any) => c.account.id === W)).toMatchObject({ skipped: 'account_inactive', account: { status } });
    }
  });

  it('S-8: a currency-specific link whose currency is closed is not eligible', async () => {
    const { api, W, K, KW } = await wise(['EUR', 'USD']);
    await api.patch(`/api/card-links/${KW}`, { status: 'suspended' });
    const usd = await link(api, K, W, { currency: 'USD' });
    expect((await recommend(api, K, 'USD')).linkId).toBe(usd.id);
    await setCurrencies(api, W, [['EUR', 'active'], ['USD', 'closed']]);
    const r = await recommend(api, K, 'USD');
    expect(pick(r)).toEqual({ match: 'no_match', eventCurrency: 'USD', reason: 'no_eligible_link' });
    expect(r.considered.find((c: any) => c.linkId === usd.id)).toMatchObject({ scope: [], skipped: 'currency_closed', exact: false });
  });

  it('S-9: all-currency link with USD closed → conversion_required, candidates without USD', async () => {
    const { api, W, K, KW } = await wise(['EUR', 'USD']);
    await setCurrencies(api, W, [['EUR', 'active'], ['USD', 'closed']]);
    expect(pick(await recommend(api, K, 'USD'))).toEqual({ match: 'conversion_required', eventCurrency: 'USD', accountId: W, linkId: KW, fundingCurrency: null, candidateCurrencies: ['EUR'] });
  });

  it('S-10: a currency match beats the default — K→W default (no USD) + K→B (USD) → B', async () => {
    const { api, B, K, KW } = await wise(['HKD', 'EUR'], ['SGD', 'USD']);
    const KB = await link(api, K, B);
    const r = await recommend(api, K, 'USD');
    expect(pick(r)).toEqual({ match: 'exact_currency', eventCurrency: 'USD', accountId: B, linkId: KB.id, fundingCurrency: 'USD' });
    expect(r.considered.map((c: any) => [c.linkId, c.exact, c.skipped])).toEqual([
      [KB.id, true, null],
      [KW, false, null],
    ]);
    // In W's currencies, W's default wins.
    expect((await recommend(api, K, 'EUR')).linkId).toBe(KW);
  });

  it('S-11: a currency-specific default beats the all-currency default for its currency only', async () => {
    const { api, W, B, K, KW } = await wise(['GBP', 'EUR'], ['GBP']);
    const KB = await link(api, K, B, { currency: 'GBP', isDefault: true });
    expect(pick(await recommend(api, K, 'GBP'))).toMatchObject({ accountId: B, linkId: KB.id, fundingCurrency: 'GBP' });
    expect(pick(await recommend(api, K, 'EUR'))).toMatchObject({ accountId: W, linkId: KW, fundingCurrency: 'EUR' });
    // Both defaults stay (different scopes).
    expect((await defaults(K)).length).toBe(2);
  });

  it('S-12: among equals, priority 1 before 2, no priority last, then the older link — a stable order', async () => {
    const { api, inst, K, KW } = await wise(['HKD']);
    await api.patch(`/api/card-links/${KW}`, { status: 'suspended' });
    const accs = [await createAccount(api, inst, ['USD']), await createAccount(api, inst, ['USD']), await createAccount(api, inst, ['USD']), await createAccount(api, inst, ['USD'])];
    const none2 = await link(api, K, accs[0]!);
    e.t.advance(1);
    const p2 = await link(api, K, accs[1]!, { priority: 2 });
    e.t.advance(1);
    const none1 = await link(api, K, accs[2]!);
    e.t.advance(1);
    const p1 = await link(api, K, accs[3]!, { priority: 1 });
    const order = [p1.id, p2.id, none2.id, none1.id];
    for (let i = 0; i < 3; i++) {
      const r = await recommend(api, K, 'USD');
      expect(r.linkId).toBe(p1.id);
      expect(r.considered.map((c: any) => c.linkId)).toEqual([...order, KW]);
    }
    // Without its priority, p1 is the youngest of the links without one: last of them.
    await api.patch(`/api/card-links/${p1.id}`, { priority: null });
    expect((await recommend(api, K, 'USD')).considered.map((c: any) => c.linkId)).toEqual([p2.id, none2.id, none1.id, p1.id, KW]);
    // Same creation instant: the id decides (still a total order).
    await e.exec('UPDATE account_card_links SET created_at = 5 WHERE card_id = ? AND priority IS NULL', K);
    const ids = [none2.id, none1.id, p1.id].sort();
    expect((await recommend(api, K, 'USD')).considered.map((c: any) => c.linkId)).toEqual([p2.id, ...ids, KW]);
  });

  it('S-13: read-only; currency is required, upper-case ISO 4217; unknown parameters are 400; another user’s card is 404', async () => {
    const { api, K } = await wise(['USD']);
    const before = await snapshot();
    for (const q of ['', '?currency=usd', '?currency=XAU', '?currency=US', '?currency=USD&x=1']) {
      const r = await api.get(`/api/cards/${K}/spending-source${q}`);
      expect(r.status, q).toBe(400);
      expect(r.json.code).toBe('VALIDATION');
    }
    await recommend(api, K, 'USD');
    await recommend(api, K, 'JPY');
    expect(await snapshot()).toEqual(before);
    const { api: other } = await signIn('other');
    const r = await other.get(`/api/cards/${K}/spending-source?currency=USD`);
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: 'card not found', code: 'NOT_FOUND' });
    expect((await api.get(`/api/cards/${'x'.repeat(26)}/spending-source?currency=USD`)).status).toBe(404);
  });

  // ================================================================== isolation (U-1, U-2, U-4)

  /** Two users with look-alike data: A's card K → W (default) and → X (top-up); B's own card, account (holding JPY) and default link. */
  async function twoUsers() {
    const b = await signIn('b');
    const bInst = await institution(b.api);
    const bCard = await createCard(b.api, bInst, { name: 'B Secret Card' });
    const bAcc = await createAccount(b.api, bInst, ['USD', 'JPY'], { name: 'B Secret Account' });
    const bLink = await link(b.api, bCard, bAcc, { isDefault: true, notes: 'b-private-note' });
    const a = await signIn('a');
    const inst = await institution(a.api);
    const K = await createCard(a.api, inst);
    const W = await createAccount(a.api, inst, ['USD', 'EUR']);
    const X = await createAccount(a.api, inst, ['HKD']);
    const lw = await link(a.api, K, W, { isDefault: true });
    const lx = await link(a.api, K, X, { role: 'top_up_source' });
    const secrets = ['B Secret', 'b-private-note', bCard, bAcc, bLink.id, b.user.id, bInst];
    /** Every candidate is one of A's links on K, with A's own account summary; nothing of B's anywhere in the body. */
    const expectOwn = (r: Record<string, any>, what: string) => {
      for (const c of r.considered) {
        expect([lw.id, lx.id], what).toContain(c.linkId);
        expect([W, X], what).toContain(c.account.id);
        expect(Object.keys(c.account).sort(), what).toEqual(['accountCountry', 'id', 'name', 'status']);
      }
      const text = JSON.stringify(r);
      for (const s of secrets) expect(text, `${what}: ${s}`).not.toContain(s);
    };
    return { a, b, K, W, X, lw, lx, bCard, bAcc, bLink, secrets, expectOwn };
  }

  it("S-13 / U-1: `considered` only ever describes the caller's own links and accounts, in all three response shapes; another user's card is a bare 404", async () => {
    const { a, b, K, W, lw, lx, bCard, bAcc, bLink, expectOwn } = await twoUsers();
    // exact_currency
    let r = await recommend(a.api, K, 'USD');
    expect(r).toMatchObject({ match: 'exact_currency', accountId: W, linkId: lw.id });
    expect(r.considered.map((c: any) => c.linkId)).toEqual([lw.id, lx.id]);
    expectOwn(r, 'exact');
    // conversion_required — B's account holds JPY, A's do not: candidates are A's currencies only.
    r = await recommend(a.api, K, 'JPY');
    expect(r).toMatchObject({ match: 'conversion_required', accountId: W, fundingCurrency: null, candidateCurrencies: ['USD', 'EUR'] });
    expectOwn(r, 'conversion');
    // no_match / no_eligible_link
    await a.api.patch(`/api/card-links/${lw.id}`, { status: 'suspended' });
    r = await recommend(a.api, K, 'USD');
    expect(r).toMatchObject({ match: 'no_match', reason: 'no_eligible_link' });
    expect(r.considered.map((c: any) => [c.linkId, c.skipped])).toEqual([
      [lw.id, 'link_suspended'],
      [lx.id, 'not_spending_source'],
    ]);
    expectOwn(r, 'no_eligible_link');
    // no_match / card_inactive: no explanation at all.
    await a.api.patch(`/api/cards/${K}`, { status: 'frozen' });
    r = await recommend(a.api, K, 'USD');
    expect(r).toEqual({ match: 'no_match', eventCurrency: 'USD', reason: 'card_inactive', considered: [] });

    // Each user asking for the other's card: the same bare 404 as for a missing card, never an explanation.
    const missing = 'x'.repeat(26);
    for (const [api, card] of [
      [b.api, K],
      [a.api, bCard],
      [a.api, missing],
    ] as const) {
      for (const currency of ['USD', 'JPY']) {
        const x = await api.get(`/api/cards/${card}/spending-source?currency=${currency}`);
        expect(x.status).toBe(404);
        expect(x.json).toEqual({ error: 'card not found', code: 'NOT_FOUND' });
      }
    }
    // B's own recommendation is B's alone.
    const own = await recommend(b.api, bCard, 'USD');
    expect(own).toMatchObject({ match: 'exact_currency', accountId: bAcc, linkId: bLink.id });
    expect(own.considered.map((c: any) => c.linkId)).toEqual([bLink.id]);
    for (const s of [K, W, lw.id, lx.id, a.user.id]) expect(JSON.stringify(own)).not.toContain(s);
  });

  it.skipIf(engine === 'd1')('`considered` stays the caller’s even with cross-user link rows forced in past the foreign keys (libsql: foreign_keys OFF; D1 cannot turn them off)', async () => {
    const { a, b, K, W, lw, lx, bAcc, expectOwn } = await twoUsers();
    const baseline = await recommend(a.api, K, 'USD');
    const rows = [
      // Owned by B, on A's card: filtered out by the link query's user_id.
      ['forced-b-on-a', b.user.id, K, bAcc, 'spending_source'],
      // Owned by A, pointing at B's account: the account query is user-scoped, so the link is left out (no 500, no B summary).
      ['forced-a-to-b', a.user.id, K, bAcc, 'other'],
      // Owned by B, on A's card and A's own account: only the link query's user_id keeps B's row (its id, role, status) out.
      ['forced-b-on-a-own', b.user.id, K, W, 'top_up_source'],
    ];
    try {
      await e.exec('PRAGMA foreign_keys = OFF');
      try {
        for (const [id, userId, cardId, accountId, role] of rows) {
          await e.exec("INSERT INTO account_card_links (id, user_id, card_id, account_id, role, is_default, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 'active', 1, 1)", id, userId, cardId, accountId, role);
        }
      } finally {
        await e.exec('PRAGMA foreign_keys = ON');
      }
      expect(await e.all('PRAGMA foreign_key_check(account_card_links)')).not.toEqual([]);
      for (const currency of ['USD', 'JPY', 'EUR']) {
        const r = await recommend(a.api, K, currency);
        expect(r.considered.map((c: any) => c.linkId), currency).toEqual([lw.id, lx.id]);
        expectOwn(r, `forced rows, ${currency}`);
      }
      expect(await recommend(a.api, K, 'USD')).toEqual(baseline);
      expect((await b.api.get(`/api/cards/${K}/spending-source?currency=USD`)).json).toEqual({ error: 'card not found', code: 'NOT_FOUND' });
    } finally {
      await e.exec("DELETE FROM account_card_links WHERE id IN ('forced-b-on-a', 'forced-a-to-b', 'forced-b-on-a-own')");
    }
    expect(await e.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it("U-1 / U-2: another user's links, cards and accounts are 404 on every route — nothing changes and nothing leaks", async () => {
    const owner = await signIn('owner');
    const inst = await institution(owner.api);
    const card = await createCard(owner.api, inst, { name: 'Owner Secret Card' });
    const acc = await createAccount(owner.api, inst, ['USD'], { name: 'Owner Secret Account' });
    const l = await link(owner.api, card, acc, { isDefault: true, notes: 'owner-private-note' });
    const intruder = await signIn('intruder');
    const iInst = await institution(intruder.api);
    const iCard = await createCard(intruder.api, iInst);
    const iAcc = await createAccount(intruder.api, iInst, ['USD']);
    const before = await m2Snapshot();
    const attempts: [string, string, unknown?][] = [
      ['PATCH', `/api/card-links/${l.id}`, { notes: 'x' }],
      ['PATCH', `/api/card-links/${l.id}`, { status: 'suspended' }],
      ['POST', `/api/card-links/${l.id}/default`, {}],
      ['POST', `/api/card-links/${l.id}/end`, {}],
      ['DELETE', `/api/card-links/${l.id}`],
      // Cross-user references in a create: the owner's card or account with the intruder's own.
      ['POST', '/api/card-links', { cardId: card, accountId: iAcc }],
      ['POST', '/api/card-links', { cardId: iCard, accountId: acc }],
      ['POST', '/api/card-links', { cardId: card, accountId: acc }],
      ['POST', '/api/card-links', { cardId: iCard, accountId: acc, currency: 'USD' }],
      ['GET', `/api/cards/${card}/spending-source?currency=USD`],
    ];
    for (const [method, path, b] of attempts) {
      const r = await intruder.api.req(method, path, b);
      expect(r.status, `${method} ${path} ${JSON.stringify(b)}`).toBe(404);
      expect(r.json.code).toBe('NOT_FOUND');
      const text = JSON.stringify(r.json);
      for (const secret of ['Owner Secret', 'owner-private-note', acc, card, l.id]) expect(text).not.toContain(secret);
    }
    expect(await m2Snapshot()).toEqual(before);
    // The intruder's own lists and details show none of it.
    expect((await intruder.api.get(`/api/accounts/${iAcc}`)).json.links).toEqual([]);
    expect(JSON.stringify((await intruder.api.get('/api/cards')).json)).not.toContain('Owner Secret');
    // And the owner's link is intact.
    expect((await owner.api.get(`/api/cards/${card}`)).json.links).toEqual([expect.objectContaining({ id: l.id, isDefault: true, status: 'active', notes: 'owner-private-note' })]);
  });

  it('U-4: the database refuses cross-user links (composite foreign keys) even when the API is bypassed', async () => {
    const a = await signIn('a');
    const b = await signIn('b');
    const aInst = await institution(a.api);
    const aCard = await createCard(a.api, aInst);
    const aAcc = await createAccount(a.api, aInst, ['USD']);
    const bInst = await institution(b.api);
    const bCard = await createCard(b.api, bInst);
    const bAcc = await createAccount(b.api, bInst, ['USD']);
    const insert = (id: string, user: string, cardId: string, accountId: string, currency: string | null) =>
      sqlError('INSERT INTO account_card_links (id, user_id, card_id, account_id, currency, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)', id, user, cardId, accountId, currency);
    expect(await insert(`x1-${engine}`, b.user.id, aCard, bAcc, null)).toMatch(/FOREIGN KEY constraint failed/);
    expect(await insert(`x2-${engine}`, b.user.id, bCard, aAcc, null)).toMatch(/FOREIGN KEY constraint failed/);
    expect(await insert(`x3-${engine}`, b.user.id, bCard, aAcc, 'USD')).toMatch(/FOREIGN KEY constraint failed/);
    expect(await insert(`x4-${engine}`, a.user.id, aCard, bAcc, null)).toMatch(/FOREIGN KEY constraint failed/);
    // Same user: accepted (the check above is not a false positive).
    expect(await insert(`ok-${engine}`, b.user.id, bCard, bAcc, 'USD')).toBe('no error');
  });

  // ================================================================== atomicity and concurrency

  it('create: a failing link or audit insert leaves neither — and a failed default switch leaves the old default in place', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst, ['USD', 'EUR']);
    const acc2 = await createAccount(api, inst, ['USD']);
    const old = await link(api, card, acc, { isDefault: true });
    for (const [event, table, when] of [
      ['INSERT', 'account_card_links', null],
      ['INSERT', 'audit_log', "NEW.action = 'card_link.create'"],
      // The new default is set after the old one was cleared: failing there must restore the old.
      ['UPDATE', 'account_card_links', 'NEW.is_default = 1'],
    ] as const) {
      const before = await snapshot();
      // Same card and scope as the old default: the new one would replace it.
      const r = await failing(event, table, when, () => api.post('/api/card-links', { cardId: card, accountId: acc2, isDefault: true }));
      expect(r.status, `${event} ${table}`).toBe(500);
      expect(await snapshot(), `${event} ${table}`).toEqual(before);
    }
    expect(await defaults(card)).toEqual([{ id: old.id, scope: '' }]);
    // The retry once the fault is gone: one link, one audit.
    const ok = await link(api, card, acc2, { isDefault: true });
    expect(await defaults(card)).toEqual([{ id: ok.id, scope: '' }]);
    expect((await linkRow(old.id))!.is_default).toBe(0);
    expect((await auditRows(user.id)).map((a) => a.detail.id)).toEqual([old.id, ok.id]);
  });

  it('POST /default: the switch is one transaction — when setting the new default fails, the old one is still the default', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const a = await createAccount(api, inst);
    const b = await createAccount(api, inst);
    const la = await link(api, card, a, { isDefault: true });
    const lb = await link(api, card, b);
    const before = await snapshot();
    const r = await failing('UPDATE', 'account_card_links', `NEW.id = '${lb.id}'`, () => api.post(`/api/card-links/${lb.id}/default`));
    expect(r.status).toBe(500);
    expect(await snapshot()).toEqual(before);
    expect(await defaults(card)).toEqual([{ id: la.id, scope: '' }]);
  });

  it('end / delete: a failing audit insert rolls the change back; the audit never reports what did not happen', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst);
    const l = await link(api, card, acc, { isDefault: true });
    for (const [action, call] of [
      ['card_link.end', () => api.post(`/api/card-links/${l.id}/end`)],
      ['card_link.delete', () => api.del(`/api/card-links/${l.id}`)],
    ] as const) {
      const before = await snapshot();
      expect((await failing('INSERT', 'audit_log', `NEW.action = '${action}'`, call)).status, action).toBe(500);
      expect(await snapshot(), action).toEqual(before);
    }
    // A failing update (end) or delete rolls back the audit record written before it in the batch.
    for (const [event, call] of [
      ['UPDATE', () => api.post(`/api/card-links/${l.id}/end`)],
      ['DELETE', () => api.del(`/api/card-links/${l.id}`)],
    ] as const) {
      const before = await snapshot();
      expect((await failing(event, 'account_card_links', null, call)).status, event).toBe(500);
      expect(await snapshot(), event).toEqual(before);
    }
    expect((await auditRows(user.id)).map((a) => a.action)).toEqual(['card_link.create']);
  });

  it('concurrent default switches on one card and scope: always exactly one default, and it is one of the two', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const links = [];
    for (let i = 0; i < 4; i++) links.push(await link(api, card, await createAccount(api, inst)));
    for (let round = 0; round < 3; round++) {
      const results = await Promise.all(links.map((l) => api.post(`/api/card-links/${l.id}/default`)));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      const d = await defaults(card);
      expect(d).toHaveLength(1);
      expect(links.map((l) => l.id)).toContain(d[0]!.id);
    }
    // Concurrent creates with isDefault too.
    const created = await Promise.all([0, 1, 2].map(async () => api.post('/api/card-links', { cardId: card, accountId: await createAccount(api, inst), isDefault: true })));
    expect(created.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(await defaults(card)).toHaveLength(1);
  });

  it('suspended (or ended) between the check and the switch: 409 LINK_STATE and the old default is NOT cleared', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const la = await link(api, card, await createAccount(api, inst), { isDefault: true });
    for (const [status, sql] of [
      ['suspended', "UPDATE account_card_links SET status = 'suspended' WHERE id = ?"],
      ['ended', "UPDATE account_card_links SET status = 'ended', ended_on = '2026-01-01' WHERE id = ?"],
    ] as const) {
      const lb = await link(api, card, await createAccount(api, inst));
      const spy = beforeNextBatch(() => e.exec(sql, lb.id));
      const r = await api.post(`/api/card-links/${lb.id}/default`);
      spy.mockRestore();
      expect(r.status, status).toBe(409);
      expect(r.json).toMatchObject({ code: 'LINK_STATE', details: { status } });
      expect(await defaults(card)).toEqual([{ id: la.id, scope: '' }]);
    }
    // Re-roled in between: 400, old default kept.
    const lc = await link(api, card, await createAccount(api, inst));
    const spy = beforeNextBatch(() => e.exec("UPDATE account_card_links SET role = 'other' WHERE id = ?", lc.id));
    expect((await api.post(`/api/card-links/${lc.id}/default`)).status).toBe(400);
    spy.mockRestore();
    // Deleted in between: 404.
    const ld = await link(api, card, await createAccount(api, inst));
    const spy2 = beforeNextBatch(() => e.exec('DELETE FROM account_card_links WHERE id = ?', ld.id));
    expect((await api.post(`/api/card-links/${ld.id}/default`)).status).toBe(404);
    spy2.mockRestore();
    expect(await defaults(card)).toEqual([{ id: la.id, scope: '' }]);
  });

  it('create racing other writes: a currency closed, a card deleted or a twin created after the checks — the right error, the old default kept, nothing written', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst, ['USD', 'EUR']);
    const old = await link(api, card, acc, { currency: 'EUR', isDefault: true });
    const auditsBefore = (await auditRows(user.id)).length;

    let spy = beforeNextBatch(() => e.exec("UPDATE account_currencies SET status = 'closed' WHERE account_id = ? AND currency = 'EUR'", acc));
    let before = await m2Snapshot();
    let r = await api.post('/api/card-links', { cardId: card, accountId: acc, currency: 'EUR', role: 'other' });
    spy.mockRestore();
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('CURRENCY_NOT_ON_ACCOUNT');
    // (the currency status change is the only difference)
    expect((await m2Snapshot()).account_card_links).toEqual(before.account_card_links);
    await e.exec("UPDATE account_currencies SET status = 'active' WHERE account_id = ? AND currency = 'EUR'", acc);

    // A new default for EUR whose currency closes in between: the old EUR default must stay.
    const acc2 = await createAccount(api, inst, ['USD', 'EUR']);
    spy = beforeNextBatch(() => e.exec("UPDATE account_currencies SET status = 'closed' WHERE account_id = ? AND currency = 'EUR'", acc2));
    r = await api.post('/api/card-links', { cardId: card, accountId: acc2, currency: 'EUR', isDefault: true });
    spy.mockRestore();
    expect(r.json.code).toBe('CURRENCY_NOT_ON_ACCOUNT');
    expect(await defaults(card)).toEqual([{ id: old.id, scope: 'EUR' }]);

    // A twin created in between: 409 DUPLICATE naming it.
    spy = beforeNextBatch(() =>
      e.exec("INSERT INTO account_card_links (id, user_id, card_id, account_id, currency, role, created_at, updated_at) VALUES (?, ?, ?, ?, 'USD', 'top_up_source', 1, 1)", `twin-${engine}`, user.id, card, acc),
    );
    r = await api.post('/api/card-links', { cardId: card, accountId: acc, currency: 'USD', role: 'top_up_source' });
    spy.mockRestore();
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: 'DUPLICATE', details: { existingId: `twin-${engine}` } });

    // The card deleted in between: 404, nothing left behind.
    const doomed = await createCard(api, inst);
    spy = beforeNextBatch(() => e.exec('DELETE FROM cards WHERE id = ?', doomed));
    before = await m2Snapshot();
    r = await api.post('/api/card-links', { cardId: doomed, accountId: acc, isDefault: true });
    spy.mockRestore();
    expect(r.status).toBe(404);
    expect(r.json.code).toBe('NOT_FOUND');
    const after = await m2Snapshot();
    expect(after.account_card_links).toEqual(before.account_card_links);
    expect(after.audit_log).toEqual(before.audit_log);
    expect((await auditRows(user.id)).length).toBe(auditsBefore);
    expect(await e.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('PATCH racing a default switch or an end: a role change still clears the default (never a CHECK failure); a concurrent end wins', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst);
    const l = await link(api, card, acc);
    // Made the default after PATCH read the row (it was not the default then).
    let spy = beforeNextBatch(() => e.exec('UPDATE account_card_links SET is_default = 1 WHERE id = ?', l.id));
    let r = await api.patch(`/api/card-links/${l.id}`, { role: 'top_up_source' });
    spy.mockRestore();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ role: 'top_up_source', isDefault: false });
    await api.patch(`/api/card-links/${l.id}`, { role: 'spending_source' });
    // Ended in between: the status change is refused, the end stands.
    spy = beforeNextBatch(() => e.exec("UPDATE account_card_links SET status = 'ended', is_default = 0, ended_on = '2026-01-01' WHERE id = ?", l.id));
    r = await api.patch(`/api/card-links/${l.id}`, { status: 'suspended' });
    spy.mockRestore();
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('LINK_STATE');
    expect(await linkRow(l.id)).toMatchObject({ status: 'ended', ended_on: '2026-01-01' });
  });

  it('concurrent end and delete requests: one succeeds, the others get 409 / 404 — and exactly one audit record each', async () => {
    const { api, user } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst);
    const l = await link(api, card, acc, { isDefault: true });
    const ends = await Promise.all([0, 1, 2].map(() => api.post(`/api/card-links/${l.id}/end`)));
    expect(ends.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const dels = await Promise.all([0, 1, 2].map(() => api.del(`/api/card-links/${l.id}`)));
    expect(dels.map((r) => r.status).sort()).toEqual([200, 404, 404]);
    expect((await auditRows(user.id)).map((a) => a.action)).toEqual(['card_link.create', 'card_link.end', 'card_link.delete']);
  });

  it('deleting or archiving the things a link points at leaves no orphan: card delete and account delete cascade; a referenced currency cannot be removed; archiving an institution changes nothing', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst, ['USD', 'EUR']);
    const other = await createAccount(api, inst, ['USD']);
    const eur = await link(api, card, acc, { currency: 'EUR' });
    const l2 = await link(api, card, other);
    // A currency used by a link (even an ended one) cannot be removed — only closed.
    await api.post(`/api/card-links/${eur.id}/end`);
    const put = await api.req('PUT', `/api/accounts/${acc}/currencies`, { currencies: [{ code: 'USD', isDefault: true }] });
    expect(put.status).toBe(409);
    expect(put.json.code).toBe('CURRENCY_IN_USE');
    expect((await api.patch(`/api/institutions/${inst}`, { status: 'archived' })).status).toBe(200);
    expect((await api.get(`/api/cards/${card}`)).json.links).toHaveLength(2);
    expect((await api.del(`/api/accounts/${acc}`)).status).toBe(200);
    expect(await e.all('SELECT id FROM account_card_links WHERE id = ?', eur.id)).toEqual([]);
    expect((await api.del(`/api/cards/${card}`)).status).toBe(200);
    expect(await e.all('SELECT id FROM account_card_links WHERE id = ?', l2.id)).toEqual([]);
    expect(await e.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(await e.all('SELECT l.id FROM account_card_links l LEFT JOIN cards c ON c.id = l.card_id LEFT JOIN accounts a ON a.id = l.account_id WHERE c.id IS NULL OR a.id IS NULL')).toEqual([]);
  });

  it('links to inactive cards or accounts can be recorded (history), but are not recommended', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst, { status: 'closed' });
    const acc = await createAccount(api, inst, ['USD'], { status: 'frozen' });
    const l = await link(api, card, acc, { isDefault: true });
    expect(l).toMatchObject({ status: 'active', isDefault: true, card: { status: 'closed' }, account: { status: 'frozen' } });
    expect(pick(await recommend(api, card, 'USD'))).toEqual({ match: 'no_match', eventCurrency: 'USD', reason: 'card_inactive' });
    await api.patch(`/api/cards/${card}`, { status: 'active' });
    expect(pick(await recommend(api, card, 'USD'))).toEqual({ match: 'no_match', eventCurrency: 'USD', reason: 'no_eligible_link' });
  });

  it('R-1: every link route needs a session; writes need the CSRF header and an allowed Origin', async () => {
    const { api } = await signIn();
    const inst = await institution(api);
    const card = await createCard(api, inst);
    const acc = await createAccount(api, inst);
    const l = await link(api, card, acc);
    const anon = client(e.t);
    const routes: [string, string, unknown?][] = [
      ['POST', '/api/card-links', { cardId: card, accountId: acc, role: 'other' }],
      ['PATCH', `/api/card-links/${l.id}`, { notes: 'x' }],
      ['POST', `/api/card-links/${l.id}/default`, {}],
      ['POST', `/api/card-links/${l.id}/end`, {}],
      ['DELETE', `/api/card-links/${l.id}`],
      ['GET', `/api/cards/${card}/spending-source?currency=USD`],
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
    expect((await api.get(`/api/cards/${card}/spending-source?currency=USD`)).res.headers.get('cache-control')).toBe('no-store');
    const missing = 'x'.repeat(26);
    for (const [method, path, b] of [
      ['PATCH', `/api/card-links/${missing}`, { notes: 'x' }],
      ['POST', `/api/card-links/${missing}/default`, {}],
      ['POST', `/api/card-links/${missing}/end`, {}],
      ['DELETE', `/api/card-links/${missing}`],
    ] as const) {
      expect((await api.req(method, path, b)).status, `${method} ${path}`).toBe(404);
    }
  });
});
