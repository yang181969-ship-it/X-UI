// M3-B5-B: GET /transactions/summary (API_SPEC §5.10, DATA_MODEL §10.12, PRODUCT_SPEC §7.7; TEST_PLAN
// SUM-1 – SUM-7, IMM-8, M3-2/3/7/8/9, REG-3/7/8, ISO-4, and the approved transactionCount /
// pendingTransactionCount). Every case runs on libsql and on wrangler's local in-memory D1 through the
// real HTTP app, and every answer is compared with an independent reference computed here in JS
// (BigInt) from the raw rows — not with the service's SQL. All data is fictional.
import { AMOUNT_MAX, SUM_GROUP_ROWS_MAX, transactionSummaryQuerySchema, type TransactionSummaryDto } from '@xui/ledger-shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { groupAmount, summarizeTransactions, summaryStatements } from '../src/services/transactionSummary.ts';
import { batchHooks, factOf, ownTransfer, seedUser, spend, startEngine, type Engine, type Seed } from './transactions-kit.ts';

type Body = Record<string, unknown>;
type Q = { from?: string; to?: string; type?: string; currency?: string };
type Group = TransactionSummaryDto['foreign'][number];

const KEYS = ['from', 'to', 'transactionCount', 'pendingTransactionCount', 'homeRegions', 'foreign', 'undetermined', 'domestic', 'pending'];

/** Groups compared as sets (the fixed order has its own case). */
const canon = (d: TransactionSummaryDto) => {
  const sort = <T>(xs: T[]) => [...xs].map((x) => JSON.stringify(x)).sort();
  return { ...d, foreign: sort(d.foreign), undetermined: sort(d.undetermined), domestic: sort(d.domestic), pending: sort(d.pending) };
};

/**
 * The expected summary, from the raw rows: active headers, the event whose revision equals
 * current_revision, its entries; filters by occurred_on (inclusive), type and ENTRY currency; sums
 * with BigInt; the account side from the saved snapshots; distinct transaction sets for the counts.
 */
async function reference(e: Engine, userId: string, q: Q): Promise<TransactionSummaryDto> {
  const headers = await e.all('SELECT id, txn_type, status, current_revision FROM transactions WHERE user_id = ?', userId);
  const events = await e.all('SELECT id, transaction_id, revision, occurred_on, foreign_status, merchant_scope, transfer_scope, home_region FROM transaction_events WHERE user_id = ?', userId);
  const entries = await e.all('SELECT event_id, direction, funding_currency, currency_exponent, amount, amount_status, funding_account_country FROM transaction_entries WHERE user_id = ?', userId);
  const groups = new Map<string, { block: string; g: Omit<Group, 'amount'> & { amount: bigint } }>();
  const pending = new Map<string, TransactionSummaryDto['pending'][number]>();
  const all = new Set<string>();
  const withPending = new Set<string>();
  const regions = new Set<string>();
  const eventAt = new Map(events.map((x) => [`${x.transaction_id}#${Number(x.revision)}`, x]));
  const entriesOf = new Map<unknown, typeof entries>();
  for (const en of entries) entriesOf.set(en.event_id, [...(entriesOf.get(en.event_id) ?? []), en]);
  for (const h of headers) {
    if (h.status !== 'active' || Number(h.current_revision) < 1) continue;
    if (q.type && h.txn_type !== q.type) continue;
    const ev = eventAt.get(`${h.id}#${Number(h.current_revision)}`);
    if (!ev) throw new Error('published header without its current event');
    const on = String(ev.occurred_on);
    if ((q.from && on < q.from) || (q.to && on > q.to)) continue;
    for (const en of entriesOf.get(ev.id) ?? []) {
      if (q.currency && en.funding_currency !== q.currency) continue;
      all.add(String(h.id));
      regions.add(String(ev.home_region));
      const base = { txnType: h.txn_type as never, direction: en.direction as never, currency: String(en.funding_currency), currencyExponent: Number(en.currency_exponent) };
      if (en.amount_status === 'pending') {
        withPending.add(String(h.id));
        const k = JSON.stringify([ev.foreign_status, base]);
        const p = pending.get(k) ?? { foreignStatus: ev.foreign_status as never, ...base, count: 0 };
        p.count++;
        pending.set(k, p);
        continue;
      }
      const g = {
        ...base,
        merchantScope: (ev.merchant_scope ?? null) as never,
        transferScope: (ev.transfer_scope ?? null) as never,
        accountScope: (en.funding_account_country === ev.home_region ? 'domestic' : 'foreign') as never,
      };
      const k = JSON.stringify([ev.foreign_status, g]);
      const cur = groups.get(k) ?? { block: String(ev.foreign_status), g: { ...g, amount: 0n, count: 0 } };
      cur.g.amount += BigInt(Number(en.amount));
      cur.g.count++;
      groups.set(k, cur);
    }
  }
  const block = (b: string) => [...groups.values()].filter((x) => x.block === b).map((x) => ({ ...x.g, amount: x.g.amount.toString() }));
  return {
    from: q.from ?? null,
    to: q.to ?? null,
    transactionCount: all.size,
    pendingTransactionCount: withPending.size,
    homeRegions: [...regions].sort(),
    foreign: block('foreign'),
    undetermined: block('undetermined'),
    domestic: block('domestic'),
    pending: [...pending.values()],
  };
}

describe.each(['libsql', 'd1'] as const)('GET /transactions/summary on %s', (engine) => {
  let e: Engine;
  beforeAll(async () => {
    e = await startEngine(engine, 'xui-v1-txn-summary-d1');
  }, 180_000);
  afterAll(async () => {
    await e?.dispose();
  });
  beforeEach(() => e.ping());

  const qs = (q: Record<string, string | undefined>) => {
    const s = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined) as [string, string][]).toString();
    return s ? `?${s}` : '';
  };
  const summary = async (s: Seed, q: Q = {}): Promise<TransactionSummaryDto> => {
    const r = await s.api.get(`/api/transactions/summary${qs(q)}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(Object.keys(r.json)).toEqual(KEYS);
    return r.json;
  };
  /** The answer equals the independent reference (and the exact key set). */
  const matches = async (s: Seed, q: Q = {}) => {
    const got = await summary(s, q);
    expect(canon(got)).toEqual(canon(await reference(e, s.id, q)));
    return got;
  };
  const created = async (s: Seed, body: Body) => {
    const r = await s.post(body);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.transactionId as string;
  };
  const ok = (r: { status: number; json: unknown }, status = 201) => expect(r.status, JSON.stringify(r.json)).toBe(status);
  const amountOf = (gs: Group[], f: Partial<Group>) => gs.filter((g) => Object.entries(f).every(([k, v]) => g[k as keyof Group] === v));
  let jp = 0;
  /** An extra account (JP: JPY default, BHD) for zero- and three-decimal currencies. */
  const jpAccount = async (s: Seed) => {
    const r = await s.api.post('/api/accounts', { institutionId: s.I, name: `JP account ${++jp}`, accountType: 'bank', accountCountry: 'JP', currencies: [{ code: 'JPY', isDefault: true }, { code: 'BHD' }] });
    ok(r);
    return r.json.id as string;
  };

  // Bodies (all fictional).
  const refund = (s: Seed, x: Body = {}): Body => ({
    type: 'merchant_refund', occurredOn: '2026-03-31', eventCurrency: 'HKD', eventAmount: 2000, merchantName: 'Example Store', merchantCountry: 'US', cardId: s.K,
    entries: [{ direction: 'in', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 2000 }], ...x,
  });
  const thirdOut = (s: Seed, x: Body = {}): Body => ({
    type: 'third_party_transfer', occurredOn: '2026-06-30', eventCurrency: 'USD', eventAmount: 50000, transferMethod: 'ach', counterparty: { name: 'Alice Example', country: null },
    entries: [{ direction: 'out', accountId: s.US, currency: 'USD', amountStatus: 'confirmed', amount: 50100 }], ...x,
  });
  const thirdIn = (s: Seed, x: Body = {}): Body => ({
    type: 'third_party_transfer', occurredOn: '2026-07-01', eventCurrency: null, eventAmount: null, transferMethod: 'swift', counterparty: { name: 'Bob Example', country: null },
    entries: [{ direction: 'in', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 300000 }], ...x,
  });

  /** A user with every kind of activity, superseded versions, a void, pending entries and two home regions. */
  async function richUser() {
    const s = await seedUser(e);
    const JP = await jpAccount(s);
    const T: Record<string, string> = {};
    T.spend = await created(s, spend(s)); // HKD 78.30 for USD 10.00 (event USD never counted)
    T.undetermined = await created(s, spend(s, { occurredOn: '2026-01-01', merchantCountry: null, eventCurrency: 'CNY', eventAmount: 5000, entries: [{ direction: 'out', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 5000 }] }));
    T.refund = await created(s, refund(s));
    T.own = await created(s, ownTransfer(s));
    T.ownCross = await created(s, ownTransfer(s, {
      occurredOn: '2025-12-31', eventCurrency: 'HKD', eventAmount: 780000,
      entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 780000 }, { direction: 'in', accountId: s.US, currency: 'USD', amountStatus: 'pending', amount: null }],
    }));
    T.thirdOut = await created(s, thirdOut(s));
    T.thirdIn = await created(s, thirdIn(s));
    T.pendingSpend = await created(s, spend(s, { occurredOn: '2026-10-16', eventCurrency: 'EUR', eventAmount: 900, merchantCountry: 'FR', entries: [{ direction: 'out', accountId: s.BE, currency: 'USD', amountStatus: 'pending', amount: null }] }));
    T.jpy = await created(s, spend(s, { occurredOn: '2026-02-28', eventCurrency: 'JPY', eventAmount: 120000, merchantCountry: 'JP', entries: [{ direction: 'out', accountId: JP, currency: 'JPY', amountStatus: 'confirmed', amount: 120000 }] }));
    T.bhd = await created(s, spend(s, { occurredOn: '2026-09-01', eventCurrency: 'BHD', eventAmount: 1234, merchantCountry: 'BH', entries: [{ direction: 'out', accountId: JP, currency: 'BHD', amountStatus: 'confirmed', amount: 1234 }] }));
    T.voided = await created(s, spend(s, { occurredOn: '2026-10-01', entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 9999 }] }));
    ok(await s.voidTx(T.voided, { baseRevision: 1, reason: null }), 200);
    const superseded = spend(s, { occurredOn: '2026-05-05', entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 1111 }] });
    T.corrected = await created(s, superseded);
    ok(await s.correct(T.corrected, factOf(superseded, { entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 2222 }] })));
    T.backfillHK = await created(s, spend(s, {
      recordMode: 'backfill', declaredHomeRegion: 'HK', occurredOn: '2025-06-01', cardId: null, merchantCountry: 'CN', eventCurrency: 'CNY', eventAmount: 4000,
      entries: [{ direction: 'out', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 4000 }],
    }));
    T.bothPending = await created(s, ownTransfer(s, {
      occurredOn: '2026-08-08', eventCurrency: 'HKD', eventAmount: 50000,
      entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'pending', amount: null }, { direction: 'in', accountId: s.BE, currency: 'EUR', amountStatus: 'pending', amount: null }],
    }));
    return { s, T, JP };
  }

  // ================================================================== route and query

  it('is a real route before /:id: 200 for the caller, 401 without a session; strict query → 400 VALIDATION', async () => {
    const s = await seedUser(e);
    await summary(s); // 200, not the /:id 404
    const anon = await e.t.app.request('/api/transactions/summary');
    expect(anon.status).toBe(401);
    for (const bad of [
      { foreignStatus: 'foreign' }, { accountId: s.HK }, { status: 'all' }, { cursor: 'x' }, { limit: '5' },
      { from: '2026-02-30' }, { to: '2026-13-01' }, { from: '2026-1-01' }, { from: '2026-10-02', to: '2026-10-01' },
      { type: 'transfer' }, { currency: 'usd' }, { currency: 'XYZ' },
    ]) {
      const r = await s.api.get(`/api/transactions/summary${qs(bad)}`);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.json.code).toBe('VALIDATION');
    }
  });

  it('empty data: a complete, empty DTO (with the period echoed back)', async () => {
    const s = await seedUser(e);
    expect(await summary(s)).toEqual({ from: null, to: null, transactionCount: 0, pendingTransactionCount: 0, homeRegions: [], foreign: [], undetermined: [], domestic: [], pending: [] });
    expect(await summary(s, { from: '2026-01-01', to: '2026-12-31' })).toMatchObject({ from: '2026-01-01', to: '2026-12-31', transactionCount: 0 });
  });

  // ================================================================== the whole picture against the reference

  it('every filter combination equals the independent reference (versions, void, pending, currencies, types, regions)', async () => {
    const { s } = await richUser();
    const combos: Q[] = [
      {},
      { from: '2026-01-01', to: '2026-12-31' },
      { from: '2026-01-01', to: '2026-09-30' },
      { type: 'own_transfer' },
      { type: 'merchant_spend' },
      { currency: 'USD' },
      { currency: 'HKD' },
      { currency: 'EUR' },
      { from: '2026-01-01', to: '2026-10-16', type: 'third_party_transfer' },
      { from: '2025-01-01', to: '2025-12-31', currency: 'HKD' },
      { type: 'own_transfer', currency: 'USD' },
      { from: '2025-12-31', to: '2026-10-14', type: 'own_transfer', currency: 'HKD' },
      { from: '2030-01-01' },
    ];
    for (const q of combos) await matches(s, q);

    // Spot checks of the rules behind the reference.
    const all = await summary(s);
    expect(all.transactionCount).toBe(13); // 14 created, 1 voided; the corrected one once
    expect(all.homeRegions).toEqual(['CN', 'HK']);
    expect(all.domestic).toEqual([]); // P2
    // Event amounts never count: the USD 10.00 of the HKD spend is nowhere.
    expect(amountOf(all.foreign, { txnType: 'merchant_spend', currency: 'USD' }).map((g) => g.amount)).toEqual(['2222']); // only the corrected version
    expect(amountOf(all.foreign, { txnType: 'merchant_spend', currency: 'HKD' })).toEqual([
      { txnType: 'merchant_spend', direction: 'out', currency: 'HKD', currencyExponent: 2, merchantScope: 'foreign', transferScope: null, accountScope: 'foreign', amount: '7830', count: 1 },
    ]); // the voided 99.99 and the superseded 11.11 are gone
    // Refund on its own, never netted against spending.
    expect(amountOf(all.foreign, { txnType: 'merchant_refund' })).toEqual([
      { txnType: 'merchant_refund', direction: 'in', currency: 'HKD', currencyExponent: 2, merchantScope: 'foreign', transferScope: null, accountScope: 'foreign', amount: '2000', count: 1 },
    ]);
    // Own transfer: out and in apart, never added.
    expect(amountOf(all.foreign, { txnType: 'own_transfer', currency: 'USD' }).map((g) => [g.direction, g.amount])).toEqual([['out', '100000'], ['in', '99900']]);
    // JPY (0 decimals) and BHD (3) as saved.
    expect(amountOf(all.foreign, { currency: 'JPY' })[0]).toMatchObject({ currencyExponent: 0, amount: '120000' });
    expect(amountOf(all.foreign, { currency: 'BHD' })[0]).toMatchObject({ currencyExponent: 3, amount: '1234' });
    // Unknown is not domestic: the CNY spend at an unknown merchant and the third-party transfer from an unknown side.
    expect(all.undetermined.map((g) => [g.txnType, g.direction, g.currency, g.amount, g.merchantScope, g.transferScope, g.accountScope])).toEqual([
      ['merchant_spend', 'out', 'CNY', '5000', 'unknown', null, 'domestic'],
      ['third_party_transfer', 'in', 'CNY', '300000', null, 'unknown_to_domestic', 'domestic'],
    ]);
    // Pending: counted, never an amount.
    expect(all.pending).toEqual([
      { foreignStatus: 'foreign', txnType: 'merchant_spend', direction: 'out', currency: 'USD', currencyExponent: 2, count: 1 },
      { foreignStatus: 'foreign', txnType: 'own_transfer', direction: 'out', currency: 'HKD', currencyExponent: 2, count: 1 },
      { foreignStatus: 'foreign', txnType: 'own_transfer', direction: 'in', currency: 'EUR', currencyExponent: 2, count: 1 },
      { foreignStatus: 'foreign', txnType: 'own_transfer', direction: 'in', currency: 'USD', currencyExponent: 2, count: 1 },
    ]);
    expect(all.pendingTransactionCount).toBe(3); // 4 pending entries in 3 transactions
    // No group anywhere carries a total or a converted value.
    for (const g of [...all.foreign, ...all.undetermined]) expect(Object.keys(g).sort()).toEqual(['accountScope', 'amount', 'count', 'currency', 'currencyExponent', 'direction', 'merchantScope', 'transferScope', 'txnType']);
  });

  it('groups come in the fixed order: type, direction (out first), currency, exponent, merchant side, transfer scope, account side', async () => {
    const { s } = await richUser();
    const all = await summary(s);
    const keyOf = (g: Group) => [
      ['merchant_spend', 'merchant_refund', 'own_transfer', 'third_party_transfer'].indexOf(g.txnType), g.direction === 'out' ? 0 : 1, g.currency, g.currencyExponent,
      ['foreign', 'domestic', 'unknown', null].indexOf(g.merchantScope), g.transferScope ?? '~', g.accountScope === 'foreign' ? 0 : 1,
    ];
    for (const block of [all.foreign, all.undetermined]) {
      for (let i = 1; i < block.length; i++) {
        const [a, b] = [keyOf(block[i - 1]!), keyOf(block[i]!)];
        const first = a.findIndex((v, j) => v !== b[j]);
        expect(first, JSON.stringify([block[i - 1], block[i]])).toBeGreaterThanOrEqual(0);
        if (typeof a[first] === 'number') expect(a[first] as number).toBeLessThan(b[first] as number);
      }
    }
    expect((await summary(s)).foreign).toEqual(all.foreign); // deterministic
  });

  // ================================================================== versions, void, settlement

  it('versions: a fact correction replaces the old amount, currency and date — only the current version counts (IMM-8)', async () => {
    const s = await seedUser(e);
    const body = spend(s, { occurredOn: '2026-09-30' });
    const T = await created(s, body);
    ok(await s.correct(T, factOf(body, { occurredOn: '2026-10-02', entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 1000 }] })));
    ok(await s.correct(T, { ...factOf(body, { occurredOn: '2026-10-03', entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 1200 }] }), baseRevision: 2 }));
    const all = await matches(s);
    expect(all.transactionCount).toBe(1);
    expect(all.foreign).toEqual([{ txnType: 'merchant_spend', direction: 'out', currency: 'USD', currencyExponent: 2, merchantScope: 'foreign', transferScope: null, accountScope: 'foreign', amount: '1200', count: 1 }]);
    // The date moved out of September and into October (occurredOn of the current version).
    expect((await matches(s, { from: '2026-09-01', to: '2026-09-30' })).transactionCount).toBe(0);
    expect((await matches(s, { from: '2026-10-03', to: '2026-10-03' })).transactionCount).toBe(1);
    expect((await matches(s, { from: '2026-10-02', to: '2026-10-02' })).transactionCount).toBe(0);
  });

  it('void: the transaction leaves the amounts, the pending counts and both transaction counts', async () => {
    const s = await seedUser(e);
    const a = await created(s, spend(s));
    const p = await created(s, spend(s, { eventCurrency: 'EUR', eventAmount: 900, entries: [{ direction: 'out', accountId: s.BE, currency: 'USD', amountStatus: 'pending', amount: null }] }));
    expect(await matches(s)).toMatchObject({ transactionCount: 2, pendingTransactionCount: 1 });
    ok(await s.voidTx(p, { baseRevision: 1, reason: null }), 200);
    expect(await matches(s)).toMatchObject({ transactionCount: 1, pendingTransactionCount: 0, pending: [] });
    ok(await s.voidTx(a, { baseRevision: 1, reason: null }), 200);
    expect(await matches(s)).toEqual({ from: null, to: null, transactionCount: 0, pendingTransactionCount: 0, homeRegions: [], foreign: [], undetermined: [], domestic: [], pending: [] });
  });

  it('pending → settlement: the entry moves from the pending count into the confirmed amount (M3-9)', async () => {
    const s = await seedUser(e);
    const T = await created(s, ownTransfer(s, {
      eventCurrency: 'HKD', eventAmount: 780000,
      entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 780000 }, { direction: 'in', accountId: s.US, currency: 'USD', amountStatus: 'pending', amount: null }],
    }));
    const before = await matches(s);
    expect(before).toMatchObject({ transactionCount: 1, pendingTransactionCount: 1 });
    expect(before.pending).toEqual([{ foreignStatus: 'foreign', txnType: 'own_transfer', direction: 'in', currency: 'USD', currencyExponent: 2, count: 1 }]);
    expect(before.foreign.map((g) => [g.direction, g.currency, g.amount])).toEqual([['out', 'HKD', '780000']]);
    ok(await s.correct(T, { kind: 'settlement', baseRevision: 1, reason: null, entries: [{ direction: 'in', amount: 99950 }] }));
    const after = await matches(s);
    expect(after).toMatchObject({ transactionCount: 1, pendingTransactionCount: 0, pending: [] });
    expect(after.foreign.map((g) => [g.direction, g.currency, g.amount, g.count])).toEqual([['out', 'HKD', '780000', 1], ['in', 'USD', '99950', 1]]);
  });

  // ================================================================== the two distinct counts

  it('counts: COUNT(DISTINCT transaction) — never the sum of group counts; pending and confirmed entries of one transaction count once', async () => {
    const s = await seedUser(e);
    // Both sides confirmed: two groups, one transaction.
    await created(s, ownTransfer(s));
    let r = await matches(s);
    expect(r.foreign.reduce((n, g) => n + g.count, 0)).toBe(2);
    expect(r).toMatchObject({ transactionCount: 1, pendingTransactionCount: 0 });
    // One confirmed (HKD out), one pending (USD in): one transaction, one pending transaction.
    await created(s, ownTransfer(s, {
      eventCurrency: 'HKD', eventAmount: 780000,
      entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 780000 }, { direction: 'in', accountId: s.US, currency: 'USD', amountStatus: 'pending', amount: null }],
    }));
    // Both sides pending: two pending entries, one pending transaction.
    await created(s, ownTransfer(s, {
      eventCurrency: 'HKD', eventAmount: 1000,
      entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'pending', amount: null }, { direction: 'in', accountId: s.BE, currency: 'EUR', amountStatus: 'pending', amount: null }],
    }));
    // Confirmed only: never a pending transaction.
    await created(s, spend(s));
    r = await matches(s);
    expect(r).toMatchObject({ transactionCount: 4, pendingTransactionCount: 2 });
    expect(r.pending.reduce((n, g) => n + g.count, 0)).toBe(3); // entries, not transactions
    expect(r.foreign.reduce((n, g) => n + g.count, 0) + r.pending.reduce((n, g) => n + g.count, 0)).toBe(7); // 4 confirmed + 3 pending entries ≠ 4 transactions

    // The currency filter looks at the matching entries only.
    expect(await matches(s, { currency: 'HKD' })).toMatchObject({ transactionCount: 3, pendingTransactionCount: 1 }); // the HKD out of the half-pending one is confirmed
    expect(await matches(s, { currency: 'USD' })).toMatchObject({ transactionCount: 2, pendingTransactionCount: 1 });
    expect(await matches(s, { currency: 'EUR' })).toMatchObject({ transactionCount: 1, pendingTransactionCount: 1 });
    expect(await matches(s, { currency: 'CNY' })).toMatchObject({ transactionCount: 0, pendingTransactionCount: 0, homeRegions: [] });
    const usd = await summary(s, { currency: 'USD' });
    for (const g of [...usd.foreign, ...usd.pending]) expect(g.currency).toBe('USD'); // the HKD side of a USD-touching transaction is not returned
    // The type filter.
    expect(await matches(s, { type: 'merchant_spend' })).toMatchObject({ transactionCount: 1, pendingTransactionCount: 0 });
    expect(await matches(s, { type: 'own_transfer' })).toMatchObject({ transactionCount: 3, pendingTransactionCount: 2 });
    // The date filter.
    expect(await matches(s, { from: '2026-10-15' })).toMatchObject({ transactionCount: 0, pendingTransactionCount: 0 });
    // Against independent COUNT(DISTINCT) queries.
    const [ref] = await e.all(
      `SELECT COUNT(DISTINCT t.id) AS a, COUNT(DISTINCT CASE WHEN en.amount_status = 'pending' THEN t.id END) AS p
       FROM transactions t JOIN transaction_events ev ON ev.transaction_id = t.id AND ev.revision = t.current_revision JOIN transaction_entries en ON en.event_id = ev.id
       WHERE t.user_id = ? AND t.status = 'active'`,
      s.id,
    );
    expect([Number(ref!.a), Number(ref!.p)]).toEqual([4, 2]);
  });

  // ================================================================== dates (occurredOn only)

  it('dates: occurredOn decides — inclusive bounds; postedOn, createdAt and a backfilled old date do not', async () => {
    const s = await seedUser(e);
    await created(s, spend(s, { occurredOn: '2026-09-30', postedOn: '2026-10-02' })); // posted in October
    await created(s, spend(s, { occurredOn: '2026-10-01' }));
    await created(s, spend(s, { occurredOn: '2026-10-16' })); // the latest allowed day
    await created(s, spend(s, { recordMode: 'backfill', occurredOn: '2025-03-01', cardId: null })); // created today, happened in 2025
    const n = async (q: Q) => (await matches(s, q)).transactionCount;
    expect(await n({ from: '2026-09-30', to: '2026-09-30' })).toBe(1); // occurredOn = from = to
    expect(await n({ from: '2026-10-01', to: '2026-10-31' })).toBe(2); // the September one is out even though posted in October
    expect(await n({ from: '2026-10-01', to: '2026-10-15' })).toBe(1); // occurredOn = to + 1 is out
    expect(await n({ from: '2026-10-02' })).toBe(1);
    expect(await n({ to: '2026-09-30' })).toBe(2);
    expect(await n({ from: '2025-01-01', to: '2025-12-31' })).toBe(1); // the backfill belongs to 2025
    expect(await n({ from: '2026-01-01', to: '2026-12-31' })).toBe(3); // although created in 2026
  });

  // ================================================================== snapshots, not current settings

  it('no reclassification: changing the account country, home region or links leaves the summary identical (M3-2 / M3-3 / REG-7)', async () => {
    const { s } = await richUser();
    const before = await summary(s);
    ok(await s.api.patch(`/api/accounts/${s.HK}`, { accountCountry: 'SG' }), 200);
    ok(await s.api.patch(`/api/accounts/${s.CN}`, { accountCountry: 'HK' }), 200);
    ok(await s.api.patch('/api/settings/profile', { homeRegion: 'HK' }), 200);
    expect(await summary(s)).toEqual(before);
    await matches(s);
  });

  it('a snapshot correction of the home region moves the transaction into the block its new snapshot gives (accountScope from snapshots)', async () => {
    const s = await seedUser(e);
    const T = await created(s, spend(s, { merchantCountry: null, eventCurrency: 'CNY', eventAmount: 5000, entries: [{ direction: 'out', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 5000 }] }));
    let r = await matches(s);
    expect(r.undetermined.map((g) => g.accountScope)).toEqual(['domestic']);
    expect(r.foreign).toEqual([]);
    ok(await s.correct(T, { kind: 'snapshot_correction', baseRevision: 1, reason: 'home was HK then', homeRegion: 'HK' }));
    r = await matches(s);
    expect(r.undetermined).toEqual([]);
    expect(r.foreign).toEqual([{ txnType: 'merchant_spend', direction: 'out', currency: 'CNY', currencyExponent: 2, merchantScope: 'unknown', transferScope: null, accountScope: 'foreign', amount: '5000', count: 1 }]);
    expect(r.homeRegions).toEqual(['HK']);
  });

  it('home regions: every saved home_region in the filtered scope (pending-only transactions too), narrowed by type and currency', async () => {
    const s = await seedUser(e);
    await created(s, spend(s)); // CN, HKD confirmed
    await created(s, spend(s, {
      recordMode: 'backfill', declaredHomeRegion: 'HK', occurredOn: '2025-06-01', cardId: null, merchantCountry: 'CN', eventCurrency: 'EUR', eventAmount: 900,
      entries: [{ direction: 'out', accountId: s.BE, currency: 'USD', amountStatus: 'pending', amount: null }],
    })); // HK, USD pending only
    await created(s, ownTransfer(s, { recordMode: 'backfill', declaredHomeRegion: 'US', occurredOn: '2025-07-01' })); // US, USD both sides
    expect((await matches(s)).homeRegions).toEqual(['CN', 'HK', 'US']);
    expect((await matches(s, { currency: 'USD' })).homeRegions).toEqual(['HK', 'US']);
    expect((await matches(s, { currency: 'HKD' })).homeRegions).toEqual(['CN']);
    expect((await matches(s, { type: 'merchant_spend' })).homeRegions).toEqual(['CN', 'HK']);
    expect((await matches(s, { from: '2026-01-01' })).homeRegions).toEqual(['CN']);
  });

  // ================================================================== isolation

  it('isolation: A and B with the same period only ever see their own data (ISO-4)', async () => {
    const a = await richUser();
    const b = await seedUser(e, 'b');
    await created(b, spend(b, { entries: [{ direction: 'out', accountId: b.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 1 }] }));
    const q = { from: '2025-01-01', to: '2026-12-31' };
    const ra = await matches(a.s, q);
    const rb = await matches(b, q);
    expect(rb).toMatchObject({ transactionCount: 1, pendingTransactionCount: 0, homeRegions: ['CN'] });
    expect(rb.foreign).toEqual([{ txnType: 'merchant_spend', direction: 'out', currency: 'HKD', currencyExponent: 2, merchantScope: 'foreign', transferScope: null, accountScope: 'foreign', amount: '1', count: 1 }]);
    expect(ra.transactionCount).toBe(13);
    expect(JSON.stringify(ra)).not.toMatch(/"amount":"1"/); // B's HKD 0.01 is not in A
  });

  // ================================================================== one consistent read

  it('one read: the four parts come from a single db.batch (one transaction on both engines)', async () => {
    const s = await seedUser(e);
    await created(s, spend(s));
    const spy = batchHooks(e, []);
    try {
      await summary(s);
      expect(spy).toHaveBeenCalledTimes(1);
      expect((spy.mock.calls[0]![0] as readonly unknown[]).length).toBe(4);
    } finally {
      spy.mockRestore();
    }
  });

  it('one read at the driver: the four statements reach the native client as ONE batch (one transaction), with no other read', async () => {
    const s = await seedUser(e);
    await created(s, spend(s));
    // Count every call drizzle makes on its native client (libSQL Client / D1 binding — the latter is
    // an RPC proxy, so the session's reference is wrapped rather than spied on).
    const session = (e.t.db as unknown as { session: { client: object } }).session;
    const real = session.client;
    const calls: { method: string; args: unknown[] }[] = [];
    session.client = new Proxy(real, {
      get(target, key) {
        const v = Reflect.get(target, key) as unknown;
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          calls.push({ method: String(key), args });
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    try {
      const dto = await summarizeTransactions({ db: e.t.db, userId: s.id }, {});
      expect(dto.transactionCount).toBe(1);
    } finally {
      session.client = real;
    }
    const batches = calls.filter((c) => c.method === 'batch');
    expect(batches).toHaveLength(1);
    expect((batches[0]!.args[0] as unknown[]).length).toBe(4);
    if (engine === 'libsql') {
      // No mode argument → the client's default "deferred": BEGIN DEFERRED; the four; COMMIT. Nothing outside it.
      expect(batches[0]!.args[1]).toBeUndefined();
      expect(calls.map((c) => c.method)).toEqual(['batch']);
    } else {
      // D1 prepares each statement, then runs them as one batch (one transaction). Nothing else.
      expect(calls.map((c) => c.method)).toEqual(['prepare', 'prepare', 'prepare', 'prepare', 'batch']);
    }
  });

  it('query plan (both engines): entries are reached only through their event (event_id), never through the user index', async () => {
    const s = await seedUser(e);
    const queries: Q[] = [{}, { from: '2026-03-01', to: '2026-06-30' }, { from: '2026-03-01', to: '2026-06-30', currency: 'HKD' }, { type: 'own_transfer' }, { currency: 'USD' }, { to: '2026-01-31', type: 'merchant_spend', currency: 'JPY' }];
    for (const q of queries) {
      for (const st of summaryStatements({ db: e.t.db, userId: s.id }, transactionSummaryQuerySchema.parse(q))) {
        const { sql, params } = st.toSQL();
        const plan = (await e.all(`EXPLAIN QUERY PLAN ${sql}`, ...params)).map((p) => String(p.detail));
        const entryAccess = plan.filter((d) => /\btransaction_entries\b/.test(d));
        expect(entryAccess, `${JSON.stringify(q)}\n${plan.join('\n')}`).toHaveLength(1);
        expect(entryAccess[0]).toMatch(/^SEARCH transaction_entries USING (COVERING )?INDEX transaction_entries_event_\w+ \(event_id=\?/);
        expect(plan.join('\n')).not.toMatch(/transaction_entries_user_account_idx|SCAN transaction_entries/);
      }
    }
  });

  it('unary + changes the plan only: every statement returns the same rows without it; user ids are TEXT so no affinity changes a comparison', async () => {
    const { s } = await richUser();
    const other = await seedUser(e, 'plus');
    await created(other, spend(other));
    for (const table of ['transactions', 'transaction_events', 'transaction_entries']) {
      expect((await e.all(`SELECT DISTINCT typeof(user_id) AS t FROM ${table}`)).map((r) => r.t), table).toEqual(['text']);
    }
    for (const q of [{}, { from: '2026-01-01', to: '2026-09-30' }, { currency: 'USD' }, { type: 'own_transfer', currency: 'HKD' }] as Q[]) {
      for (const st of summaryStatements({ db: e.t.db, userId: s.id }, transactionSummaryQuerySchema.parse(q))) {
        const { sql, params } = st.toSQL();
        expect(sql.match(/\+"transaction_entries"\."user_id"/g)).toHaveLength(2);
        const plain = sql.replaceAll('+"transaction_entries"."user_id"', '"transaction_entries"."user_id"');
        const sort = (rows: Record<string, unknown>[]) => rows.map((r) => JSON.stringify(r)).sort();
        expect(sort(await e.all(sql, ...params))).toEqual(sort(await e.all(plain, ...params)));
      }
    }
  });

  it('one read: under concurrent writes every answer is internally consistent (counts, groups and pending agree)', async () => {
    const s = await seedUser(e);
    for (let i = 0; i < 3; i++) await created(s, spend(s));
    // Each concurrent write adds one transaction with one pending entry (the BE USD spend).
    const pendingSpend = () => spend(s, { eventCurrency: 'EUR', eventAmount: 900, entries: [{ direction: 'out', accountId: s.BE, currency: 'USD', amountStatus: 'pending', amount: null }] });
    const writes = Array.from({ length: 12 }, () => s.post(pendingSpend()));
    const reads = Array.from({ length: 24 }, () => s.api.get('/api/transactions/summary'));
    const results = await Promise.all([...writes, ...reads]);
    for (const w of results.slice(0, 12)) expect(w.status).toBe(201);
    for (const r of results.slice(12)) {
      expect(r.status).toBe(200);
      const d = r.json as TransactionSummaryDto;
      const confirmed = d.foreign.reduce((n, g) => n + g.count, 0);
      const pendingEntries = d.pending.reduce((n, g) => n + g.count, 0);
      expect(confirmed).toBe(3);
      expect(d.pendingTransactionCount).toBe(pendingEntries); // one pending entry per such transaction
      expect(d.transactionCount).toBe(confirmed + d.pendingTransactionCount);
    }
    expect(await matches(s)).toMatchObject({ transactionCount: 15, pendingTransactionCount: 12 });
  });

  // ================================================================== exponents (raw SQL) and big sums

  /** `count` published spends built with raw SQL (the publish triggers still check them), HK account, home CN, US merchant. */
  async function rawSpends(s: Seed, o: { prefix: string; count: number; currency: string; exponent: number; amount: number; accountId: string; accountCountry: string }) {
    const TS = e.t.clock.t;
    const p = `${o.prefix}_`;
    await e.exec(
      `INSERT INTO transactions (id, user_id, txn_type, created_at, updated_at)
       WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) SELECT ? || i, ?, 'merchant_spend', ?, ? FROM n`,
      o.count, p, s.id, TS, TS,
    );
    await e.exec(
      `INSERT INTO transaction_events (id, user_id, transaction_id, txn_type, revision, revision_kind, record_mode, occurred_on, event_currency, event_amount, event_currency_exponent,
                                       merchant_name, merchant_country, home_region, home_region_source, merchant_scope, foreign_status, classifier_version, created_at)
       SELECT 'ev_' || id, user_id, id, txn_type, 1, 'original', 'current', date('2026-01-01', '+' || (CAST(substr(id, ?) AS INTEGER) % 280) || ' days'), ?, ?, ?,
              'Shop', 'US', 'CN', 'preference_at_save', 'foreign', 'foreign', 1, ?
       FROM transactions WHERE user_id = ? AND substr(id, 1, ?) = ?`,
      p.length + 1, o.currency, o.amount, o.exponent, TS, s.id, p.length, p,
    );
    await e.exec(
      `INSERT INTO transaction_entries (id, user_id, event_id, txn_type, direction, funding_account_id, funding_currency, amount, amount_status, currency_exponent,
                                        funding_account_country, country_source, currency_status_at_save, created_at)
       SELECT 'en_' || id, user_id, id, txn_type, 'out', ?, ?, ?, 'confirmed', ?, ?, 'account_at_save', 'active', ?
       FROM transaction_events WHERE user_id = ? AND substr(id, 1, ?) = ?`,
      o.accountId, o.currency, o.amount, o.exponent, o.accountCountry, TS, s.id, p.length + 3, `ev_${p}`,
    );
    await e.exec('UPDATE transactions SET current_revision = 1 WHERE user_id = ? AND substr(id, 1, ?) = ?', s.id, p.length, p);
  }

  it('one currency with two saved exponents stays two groups; nothing is merged across currencies or exponents (SUM-5)', async () => {
    const s = await seedUser(e);
    await created(s, spend(s)); // HKD, exponent 2
    await rawSpends(s, { prefix: `x3${engine}`, count: 2, currency: 'HKD', exponent: 3, amount: 5, accountId: s.HK, accountCountry: 'HK' });
    const r = await matches(s);
    expect(r.foreign.map((g) => [g.currency, g.currencyExponent, g.amount, g.count])).toEqual([['HKD', 2, '7830', 1], ['HKD', 3, '10', 2]]);
  });

  it('10 000 transactions: exact sums beyond 2^53 (SUM-1 / SUM-2 through /summary) within the time budget', async () => {
    const s = await seedUser(e);
    await rawSpends(s, { prefix: `big${engine}`, count: 9300, currency: 'HKD', exponent: 2, amount: AMOUNT_MAX, accountId: s.HK, accountCountry: 'HK' });
    await rawSpends(s, { prefix: `usd${engine}`, count: 700, currency: 'USD', exponent: 2, amount: 12345, accountId: s.US, accountCountry: 'US' });
    // Direct SUM overflows (why the sum is segmented).
    let overflow = '';
    try {
      await e.all('SELECT SUM(amount) AS s FROM transaction_entries WHERE user_id = ?', s.id);
    } catch (err) {
      overflow = String((err as Error).message); // keep only the text (a retained libsql error holds the file open)
    }
    expect(overflow).toMatch(/overflow/i);
    const t0 = performance.now();
    const r = await summary(s);
    const first = performance.now() - t0;
    const t1 = performance.now();
    const ranged = await summary(s, { from: '2026-03-01', to: '2026-06-30', currency: 'HKD' });
    const second = performance.now() - t1;
    console.info(`[summary perf] ${engine}: 10 000 transactions — full ${first.toFixed(0)} ms, ranged ${second.toFixed(0)} ms`);
    expect(r.transactionCount).toBe(10_000);
    expect(r.foreign.map((g) => [g.currency, g.amount, g.count])).toEqual([['HKD', (9300n * BigInt(AMOUNT_MAX)).toString(), 9300], ['USD', String(700 * 12345), 700]]);
    expect(BigInt(r.foreign[0]!.amount) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(canon(r)).toEqual(canon(await reference(e, s.id, {})));
    expect(canon(ranged)).toEqual(canon(await reference(e, s.id, { from: '2026-03-01', to: '2026-06-30', currency: 'HKD' })));
    expect(first).toBeLessThan(2000);
    expect(second).toBeLessThan(2000);
  }, 300_000);
});

describe('summary group amounts (guards)', () => {
  it('merges the two text segments exactly and refuses anything it cannot vouch for', () => {
    expect(groupAmount('9299999', '999990700', 9300)).toBe('9299999999990700');
    expect(groupAmount('0', '7830', 1)).toBe('7830');
    expect(() => groupAmount(0 as unknown, '1', 1)).toThrow(/not text/);
    expect(() => groupAmount('0', 1 as unknown, 1)).toThrow(/not text/);
    expect(() => groupAmount('0', '1', 0)).toThrow(/row count/);
    expect(() => groupAmount('0', '1', SUM_GROUP_ROWS_MAX)).toThrow(/row count/);
    expect(() => groupAmount('0', '1', 1.5)).toThrow(/row count/);
    expect(() => groupAmount('-1', '0', 1)).toThrow(RangeError);
  });
});
