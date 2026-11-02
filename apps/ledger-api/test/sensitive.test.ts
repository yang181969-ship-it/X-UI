// @xui/ledger-shared sensitive-data scan (DATA_MODEL §6.2, TEST_PLAN X-1 – X-3).
import { detectSensitive, luhnValid, scanSensitive } from '@xui/ledger-shared';
import { describe, expect, it } from 'vitest';

describe('detectSensitive', () => {
  it('finds Luhn-valid 13–19 digit card numbers, with or without spaces / hyphens', () => {
    for (const s of [
      '4111111111111111',
      '4111 1111 1111 1111',
      '4111-1111-1111-1111',
      '4111  1111-1111 1111',
      'my card 4111 1111 1111 1111.',
      'ref 12 4111 1111 1111 1111', // a group in front does not hide it
      '378282246310005', // 15 digits (Amex test number)
      '4222222222222', // 13 digits
      '6011 0009 9013 9424', // Discover test number
      '４１１１　１１１１　１１１１　１１１１', // full-width digits and spaces (NFKC)
      'x4111111111111111y',
    ]) {
      expect.soft(detectSensitive(s), s).toBe('card_number');
    }
  });

  it('ignores numbers that fail Luhn or have the wrong length', () => {
    for (const s of [
      '4111 1111 1111 1112',
      '411111111111', // 12 digits
      '41111111111111111111111', // 23 digits in one run, no group boundary inside
      'phone 12345678',
      'branch 004, account ending 1234',
      'Opened 2024-03-05',
      '',
    ]) {
      expect.soft(detectSensitive(s), s).toBeNull();
    }
  });

  it('finds CVV / CVC / PIN / 安全码 / 密码 followed by 3–6 digits', () => {
    for (const s of ['cvv 123', 'CVC:1234', 'PIN=0000', 'pin#123456', '安全码 123', '安全码：123', '密码123456', 'cvv2: 999', 'CVV-321', 'ＰＩＮ １２３４']) {
      expect.soft(detectSensitive(s), s).toBe('secret_code');
    }
    for (const s of ['pin the card', 'spin 1234', 'pinned 1234', 'cvv 12', 'PIN 1234567', 'pincode', 'cvvs 123']) {
      expect.soft(detectSensitive(s), s).toBeNull();
    }
  });

  it('luhnValid', () => {
    expect(luhnValid('79927398713')).toBe(true);
    expect(luhnValid('79927398710')).toBe(false);
    expect(luhnValid('')).toBe(false);
  });
});

describe('scanSensitive', () => {
  it('reports the offending fields and kinds only, skipping empty values', () => {
    const hits = scanSensitive({ name: 'Bank', notes: 'card 4111111111111111', website: null, other: undefined, code: 'PIN 1234' });
    expect(hits).toEqual([
      { field: 'notes', kind: 'card_number' },
      { field: 'code', kind: 'secret_code' },
    ]);
    expect(JSON.stringify(hits)).not.toContain('4111');
  });
});
