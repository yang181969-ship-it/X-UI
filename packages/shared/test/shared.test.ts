import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  addMonths,
  appConfigSchema,
  binOf,
  checkPan,
  decimalToMinor,
  detectBrand,
  formatExpiryInput,
  formatMoney,
  grossMinor,
  microsToString,
  priceFromAmount,
  toMicros,
  formatPan,
  fromMinor,
  isIsoDate,
  luhnValid,
  mergeExtra,
  nextDayOfMonth,
  nextOccurrence,
  occurrencesBetween,
  panInputState,
  parseExpiry,
  serializeConfig,
  summarizeConfigChange,
  toMinor,
  unifiedDiff,
  type CustomField,
} from '../src/index.ts';

describe('money', () => {
  it('parses decimals into minor units without float error', () => {
    expect(toMinor('0.1', 2)).toBe(10);
    expect(toMinor('0.29', 2)).toBe(29); // 0.29 * 100 = 28.999… in floats
    expect(toMinor('1,234.56', 2)).toBe(123456);
    expect(toMinor(19.99, 2)).toBe(1999);
    expect(toMinor('-12.5', 2)).toBe(-1250);
    expect(toMinor('1000', 0)).toBe(1000); // JPY
    expect(toMinor('1.2345', 3)).toBe(1235); // KWD, half away from zero
    expect(toMinor('-0.005', 2)).toBe(-1);
    expect(toMinor('abc', 2)).toBeNull();
    expect(toMinor('', 2)).toBeNull();
  });

  it('formats minor units back', () => {
    expect(fromMinor(123456, 2)).toBe('1234.56');
    expect(fromMinor(-5, 2)).toBe('-0.05');
    expect(fromMinor(1000, 0)).toBe('1000');
    expect(fromMinor(1, 3)).toBe('0.001');
    expect(formatMoney(123456, 'USD', 2, { locale: 'en-US' })).toBe('$1,234.56');
    expect(formatMoney(5000, 'JPY', 0, { locale: 'en-US' })).toBe('¥5,000');
    // Configured symbols avoid "$" ambiguity between USD/HKD/SGD.
    expect(formatMoney(608500, 'HKD', 2, { locale: 'zh-CN', symbol: 'HK$' })).toBe('HK$6,085.00');
    expect(formatMoney(-150, 'CNY', 2, { symbol: '¥', signDisplay: 'exceptZero' })).toBe('-¥1.50');
    expect(formatMoney(150, 'CNY', 2, { symbol: '¥', signDisplay: 'exceptZero' })).toBe('+¥1.50');
    expect(formatMoney(0, 'CNY', 2, { symbol: '¥', signDisplay: 'exceptZero' })).toBe('¥0.00');
  });
});

describe('share quantities & prices', () => {
  it('keeps fractional shares exact', () => {
    expect(toMicros('12.5')).toBe(12_500_000);
    expect(toMicros('0.1234567')).toBe(123_457); // rounded to 6 decimals
    expect(microsToString(12_500_000)).toBe('12.5');
    expect(microsToString(1_000_000)).toBe('1');
    expect(grossMinor(toMicros('0.5'), toMicros('480.123456'))).toBe(24006);
    expect(grossMinor(toMicros('3'), toMicros('0.1'))).toBe(30); // no 0.30000000000000004
    expect(priceFromAmount(100000, toMicros('5'))).toBe(toMicros('200'));
  });
});

describe('cards', () => {
  it('validates Luhn and detects brands', () => {
    expect(luhnValid('4242 4242 4242 4242')).toBe(true);
    expect(luhnValid('4242424242424241')).toBe(false);
    expect(detectBrand('4242424242424242')).toBe('visa');
    expect(detectBrand('5555555555554444')).toBe('mastercard');
    expect(detectBrand('2223003122003222')).toBe('mastercard');
    expect(detectBrand('378282246310005')).toBe('amex');
    expect(detectBrand('6200000000000005')).toBe('unionpay');
    expect(detectBrand('3566002020360505')).toBe('jcb');
    expect(detectBrand('6011111111111117')).toBe('discover');
    expect(checkPan('378282246310005')).toEqual({ ok: true, brand: 'amex' });
    expect(checkPan('4242424242424').reason).toBe('luhn');
    expect(checkPan('42424242').reason).toBe('length');
  });

  it('derives BIN and groups digits', () => {
    expect(binOf('4242424242424242')).toBe('424242');
    expect(binOf('378282246310005')).toBe('378282');
    expect(formatPan('378282246310005')).toBe('3782 822463 10005');
    expect(formatPan('4242424242424242')).toBe('4242 4242 4242 4242');
  });
});

describe('card number & expiry inputs', () => {
  it('stays quiet while typing and validates once the number is complete', () => {
    expect(panInputState('4').error).toBeNull(); // first digit: no error
    expect(panInputState('424242424242').error).toBeNull(); // still typing
    expect(panInputState('4242 4242 4242 4242')).toMatchObject({ valid: true, error: null, brand: 'visa' });
    expect(panInputState('4242 4242 4242 4241').error).toBeNull(); // Visa may still grow to 19
    expect(panInputState('4242 4242 4242 4241 124').error).toBe('luhn'); // 19 = Visa max length
    expect(panInputState('4242 4242 4242 4241', true).error).toBe('luhn'); // on blur
    // Amex: 15 digits is the maximum, so a bad number errs immediately.
    expect(panInputState('3782 822463 10005')).toMatchObject({ valid: true, brand: 'amex' });
    expect(panInputState('3782 822463 10006').error).toBe('luhn');
    // UnionPay: 16 or 19 digits, Luhn optional.
    expect(panInputState('6212345678901232')).toMatchObject({ valid: true, error: null, brand: 'unionpay' });
    expect(panInputState('6212345678901234563')).toMatchObject({ valid: true, warning: 'luhn' });
    expect(panInputState('62123456789012', true).error).toBe('length');
  });

  it('formats expiry like Stripe', () => {
    const type = (keys: string[]) => keys.reduce((prev, next) => formatExpiryInput(prev, next), '');
    expect(type(['1'])).toBe('1');
    expect(type(['1', '12'])).toBe('12 / ');
    expect(type(['4'])).toBe('04 / ');
    expect(type(['1', '13'])).toBe('01 / 3');
    expect(type(['1', '12', '12 / 2', '12 / 25'])).toBe('12 / 25');
    expect(formatExpiryInput('12 / 25', '12 / 256')).toBe('12 / 25');
    expect(formatExpiryInput('12 / ', '12 /')).toBe('1'); // backspace over the slash
    expect(formatExpiryInput('', '12/2027')).toBe('12 / 27'); // paste
    expect(parseExpiry('12 / 27')).toEqual({ month: 12, year: 2027 });
    expect(parseExpiry('12 / 2')).toBeNull();
  });
});

describe('dates & recurrence', () => {
  it('validates ISO dates including month lengths', () => {
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
  });

  it('clamps month-end and returns to the anchor day', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    const rec = { freq: 'monthly' as const, interval: 1, startDate: '2026-01-31' };
    expect(occurrencesBetween(rec, '2026-01-01', '2026-05-31')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ]);
  });

  it('handles leap years, yearly, weekly and end dates', () => {
    const yearly = { freq: 'yearly' as const, interval: 1, startDate: '2028-02-29' };
    expect(occurrencesBetween(yearly, '2028-01-01', '2032-12-31')).toEqual(['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
    const weekly = { freq: 'weekly' as const, interval: 2, startDate: '2026-12-28', endDate: '2027-01-25' };
    expect(occurrencesBetween(weekly, '2026-01-01', '2027-12-31')).toEqual(['2026-12-28', '2027-01-11', '2027-01-25']);
    expect(nextOccurrence(weekly, '2027-01-26')).toBeNull();
    expect(nextOccurrence({ freq: 'monthly', interval: 3, startDate: '2026-01-15' }, '2026-02-01')).toBe('2026-04-15');
  });

  it('finds the next card due day', () => {
    expect(nextDayOfMonth('2026-10-15', 20)).toBe('2026-10-20');
    expect(nextDayOfMonth('2026-10-15', 15)).toBe('2026-10-15');
    expect(nextDayOfMonth('2026-10-15', 5)).toBe('2026-11-05');
    expect(nextDayOfMonth('2027-01-31', 31)).toBe('2027-01-31');
    expect(nextDayOfMonth('2027-02-01', 31)).toBe('2027-02-28');
  });
});

describe('config', () => {
  const raw = JSON.parse(readFileSync(new URL('../../../config/app.config.json', import.meta.url), 'utf8'));

  it('accepts the repository config and serializes it byte-identically', () => {
    const cfg = appConfigSchema.parse(raw);
    expect(serializeConfig(cfg)).toBe(readFileSync(new URL('../../../config/app.config.json', import.meta.url), 'utf8'));
  });

  it('rejects duplicate keys, missing options and unknown default currency', () => {
    const bad = structuredClone(raw);
    bad.customFields.account = [
      { key: 'status', label: '状态', type: 'select' },
      { key: 'status', label: '状态2', type: 'text' },
    ];
    bad.app.defaultCurrency = 'XXX';
    const r = appConfigSchema.safeParse(bad);
    expect(r.success).toBe(false);
    const paths = r.error!.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('customFields.account.0.options');
    expect(paths).toContain('customFields.account.1.key');
    expect(paths).toContain('app.defaultCurrency');
  });

  it('summarizes custom field changes for commit messages', () => {
    const a = appConfigSchema.parse(raw);
    const b = structuredClone(a);
    b.customFields.account.push({ key: 'status', label: '账户状态', type: 'text', showInTable: true, required: false, order: 0 });
    expect(summarizeConfigChange(a, b)).toBe('add account field 账户状态');
    expect(unifiedDiff(serializeConfig(a), serializeConfig(b))).toContain('+        "label": "账户状态",');
  });
});

describe('custom field values', () => {
  const fields: CustomField[] = [
    { key: 'status', label: '账户状态', type: 'select', options: [{ value: 'active', label: '正常' }, { value: 'frozen', label: '冻结' }], showInTable: true, required: true, order: 0 },
    { key: 'opened', label: '开户日', type: 'date', showInTable: false, required: false, order: 1 },
  ];

  it('validates and merges, keeping values of removed fields', () => {
    expect(mergeExtra(fields, {}, { status: 'active', opened: '2020-01-02' })).toEqual({ ok: true, value: { status: 'active', opened: '2020-01-02' } });
    expect(mergeExtra(fields, {}, { status: 'nope' }).ok).toBe(false);
    expect(mergeExtra(fields, {}, {}).ok).toBe(false); // required
    expect(mergeExtra(fields, { status: 'active', legacy: 'x' }, { opened: null })).toEqual({ ok: true, value: { status: 'active', legacy: 'x' } });
  });
});

describe('decimalToMinor', () => {
  it('rounds prices half-up to cents for display', () => {
    expect(decimalToMinor('150')).toBe(15000);
    expect(decimalToMinor('333.333333')).toBe(33333);
    expect(decimalToMinor('0.125')).toBe(13);
    expect(decimalToMinor('2.005')).toBe(201);
    expect(decimalToMinor('480.123456')).toBe(48012);
  });
});
