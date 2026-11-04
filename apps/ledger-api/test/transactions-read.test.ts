// M3-B2-C1: GET /transactions and GET /transactions/:id (API_SPEC §5.3, §5.5; TEST_PLAN ISO-1 / ISO-4
// read parts, REG-3 / REG-8 list parts, IMM-8, BF-6, LST-1 – LST-8). Every case runs on libsql and on
// wrangler's local in-memory D1 through the real HTTP app. Superseded versions and voids are built
// with the M3-B1 write chains (test/m3-ledger.ts) — there is no correction or void route before M3-B3.
// All data is fictional.
import { normalizeNameKey } from '@xui/ledger-shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LIST_SCAN_BATCH } from '../src/services/transactionRead.ts';
import { bytesToBase64Url } from '../src/lib/encoding.ts';
import { nid, type EventFactsIn } from './m3-ledger.ts';
import { factCorrection as kitFactCorrection, ownTransfer, seedUser, spend, startEngine, voidTxn as kitVoidTxn, type Engine, type Seed } from './transactions-kit.ts';

type Body = Record<string, unknown>;
type Item = Record<string, any>;

describe.each(['libsql', 'd1'] as const)('GET /transactions on %s', (engine) => {
  let e: Engine;
  beforeAll(async () => {
    e = await startEngine(engine, 'xui-v1-txn-read-d1');
  }, 180_000);
  afterAll(async () => {
    await e?.dispose();
  });
  beforeEach(() => e.ping());

  const qs = (p: Record<string, string | number | undefined> = {}) => {
    const s = new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined).map(([k, v]): [string, string] => [k, String(v)])).toString();
    return s ? `?${s}` : '';
  };
  const list = async (s: Seed, p: Record<string, string | number | undefined> = {}) => {
    const r = await s.api.get(`/api/transactions${qs(p)}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json as { items: Item[]; nextCursor: string | null };
  };
  /** Every page in order; checks the page-size contract on the way. */
  const pages = async (s: Seed, p: Record<string, string | number | undefined>, limit: number) => {
    const out: Item[][] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 1000; i++) {
      const page = await list(s, { ...p, limit, cursor });
      out.push(page.items);
      if (page.nextCursor === null) break;
      expect(page.items).toHaveLength(limit); // every page but the last is full
      expect(decode(page.nextCursor)).toEqual(positionOf(page.items[page.items.length - 1]!)); // the last RETURNED item
      cursor = page.nextCursor;
    }
    return out;
  };
  const ids = (items: Item[]) => items.map((i) => i.id as string);
  const decode = (cursor: string) => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  const positionOf = (i: Item) => [1, i.event.occurredOn, i.event.occurredTime, i.createdAt, i.id];
  const cursorOf = (raw: unknown) => bytesToBase64Url(new TextEncoder().encode(JSON.stringify(raw)));
  /** The list order, computed independently from the items. */
  const sortedLikeList = (items: Item[]) =>
    [...items].sort((a, b) => {
      const k = (x: Item) => [x.event.occurredOn, x.event.occurredTime === null ? 0 : 1, x.event.occurredTime ?? '', x.createdAt, x.id];
      const [ka, kb] = [k(a), k(b)];
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! < kb[i]! ? 1 : -1;
      return 0;
    });

  const created = async (s: Seed, body: Body) => {
    const r = await s.post(body);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json as Item;
  };
  const day = (base: string, n: number) => new Date(Date.parse(`${base}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  const factCorrection = (s: Seed, T: string, changes: Partial<EventFactsIn>, entryChange?: { accountId: string; currency: string }) => kitFactCorrection(e, s, T, changes, entryChange);
  const voidTxn = (s: Seed, T: string, reason: string | null = null) => kitVoidTxn(e, s, T, reason);

  // ================================================================== detail (§5.5, ISO-1)

  it('detail: the TransactionDto of a new spend — current version, entries with the current account summary, card, channel, one revision; the list item is the same without revisions', async () => {
    const s = await seedUser(e);
    const w = await created(s, spend(s, { paymentChannelId: s.PP, notes: 'dinner' }));
    const r = await s.api.get(`/api/transactions/${w.transactionId}`);
    expect(r.status).toBe(200);
    const now = e.t.clock.t;
    const card = (await s.api.get(`/api/cards/${s.K}`)).json;
    const channel = (await s.api.get(`/api/payment-channels/${s.PP}`)).json;
    const account = (await s.api.get(`/api/accounts/${s.HK}`)).json;
    expect(r.json).toEqual({
      id: w.transactionId, txnType: 'merchant_spend', status: 'active', currentRevision: 1, notes: 'dinner', createdAt: now, updatedAt: now, voidedAt: null, voidReason: null,
      event: w.event,
      entries: [{ ...w.entries[0], account: { id: s.HK, name: account.name, accountCountry: 'HK', status: 'active' } }],
      card: { id: s.K, name: card.name, network: 'visa', last4: '4321', cardType: 'debit', status: 'active' },
      paymentChannel: { id: s.PP, name: channel.name, channelType: 'payment_service', status: 'active' },
      revisions: [{ revision: 1, revisionKind: 'original', correctionReason: null, createdAt: now }],
    });
    // The list item is the detail without its revision list.
    const item = { ...r.json };
    delete item.revisions;
    expect((await list(s)).items).toEqual([item]);
  });

  it("ISO-1: another user's transaction and a missing one are the same 404 (same body, no details); an unpublished residue is invisible", async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    const w = await created(a, spend(a));
    const foreign = await b.api.get(`/api/transactions/${w.transactionId}`);
    const missing = await b.api.get('/api/transactions/no-such-transaction-0000000');
    expect([foreign.status, missing.status]).toEqual([404, 404]);
    expect(foreign.json).toEqual(missing.json);
    expect(foreign.json).toEqual({ error: 'transaction not found', code: 'NOT_FOUND' });
    expect(JSON.stringify(foreign.json)).not.toContain(w.transactionId);
    expect((await a.api.get(`/api/transactions/${w.transactionId}`)).status).toBe(200);
    // A header left at revision 0 by raw SQL (abnormal state, DATA_MODEL §10.11) is never listed or shown.
    const T = nid('T');
    await e.exec('INSERT INTO transactions (id, user_id, txn_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', T, a.id, 'merchant_spend', 1, 1);
    expect((await a.api.get(`/api/transactions/${T}`)).status).toBe(404);
    expect(ids((await list(a, { status: 'all' })).items)).toEqual([w.transactionId]);
    // An unpublished next version (revision 2 > currentRevision 1, raw SQL) is not a revision yet.
    const cols = (await e.all("SELECT name FROM pragma_table_info('transaction_events')")).map((c) => String(c.name));
    const pick = cols.map((c) => ({ id: '?', revision: '2', revision_kind: "'fact_correction'", correction_reason: "'residue'", home_region_source: "'carried'", merchant_name: "'Residue Shop'" })[c] ?? c);
    await e.exec(`INSERT INTO transaction_events (${cols.join(', ')}) SELECT ${pick.join(', ')} FROM transaction_events WHERE id = ?`, nid('E'), w.eventId);
    const d = (await a.api.get(`/api/transactions/${w.transactionId}`)).json;
    expect([d.currentRevision, d.event.revision, d.event.merchantName, d.revisions.length]).toEqual([1, 1, 'Example Store', 1]);
    expect((await list(a, { q: 'residue' })).items).toEqual([]);
  });

  it('strict shape: list items and details carry exactly the contract fields at every level (card = CardSummary with cardType)', async () => {
    const s = await seedUser(e);
    await created(s, spend(s, { paymentChannelId: s.PP }));
    await created(s, ownTransfer(s));
    await created(s, { type: 'third_party_transfer', occurredOn: '2026-10-14', eventCurrency: 'USD', eventAmount: null, counterparty: { country: 'US' }, entries: [{ direction: 'in', accountId: s.CN, currency: 'CNY', amountStatus: 'pending', amount: null }] });
    const keys = (o: object) => Object.keys(o).sort();
    const EVENT = ['cardId', 'classifierVersion', 'correctionReason', 'counterparty', 'createdAt', 'eventAmount', 'eventCurrency', 'eventCurrencyExponent', 'eventId', 'foreignStatus', 'homeRegion', 'homeRegionSource', 'merchantCountry', 'merchantName', 'merchantScope', 'occurredOn', 'occurredTime', 'paymentChannelId', 'postedOn', 'recordMode', 'revision', 'revisionKind', 'transferMethod', 'transferScope'];
    const ENTRY = ['account', 'accountId', 'amount', 'amountStatus', 'carriedFromEntryId', 'closedCurrencyAck', 'countrySource', 'currency', 'currencyExponent', 'currencyStatusAtSave', 'direction', 'entryId', 'fundingAccountCountry'];
    const ITEM = ['card', 'createdAt', 'currentRevision', 'entries', 'event', 'id', 'notes', 'paymentChannel', 'status', 'txnType', 'updatedAt', 'voidReason', 'voidedAt'];
    const check = (i: Item) => {
      expect(keys(i.event)).toEqual(EVENT);
      if (i.event.counterparty !== null) expect(keys(i.event.counterparty)).toEqual(['accountHint', 'country', 'institution', 'kind', 'name']);
      for (const en of i.entries) {
        expect(keys(en)).toEqual(ENTRY);
        expect(keys(en.account)).toEqual(['accountCountry', 'id', 'name', 'status']);
      }
      if (i.card !== null) expect(keys(i.card)).toEqual(['cardType', 'id', 'last4', 'name', 'network', 'status']);
      if (i.paymentChannel !== null) expect(keys(i.paymentChannel)).toEqual(['channelType', 'id', 'name', 'status']);
    };
    const page = await list(s);
    expect(page.items).toHaveLength(3);
    expect(page.items.some((i) => i.card !== null) && page.items.some((i) => i.paymentChannel !== null) && page.items.some((i) => i.event.counterparty !== null)).toBe(true);
    for (const i of page.items) {
      expect(keys(i)).toEqual(ITEM);
      check(i);
      const d = (await s.api.get(`/api/transactions/${i.id}`)).json;
      expect(keys(d)).toEqual([...ITEM, 'revisions'].sort());
      check(d);
      for (const r of d.revisions) expect(keys(r)).toEqual(['correctionReason', 'createdAt', 'revision', 'revisionKind']);
    }
    expect(page.items.find((i) => i.card !== null)!.card.cardType).toBe('debit');
  });

  // ================================================================== versions (IMM-8) and voids

  it('IMM-8: only the current version is listed, filtered and searched; the detail lists every published revision; voided transactions by status', async () => {
    const s = await seedUser(e);
    const w = await created(s, spend(s, { occurredOn: '2026-10-01', merchantName: 'Old Shop' }));
    const T = w.transactionId as string;
    const v2 = await factCorrection(s, T, { occurredOn: '2026-10-10', merchantName: 'New Shop' });
    let d = (await s.api.get(`/api/transactions/${T}`)).json;
    expect(d).toMatchObject({ currentRevision: 2, event: { revision: 2, revisionKind: 'fact_correction', correctionReason: 'fix 1', merchantName: 'New Shop', occurredOn: '2026-10-10' } });
    expect(d.entries).toEqual([expect.objectContaining({ entryId: v2.entryIds[0], countrySource: 'carried', carriedFromEntryId: w.entries[0].entryId, accountId: s.HK })]);
    expect(d.revisions.map((r: Item) => [r.revision, r.revisionKind, r.correctionReason])).toEqual([[1, 'original', null], [2, 'fact_correction', 'fix 1']]);
    expect((await list(s, { q: 'old shop' })).items).toEqual([]);
    expect(ids((await list(s, { q: 'new shop' })).items)).toEqual([T]);
    expect((await list(s, { from: '2026-10-01', to: '2026-10-05' })).items).toEqual([]);
    expect(ids((await list(s, { from: '2026-10-10' })).items)).toEqual([T]);

    // A version on another account: the superseded entry's account no longer matches.
    await factCorrection(s, T, {}, { accountId: s.US, currency: 'USD' });
    expect((await list(s, { accountId: s.HK })).items).toEqual([]);
    expect(ids((await list(s, { accountId: s.US })).items)).toEqual([T]);
    expect((await list(s, { currency: 'HKD' })).items).toEqual([]);
    d = (await s.api.get(`/api/transactions/${T}`)).json;
    expect(d.entries.map((x: Item) => [x.accountId, x.currency, x.countrySource, x.fundingAccountCountry, x.account.id])).toEqual([[s.US, 'USD', 'account_at_save', 'US', s.US]]);
    expect(d.revisions).toHaveLength(3);

    // Voided: out of the default list, in status=voided and all; the detail still shows every version.
    await voidTxn(s, T, 'duplicate');
    const other = await created(s, spend(s));
    expect(ids((await list(s)).items)).toEqual([other.transactionId]);
    expect(ids((await list(s, { status: 'voided' })).items)).toEqual([T]);
    expect(new Set(ids((await list(s, { status: 'all' })).items))).toEqual(new Set([T, other.transactionId]));
    d = (await s.api.get(`/api/transactions/${T}`)).json;
    expect(d).toMatchObject({ status: 'voided', currentRevision: 3, voidedAt: e.t.clock.t, voidReason: 'duplicate', event: { revision: 3 } });
    expect(d.revisions).toHaveLength(3);
  });

  // ================================================================== snapshots and mutable data (BF-6, notes)

  it('BF-6: saved-state snapshots stay, current summaries follow the data — currency status at save, jurisdiction snapshot vs current account', async () => {
    const s = await seedUser(e);
    const w = await created(s, spend(s, { cardId: null, recordMode: 'backfill', occurredOn: '2024-02-01', entries: [{ direction: 'out', accountId: s.BE, currency: 'GBP', amountStatus: 'confirmed', amount: 900, closedCurrencyAck: true }] }));
    await e.exec("UPDATE account_currencies SET status = 'active' WHERE account_id = ? AND currency = 'GBP'", s.BE);
    await e.exec("UPDATE accounts SET account_country = 'SG', status = 'frozen' WHERE id = ?", s.BE);
    expect((await s.api.patch(`/api/accounts/${s.BE}`, { name: 'Renamed e-money' })).status).toBe(200);
    const d = (await s.api.get(`/api/transactions/${w.transactionId}`)).json;
    expect(d.event).toMatchObject({ recordMode: 'backfill', occurredOn: '2024-02-01' });
    expect(d.entries[0]).toMatchObject({
      currency: 'GBP', currencyStatusAtSave: 'closed', closedCurrencyAck: true, fundingAccountCountry: 'BE', countrySource: 'account_at_save',
      account: { id: s.BE, name: 'Renamed e-money', accountCountry: 'SG', status: 'frozen' },
    });
    expect(ids((await list(s, { recordMode: 'backfill' })).items)).toEqual([w.transactionId]);
    expect((await list(s, { recordMode: 'current' })).items).toEqual([]);
  });

  it('notes are header data: after a notes change the detail and list show the new notes and updatedAt, q follows them, the version is unchanged', async () => {
    const s = await seedUser(e);
    const w = await created(s, spend(s, { notes: 'old remark' }));
    const T = w.transactionId as string;
    expect(ids((await list(s, { q: 'old remark' })).items)).toEqual([T]);
    await e.exec("UPDATE transactions SET notes = 'brand new remark', updated_at = ? WHERE id = ?", e.t.clock.t + 5, T);
    const d = (await s.api.get(`/api/transactions/${T}`)).json;
    expect(d).toMatchObject({ notes: 'brand new remark', updatedAt: e.t.clock.t + 5, currentRevision: 1, event: w.event });
    expect((await list(s, { q: 'old remark' })).items).toEqual([]);
    expect((await list(s, { q: 'new remark' })).items.map((i) => i.notes)).toEqual(['brand new remark']);
  });

  it('amounts per currency only: entries in HKD, EUR (pending) and a two-currency transfer are listed as they are — no total, no conversion, no event amount counted as an entry', async () => {
    const s = await seedUser(e);
    await created(s, spend(s));
    await created(s, spend(s, { cardId: null, entries: [{ direction: 'out', accountId: s.BE, currency: 'EUR', amountStatus: 'pending', amount: null }] }));
    const t = await created(s, ownTransfer(s, { entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 780000 }, { direction: 'in', accountId: s.BE, currency: 'EUR', amountStatus: 'confirmed', amount: 91000 }] }));
    const page = await list(s);
    expect(Object.keys(page).sort()).toEqual(['items', 'nextCursor']);
    expect(JSON.stringify(page)).not.toMatch(/total|sum|converted|rate|balance/i);
    const transfer = page.items.find((i) => i.id === t.transactionId)!;
    expect(transfer.entries.map((x: Item) => [x.direction, x.currency, x.amount])).toEqual([['out', 'HKD', 780000], ['in', 'EUR', 91000]]);
    expect(transfer.event).toMatchObject({ eventCurrency: 'USD', eventAmount: 100000 });
    expect(page.items.map((i) => Object.keys(i).sort())).toEqual(page.items.map(() => ['card', 'createdAt', 'currentRevision', 'entries', 'event', 'id', 'notes', 'paymentChannel', 'status', 'txnType', 'updatedAt', 'voidReason', 'voidedAt']));
    expect((await list(s, { currency: 'EUR' })).items).toHaveLength(2);
    expect((await list(s, { amountStatus: 'pending' })).items.map((i) => i.entries[0].currency)).toEqual(['EUR']);
    expect((await list(s, { amountStatus: 'confirmed' })).items).toHaveLength(2);
  });

  // ================================================================== regions in the list (REG-3, REG-8)

  it('REG-3 / REG-8: the three states filter apart (undetermined is not domestic); there is no "not foreign" parameter', async () => {
    const s = await seedUser(e);
    const f = await created(s, spend(s));
    const u1 = await created(s, spend(s, { merchantCountry: null, eventCurrency: 'CNY', cardId: null, entries: [{ direction: 'out', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 1 }] }));
    const u2 = await created(s, { type: 'third_party_transfer', occurredOn: '2026-10-14', eventCurrency: 'CNY', eventAmount: 1, counterparty: { name: 'Someone' }, entries: [{ direction: 'out', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 1 }] });
    expect(ids((await list(s, { foreignStatus: 'foreign' })).items)).toEqual([f.transactionId]);
    expect(new Set(ids((await list(s, { foreignStatus: 'undetermined' })).items))).toEqual(new Set([u1.transactionId, u2.transactionId]));
    expect((await list(s, { foreignStatus: 'domestic' })).items).toEqual([]);
    expect((await list(s, { foreignStatus: 'all' })).items).toHaveLength(3);
    expect((await list(s)).items).toHaveLength(3);
    for (const bad of [{ foreignStatus: 'not_foreign' }, { notForeign: '1' }, { foreignStatus: 'FOREIGN' }]) {
      const r = await s.api.get(`/api/transactions${qs(bad)}`);
      expect([r.status, r.json.code]).toEqual([400, 'VALIDATION']);
    }
  });

  // ================================================================== isolation (ISO-4, LST-6)

  it("ISO-4 / LST-6: lists hold only the caller's transactions — another user's ids as filters give an empty list, another user's cursor is only a position", async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    for (let i = 0; i < 3; i++) await created(a, spend(a, { merchantName: `Shared Name ${i}`, paymentChannelId: a.PP, occurredOn: day('2026-09-01', i) }));
    const mine = await created(b, spend(b, { merchantName: 'Shared Name b', occurredOn: '2026-08-01' }));
    expect(ids((await list(b, { q: 'shared name' })).items)).toEqual([mine.transactionId]);
    expect(ids((await list(b, { status: 'all' })).items)).toEqual([mine.transactionId]);
    for (const p of [{ accountId: a.HK }, { cardId: a.K }, { channelId: a.PP }]) {
      const r = await b.api.get(`/api/transactions${qs(p)}`);
      expect([r.status, r.json]).toEqual([200, { items: [], nextCursor: null }]);
    }
    const aPage = await list(a, { limit: 1 });
    expect(aPage.nextCursor).not.toBeNull();
    // a's cursor in b's request: a position only — b still sees only b's rows after it.
    expect(ids((await list(b, { cursor: aPage.nextCursor! })).items)).toEqual([mine.transactionId]);
    expect((await b.api.get(`/api/transactions/${aPage.items[0]!.id}`)).status).toBe(404);
  });

  // ================================================================== order and pages (LST-1, LST-2)

  /** Ties on every sort column but the id: same date, same time (or none), same createdAt (fixed test clock). */
  async function tieSet(s: Seed) {
    const out: Item[] = [];
    for (let i = 0; i < 4; i++) out.push(await created(s, spend(s, { occurredOn: '2026-10-05', occurredTime: '09:30', merchantName: `Tie ${i}` })));
    for (let i = 0; i < 3; i++) out.push(await created(s, spend(s, { occurredOn: '2026-10-05', occurredTime: null, merchantName: `No time ${i}` })));
    out.push(await created(s, spend(s, { occurredOn: '2026-10-05', occurredTime: '23:59', merchantName: 'Late' })));
    e.t.advance(1);
    out.push(await created(s, spend(s, { occurredOn: '2026-10-05', occurredTime: '09:30', merchantName: 'Tie later created' })));
    out.push(await created(s, spend(s, { occurredOn: '2026-10-06', occurredTime: null, merchantName: 'Next day' })));
    out.push(await created(s, spend(s, { occurredOn: '2026-10-04', occurredTime: '00:00', merchantName: 'Day before' })));
    return out;
  }

  it('LST-1: a total order — date desc, time desc with no-time last, createdAt desc, id desc — stable across requests', async () => {
    const s = await seedUser(e);
    await tieSet(s);
    const first = (await list(s)).items;
    expect(first).toHaveLength(11);
    expect(ids(first)).toEqual(ids(sortedLikeList(first)));
    expect(first.map((i) => i.event.merchantName).slice(0, 3)).toEqual(['Next day', 'Late', 'Tie later created']);
    expect(first.slice(-4).map((i) => i.event.occurredTime)).toEqual([null, null, null, '00:00']);
    const tied = first.filter((i) => /^Tie \d$/.test(i.event.merchantName));
    expect(ids(tied)).toEqual(ids(tied).sort().reverse()); // the id decides among full ties
    expect(ids((await list(s)).items)).toEqual(ids(first));
  });

  it('LST-2: paging without q — every limit gives each transaction exactly once in the one-page order; pages are full but the last; ties on page borders are kept', async () => {
    const s = await seedUser(e);
    await tieSet(s);
    const all = ids((await list(s, { limit: 100 })).items);
    for (const limit of [1, 2, 3, 4, 50, 100]) {
      const got = (await pages(s, {}, limit)).flat();
      expect(ids(got), `limit ${limit}`).toEqual(all);
    }
  });

  // ================================================================== search (LST-3, LST-4, LST-5)

  it(`LST-3: q pages over the filtered matches — sparse matches across several scan batches (${LIST_SCAN_BATCH} rows), dense, exactly limit, limit + 1, none`, async () => {
    const s = await seedUser(e);
    const total = Math.floor(LIST_SCAN_BATCH * 2.3);
    const needleAt = new Set([5, Math.floor(LIST_SCAN_BATCH * 1.2), total - 5]);
    for (let i = 0; i < total; i++) await created(s, spend(s, { occurredOn: day('2025-01-01', i), merchantName: needleAt.has(i) ? `Rare Needle ${i}` : `Plain ${i}` }));
    // Sparse, limit 1: three pages; the last one stops after scanning the rest, without an empty extra page.
    const sparse = await pages(s, { q: 'rare needle' }, 1);
    expect(sparse.map((p) => p.map((i) => i.event.merchantName))).toEqual([...needleAt].sort((x, y) => y - x).map((i) => [`Rare Needle ${i}`]));
    // Exactly limit → one page and no cursor; limit + 1 → a cursor, then the last match.
    expect(await list(s, { q: 'rare needle', limit: 3 })).toMatchObject({ nextCursor: null });
    const two = await pages(s, { q: 'rare needle' }, 2);
    expect(two.map((p) => p.length)).toEqual([2, 1]);
    // Dense: q matching everything pages exactly like no q.
    expect(ids((await pages(s, { q: 'n' }, 37)).flat())).toEqual(ids((await pages(s, {}, 100)).flat()));
    expect(await list(s, { q: 'no such text' })).toEqual({ items: [], nextCursor: null });
  }, 120_000);

  it('LST-4: normalized matching (NFKC, case, whitespace) on merchant, counterparty and notes only; %, _ and \\ are literal', async () => {
    const s = await seedUser(e);
    const w = await created(s, spend(s, { merchantName: 'ＷＩＳＥ   Store' }));
    const c = await created(s, { type: 'third_party_transfer', occurredOn: '2026-10-14', eventCurrency: 'HKD', eventAmount: 100, counterparty: { name: 'Ａｌｉｃｅ  Chan' }, entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 100 }] });
    const n = await created(s, spend(s, { merchantName: 'Cafe', notes: 'Trip\tto   Tokyo' }));
    const pct = await created(s, spend(s, { merchantName: '100% Shop' }));
    const und = await created(s, spend(s, { merchantName: 'a_b corner' }));
    const bs = await created(s, spend(s, { merchantName: 'back\\slash' }));
    await created(s, spend(s, { merchantName: 'Abc corner 1000' }));
    expect((await s.api.patch(`/api/accounts/${s.HK}`, { name: 'Zebra Account' })).status).toBe(200);
    const found = async (q: string) => new Set(ids((await list(s, { q })).items));
    for (const q of ['wise store', 'WISE STORE', '  wise   store ', 'ｗｉｓｅ ｓｔｏｒｅ']) expect(await found(q), q).toEqual(new Set([w.transactionId]));
    expect(await found('alice chan')).toEqual(new Set([c.transactionId]));
    expect(await found('trip to tokyo')).toEqual(new Set([n.transactionId]));
    expect(await found('%')).toEqual(new Set([pct.transactionId]));
    expect(await found('_')).toEqual(new Set([und.transactionId]));
    expect(await found('\\')).toEqual(new Set([bs.transactionId]));
    // Not searched: account names, amounts, ids, card names.
    for (const q of ['zebra', '7830', w.transactionId, 'Card']) expect(await found(q), q).toEqual(new Set());
    expect(normalizeNameKey('ＷＩＳＥ   Store')).toBe('wise store');
  });

  it('LST-5: q combined with every filter is the intersection of the parts', async () => {
    const s = await seedUser(e);
    const bodies: Body[] = [
      spend(s, { merchantName: 'Combo Alpha', occurredOn: '2026-09-01' }),
      spend(s, { merchantName: 'Combo Beta', occurredOn: '2026-09-05', cardId: null, paymentChannelId: s.PP, entries: [{ direction: 'out', accountId: s.BE, currency: 'EUR', amountStatus: 'pending', amount: null }] }),
      spend(s, { merchantName: 'Combo Gamma', merchantCountry: null, eventCurrency: 'CNY', cardId: null, recordMode: 'backfill', occurredOn: '2025-05-05', entries: [{ direction: 'out', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 1 }] }),
      spend(s, { type: 'merchant_refund', merchantName: 'Combo Delta', occurredOn: '2026-10-01', entries: [{ direction: 'in', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 5 }] }),
      { ...ownTransfer(s, { occurredOn: '2026-09-20', notes: 'combo transfer' }) },
      spend(s, { merchantName: 'Unrelated', occurredOn: '2026-09-02' }),
    ];
    const made: Item[] = [];
    for (const b of bodies) made.push(await created(s, b));
    await voidTxn(s, made[0]!.transactionId);
    const everything = (await list(s, { status: 'all', limit: 100 })).items;
    const filters: [Record<string, string>, (i: Item) => boolean][] = [
      [{ type: 'merchant_spend' }, (i) => i.txnType === 'merchant_spend'],
      [{ accountId: s.BE }, (i) => i.entries.some((x: Item) => x.accountId === s.BE)],
      [{ cardId: s.K }, (i) => i.event.cardId === s.K],
      [{ channelId: s.PP }, (i) => i.event.paymentChannelId === s.PP],
      [{ currency: 'HKD' }, (i) => i.entries.some((x: Item) => x.currency === 'HKD')],
      [{ amountStatus: 'pending' }, (i) => i.entries.some((x: Item) => x.amountStatus === 'pending')],
      [{ foreignStatus: 'undetermined' }, (i) => i.event.foreignStatus === 'undetermined'],
      [{ recordMode: 'backfill' }, (i) => i.event.recordMode === 'backfill'],
      [{ status: 'voided' }, (i) => i.status === 'voided'],
      [{ status: 'active' }, (i) => i.status === 'active'],
      [{ from: '2026-09-02', to: '2026-09-30' }, (i) => i.event.occurredOn >= '2026-09-02' && i.event.occurredOn <= '2026-09-30'],
    ];
    const qMatch = (i: Item) => [i.event.merchantName, i.event.counterparty?.name ?? null, i.notes].some((v) => v !== null && normalizeNameKey(v).includes('combo'));
    for (const [f, pred] of filters) {
      // Without a status filter the list holds active transactions only (the default).
      const expected = everything.filter((i) => qMatch(i) && pred(i) && (f.status ? true : i.status === 'active'));
      expect(ids((await list(s, { q: 'combo', ...f })).items), JSON.stringify(f)).toEqual(ids(expected));
    }
  });

  // ================================================================== changes while paging (LST-7)

  it('LST-7: changes between pages — newer rows before the cursor do not appear, older rows after it appear once, a row that stops matching drops out, nothing else repeats or goes missing', async () => {
    const s = await seedUser(e);
    const base: Item[] = [];
    // Row 3 matches q through its notes only; the others through the merchant name.
    for (let i = 0; i < 6; i++) {
      base.push(await created(s, spend(s, { occurredOn: day('2026-09-10', -i), ...(i === 3 ? { merchantName: 'Other shop', notes: 'page row in notes' } : { merchantName: `Page row ${i}` }) })));
    }
    const p1 = await list(s, { q: 'page row', limit: 2 });
    expect(p1.items.map((i) => i.event.merchantName)).toEqual(['Page row 0', 'Page row 1']);
    const newer = await created(s, spend(s, { occurredOn: '2026-10-01', merchantName: 'Page row newer' }));
    const older = await created(s, spend(s, { occurredOn: '2026-01-01', merchantName: 'Page row older' }));
    // Row 3's notes change so that it no longer matches; row 4 gets a new version without the name.
    const t3 = base[3]!.transactionId as string;
    const t4 = base[4]!.transactionId as string;
    await e.exec("UPDATE transactions SET notes = 'something else', updated_at = updated_at + 1 WHERE id = ?", t3);
    await factCorrection(s, t4, { merchantName: 'Renamed away' });
    const rest: Item[] = [];
    let cursor: string | null = p1.nextCursor;
    while (cursor) {
      const p = await list(s, { q: 'page row', limit: 2, cursor });
      rest.push(...p.items);
      cursor = p.nextCursor;
    }
    const seen = [...ids(p1.items), ...ids(rest)];
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(newer.transactionId);
    expect(seen.filter((id) => id === older.transactionId)).toHaveLength(1);
    expect(seen).not.toContain(t3);
    expect(seen).not.toContain(t4);
    expect(seen).toEqual([...base.map((b) => b.transactionId as string).filter((id) => id !== t3 && id !== t4), older.transactionId]);
  });

  // ================================================================== parameters (LST-8)

  it('LST-8: malformed cursors and parameters are 400 VALIDATION; any well-formed cursor is only a position', async () => {
    const s = await seedUser(e);
    const rows: Item[] = [];
    for (let i = 0; i < 4; i++) rows.push(await created(s, spend(s, { occurredOn: day('2026-09-01', i), merchantName: `Row ${i}` })));
    const good = cursorOf([1, '2026-09-03', '14:05', e.t.clock.t, rows[2]!.transactionId]);
    expect(ids((await list(s, { cursor: good })).items)).toEqual([rows[1]!.transactionId, rows[0]!.transactionId]);
    // Hand-made positions that match no row are fine too.
    expect(ids((await list(s, { cursor: cursorOf([1, '2026-09-02', null, 0, 'zzzz']) })).items)).toEqual([rows[0]!.transactionId]);
    expect((await list(s, { cursor: cursorOf([1, '2000-01-01', null, 0, 'a']) })).items).toEqual([]);
    const bad = [
      'not base64!', 'abc', cursorOf('x'), cursorOf({ a: 1 }), cursorOf([2, '2026-09-03', null, 1, 'x']), cursorOf([1, '2026-02-30', null, 1, 'x']),
      cursorOf([1, '2026-09-03', '25:00', 1, 'x']), cursorOf([1, '2026-09-03', null, -1, 'x']), cursorOf([1, '2026-09-03', null, 1.5, 'x']),
      cursorOf([1, '2026-09-03', null, '1', 'x']), cursorOf([1, '2026-09-03', null, 1, '']), cursorOf([1, '2026-09-03', null, 1, 'x'.repeat(65)]),
      cursorOf([1, '2026-09-03', null, 1, 'x', 'extra']), bytesToBase64Url(new Uint8Array([0xff, 0xfe, 0x00])), 'a'.repeat(201),
      cursorOf([1, "2026-09-03' OR 1=1 --", null, 1, 'x']),
    ];
    for (const cursor of bad) {
      const r = await s.api.get(`/api/transactions${qs({ cursor })}`);
      expect([r.status, r.json.code], cursor).toEqual([400, 'VALIDATION']);
    }
    for (const p of [{ limit: 0 }, { limit: 101 }, { limit: '1.5' }, { limit: 'ten' }, { from: '2026-09-02', to: '2026-09-01' }, { from: '2026-13-01' }, { type: 'transfer' }, { status: 'deleted' }, { unknown: 'x' }, { amountStatus: 'unknown' }]) {
      const r = await s.api.get(`/api/transactions${qs(p as never)}`);
      expect([r.status, r.json.code], JSON.stringify(p)).toEqual([400, 'VALIDATION']);
    }
    expect((await list(s, { limit: 100 })).items).toHaveLength(4);
  });
});
