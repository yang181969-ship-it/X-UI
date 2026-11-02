// @xui/ledger-shared: ISO lists, name keys and the zod request schemas (the database side of the
// same enums is covered by m2-schema.test.ts). Kept under apps/ledger-api/test so the legacy
// suite (root vitest.config.ts: packages/*/test) never runs it.
import {
  accountCreateSchema,
  accountCurrenciesReplaceSchema,
  accountUpdateSchema,
  ACCOUNT_TYPES,
  cardCreateSchema,
  cardLinkCreateSchema,
  cardLinkUpdateSchema,
  cardUpdateSchema,
  CARD_TYPES,
  channelSourceCreateSchema,
  CHANNEL_TYPES,
  COUNTRY_CODES,
  CURRENCY_CODES,
  EXCLUDED_CURRENCY_CODES,
  institutionCreateSchema,
  isCountryCode,
  isCurrencyCode,
  ledgerErrorCode,
  normalizeNameKey,
  paymentChannelCreateSchema,
  paymentChannelUpdateSchema,
  profileSettingsUpdateSchema,
  spendingSourceQuerySchema,
} from '@xui/ledger-shared';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

const ok = (schema: z.ZodType, v: unknown) => {
  const r = schema.safeParse(v);
  expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true);
  return r.success ? r.data : undefined;
};
const bad = (schema: z.ZodType, v: unknown) => {
  const r = schema.safeParse(v);
  expect(r.success, `accepted ${JSON.stringify(v)}`).toBe(false);
  return r.success ? undefined : ledgerErrorCode(r.error);
};

describe('ISO lists', () => {
  it('has the 249 ISO 3166-1 alpha-2 codes, unique and upper case', () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(new Set(COUNTRY_CODES).size).toBe(249);
    for (const c of COUNTRY_CODES) expect(c).toMatch(/^[A-Z]{2}$/);
    for (const c of ['CN', 'HK', 'MO', 'TW', 'GB', 'BE', 'LU', 'LT', 'US', 'SG']) expect(isCountryCode(c)).toBe(true);
    for (const c of ['XK', 'UK', 'EU', 'cn', 'CHN']) expect(isCountryCode(c)).toBe(false);
  });

  it('has circulating ISO 4217 currencies only', () => {
    expect(new Set(CURRENCY_CODES).size).toBe(CURRENCY_CODES.length);
    for (const c of CURRENCY_CODES) expect(c).toMatch(/^[A-Z]{3}$/);
    for (const c of ['CNY', 'HKD', 'USD', 'EUR', 'GBP', 'JPY', 'SGD', 'MOP', 'TWD', 'XAF', 'XOF', 'XCD', 'XPF']) expect(isCurrencyCode(c)).toBe(true);
    for (const c of EXCLUDED_CURRENCY_CODES) expect(isCurrencyCode(c), c).toBe(false);
    // SIX List One, Pblshd 2026-09-17: 178 distinct codes = 155 accepted + 23 excluded (iso.ts).
    expect(CURRENCY_CODES).toHaveLength(155);
    expect(EXCLUDED_CURRENCY_CODES).toHaveLength(23);
    expect(new Set([...CURRENCY_CODES, ...EXCLUDED_CURRENCY_CODES]).size).toBe(178);
    for (const c of ['HRK', 'ANG', 'SLL', 'ZWL', 'CUC', 'XAD', 'usd', 'US', 'CNH']) expect(isCurrencyCode(c), c).toBe(false);
  });
});

describe('enums leave out what v1 does not support', () => {
  it('no credit cards, credit/investment/cash accounts or bank_transfer channels', () => {
    expect(CARD_TYPES).toEqual(['debit', 'prepaid']);
    expect(ACCOUNT_TYPES).toEqual(['bank', 'e_money', 'stored_value', 'other']);
    expect(CHANNEL_TYPES).toEqual(['device_wallet', 'payment_service', 'other']);
  });
});

describe('normalizeNameKey', () => {
  it('folds width, case and whitespace (I-2)', () => {
    expect(normalizeNameKey('Wise')).toBe('wise');
    expect(normalizeNameKey('  wise ')).toBe('wise');
    expect(normalizeNameKey('ＷＩＳＥ')).toBe('wise');
    expect(normalizeNameKey('Bank \t of\n  China')).toBe('bank of china');
    expect(normalizeNameKey('招商银行')).toBe('招商银行');
  });
});

const account = { institutionId: 'i1', name: 'Wise 多币种账户', accountType: 'e_money', accountCountry: 'BE', currencies: [{ code: 'USD', isDefault: true }, { code: 'EUR' }, { code: 'GBP' }] };
const card = { issuerInstitutionId: 'i1', name: 'Wise Debit', network: 'visa', cardType: 'debit', last4: '4321', issuingCountry: 'BE' };

describe('accounts', () => {
  it('accepts the minimal body and the full example (A-1, A-5)', () => {
    ok(accountCreateSchema, account);
    ok(accountCreateSchema, { ...account, depositKind: null, numberHint: '1234', status: 'active', openedOn: '2024-03-01', notes: null });
    ok(accountCreateSchema, { ...account, accountType: 'bank', depositKind: 'savings' });
  });

  it('validates the currency list (A-2)', () => {
    bad(accountCreateSchema, { ...account, currencies: [] });
    bad(accountCreateSchema, { ...account, currencies: [{ code: 'USD', isDefault: true }, { code: 'EUR', isDefault: true }] });
    bad(accountCreateSchema, { ...account, currencies: [{ code: 'USD' }, { code: 'EUR' }] });
    bad(accountCreateSchema, { ...account, currencies: [{ code: 'USD', isDefault: true }, { code: 'USD' }] });
    bad(accountCreateSchema, { ...account, currencies: [{ code: 'XAU', isDefault: true }] });
    bad(accountCreateSchema, { ...account, currencies: [{ code: 'usd', isDefault: true }] });
    bad(accountCreateSchema, { ...account, currencies: [{ code: 'USD', isDefault: true, status: 'closed' }] });
    bad(accountCreateSchema, { ...account, currencies: Array.from({ length: 31 }, (_, i) => ({ code: CURRENCY_CODES[i]!, isDefault: i === 0 })) });
    ok(accountCurrenciesReplaceSchema, { currencies: [{ code: 'USD', isDefault: true, status: 'active' }, { code: 'JPY', status: 'closed' }] });
  });

  it('has no balance fields (A-5) and requires institution and country (A-6, A-7)', () => {
    expect(bad(accountCreateSchema, { ...account, balance: 100 })).toBe('VALIDATION');
    expect(bad(accountCreateSchema, { ...account, openingBalance: 100 })).toBe('VALIDATION');
    bad(accountUpdateSchema, { balance: 1 });
    const { institutionId: _i, ...noInstitution } = account;
    bad(accountCreateSchema, noInstitution);
    const { accountCountry: _c, ...noCountry } = account;
    bad(accountCreateSchema, noCountry);
  });

  it('account types, deposit kind, number hint and dates (A-8, A-9)', () => {
    for (const t of ['credit', 'investment', 'cash']) bad(accountCreateSchema, { ...account, accountType: t });
    bad(accountCreateSchema, { ...account, depositKind: 'savings' }); // e_money
    for (const h of ['1234', 'AB12']) ok(accountCreateSchema, { ...account, numberHint: h });
    for (const h of ['12345', 'GB33BUKB20201555555555', '12 3', 'A-1', '']) bad(accountCreateSchema, { ...account, numberHint: h });
    bad(accountCreateSchema, { ...account, openedOn: '2024-02-30' });
    bad(accountCreateSchema, { ...account, openedOn: '2024-03-02', closedOn: '2024-03-01' });
    ok(accountUpdateSchema, { accountCountry: 'LT' });
    // The institution is fixed once the account exists (a new legal entity = a new account).
    expect(bad(accountUpdateSchema, { institutionId: 'i2' })).toBe('VALIDATION');
    expect(bad(accountUpdateSchema, { name: 'Renamed', institutionId: 'i2' })).toBe('VALIDATION');
    expect(Object.keys(accountUpdateSchema.shape)).not.toContain('institutionId');
    expect(Object.keys(accountCreateSchema.shape)).toContain('institutionId');
    bad(accountUpdateSchema, { accountType: 'other', depositKind: 'current' });
  });
});

describe('cards', () => {
  it('accepts debit and prepaid, physical and virtual (C-1)', () => {
    ok(cardCreateSchema, card);
    ok(cardCreateSchema, { ...card, cardType: 'prepaid', form: 'virtual', expiresOn: '2028-07', status: 'active', notes: null });
  });

  it('refuses credit cards with CARD_TYPE_UNSUPPORTED (C-2)', () => {
    expect(bad(cardCreateSchema, { ...card, cardType: 'credit' })).toBe('CARD_TYPE_UNSUPPORTED');
    expect(bad(cardUpdateSchema, { cardType: 'credit' })).toBe('CARD_TYPE_UNSUPPORTED');
    const { cardType: _t, ...noType } = card;
    expect(bad(cardCreateSchema, noType)).toBe('VALIDATION');
  });

  it('refuses every card-number / secret field as unknown (C-3, X-4)', () => {
    for (const f of ['pan', 'cardNumber', 'number', 'bin', 'cvv', 'cvc', 'pin', 'holderName', 'force', 'allowSensitive']) {
      expect(bad(cardCreateSchema, { ...card, [f]: f === 'force' || f === 'allowSensitive' ? true : '4111111111111111' }), f).toBe('VALIDATION');
    }
  });

  it('last4 and expiry formats (C-4, C-6)', () => {
    ok(cardCreateSchema, { ...card, last4: '0042' });
    for (const l of ['42', '12345', 'abcd']) bad(cardCreateSchema, { ...card, last4: l });
    for (const e of ['2028-01', '2028-12']) ok(cardCreateSchema, { ...card, expiresOn: e });
    for (const e of ['2028-13', '07/28', '2028-00', '2028-1', '2028-7', '2028-012']) bad(cardCreateSchema, { ...card, expiresOn: e });
  });

  it('creates a stored-value account only for prepaid cards, with an explicit country (C-7)', () => {
    const sv = { name: '某预付卡余额', accountCountry: 'HK', currency: 'HKD' };
    ok(cardCreateSchema, { ...card, cardType: 'prepaid', createStoredValueAccount: sv });
    bad(cardCreateSchema, { ...card, cardType: 'debit', createStoredValueAccount: sv });
    const { accountCountry: _c, ...noCountry } = sv;
    bad(cardCreateSchema, { ...card, cardType: 'prepaid', createStoredValueAccount: noCountry });
  });
});

describe('links, channels, sources, settings', () => {
  it('link defaults belong to spending sources; ended is not settable by PATCH (L-6, L-8)', () => {
    ok(cardLinkCreateSchema, { cardId: 'c', accountId: 'a', currency: null, role: 'spending_source', isDefault: true, priority: null, startedOn: '2024-03-05', notes: null });
    ok(cardLinkCreateSchema, { cardId: 'c', accountId: 'a', isDefault: true });
    bad(cardLinkCreateSchema, { cardId: 'c', accountId: 'a', role: 'top_up_source', isDefault: true });
    bad(cardLinkCreateSchema, { cardId: 'c', accountId: 'a', role: 'other', isDefault: true });
    bad(cardLinkCreateSchema, { cardId: 'c', accountId: 'a', priority: 0 });
    bad(cardLinkCreateSchema, { cardId: 'c', accountId: 'a', currency: 'usd' });
    ok(cardLinkUpdateSchema, { status: 'suspended' });
    bad(cardLinkUpdateSchema, { status: 'ended' });
  });

  it('channel types and balance accounts (P-1, P-2)', () => {
    ok(paymentChannelCreateSchema, { name: 'PayPal', channelType: 'payment_service', providerInstitutionId: 'i', balanceAccountId: 'a', region: 'LU', notes: null });
    ok(paymentChannelCreateSchema, { name: 'Apple Pay', channelType: 'device_wallet' });
    bad(paymentChannelCreateSchema, { name: 'Wire', channelType: 'bank_transfer' });
    bad(paymentChannelCreateSchema, { name: 'Apple Pay', channelType: 'device_wallet', balanceAccountId: 'a' });
    bad(paymentChannelUpdateSchema, { channelType: 'other', balanceAccountId: 'a' });
  });

  it('a source is a card or an account, never both or neither (P-4)', () => {
    ok(channelSourceCreateSchema, { cardId: 'c', isDefault: true });
    ok(channelSourceCreateSchema, { accountId: 'a' });
    bad(channelSourceCreateSchema, { cardId: 'c', accountId: 'a' });
    bad(channelSourceCreateSchema, {});
  });

  it('home region and the spending-source query (H-2, S-13)', () => {
    ok(profileSettingsUpdateSchema, { homeRegion: 'HK' });
    for (const r of ['hk', 'CHN', '']) bad(profileSettingsUpdateSchema, { homeRegion: r });
    ok(spendingSourceQuerySchema, { currency: 'USD' });
    for (const c of ['usd', 'XAU', 'US']) bad(spendingSourceQuerySchema, { currency: c });
    bad(spendingSourceQuerySchema, {});
  });

  it('institutions: name trimmed, https website, colour', () => {
    expect(ok(institutionCreateSchema, { name: '  Wise ', country: 'GB', institutionType: 'emi', website: 'https://wise.com', color: '#9FE870' })).toMatchObject({
      name: 'Wise',
      color: '#9fe870',
    });
    ok(institutionCreateSchema, { name: 'Wise', institutionType: 'emi', country: null });
    for (const w of ['http://wise.com', 'https://', 'javascript:alert(1)', 'https://wise com']) bad(institutionCreateSchema, { name: 'Wise', institutionType: 'emi', website: w });
    bad(institutionCreateSchema, { name: '   ', institutionType: 'emi' });
    bad(institutionCreateSchema, { name: 'x'.repeat(81), institutionType: 'emi' });
    bad(institutionCreateSchema, { name: 'Wise', institutionType: 'broker' });
  });
});
