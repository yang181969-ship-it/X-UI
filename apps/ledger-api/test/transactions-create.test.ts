// M3-B2-B.1: POST /transactions — what is written and what is refused (API_SPEC §5.0 – §5.4,
// DATA_MODEL §10; TEST_PLAN M3-1, AMT, SHP, REG, BF, HRD, ISO-2/3/5/6). Every case runs on libsql
// and on wrangler's local in-memory D1 through the real HTTP app. All data is fictional.
import { requestHashV1, transactionCreateSchema } from '@xui/ledger-shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { counts, entryRows, eventRow, keyRow, ledgerDump, newKey, NONE, ONE_SPEND, ownTransfer, seedUser, spend, startEngine, type Engine, type Seed } from './transactions-kit.ts';

type Body = Record<string, unknown>;

describe.each(['libsql', 'd1'] as const)('POST /transactions on %s', (engine) => {
  let e: Engine;
  beforeAll(async () => {
    e = await startEngine(engine, 'xui-v1-txn-create-d1');
  }, 180_000);
  afterAll(async () => {
    await e?.dispose();
  });
  beforeEach(() => e.ping());

  const ok = async (s: Seed, body: Body, key = newKey()) => {
    const r = await s.post(body, key);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json;
  };
  const refused = async (s: Seed, body: Body, status: number, code: string) => {
    const before = await counts(e, s.id);
    const r = await s.post(body);
    expect(r.status, JSON.stringify(r.json)).toBe(status);
    expect(r.json.code).toBe(code);
    expect(await counts(e, s.id)).toEqual(before);
    return r.json;
  };

  // ================================================================== what is written (M3-1, AMT-6)

  it('M3-1: a foreign spend is written whole — header, version 1, entry, audit, permanent key — and answered with TransactionWriteResult', async () => {
    const s = await seedUser(e);
    const key = newKey();
    const body = spend(s, { notes: 'lunch' });
    const r = await s.post(body, key);
    expect(r.status).toBe(201);
    expect(r.res.headers.get('idempotency-replayed')).toBeNull();
    const now = e.t.clock.t;
    const T = r.json.transactionId as string;
    const E = r.json.eventId as string;
    expect(r.json).toEqual({
      operation: 'transaction.create',
      transactionId: T,
      txnType: 'merchant_spend',
      revision: 1,
      eventId: E,
      statusAfter: 'active',
      recordedAt: now,
      event: {
        eventId: E, revision: 1, revisionKind: 'original', correctionReason: null, recordMode: 'current',
        occurredOn: '2026-10-14', occurredTime: '14:05', postedOn: null,
        eventCurrency: 'USD', eventAmount: 1000, eventCurrencyExponent: 2,
        merchantName: 'Example Store', merchantCountry: 'US', cardId: s.K, paymentChannelId: null, transferMethod: null, counterparty: null,
        homeRegion: 'CN', homeRegionSource: 'preference_at_save', merchantScope: 'foreign', transferScope: null, foreignStatus: 'foreign',
        classifierVersion: 1, createdAt: now,
      },
      entries: [
        {
          entryId: expect.any(String), direction: 'out', accountId: s.HK, currency: 'HKD', currencyExponent: 2, amount: 7830, amountStatus: 'confirmed',
          fundingAccountCountry: 'HK', countrySource: 'account_at_save', currencyStatusAtSave: 'active', closedCurrencyAck: false, carriedFromEntryId: null,
        },
      ],
      void: null,
    });
    // Notes live on the header, never in the write result.
    expect(JSON.stringify(r.json)).not.toContain('lunch');

    expect(await counts(e, s.id)).toEqual(ONE_SPEND);
    const [header] = await e.all('SELECT * FROM transactions WHERE id = ?', T);
    expect(header).toMatchObject({ user_id: s.id, txn_type: 'merchant_spend', status: 'active', current_revision: 1, notes: 'lunch', voided_at: null, created_at: now, updated_at: now });
    const [audit] = await e.all("SELECT * FROM audit_log WHERE user_id = ? AND action = 'transaction.create'", s.id);
    expect(JSON.parse(String(audit!.detail))).toEqual({ id: T, eventId: E, revision: 1 });
    const k = await keyRow(e, s.id, key);
    expect(k).toMatchObject({
      operation: 'transaction.create', hash_version: 1, transaction_id: T, result_revision: 1, result_event_id: E, audit_id: audit!.id, response_status: 201, created_at: now, expires_at: null,
    });
    // The hash is of the zod-parsed body (defaults filled in), not of the raw JSON.
    expect(k!.request_hash).toBe(await requestHashV1('transaction.create', null, transactionCreateSchema.parse(body)));
  });

  it('each type: refund, own transfer (two sides, cross-currency), own transfer to an unregistered own account, third party out and in (amount unknown), pending amount', async () => {
    const s = await seedUser(e);
    const cases: { body: Body; scope: Record<string, unknown>; cp: unknown; entries: Record<string, unknown>[] }[] = [
      {
        body: spend(s, { type: 'merchant_refund', entries: [{ direction: 'in', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 7830 }] }),
        scope: { merchantScope: 'foreign', transferScope: null, foreignStatus: 'foreign' },
        cp: null,
        entries: [{ direction: 'in', accountId: s.HK, currency: 'HKD', amount: 7830 }],
      },
      {
        // SHP-8 / AMT-8: HKD out of HK, EUR into BE — three independent amounts, no rate.
        body: ownTransfer(s, {
          entries: [
            { direction: 'in', accountId: s.BE, currency: 'EUR', amountStatus: 'confirmed', amount: 91000 },
            { direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 781234 },
          ],
        }),
        scope: { merchantScope: null, transferScope: 'foreign_cross_border', foreignStatus: 'foreign' },
        cp: { kind: 'self', name: null, country: null, institution: null, accountHint: null },
        entries: [
          { direction: 'out', accountId: s.HK, currency: 'HKD', amount: 781234 },
          { direction: 'in', accountId: s.BE, currency: 'EUR', amount: 91000 },
        ],
      },
      {
        body: ownTransfer(s, {
          eventCurrency: 'CNY',
          eventAmount: 500000,
          counterparty: { country: 'HK', institution: 'Other Bank', accountHint: '0042' },
          entries: [{ direction: 'out', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 500000 }],
        }),
        scope: { merchantScope: null, transferScope: 'outbound', foreignStatus: 'foreign' },
        cp: { kind: 'self', name: null, country: 'HK', institution: 'Other Bank', accountHint: '0042' },
        entries: [{ direction: 'out', accountId: s.CN, currency: 'CNY', amount: 500000 }],
      },
      {
        body: { type: 'third_party_transfer', occurredOn: '2026-10-14', eventCurrency: 'HKD', eventAmount: 20000, transferMethod: 'fps', counterparty: { name: 'A Friend' }, entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 20000 }] },
        scope: { merchantScope: null, transferScope: 'foreign_to_unknown', foreignStatus: 'foreign' },
        cp: { kind: 'third_party', name: 'A Friend', country: null, institution: null, accountHint: null },
        entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amount: 20000 }],
      },
      {
        // P8: money received from a third party whose sent amount is unknown — currency alone.
        body: { type: 'third_party_transfer', occurredOn: '2026-10-14', eventCurrency: 'USD', eventAmount: null, transferMethod: 'swift', counterparty: { country: 'US' }, entries: [{ direction: 'in', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 70000 }] },
        scope: { merchantScope: null, transferScope: 'inbound', foreignStatus: 'foreign' },
        cp: { kind: 'third_party', name: null, country: 'US', institution: null, accountHint: null },
        entries: [{ direction: 'in', accountId: s.CN, currency: 'CNY', amount: 70000 }],
      },
      {
        // M3-9: a cross-currency charge not known yet is pending — never estimated.
        body: spend(s, { cardId: null, entries: [{ direction: 'out', accountId: s.BE, currency: 'EUR', amountStatus: 'pending', amount: null }] }),
        scope: { merchantScope: 'foreign', transferScope: null, foreignStatus: 'foreign' },
        cp: null,
        entries: [{ direction: 'out', accountId: s.BE, currency: 'EUR', amount: null, amountStatus: 'pending' }],
      },
    ];
    for (const c of cases) {
      const r = await ok(s, c.body);
      expect(r.event, JSON.stringify(c.body)).toMatchObject({ ...c.scope, counterparty: c.cp, eventAmount: c.body.eventAmount });
      expect(r.entries).toHaveLength(c.entries.length);
      c.entries.forEach((x, i) => expect(r.entries[i]).toMatchObject(x));
      const rows = await entryRows(e, r.eventId);
      expect(rows.map((x) => [x.direction, x.funding_account_id, x.funding_currency, x.amount, x.amount_status])).toEqual(
        c.entries.map((x) => [x.direction, x.accountId, x.currency, x.amount, x.amountStatus ?? 'confirmed']),
      );
    }
    expect((await counts(e, s.id)).transactions).toBe(cases.length);
    // No rate, fee or difference column was invented anywhere.
    for (const t of ['transaction_events', 'transaction_entries']) {
      const cols = (await e.all(`SELECT name FROM pragma_table_info('${t}')`)).map((c) => String(c.name));
      expect(cols.filter((c) => /rate|fee|fx|converted|difference|balance/.test(c))).toEqual([]);
    }
  });

  // ================================================================== amounts and strictness (AMT-4, AMT-6, AMT-7)

  it('AMT-4: amounts are minor-unit integers 1 … 999 999 999 999 999; 0, negative, 1e15, fractions and strings are 400 VALIDATION', async () => {
    const s = await seedUser(e);
    for (const amount of [1, 999_999_999_999_999]) {
      const r = await ok(s, spend(s, { eventAmount: amount, entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount }] }));
      expect([r.event.eventAmount, r.entries[0].amount]).toEqual([amount, amount]);
    }
    for (const bad of [0, -1, 1e15, 78.3, '100']) {
      await refused(s, spend(s, { eventAmount: bad }), 400, 'VALIDATION');
      await refused(s, spend(s, { entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: bad }] }), 400, 'VALIDATION');
    }
    // pending ⇔ no amount
    await refused(s, spend(s, { entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'pending', amount: 5 }] }), 400, 'VALIDATION');
    await refused(s, spend(s, { entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: null }] }), 400, 'VALIDATION');
    await refused(s, spend(s, { entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amount: 5 }] }), 400, 'VALIDATION');
  });

  it('AMT-6 / §5.0.1: exponents and every server-written field are refused (400 VALIDATION); exponents come from the ISO table', async () => {
    const s = await seedUser(e);
    const extra: Body[] = [
      { eventCurrencyExponent: 2 }, { homeRegion: 'HK' }, { merchantScope: 'foreign' }, { transferScope: 'outbound' }, { foreignStatus: 'foreign' },
      { classifierVersion: 1 }, { revision: 1 }, { status: 'active' }, { fundingAccountCountry: 'HK' }, { userId: s.id }, { iban: 'GB00XXXX' },
    ];
    for (const x of extra) await refused(s, spend(s, x), 400, 'VALIDATION');
    for (const x of [{ currencyExponent: 2 }, { countrySource: 'carried' }, { currencyStatusAtSave: 'active' }, { carriedFromEntryId: 'x' }, { fundingAccountCountry: 'HK' }]) {
      await refused(s, spend(s, { entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 1, ...x }] }), 400, 'VALIDATION');
    }
    // JPY (0 decimals) event, BHD-free account: the exponent snapshot is the table's.
    const r = await ok(s, spend(s, { eventCurrency: 'JPY', eventAmount: 1500 }));
    expect([r.event.eventCurrencyExponent, r.entries[0].currencyExponent]).toEqual([0, 2]);
    expect((await eventRow(e, r.transactionId)).event_currency_exponent).toBe(0);
  });

  it('AMT-7 / P8: only an incoming third-party transfer may leave the event amount unknown (400 ENTRY_SHAPE rule event_amount)', async () => {
    const s = await seedUser(e);
    for (const body of [
      spend(s, { eventAmount: null }),
      spend(s, { type: 'merchant_refund', eventAmount: null, entries: [{ direction: 'in', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 1 }] }),
      ownTransfer(s, { eventAmount: null }),
      { type: 'third_party_transfer', occurredOn: '2026-10-14', eventCurrency: 'USD', eventAmount: null, counterparty: { country: 'US' }, entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 1 }] },
    ]) {
      const j = await refused(s, body, 400, 'ENTRY_SHAPE');
      expect(j.details).toEqual({ rule: 'event_amount' });
    }
    // An amount needs its currency.
    await refused(s, spend(s, { eventCurrency: null }), 400, 'VALIDATION');
  });

  // ================================================================== shapes (SHP)

  it('SHP-1 … SHP-6: entries and fields that do not fit the type are 400 ENTRY_SHAPE with the rule; nothing is written', async () => {
    const s = await seedUser(e);
    const out = (accountId = s.HK, currency = 'HKD') => ({ direction: 'out', accountId, currency, amountStatus: 'confirmed', amount: 100 });
    const inn = (accountId = s.BE, currency = 'USD') => ({ direction: 'in', accountId, currency, amountStatus: 'confirmed', amount: 100 });
    const third = (x: Body) => ({ type: 'third_party_transfer', occurredOn: '2026-10-14', eventCurrency: 'USD', eventAmount: 100, counterparty: { country: 'US' }, entries: [out(s.HK, 'USD')], ...x });
    const cases: [Body, string][] = [
      [spend(s, { entries: [] }), 'merchant_entries'],
      [spend(s, { entries: [out(), inn()] }), 'merchant_entries'],
      [spend(s, { entries: [inn(s.HK, 'HKD')] }), 'merchant_entries'],
      [spend(s, { type: 'merchant_refund' }), 'merchant_entries'],
      [spend(s, { transferMethod: 'swift' }), 'merchant_fields'],
      [spend(s, { counterparty: { name: 'x' } }), 'merchant_fields'],
      [third({ entries: [out(s.HK, 'USD'), inn()] }), 'third_party_entries'],
      [third({ entries: [] }), 'third_party_entries'],
      [ownTransfer(s, { entries: [] }), 'own_entries'],
      [ownTransfer(s, { entries: [out(s.HK, 'USD'), out(s.BE, 'USD')] }), 'own_entries'],
      [ownTransfer(s, { entries: [out(s.HK, 'HKD'), inn(s.HK, 'USD')] }), 'own_entries'], // no exchange within one account (D2)
      [ownTransfer(s, { counterparty: { country: 'SG' } }), 'own_two_sides_counterparty'],
      [ownTransfer(s, { counterparty: { name: 'Me' } }), 'own_two_sides_counterparty'],
      [ownTransfer(s, { entries: [out(s.HK, 'USD')] }), 'own_one_side_country'],
      [ownTransfer(s, { counterparty: { name: 'Me' }, entries: [out(s.HK, 'USD')] }), 'own_one_side_country'],
      [third({ cardId: s.K }), 'transfer_fields'],
      [third({ merchantName: 'Shop' }), 'transfer_fields'],
      [ownTransfer(s, { merchantCountry: 'US' }), 'transfer_fields'],
    ];
    for (const [body, rule] of cases) {
      const j = await refused(s, body, 400, 'ENTRY_SHAPE');
      expect(j.details, rule).toEqual({ rule });
    }
    // More than ten entries never reach the shape check: the schema caps them.
    await refused(s, spend(s, { entries: Array.from({ length: 11 }, () => out()) }), 400, 'VALIDATION');
  });

  it('request-only checks: occurredOn at most the day after the server UTC date, postedOn not before occurredOn, real dates, HH:MM, sensitive text (no echo)', async () => {
    const s = await seedUser(e);
    const tomorrow = new Date(e.t.clock.t + 86_400_000).toISOString().slice(0, 10);
    const later = new Date(e.t.clock.t + 2 * 86_400_000).toISOString().slice(0, 10);
    await ok(s, spend(s, { occurredOn: tomorrow }));
    const j = await refused(s, spend(s, { occurredOn: later }), 400, 'VALIDATION');
    expect(j.details[0].path).toEqual(['occurredOn']);
    await refused(s, spend(s, { occurredOn: '2026-02-30' }), 400, 'VALIDATION');
    await refused(s, spend(s, { postedOn: '2026-10-13' }), 400, 'VALIDATION');
    await refused(s, spend(s, { occurredTime: '24:00' }), 400, 'VALIDATION');
    const card = '4111 1111 1111 1111';
    for (const x of [{ merchantName: `Shop ${card}` }, { notes: `cvv 123 ${card}` }]) {
      const r = await refused(s, spend(s, x), 400, 'SENSITIVE_DATA');
      expect(JSON.stringify(r)).not.toContain('4111');
    }
    const r = await refused(
      s,
      { type: 'third_party_transfer', occurredOn: '2026-10-14', eventCurrency: 'USD', eventAmount: 1, counterparty: { name: card, institution: `Bank ${card}` }, entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 1 }] },
      400,
      'SENSITIVE_DATA',
    );
    expect(r.details.fields.map((f: { field: string }) => f.field).sort()).toEqual(['counterparty.institution', 'counterparty.name']);
    // accountHint is a 1–4 character tail only.
    await refused(s, ownTransfer(s, { counterparty: { country: 'HK', accountHint: 'GB29NWBK60161331926819' }, entries: [{ direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 1 }] }), 400, 'VALIDATION');
  });

  // ================================================================== regions (REG)

  it('REG-3: unknown is not domestic — an unknown merchant or counterparty country with home-region sides is saved as undetermined', async () => {
    const s = await seedUser(e);
    const a = await ok(s, spend(s, { merchantCountry: null, eventCurrency: 'CNY', entries: [{ direction: 'out', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 100 }] }));
    expect(a.event).toMatchObject({ merchantScope: 'unknown', foreignStatus: 'undetermined' });
    const b = await ok(s, { type: 'third_party_transfer', occurredOn: '2026-10-14', eventCurrency: 'CNY', eventAmount: 100, counterparty: { name: 'Someone' }, entries: [{ direction: 'out', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 100 }] });
    expect(b.event).toMatchObject({ transferScope: 'domestic_to_unknown', foreignStatus: 'undetermined' });
  });

  it('REG-4 / P2: a confirmed purely domestic transaction is 400 CONFIRMED_DOMESTIC and writes nothing (no key either)', async () => {
    const s = await seedUser(e);
    const key = newKey();
    const r = await s.post(spend(s, { merchantCountry: 'CN', eventCurrency: 'CNY', cardId: null, entries: [{ direction: 'out', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 100 }] }), key);
    expect([r.status, r.json.code, r.json.details]).toEqual([400, 'CONFIRMED_DOMESTIC', undefined]);
    await refused(s, ownTransfer(s, { eventCurrency: 'CNY', counterparty: { country: 'CN' }, entries: [{ direction: 'out', accountId: s.CN, currency: 'CNY', amountStatus: 'confirmed', amount: 1 }] }), 400, 'CONFIRMED_DOMESTIC');
    expect(await counts(e, s.id)).toEqual(NONE);
    expect(await keyRow(e, s.id, key)).toBeUndefined();
  });

  it('REG-6: the legal jurisdiction decides, never the route — FPS from a HK account into a BE e-money account is foreign_cross_border', async () => {
    const s = await seedUser(e);
    const r = await ok(s, ownTransfer(s, { transferMethod: 'fps' }));
    expect(r.event).toMatchObject({ transferMethod: 'fps', transferScope: 'foreign_cross_border', foreignStatus: 'foreign' });
    expect(r.entries.map((x: { fundingAccountCountry: string }) => x.fundingAccountCountry)).toEqual(['HK', 'BE']);
  });

  it('M3-3 / REG-7: the home region is a snapshot — a later setting change is used by new transactions only', async () => {
    const s = await seedUser(e);
    const first = await ok(s, spend(s));
    expect(first.event.homeRegion).toBe('CN');
    expect((await s.api.patch('/api/settings/profile', { homeRegion: 'HK' })).status).toBe(200);
    const second = await ok(s, spend(s));
    expect(second.event).toMatchObject({ homeRegion: 'HK', homeRegionSource: 'preference_at_save', merchantScope: 'foreign', foreignStatus: 'foreign' });
    expect((await eventRow(e, first.transactionId)).home_region).toBe('CN');
    // An account's jurisdiction is a snapshot too (M3-2).
    await e.exec("UPDATE accounts SET account_country = 'SG' WHERE id = ?", s.HK);
    expect((await entryRows(e, first.eventId))[0]!.funding_account_country).toBe('HK');
    expect((await ok(s, spend(s))).entries[0].fundingAccountCountry).toBe('SG');
  });

  // ================================================================== backfill, closed currencies, declared home region (BF, HRD)

  it('BF-1 / BF-2 / BF-3: a closed currency — current → 400 CURRENCY_NOT_ON_ACCOUNT (closed); backfill without ack → 400 CLOSED_CURRENCY_ACK_REQUIRED; with ack → saved', async () => {
    const s = await seedUser(e);
    const gbp = (x: Body = {}) => spend(s, { cardId: null, entries: [{ direction: 'out', accountId: s.BE, currency: 'GBP', amountStatus: 'confirmed', amount: 500, ...x }] });
    const a = await refused(s, gbp(), 400, 'CURRENCY_NOT_ON_ACCOUNT');
    expect(a.details).toEqual({ direction: 'out', currency: 'GBP', status: 'closed' });
    // Current transactions never use a closed currency, acknowledged or not.
    expect((await refused(s, gbp({ closedCurrencyAck: true }), 400, 'CURRENCY_NOT_ON_ACCOUNT')).details.status).toBe('closed');
    const b = await refused(s, { ...gbp(), recordMode: 'backfill', occurredOn: '2024-01-10' }, 400, 'CLOSED_CURRENCY_ACK_REQUIRED');
    expect(b.details).toEqual({ direction: 'out' });
    const c = await ok(s, { ...gbp({ closedCurrencyAck: true }), recordMode: 'backfill', occurredOn: '2024-01-10' });
    expect(c.event.recordMode).toBe('backfill');
    expect(c.entries[0]).toMatchObject({ currency: 'GBP', currencyStatusAtSave: 'closed', closedCurrencyAck: true });
    expect((await entryRows(e, c.eventId))[0]).toMatchObject({ currency_status_at_save: 'closed', closed_currency_ack: 1 });
  });

  it('BF-5 / Q4: a currency the account never had → 400 CURRENCY_NOT_ON_ACCOUNT with status null; once added (even closed) it can be backfilled', async () => {
    const s = await seedUser(e);
    const jpy = (x: Body = {}) => spend(s, { cardId: null, entries: [{ direction: 'out', accountId: s.HK, currency: 'JPY', amountStatus: 'confirmed', amount: 500, ...x }] });
    expect((await refused(s, jpy(), 400, 'CURRENCY_NOT_ON_ACCOUNT')).details).toEqual({ direction: 'out', currency: 'JPY', status: null });
    // ISO-3 order: the account is checked before the currency.
    const put = await s.api.req('PUT', `/api/accounts/${s.HK}/currencies`, { currencies: [{ code: 'HKD', isDefault: true }, { code: 'USD' }, { code: 'JPY', status: 'closed' }] });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    const r = await ok(s, { ...jpy({ closedCurrencyAck: true }), recordMode: 'backfill' });
    expect(r.entries[0]).toMatchObject({ currency: 'JPY', currencyExponent: 0, currencyStatusAtSave: 'closed', closedCurrencyAck: true });
  });

  it('BF-9 / Q3: closedCurrencyAck on an active currency is a harmless permission — stored false, the request hash still covers the requested true', async () => {
    const s = await seedUser(e);
    for (const recordMode of ['current', 'backfill']) {
      const key = newKey();
      const body = spend(s, { recordMode, entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 7830, closedCurrencyAck: true }] });
      const r = await s.post(body, key);
      expect(r.status).toBe(201);
      expect(r.json.entries[0]).toMatchObject({ currencyStatusAtSave: 'active', closedCurrencyAck: false });
      expect((await entryRows(e, r.json.eventId))[0]).toMatchObject({ currency_status_at_save: 'active', closed_currency_ack: 0 });
      expect((await keyRow(e, s.id, key))!.request_hash).toBe(await requestHashV1('transaction.create', null, transactionCreateSchema.parse(body)));
      // The same request again is a replay; the same key with ack false is a different request.
      const again = await s.post(body, key);
      expect([again.status, again.res.headers.get('idempotency-replayed')]).toEqual([201, 'true']);
      expect(again.json).toEqual(r.json);
      const other = await s.post({ ...body, entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 7830, closedCurrencyAck: false }] }, key);
      expect([other.status, other.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    }
    expect((await counts(e, s.id)).transactions).toBe(2);
  });

  it('BF-7: frozen / closed accounts, closed cards and archived channels can all be recorded (no status limit, no link needed)', async () => {
    const s = await seedUser(e);
    await e.exec("UPDATE accounts SET status = 'closed' WHERE id = ?", s.HK);
    await e.exec("UPDATE cards SET status = 'closed' WHERE id = ?", s.K);
    await e.exec("UPDATE payment_channels SET status = 'archived' WHERE id = ?", s.PP);
    const r = await ok(s, spend(s, { paymentChannelId: s.PP, recordMode: 'backfill', occurredOn: '2023-05-01' }));
    expect(r.event).toMatchObject({ cardId: s.K, paymentChannelId: s.PP, recordMode: 'backfill' });
    await e.exec("UPDATE accounts SET status = 'frozen' WHERE id = ?", s.HK);
    await ok(s, spend(s));
  });

  it('HRD-1 / HRD-2 / HRD-3: a backfill may declare the home region of the time — user_declared, independent of the setting; current may not', async () => {
    const s = await seedUser(e);
    const auditsBefore = await e.all('SELECT * FROM audit_log WHERE user_id = ?', s.id);
    // Declared HK: a HK account at a US merchant is foreign (account domestic, merchant foreign).
    const r = await ok(s, spend(s, { recordMode: 'backfill', declaredHomeRegion: 'HK', occurredOn: '2022-03-01' }));
    expect(r.event).toMatchObject({ homeRegion: 'HK', homeRegionSource: 'user_declared', foreignStatus: 'foreign' });
    expect(await e.all('SELECT * FROM user_preferences WHERE user_id = ?', s.id)).toEqual([]);
    expect((await e.all("SELECT * FROM audit_log WHERE user_id = ? AND action <> 'transaction.create'", s.id)).length).toBe(auditsBefore.length);
    // Declaring HK makes a HK account at a HK merchant purely domestic: refused.
    await refused(s, spend(s, { recordMode: 'backfill', declaredHomeRegion: 'HK', merchantCountry: 'HK' }), 400, 'CONFIRMED_DOMESTIC');
    const j = await refused(s, spend(s, { declaredHomeRegion: 'HK' }), 400, 'VALIDATION');
    expect(j.details[0].path).toEqual(['declaredHomeRegion']);
    await s.api.patch('/api/settings/profile', { homeRegion: 'SG' });
    expect((await eventRow(e, r.transactionId)).home_region).toBe('HK');
  });

  // ================================================================== isolation (ISO-2, ISO-3, ISO-5, ISO-6)

  it("ISO-2 / ISO-6: another user's account, card or channel and a nonexistent id are the same 404 — same body, no details, nothing written, no foreign id echoed", async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    await ok(b, spend(b, { paymentChannelId: b.PP }));
    const before = await ledgerDump(e);
    const variants: [string, (id: string) => Body, string][] = [
      ['out account', (id) => spend(a, { cardId: null, entries: [{ direction: 'out', accountId: id, currency: 'HKD', amountStatus: 'confirmed', amount: 1 }] }), b.HK],
      ['in account', (id) => ownTransfer(a, { entries: [{ direction: 'out', accountId: a.HK, currency: 'USD', amountStatus: 'confirmed', amount: 1 }, { direction: 'in', accountId: id, currency: 'USD', amountStatus: 'confirmed', amount: 1 }] }), b.BE],
      // ISO-3: b's account in its closed currency is still just "not found" for a.
      ['closed-currency account', (id) => spend(a, { cardId: null, recordMode: 'backfill', entries: [{ direction: 'out', accountId: id, currency: 'GBP', amountStatus: 'confirmed', amount: 1, closedCurrencyAck: true }] }), b.BE],
      ['card', (id) => spend(a, { cardId: id }), b.K],
      ['channel', (id) => spend(a, { paymentChannelId: id }), b.PP],
    ];
    for (const [what, body, foreignId] of variants) {
      const foreign = await a.post(body(foreignId));
      const missing = await a.post(body('no-such-id-0000000000000000'));
      expect(foreign.status, what).toBe(404);
      expect(foreign.json, what).toEqual(missing.json);
      expect(Object.keys(foreign.json).sort(), what).toEqual(['code', 'error']);
      expect(foreign.json.code).toBe('NOT_FOUND');
      for (const id of [b.id, b.HK, b.BE, b.K, b.PP]) expect(JSON.stringify(foreign.json)).not.toContain(id);
    }
    expect(await ledgerDump(e)).toEqual(before);
  });

  it('ISO-2 order: ownership is decided before any other database-dependent error (404, not 400 / 409)', async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    // b's account with a currency a would be refused for (unregistered) and a domestic classification: still 404.
    const r = await a.post(spend(a, { merchantCountry: 'CN', cardId: null, entries: [{ direction: 'out', accountId: b.CN, currency: 'JPY', amountStatus: 'confirmed', amount: 1 }] }));
    expect([r.status, r.json.code]).toEqual([404, 'NOT_FOUND']);
    // The card is checked after the accounts, the channel after the card.
    const both = await a.post(spend(a, { cardId: b.K, paymentChannelId: b.PP }));
    expect(both.json.error).toBe('card not found');
  });

  it('ISO-5: idempotency keys are per user — the same key used by two users makes two independent transactions', async () => {
    const a = await seedUser(e, 'a');
    const b = await seedUser(e, 'b');
    const key = newKey();
    const ra = await a.post(spend(a), key);
    const rb = await b.post(spend(b), key);
    expect([ra.status, rb.status]).toEqual([201, 201]);
    expect(rb.res.headers.get('idempotency-replayed')).toBeNull();
    expect(ra.json.transactionId).not.toBe(rb.json.transactionId);
    expect(await counts(e, a.id)).toEqual(ONE_SPEND);
    expect(await counts(e, b.id)).toEqual(ONE_SPEND);
  });
});
