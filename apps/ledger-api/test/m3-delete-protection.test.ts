// M3-B2-C2: the M2 deletes protect M3 history (API_SPEC §5.12, DATA_MODEL §10.11 L5; TEST_PLAN
// DEL-1, DEL-6, D-4, D-5, CC-5) — DELETE /accounts/:id, PUT /accounts/:id/currencies, DELETE
// /cards/:id, DELETE /payment-channels/:id — and the trusted reading of database errors on those
// paths. Every case runs on libsql and on wrangler's local in-memory D1 through the real HTTP app.
// Superseded versions and voids are built with the M3-B1 chains (no M3-B3 route). Fictional data.
import { DrizzleQueryError, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { accounts, cards, paymentChannels } from '../src/db/schema.ts';
import { dbMessages } from '../src/lib/dbErrors.ts';
import { isForeignKeyViolation } from '../src/lib/guards.ts';
import {
  batchHooks,
  driverError,
  factCorrection,
  INTERNAL,
  LEAKS,
  quietly,
  raising,
  seedUser,
  spend,
  startEngine,
  voidTxn,
  type Engine,
  type Rows,
  type Seed,
} from './transactions-kit.ts';

type Body = Record<string, unknown>;

describe.each(['libsql', 'd1'] as const)('M2 deletes protect M3 history on %s', (engine) => {
  let e: Engine;
  beforeAll(async () => {
    e = await startEngine(engine, 'xui-v1-del-protect-d1');
  }, 180_000);
  afterAll(async () => {
    await e?.dispose();
  });
  beforeEach(() => e.ping());
  afterEach(() => vi.restoreAllMocks());

  let seq = 0;
  const created = async (s: Seed, body: Body) => {
    const r = await s.post(body);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json as { transactionId: string; eventId: string };
  };
  const newAccount = async (s: Seed, currencies: { code: string; isDefault?: boolean }[] = [{ code: 'USD', isDefault: true }], accountType = 'bank') => {
    const r = await s.api.post('/api/accounts', { institutionId: s.I, name: `Extra ${++seq}`, accountType, accountCountry: 'SG', currencies });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.id as string;
  };
  const newCard = async (s: Seed) => (await s.api.post('/api/cards', { issuerInstitutionId: s.I, name: `Extra card ${++seq}`, network: 'visa', cardType: 'debit', last4: '9999', issuingCountry: 'BE' })).json.card.id as string;
  const newChannel = async (s: Seed, x: Body = {}) => (await s.api.post('/api/payment-channels', { name: `Extra wallet ${++seq}`, channelType: 'payment_service', ...x })).json.id as string;
  /** A spend on `accountId` (in `currency`), optionally with a card and channel. */
  const spendOn = (s: Seed, accountId: string, currency = 'USD', x: Body = {}) =>
    created(s, spend(s, { cardId: null, ...x, entries: [{ direction: 'out', accountId, currency, amountStatus: 'confirmed', amount: 500 }] }));
  const sqlError = (sql: string, ...args: unknown[]) =>
    e.exec(sql, ...args).then(
      () => 'no error',
      (err: unknown) => dbMessages(err).join(' | ') || String(err),
    );
  const audits = async (userId: string, action: string) => (await e.all('SELECT detail FROM audit_log WHERE user_id = ? AND action = ? ORDER BY rowid', userId, action)).map((r) => JSON.parse(String(r.detail)));
  /** Everything an account delete would cascade to, and the account itself. */
  const accountState = async (id: string) => ({
    account: await e.all('SELECT * FROM accounts WHERE id = ?', id),
    currencies: await e.all('SELECT * FROM account_currencies WHERE account_id = ? ORDER BY currency', id),
    links: await e.all('SELECT * FROM account_card_links WHERE account_id = ? ORDER BY id', id),
    sources: await e.all('SELECT * FROM payment_channel_sources WHERE account_id = ? ORDER BY id', id),
  });
  const accountInUse = (balanceOfChannels: number, transactions: number, channels: unknown[] = []) => ({
    error: expect.any(String),
    code: 'IN_USE',
    details: { references: { balanceOfChannels, transactions }, channels },
  });
  const transactionsInUse = (transactions: number) => ({ error: expect.any(String), code: 'IN_USE', details: { references: { transactions } } });

  // ================================================================== DELETE /accounts/:id (DEL-1, D-4, D-5)

  it('DEL-1 / D-5: an account referenced by a current version, only by a superseded version, or only by a voided transaction is 409 IN_USE with exact details; nothing changes; raw SQL fails too', async () => {
    const s = await seedUser(e);
    const current = await newAccount(s);
    await spendOn(s, current);
    const superseded = await newAccount(s);
    const moved = await spendOn(s, superseded);
    await factCorrection(e, s, moved.transactionId, {}, { accountId: s.US, currency: 'USD' }); // v2 on another account
    const voided = await newAccount(s);
    const v = await spendOn(s, voided);
    await voidTxn(e, s, v.transactionId);
    // A link and a channel source on the account (they would be cascaded by a delete).
    expect((await s.api.post('/api/card-links', { cardId: s.K, accountId: current, currency: 'USD', role: 'spending_source' })).status).toBe(201);
    expect((await s.api.post(`/api/payment-channels/${s.PP}/sources`, { accountId: current })).status).toBe(201);
    for (const id of [current, superseded, voided]) {
      const before = await accountState(id);
      const r = await s.api.del(`/api/accounts/${id}`);
      expect([r.status, r.json]).toEqual([409, accountInUse(0, 1)]);
      expect(await accountState(id)).toEqual(before);
      expect(await sqlError('DELETE FROM accounts WHERE id = ?', id)).toMatch(/FOREIGN KEY constraint failed/);
    }
    expect(await audits(s.id, 'account.delete')).toEqual([]);
  });

  it('DEL-1: transactions are counted once — several versions and several transactions; with a balance channel both counts and the channel are reported', async () => {
    const s = await seedUser(e);
    const acc = await newAccount(s, [{ code: 'USD', isDefault: true }], 'e_money');
    const a = await spendOn(s, acc);
    await factCorrection(e, s, a.transactionId, { merchantName: 'v2' });
    await factCorrection(e, s, a.transactionId, { merchantName: 'v3' });
    await spendOn(s, acc);
    // Two transactions, four entries on the account across their versions.
    expect(Number((await e.all('SELECT count(*) AS n FROM transaction_entries WHERE funding_account_id = ?', acc))[0]!.n)).toBe(4);
    expect((await s.api.del(`/api/accounts/${acc}`)).json).toEqual(accountInUse(0, 2));
    const channel = await newChannel(s, { balanceAccountId: acc });
    const [summary] = (await e.all('SELECT id, name, channel_type, status FROM payment_channels WHERE id = ?', channel)) as Rows;
    expect((await s.api.del(`/api/accounts/${acc}`)).json).toEqual(
      accountInUse(1, 2, [{ id: channel, name: summary!.name, channelType: summary!.channel_type, status: summary!.status }]),
    );
  });

  // ================================================================== account delete + audit, one batch (DEL-6, Q8)

  it('DEL-6: a successful delete commits with exactly one account.delete audit ({ id }) and its cascade; refusals and 404s write no audit', async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    const free = await newAccount(a);
    expect((await a.api.post('/api/card-links', { cardId: a.K, accountId: free, role: 'spending_source' })).status).toBe(201);
    const r = await a.api.del(`/api/accounts/${free}`);
    expect([r.status, r.json]).toEqual([200, { ok: true }]);
    expect(await audits(a.id, 'account.delete')).toEqual([{ id: free }]);
    expect(await accountState(free)).toEqual({ account: [], currencies: [], links: [], sources: [] });
    // Refusals: referenced (409), missing / another user's (404), deleted again (404).
    const used = await newAccount(a);
    await spendOn(a, used);
    expect((await a.api.del(`/api/accounts/${used}`)).status).toBe(409);
    const missing = await a.api.del('/api/accounts/no-such-account-000000000000');
    const foreign = await a.api.del(`/api/accounts/${b.HK}`);
    expect([missing.status, foreign.status]).toEqual([404, 404]);
    expect(foreign.json).toEqual(missing.json);
    expect((await a.api.del(`/api/accounts/${free}`)).status).toBe(404);
    expect(await audits(a.id, 'account.delete')).toEqual([{ id: free }]);
    expect(await audits(b.id, 'account.delete')).toEqual([]);
    expect((await b.api.get(`/api/accounts/${b.HK}`)).status).toBe(200);
  });

  it('DEL-6: deleted concurrently after the check → 404 and no audit; a failing audit insert keeps the account; a failing delete leaves no audit', async () => {
    const s = await seedUser(e);
    const gone = await newAccount(s);
    const spy = batchHooks(e, [{ before: () => e.exec('DELETE FROM accounts WHERE id = ?', gone) }]);
    const r = await s.api.del(`/api/accounts/${gone}`);
    expect([r.status, r.json.code]).toEqual([404, 'NOT_FOUND']);
    spy.mockRestore();
    expect(await audits(s.id, 'account.delete')).toEqual([]);

    const keep = await newAccount(s);
    const before = await accountState(keep);
    const auditFails = await raising(e, 'audit_log', 'INSERT', "NEW.action = 'account.delete'", 'TEST_INJECTED_FAILURE', () => s.api.del(`/api/accounts/${keep}`));
    expect([auditFails.status, auditFails.json]).toEqual([500, INTERNAL]);
    expect(await accountState(keep)).toEqual(before);
    const deleteFails = await raising(e, 'accounts', 'DELETE', null, 'TEST_INJECTED_FAILURE', () => s.api.del(`/api/accounts/${keep}`));
    expect([deleteFails.status, deleteFails.json]).toEqual([500, INTERNAL]);
    expect(await accountState(keep)).toEqual(before);
    expect(await audits(s.id, 'account.delete')).toEqual([]);
    // Afterwards it deletes normally, with its one audit.
    expect((await s.api.del(`/api/accounts/${keep}`)).status).toBe(200);
    expect(await audits(s.id, 'account.delete')).toEqual([{ id: keep }]);
  });

  // ================================================================== PUT /accounts/:id/currencies (DEL-1)

  it('DEL-1: a currency referenced by any entry (superseded, voided) or a card link can not be removed — 409 CURRENCY_IN_USE with the union; unreferenced ones go; closing stays allowed', async () => {
    const s = await seedUser(e);
    const acc = await newAccount(s, [{ code: 'SGD', isDefault: true }, { code: 'USD' }, { code: 'EUR' }, { code: 'GBP' }, { code: 'JPY' }]);
    const t = await spendOn(s, acc, 'USD');
    await factCorrection(e, s, t.transactionId, {}, { accountId: s.HK, currency: 'HKD' }); // USD only in the superseded version
    const v = await spendOn(s, acc, 'EUR');
    await voidTxn(e, s, v.transactionId); // EUR only in a voided transaction
    expect((await s.api.post('/api/card-links', { cardId: s.K, accountId: acc, currency: 'GBP', role: 'spending_source' })).status).toBe(201);
    const before = await accountState(acc);
    const put = (currencies: { code: string; isDefault?: boolean; status?: string }[]) => s.api.req('PUT', `/api/accounts/${acc}/currencies`, { currencies });
    const r = await put([{ code: 'SGD', isDefault: true }]);
    expect([r.status, r.json]).toEqual([409, { error: expect.any(String), code: 'CURRENCY_IN_USE', details: { currencies: ['EUR', 'GBP', 'USD'] } }]);
    expect(await accountState(acc)).toEqual(before);
    expect(await sqlError("DELETE FROM account_currencies WHERE account_id = ? AND currency = 'USD'", acc)).toMatch(/FOREIGN KEY constraint failed/);
    // JPY is referenced by nothing: removing it alone works; closing a referenced one works.
    expect((await put([{ code: 'SGD', isDefault: true }, { code: 'USD', status: 'closed' }, { code: 'EUR' }, { code: 'GBP' }])).status).toBe(200);
    expect((await e.all('SELECT currency, status FROM account_currencies WHERE account_id = ? ORDER BY currency', acc)).map((x) => `${x.currency}:${x.status}`)).toEqual([
      'EUR:active', 'GBP:active', 'SGD:active', 'USD:closed',
    ]);
  });

  // ================================================================== DELETE /cards/:id and /payment-channels/:id (DEL-1)

  it('DEL-1: a card or channel used by a current version, only a superseded version or only a voided transaction is 409 IN_USE { references: { transactions } }; counted once per transaction', async () => {
    const s = await seedUser(e);
    const [kCurrent, kSuperseded, kVoided, kMany] = [await newCard(s), await newCard(s), await newCard(s), await newCard(s)];
    const [pCurrent, pSuperseded, pVoided, pMany] = [await newChannel(s), await newChannel(s), await newChannel(s), await newChannel(s)];
    await created(s, spend(s, { cardId: kCurrent, paymentChannelId: pCurrent }));
    const sup = await created(s, spend(s, { cardId: kSuperseded, paymentChannelId: pSuperseded }));
    await factCorrection(e, s, sup.transactionId, { cardId: null, paymentChannelId: null });
    const vo = await created(s, spend(s, { cardId: kVoided, paymentChannelId: pVoided }));
    await voidTxn(e, s, vo.transactionId);
    const many = await created(s, spend(s, { cardId: kMany, paymentChannelId: pMany }));
    await factCorrection(e, s, many.transactionId, { merchantName: 'again' });
    await created(s, spend(s, { cardId: kMany, paymentChannelId: pMany }));
    const cardState = async (id: string) => ({
      card: await e.all('SELECT * FROM cards WHERE id = ?', id),
      links: await e.all('SELECT * FROM account_card_links WHERE card_id = ?', id),
      sources: await e.all('SELECT * FROM payment_channel_sources WHERE card_id = ?', id),
    });
    expect((await s.api.post('/api/card-links', { cardId: kCurrent, accountId: s.HK, role: 'spending_source' })).status).toBe(201);
    expect((await s.api.post(`/api/payment-channels/${pCurrent}/sources`, { cardId: kCurrent })).status).toBe(201);
    for (const [card, n] of [[kCurrent, 1], [kSuperseded, 1], [kVoided, 1], [kMany, 2]] as const) {
      const before = await cardState(card);
      const r = await s.api.del(`/api/cards/${card}`);
      expect([r.status, r.json]).toEqual([409, transactionsInUse(n)]);
      expect(await cardState(card)).toEqual(before);
      expect(await sqlError('DELETE FROM cards WHERE id = ?', card)).toMatch(/FOREIGN KEY constraint failed/);
    }
    for (const [channel, n] of [[pCurrent, 1], [pSuperseded, 1], [pVoided, 1], [pMany, 2]] as const) {
      const before = await e.all('SELECT * FROM payment_channel_sources WHERE channel_id = ? ORDER BY id', channel);
      const r = await s.api.del(`/api/payment-channels/${channel}`);
      expect([r.status, r.json]).toEqual([409, transactionsInUse(n)]);
      expect(await e.all('SELECT * FROM payment_channel_sources WHERE channel_id = ? ORDER BY id', channel)).toEqual(before);
      expect((await e.all('SELECT id FROM payment_channels WHERE id = ?', channel))).toHaveLength(1);
      expect(await sqlError('DELETE FROM payment_channels WHERE id = ?', channel)).toMatch(/FOREIGN KEY constraint failed/);
    }
    expect([...(await audits(s.id, 'card.delete')), ...(await audits(s.id, 'channel.delete'))]).toEqual([]);
    // Unreferenced ones still delete, with their audits.
    const freeCard = await newCard(s);
    const freeChannel = await newChannel(s);
    expect((await s.api.del(`/api/cards/${freeCard}`)).status).toBe(200);
    expect((await s.api.del(`/api/payment-channels/${freeChannel}`)).status).toBe(200);
    expect((await audits(s.id, 'card.delete')).map((d) => d.id)).toEqual([freeCard]);
    expect(await audits(s.id, 'channel.delete')).toEqual([{ id: freeChannel }]);
  });

  it("isolation: another user's referenced account, card or channel and a missing id are the same 404 — never a 409 that would reveal it", async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    await created(b, spend(b, { paymentChannelId: b.PP }));
    for (const [path, foreignId] of [['accounts', b.HK], ['cards', b.K], ['payment-channels', b.PP]] as const) {
      const foreign = await a.api.del(`/api/${path}/${foreignId}`);
      const missing = await a.api.del(`/api/${path}/no-such-id-00000000000000000`);
      expect([foreign.status, foreign.json], path).toEqual([404, missing.json]);
      expect(Object.keys(foreign.json).sort()).toEqual(['code', 'error']);
    }
    const put = await a.api.req('PUT', `/api/accounts/${b.HK}/currencies`, { currencies: [{ code: 'HKD', isDefault: true }] });
    expect(put.status).toBe(404);
    expect((await b.api.get(`/api/cards/${b.K}`)).status).toBe(200);
  });

  // ================================================================== create vs delete (CC-5)

  it('CC-5: a transaction created between the check and the delete wins — the NO ACTION key refuses, the route re-counts → 409, nothing deleted, no audit', async () => {
    const s = await seedUser(e);
    const acc = await newAccount(s);
    const card = await newCard(s);
    const channel = await newChannel(s);
    const cases: [string, () => Promise<{ status: number; json: any }>, unknown][] = [
      ['account', () => s.api.del(`/api/accounts/${acc}`), accountInUse(0, 1)],
      ['card', () => s.api.del(`/api/cards/${card}`), transactionsInUse(1)],
      ['channel', () => s.api.del(`/api/payment-channels/${channel}`), transactionsInUse(1)],
    ];
    const bodies: Record<string, Body> = {
      account: spend(s, { cardId: null, entries: [{ direction: 'out', accountId: acc, currency: 'USD', amountStatus: 'confirmed', amount: 1 }] }),
      card: spend(s, { cardId: card }),
      channel: spend(s, { paymentChannelId: channel }),
    };
    for (const [what, del, expected] of cases) {
      // The delete's own batch runs right after a create commits (its batch passes through unchanged).
      const spy = batchHooks(e, [{ before: () => created(s, bodies[what]!) }]);
      const r = await del();
      expect([r.status, r.json], what).toEqual([409, expected]);
      spy.mockRestore();
    }
    expect(await e.all('SELECT * FROM accounts WHERE id = ?', acc)).toHaveLength(1);
    expect(await e.all('SELECT * FROM cards WHERE id = ?', card)).toHaveLength(1);
    expect(await e.all('SELECT * FROM payment_channels WHERE id = ?', channel)).toHaveLength(1);
    expect(await audits(s.id, 'account.delete')).toEqual([]);
    expect(await e.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('CC-5: a delete between the checks and the create batch wins — the create is 404 and writes nothing; no dangling reference either way', async () => {
    const s = await seedUser(e);
    for (const what of ['account', 'card', 'channel'] as const) {
      const id = what === 'account' ? await newAccount(s) : what === 'card' ? await newCard(s) : await newChannel(s);
      const body =
        what === 'account'
          ? spend(s, { cardId: null, entries: [{ direction: 'out', accountId: id, currency: 'USD', amountStatus: 'confirmed', amount: 1 }] })
          : spend(s, what === 'card' ? { cardId: id } : { paymentChannelId: id });
      const path = what === 'account' ? 'accounts' : what === 'card' ? 'cards' : 'payment-channels';
      const spy = batchHooks(e, [{ before: async () => expect((await s.api.del(`/api/${path}/${id}`)).status).toBe(200) }]);
      const r = await s.post(body);
      expect([r.status, r.json.code], what).toEqual([404, 'NOT_FOUND']);
      spy.mockRestore();
    }
    expect(Number((await e.all('SELECT count(*) AS n FROM transactions WHERE user_id = ?', s.id))[0]!.n)).toBe(0);
    expect(await e.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  // ================================================================== trusted error reading on the four paths (security fix)

  it('real driver errors are recognized: a refused delete as a single statement (wrapped by drizzle) and inside a batch', async () => {
    const s = await seedUser(e);
    const acc = await newAccount(s);
    await spendOn(s, acc);
    await created(s, spend(s, { paymentChannelId: s.PP })); // references card K and channel PP
    const db = e.t.db;
    const single = await db.delete(accounts).where(eq(accounts.id, acc)).then(() => null, (err: unknown) => err);
    const inBatch = await db.batch([db.delete(cards).where(eq(cards.id, s.K))]).then(() => null, (err: unknown) => err);
    const channel =await db.batch([db.delete(paymentChannels).where(eq(paymentChannels.id, s.PP))]).then(() => null, (err: unknown) => err);
    for (const err of [single, inBatch, channel]) {
      expect(isForeignKeyViolation(err)).toBe(true);
      expect(dbMessages(err).join(' | ')).not.toMatch(/Failed query|params:/);
    }
    // The single statement is wrapped in drizzle's DrizzleQueryError, whose text holds the bound id.
    expect(single).toBeInstanceOf(DrizzleQueryError);
    expect(String((single as Error).message)).toContain(acc);
  });

  it('spoofed or unverified errors are never read as a foreign-key refusal on any of the four paths — generic 500, nothing changed', async () => {
    const s = await seedUser(e);
    const acc = await newAccount(s, [{ code: 'USD', isDefault: true }, { code: 'EUR' }]);
    const card = await newCard(s);
    const channel = await newChannel(s);
    const fkText = 'FOREIGN KEY constraint failed';
    const fakes: [string, () => Error][] = [
      // drizzle's wrapper whose bound values spell a foreign-key failure, around a different (CHECK) driver error
      ['wrapper params', () => new DrizzleQueryError('delete from "x" where "id" = ?', [fkText, `${fkText}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)`], driverError(e.name, 'CHECK constraint failed: x_ck', 'SQLITE_CONSTRAINT_CHECK'))],
      // a plain Error of no verified driver shape
      ['plain error', () => Object.assign(new Error(fkText), { code: 'SQLITE_CONSTRAINT' })],
      // a verified-shape CHECK failure is not a foreign-key failure
      ['check', () => driverError(e.name, 'CHECK constraint failed: accounts_country_ck', 'SQLITE_CONSTRAINT_CHECK')],
      // a verified-shape foreign-key failure that nothing explains (no reference exists)
      ['unexplained fk', () => driverError(e.name, fkText, 'SQLITE_CONSTRAINT_FOREIGNKEY')],
    ];
    const paths: [string, () => Promise<{ status: number; json: any }>][] = [
      ['DELETE account', () => s.api.del(`/api/accounts/${acc}`)],
      ['PUT currencies', () => s.api.req('PUT', `/api/accounts/${acc}/currencies`, { currencies: [{ code: 'USD', isDefault: true }] })],
      ['DELETE card', () => s.api.del(`/api/cards/${card}`)],
      ['DELETE channel', () => s.api.del(`/api/payment-channels/${channel}`)],
    ];
    const before = {
      accounts: await accountState(acc),
      card: await e.all('SELECT * FROM cards WHERE id = ?', card),
      channel: await e.all('SELECT * FROM payment_channels WHERE id = ?', channel),
      audit: await e.all('SELECT * FROM audit_log WHERE user_id = ?', s.id),
    };
    for (const [path, call] of paths) {
      for (const [fake, make] of fakes) {
        const spy = batchHooks(e, [{ replace: async () => { throw make(); } }]);
        const r = await quietly(call);
        expect([r.status, r.json], `${path} / ${fake}`).toEqual([500, INTERNAL]);
        expect(JSON.stringify(r.json)).not.toMatch(LEAKS);
        spy.mockRestore();
      }
    }
    expect({
      accounts: await accountState(acc),
      card: await e.all('SELECT * FROM cards WHERE id = ?', card),
      channel: await e.all('SELECT * FROM payment_channels WHERE id = ?', channel),
      audit: await e.all('SELECT * FROM audit_log WHERE user_id = ?', s.id),
    }).toEqual(before);
  });
});
