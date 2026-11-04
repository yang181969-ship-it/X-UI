// @xui/ledger-shared, M3 part (TEST_PLAN §5.2 AMT-1 – AMT-4, §5.4 REG-1, §5.6 IDEM-9 / IDEM-10, and
// the request schemas / Entry-shape rules the API will use). The SQL side of the same rules is in
// m3-schema.test.ts (REG-2 compares classify() with the C6 trigger on both engines).
import { createHash } from 'node:crypto';
import {
  AMOUNT_MAX,
  amountSchema,
  canonicalJson,
  canonicalRequestV1,
  classify,
  CURRENCY_CODES,
  CURRENCY_EXPONENTS,
  currencyExponent,
  EXCLUDED_CURRENCY_CODES,
  factCorrectionSchema,
  formatAmount,
  isIdempotencyKey,
  isMinorAmount,
  latestOccurredOn,
  mergeSegmentedSum,
  parseAmount,
  REQUEST_HASH_VERSION,
  REQUEST_HASHERS,
  requestHash,
  requestHashV1,
  side,
  snapshotCorrectionSchema,
  transactionCorrectionSchema,
  transactionCreateSchema,
  transactionListQuerySchema,
  transactionNotesSchema,
  transactionShapeProblem,
  transactionSummaryQuerySchema,
  transactionVoidSchema,
  TRANSFER_SCOPES,
  type ClassificationInput,
  type ShapeInput,
} from '@xui/ledger-shared';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

const ok = <T extends z.ZodType>(schema: T, v: unknown): z.infer<T> => {
  const r = schema.safeParse(v);
  expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true);
  return r.data as z.infer<T>;
};
const bad = (schema: z.ZodType, v: unknown) => expect(schema.safeParse(v).success, `accepted ${JSON.stringify(v)}`).toBe(false);

describe('AMT-1 ISO 4217 minor units', () => {
  it('cover all 155 currencies with 0, 2 or 3 decimals, from the same List One as CURRENCY_CODES', () => {
    expect(Object.keys(CURRENCY_EXPONENTS).sort()).toEqual([...CURRENCY_CODES].sort());
    expect(Object.keys(CURRENCY_EXPONENTS)).toHaveLength(155);
    const byExp = (n: number) => CURRENCY_CODES.filter((c) => CURRENCY_EXPONENTS[c] === n).sort();
    expect(byExp(0)).toEqual(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
    expect(byExp(3)).toEqual(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
    expect(byExp(2)).toHaveLength(155 - 16 - 7);
    expect(byExp(1)).toEqual([]);
    expect(byExp(4)).toEqual([]);
  });

  it('representative values; excluded and unknown codes throw', () => {
    for (const c of ['JPY', 'KRW', 'VND', 'CLP', 'ISK']) expect(currencyExponent(c), c).toBe(0);
    for (const c of ['USD', 'HKD', 'EUR', 'CNY', 'GBP', 'TWD', 'MOP']) expect(currencyExponent(c), c).toBe(2);
    for (const c of ['BHD', 'KWD', 'JOD', 'OMR', 'TND']) expect(currencyExponent(c), c).toBe(3);
    for (const c of [...EXCLUDED_CURRENCY_CODES, 'usd', 'XXY', '']) expect(() => currencyExponent(c), c).toThrow(RangeError);
    expect(Object.isFrozen(CURRENCY_EXPONENTS)).toBe(true);
  });
});

describe('AMT-2 parseAmount: strings and BigInt only, exact scale', () => {
  it('parses within the currency scale', () => {
    expect(parseAmount('78.30', 2)).toEqual({ ok: true, minor: 7830 });
    expect(parseAmount('78.3', 2)).toEqual({ ok: true, minor: 7830 });
    expect(parseAmount('1000', 0)).toEqual({ ok: true, minor: 1000 });
    expect(parseAmount('1.234', 3)).toEqual({ ok: true, minor: 1234 });
    expect(parseAmount('0.01', 2)).toEqual({ ok: true, minor: 1 });
    expect(parseAmount('007.50', 2)).toEqual({ ok: true, minor: 750 });
    expect(parseAmount('999999999999999', 0)).toEqual({ ok: true, minor: AMOUNT_MAX });
    expect(parseAmount('9999999999999.99', 2)).toEqual({ ok: true, minor: AMOUNT_MAX });
    expect(parseAmount('0.1', 2)).toEqual({ ok: true, minor: 10 }); // 0.1 is not representable as a float — irrelevant here
  });

  it('refuses more decimals than the currency has, zero, out of range and anything but plain digits', () => {
    const err = (t: string, e: number) => (parseAmount(t, e) as { error: string }).error;
    expect(err('1.5', 0)).toBe('scale');
    expect(err('1.0', 0)).toBe('scale');
    expect(err('1.001', 2)).toBe('scale');
    expect(err('0', 2)).toBe('zero');
    expect(err('0.00', 2)).toBe('zero');
    expect(err('1000000000000000', 0)).toBe('range');
    expect(err('10000000000000.00', 2)).toBe('range');
    for (const t of ['-1', '+1', '1e3', '1E3', ' 1', '1 ', '1,000', '1_000', '１２', '', '.5', '1.', 'NaN', 'Infinity', '0x10', '1.2.3', '١٢']) expect(err(t, 2), JSON.stringify(t)).toBe('format');
  });

  it('round-trips random amounts at every exponent (property test, no float on the way)', () => {
    let state = 0x9e3779b97f4a7c15n;
    const next = () => (state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn);
    for (let i = 0; i < 2000; i++) {
      const minor = Number((next() % BigInt(AMOUNT_MAX)) + 1n);
      for (const exp of [0, 1, 2, 3, 4]) {
        const text = formatAmount(minor, exp);
        expect(parseAmount(text, exp), `${minor} @${exp}`).toEqual({ ok: true, minor });
      }
    }
  });

  it('isMinorAmount is the same range as the database CHECK', () => {
    for (const v of [1, 7830, AMOUNT_MAX]) expect(isMinorAmount(v)).toBe(true);
    for (const v of [0, -1, 78.3, AMOUNT_MAX + 1, 1e15, Number.NaN, '100', 7830n, null]) expect(isMinorAmount(v), String(v)).toBe(false);
  });
});

describe('AMT-3 formatAmount and segmented sums', () => {
  it('formats minor units with the saved exponent, including sums above 2^53', () => {
    expect(formatAmount(7830, 2)).toBe('78.30');
    expect(formatAmount(5, 2)).toBe('0.05');
    expect(formatAmount(1000, 0)).toBe('1000');
    expect(formatAmount(1234, 3)).toBe('1.234');
    expect(formatAmount(1, 4)).toBe('0.0001');
    expect(formatAmount(9300n * 999_999_999_999_999n, 2)).toBe('92999999999999907.00');
    expect(formatAmount('9007199254740993', 0)).toBe('9007199254740993');
    expect(formatAmount('9007199254740993', 2)).toBe('90071992547409.93');
    expect(() => formatAmount(78.3, 2)).toThrow(RangeError);
    expect(() => formatAmount(1, 5)).toThrow(RangeError);
    expect(() => formatAmount('1.5', 2)).toThrow(RangeError);
  });

  it('merges SUM(amount / 10^9) and SUM(amount % 10^9) exactly', () => {
    const rows = 9300n;
    const max = 999_999_999_999_999n;
    const hi = (rows * (max / 1_000_000_000n)).toString();
    const lo = (rows * (max % 1_000_000_000n)).toString();
    expect(mergeSegmentedSum(hi, lo)).toBe((rows * max).toString());
    expect(mergeSegmentedSum('0', '15660')).toBe('15660');
    expect(() => mergeSegmentedSum('1.5', '0')).toThrow(RangeError);
    expect(() => mergeSegmentedSum('-1', '0')).toThrow(RangeError);
  });
});

describe('AMT-4 (schema part) amounts are JSON integers in range', () => {
  it('accepts 1 and the maximum; refuses 0, negatives, fractions, 1e15 and strings', () => {
    expect(ok(amountSchema, 1)).toBe(1);
    expect(ok(amountSchema, AMOUNT_MAX)).toBe(AMOUNT_MAX);
    for (const v of [0, -1, 78.3, 1e15, '100', '78.30', null, Number.NaN]) bad(amountSchema, v);
  });
});

// ------------------------------------------------------------------ classification

const H = 'CN';
const spend = (account: string, merchant: string | null, txnType: 'merchant_spend' | 'merchant_refund' = 'merchant_spend', home = H): ClassificationInput => ({
  txnType,
  homeRegion: home,
  merchantCountry: merchant,
  counterpartyCountry: null,
  entries: [{ direction: txnType === 'merchant_spend' ? 'out' : 'in', fundingAccountCountry: account }],
});

/** A third-party transfer whose sides are F (sending) and T (receiving); null = unknown. */
const transfer = (f: string | null, t: string | null, home = H): ClassificationInput =>
  f !== null
    ? { txnType: 'third_party_transfer', homeRegion: home, merchantCountry: null, counterpartyCountry: t, entries: [{ direction: 'out', fundingAccountCountry: f }] }
    : { txnType: 'third_party_transfer', homeRegion: home, merchantCountry: null, counterpartyCountry: f, entries: [{ direction: 'in', fundingAccountCountry: t! }] };

describe('REG-1 classify v1 truth tables (DATA_MODEL §10.8)', () => {
  it('spend / refund: account side × merchant side', () => {
    const table: [string, string | null, string, string][] = [
      // account, merchant → merchantScope, foreignStatus
      ['CN', 'CN', 'domestic', 'domestic'],
      ['CN', 'US', 'foreign', 'foreign'],
      ['CN', null, 'unknown', 'undetermined'],
      ['HK', 'CN', 'domestic', 'foreign'],
      ['HK', 'US', 'foreign', 'foreign'],
      ['HK', null, 'unknown', 'foreign'],
    ];
    for (const type of ['merchant_spend', 'merchant_refund'] as const) {
      for (const [a, m, ms, fs] of table) {
        expect(classify(spend(a, m, type)), `${type} ${a}/${m}`).toEqual({ classifierVersion: 1, merchantScope: ms, transferScope: null, foreignStatus: fs });
      }
    }
  });

  it('transfers: sending × receiving side (= H, ≠ H, unknown; equal or different foreign sides)', () => {
    const X = 'HK';
    const Y = 'BE';
    const table: [string | null, string | null, string, string][] = [
      [H, H, 'domestic_local', 'domestic'],
      [X, X, 'foreign_local', 'foreign'],
      [H, X, 'outbound', 'foreign'],
      [X, H, 'inbound', 'foreign'],
      [X, Y, 'foreign_cross_border', 'foreign'],
      [H, null, 'domestic_to_unknown', 'undetermined'],
      [X, null, 'foreign_to_unknown', 'foreign'],
      [null, H, 'unknown_to_domestic', 'undetermined'],
      [null, X, 'unknown_to_foreign', 'foreign'],
    ];
    expect(new Set(table.map((r) => r[2]))).toEqual(new Set(TRANSFER_SCOPES));
    for (const [f, t, scope, fs] of table) {
      expect(classify(transfer(f, t)), `${f} → ${t}`).toEqual({ classifierVersion: 1, merchantScope: null, transferScope: scope, foreignStatus: fs });
    }
    // An own transfer between two registered accounts takes both sides from the entries.
    const own = (f: string, t: string): ClassificationInput => ({
      txnType: 'own_transfer',
      homeRegion: H,
      merchantCountry: null,
      counterpartyCountry: null,
      entries: [
        { direction: 'in', fundingAccountCountry: t },
        { direction: 'out', fundingAccountCountry: f },
      ],
    });
    expect(classify(own('HK', 'BE')).transferScope).toBe('foreign_cross_border');
    expect(classify(own('CN', 'HK')).transferScope).toBe('outbound');
  });

  it('HK, MO and TW are separate jurisdictions; unknown is never domestic', () => {
    expect(classify(spend('HK', 'HK', 'merchant_spend', 'CN')).foreignStatus).toBe('foreign');
    expect(classify(spend('MO', 'MO', 'merchant_spend', 'HK')).foreignStatus).toBe('foreign');
    expect(classify(spend('TW', 'TW', 'merchant_spend', 'TW')).foreignStatus).toBe('domestic');
    expect(classify(transfer('HK', 'MO', 'HK')).transferScope).toBe('outbound');
    expect(classify(transfer('TW', 'CN', 'TW')).transferScope).toBe('outbound');
    expect(side(null, 'CN')).toBe('unknown');
    expect(side('CN', 'CN')).toBe('domestic');
    expect(side('HK', 'CN')).toBe('foreign');
    expect(() => classify({ ...spend('CN', 'CN'), entries: [] })).toThrow(RangeError);
  });
});

// ------------------------------------------------------------------ idempotency

const BODY = {
  type: 'merchant_spend',
  recordMode: 'current',
  occurredOn: '2026-10-20',
  eventAmount: 1000,
  merchantName: '示例商店',
  entries: [
    { direction: 'in', accountId: 'acc-b', amount: 7830 },
    { direction: 'out', accountId: 'acc-a', amount: null },
  ],
};

describe('IDEM-10 canonical request and hash v1', () => {
  it('fixed vector: exact canonical text and SHA-256', async () => {
    const text = canonicalRequestV1('transaction.create', null, BODY);
    expect(text).toBe(
      '{"body":{"entries":[{"accountId":"acc-a","amount":null,"direction":"out"},{"accountId":"acc-b","amount":7830,"direction":"in"}],"eventAmount":1000,"merchantName":"示例商店","occurredOn":"2026-10-20","recordMode":"current","type":"merchant_spend"},"operation":"transaction.create","transactionId":null,"v":1}',
    );
    // Pinned: a change to canonicalization or encoding must fail here (and needs a new hash_version).
    const PINNED = '702935bf306f1a6cc6e6608e17eeb5f8714041d7a00be5e6bdb92c39bf97e6a9';
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(PINNED);
    expect(await requestHashV1('transaction.create', null, BODY)).toBe(PINNED);
  });

  it('key order and entry order do not matter; any value, the operation and the transaction id do', async () => {
    const base = await requestHashV1('transaction.correct', 'T1', BODY);
    const reordered = { entries: [...BODY.entries].reverse().map((e) => ({ amount: e.amount, accountId: e.accountId, direction: e.direction })), merchantName: BODY.merchantName, type: BODY.type, occurredOn: BODY.occurredOn, eventAmount: BODY.eventAmount, recordMode: BODY.recordMode };
    expect(await requestHashV1('transaction.correct', 'T1', reordered)).toBe(base);
    const variants = [
      { ...BODY, eventAmount: 1001 },
      { ...BODY, merchantName: '示例商店 ' },
      { ...BODY, entries: [BODY.entries[0], { ...BODY.entries[1], amount: 1 }] },
      { ...BODY, extra: null },
    ];
    for (const v of variants) expect(await requestHashV1('transaction.correct', 'T1', v)).not.toBe(base);
    expect(await requestHashV1('transaction.void', 'T1', BODY)).not.toBe(base);
    expect(await requestHashV1('transaction.correct', 'T2', BODY)).not.toBe(base);
    expect(await requestHashV1('transaction.correct', null, BODY)).not.toBe(base);
  });

  it('canonical JSON: sorted keys, no whitespace, integers as integers, undefined members dropped, no NaN', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 0, y: undefined } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"z":0}}');
    expect(canonicalJson(999_999_999_999_999)).toBe('999999999999999');
    expect(() => canonicalJson(Number.NaN)).toThrow(RangeError);
    expect(() => canonicalJson(new Date(0))).toThrow(TypeError);
    expect(() => canonicalJson(1n)).toThrow(TypeError);
  });

  it('a parsed body hashes the same whether optional fields were omitted or sent as null', async () => {
    const minimal = { type: 'merchant_spend', occurredOn: '2026-10-20', eventCurrency: 'USD', eventAmount: 1000, entries: [{ direction: 'out', accountId: 'a', currency: 'HKD', amountStatus: 'confirmed', amount: 7830 }] };
    const explicit = {
      ...minimal,
      recordMode: 'current',
      declaredHomeRegion: null,
      occurredTime: null,
      postedOn: null,
      merchantName: null,
      merchantCountry: null,
      cardId: null,
      paymentChannelId: null,
      transferMethod: null,
      counterparty: null,
      notes: null,
      entries: [{ ...minimal.entries[0], closedCurrencyAck: false }],
    };
    const a = ok(transactionCreateSchema, minimal);
    const b = ok(transactionCreateSchema, explicit);
    expect(await requestHashV1('transaction.create', null, a)).toBe(await requestHashV1('transaction.create', null, b));
  });
});

describe('IDEM-9 hash versions and key format', () => {
  it('a key row is compared with the hasher of its own hash_version', async () => {
    expect(REQUEST_HASH_VERSION).toBe(1);
    expect(REQUEST_HASHERS[1]).toBe(requestHashV1);
    expect(await requestHash(1, 'transaction.create', null, BODY)).toBe(await requestHashV1('transaction.create', null, BODY));
    await expect(async () => requestHash(2, 'transaction.create', null, BODY)).rejects.toThrow(RangeError);
    expect(Object.isFrozen(REQUEST_HASHERS)).toBe(true);
  });

  it('Idempotency-Key: 16–64 of [0-9A-Za-z_-] (same rule as the database CHECK)', () => {
    for (const k of ['a'.repeat(16), 'A'.repeat(64), crypto.randomUUID(), 'key_with-dash_and_9']) expect(isIdempotencyKey(k), k).toBe(true);
    for (const k of ['a'.repeat(15), 'a'.repeat(65), 'has space in it 123', 'dots.are.not.allowed', 'ü'.repeat(20), '']) expect(isIdempotencyKey(k), k).toBe(false);
  });
});

// ------------------------------------------------------------------ request schemas

const SPEND = {
  type: 'merchant_spend',
  recordMode: 'current',
  declaredHomeRegion: null,
  occurredOn: '2026-10-20',
  occurredTime: '14:05',
  postedOn: null,
  eventCurrency: 'USD',
  eventAmount: 1000,
  merchantName: 'Example Store',
  merchantCountry: 'US',
  cardId: 'card1',
  paymentChannelId: null,
  transferMethod: null,
  counterparty: null,
  entries: [{ direction: 'out', accountId: 'acc1', currency: 'HKD', amountStatus: 'confirmed', amount: 7830, closedCurrencyAck: false }],
  notes: null,
};

describe('transaction request schemas (API_SPEC §5.4 – §5.10)', () => {
  it('accepts the API_SPEC create example; recordMode defaults to current', () => {
    expect(ok(transactionCreateSchema, SPEND).recordMode).toBe('current');
    const { recordMode: _r, ...noMode } = SPEND;
    expect(ok(transactionCreateSchema, noMode).recordMode).toBe('current');
  });

  it('refuses every server-only field and unknown fields (VALIDATION)', () => {
    for (const extra of ['homeRegion', 'merchantScope', 'transferScope', 'foreignStatus', 'classifierVersion', 'revision', 'eventCurrencyExponent', 'status', 'iban', 'bic', 'receivingCountry']) {
      bad(transactionCreateSchema, { ...SPEND, [extra]: 'X' });
    }
    for (const extra of ['fundingAccountCountry', 'currencyExponent', 'countrySource', 'currencyStatusAtSave', 'carriedFromEntryId', 'accountNumber']) {
      bad(transactionCreateSchema, { ...SPEND, entries: [{ ...SPEND.entries[0], [extra]: 'X' }] });
    }
    bad(transactionCreateSchema, { ...SPEND, counterparty: { name: 'x', iban: 'GB00' } });
  });

  it('field rules: dates, time, amounts, pending ⇔ null amount, declaredHomeRegion only for backfill, eventAmount needs a currency', () => {
    for (const occurredOn of ['2026-02-30', '2026-13-01', '20261020', '']) bad(transactionCreateSchema, { ...SPEND, occurredOn });
    for (const occurredTime of ['24:00', '9:05', '12:60', '12:5']) bad(transactionCreateSchema, { ...SPEND, occurredTime });
    bad(transactionCreateSchema, { ...SPEND, postedOn: '2026-10-19' });
    ok(transactionCreateSchema, { ...SPEND, postedOn: '2026-10-20' });
    for (const amount of [0, -1, 78.3, 1e15, '7830']) bad(transactionCreateSchema, { ...SPEND, entries: [{ ...SPEND.entries[0], amount }] });
    bad(transactionCreateSchema, { ...SPEND, entries: [{ ...SPEND.entries[0], amountStatus: 'pending' }] });
    bad(transactionCreateSchema, { ...SPEND, entries: [{ ...SPEND.entries[0], amount: null }] });
    ok(transactionCreateSchema, { ...SPEND, entries: [{ ...SPEND.entries[0], amountStatus: 'pending', amount: null }] });
    bad(transactionCreateSchema, { ...SPEND, declaredHomeRegion: 'HK' });
    ok(transactionCreateSchema, { ...SPEND, recordMode: 'backfill', declaredHomeRegion: 'HK' });
    bad(transactionCreateSchema, { ...SPEND, eventCurrency: null });
    bad(transactionCreateSchema, { ...SPEND, eventCurrency: 'XAU' });
    bad(transactionCreateSchema, { ...SPEND, counterparty: { accountHint: '12345' } });
    bad(transactionCreateSchema, { ...SPEND, type: 'credit_card_spend' });
    expect(latestOccurredOn(Date.UTC(2026, 9, 31, 23, 59))).toBe('2026-11-01');
  });

  it('corrections: kind-specific bodies; no type or notes; reasons required where the spec says', () => {
    const fact = { ...SPEND, kind: 'fact_correction', baseRevision: 1, reason: 'account chosen wrongly' } as Record<string, unknown>;
    delete fact.type;
    delete fact.declaredHomeRegion;
    delete fact.notes;
    ok(transactionCorrectionSchema, fact);
    bad(transactionCorrectionSchema, { ...fact, type: 'merchant_spend' });
    bad(transactionCorrectionSchema, { ...fact, notes: 'x' });
    bad(transactionCorrectionSchema, { ...fact, declaredHomeRegion: 'HK' });
    bad(factCorrectionSchema, { ...fact, reason: undefined });
    bad(factCorrectionSchema, { ...fact, reason: '   ' });
    ok(transactionCorrectionSchema, { kind: 'settlement', baseRevision: 1, reason: null, entries: [{ direction: 'in', amount: 783000 }] });
    bad(transactionCorrectionSchema, { kind: 'settlement', baseRevision: 1, entries: [] });
    bad(transactionCorrectionSchema, { kind: 'settlement', baseRevision: 1, entries: [{ direction: 'in', amount: 1 }, { direction: 'in', amount: 2 }] });
    bad(transactionCorrectionSchema, { kind: 'settlement', baseRevision: 0, entries: [{ direction: 'in', amount: 1 }] });
    ok(snapshotCorrectionSchema, { kind: 'snapshot_correction', baseRevision: 2, reason: 'wrong', homeRegion: 'HK' });
    ok(snapshotCorrectionSchema, { kind: 'snapshot_correction', baseRevision: 2, reason: 'wrong', entries: [{ direction: 'out', fundingAccountCountry: 'SG' }] });
    bad(snapshotCorrectionSchema, { kind: 'snapshot_correction', baseRevision: 2, reason: 'wrong' });
    bad(snapshotCorrectionSchema, { kind: 'snapshot_correction', baseRevision: 2, homeRegion: 'HK' });
    bad(snapshotCorrectionSchema, { kind: 'snapshot_correction', baseRevision: 2, reason: 'wrong', homeRegion: 'HK', occurredOn: '2026-10-20' });
    bad(transactionCorrectionSchema, { kind: 'original', baseRevision: 1 });
  });

  it('void, notes, list and summary queries', () => {
    ok(transactionVoidSchema, { baseRevision: 2, reason: null });
    ok(transactionVoidSchema, { baseRevision: 2 });
    bad(transactionVoidSchema, { baseRevision: 2, reason: 'x'.repeat(201) });
    ok(transactionNotesSchema, { notes: null });
    bad(transactionNotesSchema, {});
    bad(transactionNotesSchema, { notes: 'x', baseRevision: 1 });
    expect(ok(transactionListQuerySchema, {})).toEqual({ foreignStatus: 'all', status: 'active' });
    expect(ok(transactionListQuerySchema, { limit: '100' }).limit).toBe(100);
    for (const q of [{ limit: '0' }, { limit: '101' }, { foreignStatus: 'not_foreign' }, { from: '2026-10-21', to: '2026-10-20' }, { status: 'deleted' }]) bad(transactionListQuerySchema, q);
    ok(transactionSummaryQuerySchema, { from: '2026-10-01', to: '2026-10-31', currency: 'HKD' });
    bad(transactionSummaryQuerySchema, { foreignStatus: 'foreign' });
  });
});

describe('Entry shape rules (ENTRY_SHAPE, DATA_MODEL §10.7.1)', () => {
  const base = (x: Partial<ShapeInput>): ShapeInput => ({
    type: 'merchant_spend', eventAmount: 1000, merchantName: null, merchantCountry: null, cardId: null, transferMethod: null, counterparty: null,
    entries: [{ direction: 'out', accountId: 'a' }], ...x,
  });
  const cp = (x: Partial<NonNullable<ShapeInput['counterparty']>> = {}) => ({ name: null, country: null, institution: null, accountHint: null, ...x });
  const two = [{ direction: 'out' as const, accountId: 'a' }, { direction: 'in' as const, accountId: 'b' }];

  it('SHP-1 / SHP-2 merchant types: one entry, the right direction, no transfer fields', () => {
    expect(transactionShapeProblem(base({}))).toBeNull();
    expect(transactionShapeProblem(base({ entries: [] }))).toBe('merchant_entries');
    expect(transactionShapeProblem(base({ entries: two }))).toBe('merchant_entries');
    expect(transactionShapeProblem(base({ entries: [{ direction: 'in', accountId: 'a' }] }))).toBe('merchant_entries');
    expect(transactionShapeProblem(base({ type: 'merchant_refund', entries: [{ direction: 'in', accountId: 'a' }] }))).toBeNull();
    expect(transactionShapeProblem(base({ type: 'merchant_refund' }))).toBe('merchant_entries');
    expect(transactionShapeProblem(base({ transferMethod: 'swift' }))).toBe('merchant_fields');
    expect(transactionShapeProblem(base({ counterparty: cp() }))).toBe('merchant_fields');
    expect(transactionShapeProblem(base({ eventAmount: null }))).toBe('event_amount');
  });

  it('SHP-3 third party: one entry; event amount unknown only when receiving (P8)', () => {
    const tp = (x: Partial<ShapeInput>) => base({ type: 'third_party_transfer', counterparty: cp({ country: 'US' }), ...x });
    expect(transactionShapeProblem(tp({}))).toBeNull();
    expect(transactionShapeProblem(tp({ counterparty: null }))).toBeNull();
    expect(transactionShapeProblem(tp({ entries: two }))).toBe('third_party_entries');
    expect(transactionShapeProblem(tp({ entries: [] }))).toBe('third_party_entries');
    expect(transactionShapeProblem(tp({ eventAmount: null }))).toBe('event_amount');
    expect(transactionShapeProblem(tp({ eventAmount: null, entries: [{ direction: 'in', accountId: 'a' }] }))).toBeNull();
    expect(transactionShapeProblem(tp({ cardId: 'k' }))).toBe('transfer_fields');
    expect(transactionShapeProblem(tp({ merchantCountry: 'US' }))).toBe('transfer_fields');
  });

  it('SHP-4 / SHP-5 own transfers: two registered sides without counterparty, or one side with the other side country', () => {
    const own = (x: Partial<ShapeInput>) => base({ type: 'own_transfer', ...x });
    expect(transactionShapeProblem(own({ entries: two }))).toBeNull();
    expect(transactionShapeProblem(own({ entries: two, counterparty: cp() }))).toBeNull();
    expect(transactionShapeProblem(own({ entries: two, counterparty: cp({ name: 'me' }) }))).toBe('own_two_sides_counterparty');
    expect(transactionShapeProblem(own({ entries: [two[0]!, { direction: 'in', accountId: 'a' }] }))).toBe('own_entries');
    expect(transactionShapeProblem(own({ entries: [two[0]!, { direction: 'out', accountId: 'b' }] }))).toBe('own_entries');
    expect(transactionShapeProblem(own({ entries: [...two, { direction: 'out', accountId: 'c' }] }))).toBe('own_entries');
    expect(transactionShapeProblem(own({ entries: [] }))).toBe('own_entries');
    expect(transactionShapeProblem(own({ counterparty: cp({ country: 'HK' }) }))).toBeNull();
    expect(transactionShapeProblem(own({ counterparty: cp({ name: 'my HSBC' }) }))).toBe('own_one_side_country');
    expect(transactionShapeProblem(own({ counterparty: null }))).toBe('own_one_side_country');
    expect(transactionShapeProblem(own({ entries: two, eventAmount: null }))).toBe('event_amount');
  });
});
