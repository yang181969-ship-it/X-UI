import { AMOUNT_MAX } from '@xui/ledger-shared';
import { describe, expect, it } from 'vitest';
import { amountToInput, formatMoney, groupDigits, parseAmountInput } from '../src/lib/money.ts';

describe('amount display', () => {
  it('groups the integer part as text', () => {
    expect(groupDigits('0.05')).toBe('0.05');
    expect(groupDigits('999')).toBe('999');
    expect(groupDigits('1000')).toBe('1,000');
    expect(groupDigits('1234567.891')).toBe('1,234,567.891');
    expect(groupDigits('-1234.50')).toBe('-1,234.50');
  });

  it('formats with the saved exponent, exactly, up to the largest amount', () => {
    expect(formatMoney(7830, 2)).toBe('78.30');
    expect(formatMoney(1500, 0)).toBe('1,500');
    expect(formatMoney(1234, 3)).toBe('1.234');
    expect(formatMoney(5, 2)).toBe('0.05');
    expect(formatMoney(AMOUNT_MAX, 2)).toBe('9,999,999,999,999.99');
    expect(formatMoney(AMOUNT_MAX, 0)).toBe('999,999,999,999,999');
    // Sums arrive as decimal strings (above 2^53): still exact.
    expect(formatMoney('123456789012345678', 2)).toBe('1,234,567,890,123,456.78');
  });
});

describe('amount input', () => {
  it('parses decimal text into minor units with the currency exponent', () => {
    expect(parseAmountInput('78.30', 'USD')).toEqual({ ok: true, minor: 7830 });
    expect(parseAmountInput('78.3', 'USD')).toEqual({ ok: true, minor: 7830 });
    expect(parseAmountInput('1500', 'JPY')).toEqual({ ok: true, minor: 1500 });
    expect(parseAmountInput('1.234', 'BHD')).toEqual({ ok: true, minor: 1234 });
    expect(parseAmountInput(' 12 ', 'HKD')).toEqual({ ok: true, minor: 1200 });
    expect(parseAmountInput('9999999999999.99', 'USD')).toEqual({ ok: true, minor: AMOUNT_MAX });
    // 0.1 + 0.2 style inputs stay exact: no float is involved.
    expect(parseAmountInput('0.30', 'USD')).toEqual({ ok: true, minor: 30 });
  });

  it('empty and currency come before parsing', () => {
    expect(parseAmountInput('', 'USD')).toEqual({ ok: false, error: 'empty' });
    expect(parseAmountInput('   ', 'USD')).toEqual({ ok: false, error: 'empty' });
    expect(parseAmountInput('10', null)).toEqual({ ok: false, error: 'currency' });
    expect(parseAmountInput('10', 'XXX')).toEqual({ ok: false, error: 'currency' });
  });

  it('format: signs, separators, exponents, spaces inside, non-ASCII digits', () => {
    for (const s of ['-1', '+1', '1,000', '1e3', '1 000', '１２', '.5', '1.', '1..2', 'abc', '0x10']) expect(parseAmountInput(s, 'USD')).toEqual({ ok: false, error: 'format' });
  });

  it('scale: more decimal places than the currency has', () => {
    expect(parseAmountInput('1.001', 'USD')).toEqual({ ok: false, error: 'scale' });
    expect(parseAmountInput('1.5', 'JPY')).toEqual({ ok: false, error: 'scale' });
    expect(parseAmountInput('1.0', 'JPY')).toEqual({ ok: false, error: 'scale' });
    expect(parseAmountInput('1.2345', 'BHD')).toEqual({ ok: false, error: 'scale' });
  });

  it('zero and range', () => {
    expect(parseAmountInput('0', 'USD')).toEqual({ ok: false, error: 'zero' });
    expect(parseAmountInput('0.00', 'USD')).toEqual({ ok: false, error: 'zero' });
    expect(parseAmountInput('10000000000000', 'USD')).toEqual({ ok: false, error: 'range' });
    expect(parseAmountInput('1000000000000000', 'JPY')).toEqual({ ok: false, error: 'range' });
  });

  it('turns a minor amount back into input text (no grouping)', () => {
    expect(amountToInput(7830, 'USD')).toBe('78.30');
    expect(amountToInput(1500, 'JPY')).toBe('1500');
    expect(amountToInput(123456, 'HKD')).toBe('1234.56');
  });
});
