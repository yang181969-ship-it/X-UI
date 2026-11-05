// M3-B3-B.1: GET /transactions/:id/revisions/:revision (API_SPEC §5.6) — TEST_PLAN COR-8, ISO-1
// (versions), COR-6 (every version of a voided transaction readable). A version is returned exactly
// as saved (snapshots included); the entry's account is the CURRENT summary beside its saved
// jurisdiction. Every case runs on libsql and on wrangler's local in-memory D1 through the real HTTP
// app. Corrections come from the M3-B1 test chain (no correction route before M3-B3-C). Fictional data.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { client } from './helpers.ts';
import { nid } from './m3-ledger.ts';
import { factCorrection, newKey, ownTransfer, seedUser, spend, startEngine, type Engine, type Seed } from './transactions-kit.ts';

type Json = any;

const ENTRY_KEYS = ['account', 'accountId', 'amount', 'amountStatus', 'carriedFromEntryId', 'closedCurrencyAck', 'countrySource', 'currency', 'currencyExponent', 'currencyStatusAtSave', 'direction', 'entryId', 'fundingAccountCountry'];

describe.each(['libsql', 'd1'] as const)('GET /transactions/:id/revisions/:revision on %s', (engine) => {
  let e: Engine;
  beforeAll(async () => {
    e = await startEngine(engine, 'xui-v1-txn-revisions-d1');
  }, 180_000);
  afterAll(async () => {
    await e?.dispose();
  });
  beforeEach(() => e.ping());

  const made = async (s: Seed, body = spend(s)): Promise<Json> => {
    const r = await s.post(body);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json;
  };
  const revision = (s: Seed, T: string, n: string | number) => s.api.get(`/api/transactions/${T}/revisions/${n}`);

  it('COR-8: each published version as saved — the original and a fact correction on another account; account summaries are current, jurisdictions the saved snapshots', async () => {
    const s = await seedUser(e);
    const w = await made(s);
    const T = w.transactionId as string;
    const v2 = await factCorrection(e, s, T, { merchantName: 'Corrected Store' }, { accountId: s.BE, currency: 'USD' });
    // Afterwards the HK account is renamed and changes jurisdiction: the summaries follow, the snapshots don't.
    expect((await s.api.patch(`/api/accounts/${s.HK}`, { name: 'Renamed HK', status: 'frozen' })).status).toBe(200);
    await e.exec("UPDATE accounts SET account_country = 'SG' WHERE id = ?", s.HK);
    const hk = { id: s.HK, name: 'Renamed HK', accountCountry: 'SG', status: 'frozen' };
    const be = (await s.api.get(`/api/accounts/${s.BE}`)).json;

    const r1 = await revision(s, T, 1);
    expect(r1.status).toBe(200);
    expect(Object.keys(r1.json).sort()).toEqual(['entries', 'event', 'revision', 'transactionId', 'txnType']);
    expect(r1.json).toEqual({ transactionId: T, txnType: 'merchant_spend', revision: 1, event: w.event, entries: [{ ...w.entries[0], account: hk }] });
    expect(r1.json.entries[0].fundingAccountCountry).toBe('HK');

    const r2 = await revision(s, T, 2);
    expect(r2.json).toMatchObject({
      transactionId: T, txnType: 'merchant_spend', revision: 2,
      event: { eventId: v2.eventId, revision: 2, revisionKind: 'fact_correction', correctionReason: 'fix 1', merchantName: 'Corrected Store', homeRegion: 'CN', homeRegionSource: 'carried' },
      entries: [{ entryId: v2.entryIds[0], accountId: s.BE, currency: 'USD', fundingAccountCountry: 'BE', countrySource: 'account_at_save', carriedFromEntryId: null, account: { id: s.BE, name: be.name, accountCountry: 'BE', status: 'active' } }],
    });
    for (const r of [r1, r2]) for (const en of r.json.entries) expect(Object.keys(en).sort()).toEqual(ENTRY_KEYS);
    // The current version through the detail is the same event as revision 2.
    expect((await s.api.get(`/api/transactions/${T}`)).json.event).toEqual(r2.json.event);
  });

  it('COR-8: an own transfer’s version lists both entries out first; every version of a voided transaction stays readable', async () => {
    const s = await seedUser(e);
    const w = await made(s, ownTransfer(s));
    const T = w.transactionId as string;
    await factCorrection(e, s, T, { occurredTime: '09:30' });
    expect((await s.voidTx(T, { baseRevision: 2 })).status).toBe(200);
    const r1 = await revision(s, T, 1);
    expect(r1.json.entries.map((en: Json) => [en.direction, en.accountId])).toEqual([['out', s.HK], ['in', s.BE]]);
    expect(r1.json.event).toEqual(w.event);
    const r2 = await revision(s, T, 2);
    expect([r2.status, r2.json.event.occurredTime, r2.json.entries.map((en: Json) => en.countrySource)]).toEqual([200, '09:30', ['carried', 'carried']]);
  });

  it('COR-8 / ISO-1: a version above currentRevision, an unpublished next version, an unpublished header, another user’s and a missing transaction are the same 404', async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    const w = await made(a);
    const T = w.transactionId as string;
    const notFound = { error: 'transaction revision not found', code: 'NOT_FOUND' };
    expect([(await revision(a, T, 2)).status, (await revision(a, T, 2)).json]).toEqual([404, notFound]);
    expect((await revision(a, T, '9007199254740991')).json).toEqual(notFound);
    // An unpublished revision 2 (raw SQL residue, DATA_MODEL §10.11) is not a version yet.
    const cols = (await e.all("SELECT name FROM pragma_table_info('transaction_events')")).map((c) => String(c.name));
    const pick = cols.map((c) => ({ id: '?', revision: '2', revision_kind: "'fact_correction'", correction_reason: "'residue'", home_region_source: "'carried'", merchant_name: "'Residue Shop'" })[c] ?? c);
    await e.exec(`INSERT INTO transaction_events (${cols.join(', ')}) SELECT ${pick.join(', ')} FROM transaction_events WHERE id = ?`, nid('E'), w.eventId);
    expect((await revision(a, T, 2)).json).toEqual(notFound);
    expect((await revision(a, T, 1)).json.event.merchantName).toBe('Example Store');
    const unpublished = `unpublished-${newKey()}`;
    await e.exec('INSERT INTO transactions (id, user_id, txn_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', unpublished, a.id, 'merchant_spend', 1, 1);
    expect((await revision(a, unpublished, 1)).json).toEqual(notFound);
    for (const r of [await revision(b, T, 1), await revision(b, 'no-such-transaction-000000', 1)]) {
      expect([r.status, r.json]).toEqual([404, notFound]);
      expect(JSON.stringify(r.json)).not.toContain(T);
    }
    expect((await client(e.t).get(`/api/transactions/${T}/revisions/1`)).status).toBe(401);
  });

  it('Q-B3-7: the revision must be a canonical decimal positive integer — anything else is 400 VALIDATION decided by the request alone, also for another user’s transaction', async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    const T = (await made(a)).transactionId as string;
    const bad = ['0', '00', '01', '-1', '+1', '1.0', '1e2', '0x1', 'abc', '%201', '1%20', '%EF%BC%91', '9007199254740992', '99999999999999999'];
    for (const n of bad) {
      for (const [s, id] of [[a, T], [b, T], [a, 'no-such-transaction-000000']] as [Seed, string][]) {
        const r = await revision(s, id, n);
        expect([r.status, r.json.code, r.json.details?.[0]?.path], n).toEqual([400, 'VALIDATION', ['revision']]);
      }
    }
    expect((await revision(a, T, '1')).status).toBe(200);
  });
});
