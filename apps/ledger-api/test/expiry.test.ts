// M2-B3: card expiry rules (@xui/ledger-shared expiry.ts), shared by the API filters and the web
// tags. Pure calendar-date arithmetic: the same inputs give the same answer in every time zone.
import { afterEach, describe, expect, it } from 'vitest';
import { cardExpiry, DEFAULT_EXPIRING_WITHIN_DAYS, epochDay, expiryLastDay, localDate, utcDate, type ExpiryStatus } from '@xui/ledger-shared';

const status = (expiresOn: string | null, today: string, within?: number): ExpiryStatus => cardExpiry(expiresOn, today, within).status;

describe('last valid day of an expiry month', () => {
  it('is the last calendar day of that month', () => {
    expect(expiryLastDay('2028-01')).toBe('2028-01-31');
    expect(expiryLastDay('2028-04')).toBe('2028-04-30');
    expect(expiryLastDay('2028-12')).toBe('2028-12-31');
  });

  it('handles February in leap and common years (incl. the century rules)', () => {
    expect(expiryLastDay('2028-02')).toBe('2028-02-29');
    expect(expiryLastDay('2027-02')).toBe('2027-02-28');
    expect(expiryLastDay('2100-02')).toBe('2100-02-28');
    expect(expiryLastDay('2000-02')).toBe('2000-02-29');
  });

  it('refuses malformed expiries', () => {
    for (const bad of ['2028-00', '2028-13', '2028-1', '07/28', '2028-07-01', '']) expect(expiryLastDay(bad), bad).toBeNull();
  });
});

describe('classification', () => {
  it(`uses a default threshold of ${DEFAULT_EXPIRING_WITHIN_DAYS} days`, () => {
    expect(DEFAULT_EXPIRING_WITHIN_DAYS).toBe(60);
  });

  it('this month: expiring, with the days left until the month end', () => {
    expect(cardExpiry('2026-11', '2026-11-03')).toEqual({ status: 'expiring', lastDay: '2026-11-30', daysLeft: 27 });
    expect(cardExpiry('2026-11', '2026-11-30')).toEqual({ status: 'expiring', lastDay: '2026-11-30', daysLeft: 0 });
  });

  it('next month: expiring (58 days on 2026-11-03)', () => {
    expect(cardExpiry('2026-12', '2026-11-03')).toEqual({ status: 'expiring', lastDay: '2026-12-31', daysLeft: 58 });
  });

  it('across the year end', () => {
    expect(cardExpiry('2027-01', '2026-12-15')).toEqual({ status: 'expiring', lastDay: '2027-01-31', daysLeft: 47 });
    expect(cardExpiry('2026-12', '2027-01-01')).toEqual({ status: 'expired', lastDay: '2026-12-31', daysLeft: -1 });
    expect(status('2027-03', '2026-12-15')).toBe('valid'); // 106 days
  });

  it('expired: from the first day of the following month', () => {
    expect(cardExpiry('2026-10', '2026-11-01')).toEqual({ status: 'expired', lastDay: '2026-10-31', daysLeft: -1 });
    expect(cardExpiry('2020-01', '2026-11-03').status).toBe('expired');
  });

  it('no expiry entered', () => {
    expect(cardExpiry(null, '2026-11-03')).toEqual({ status: 'none', lastDay: null, daysLeft: null });
  });

  it('leap day and the end of February', () => {
    expect(cardExpiry('2028-02', '2028-02-28')).toMatchObject({ status: 'expiring', daysLeft: 1 });
    expect(cardExpiry('2028-02', '2028-02-29')).toMatchObject({ status: 'expiring', daysLeft: 0 });
    expect(cardExpiry('2028-02', '2028-03-01')).toMatchObject({ status: 'expired', daysLeft: -1 });
    expect(cardExpiry('2027-02', '2027-02-28')).toMatchObject({ status: 'expiring', daysLeft: 0 });
    expect(cardExpiry('2027-02', '2027-03-01')).toMatchObject({ status: 'expired', daysLeft: -1 });
    // A leap day inside the count is counted.
    expect(cardExpiry('2028-03', '2028-02-01').daysLeft).toBe(59);
    expect(cardExpiry('2027-03', '2027-02-01').daysLeft).toBe(58);
  });

  it('the threshold is inclusive and adjustable', () => {
    // 2026-12-31 is exactly 60 days after 2026-11-01, 61 after 2026-10-31.
    expect(status('2026-12', '2026-11-01')).toBe('expiring');
    expect(status('2026-12', '2026-10-31')).toBe('valid');
    expect(status('2026-12', '2026-10-31', 61)).toBe('expiring');
    expect(status('2026-11', '2026-11-30', 0)).toBe('expiring');
    expect(status('2026-11', '2026-11-29', 0)).toBe('valid');
  });

  it('refuses invalid input instead of guessing', () => {
    expect(() => cardExpiry('2026-13', '2026-11-03')).toThrow(RangeError);
    expect(() => cardExpiry('2026-11', '2026-02-30')).toThrow(RangeError);
    expect(() => cardExpiry('2026-11', '2026-11-3')).toThrow(RangeError);
    expect(epochDay('2026-02-29')).toBeNull();
    expect(epochDay('2028-02-29')).not.toBeNull();
  });
});

describe('time zones', () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it('the classification of a calendar date is the same in every zone of the runtime', () => {
    const results = new Set<string>();
    for (const tz of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      process.env.TZ = tz;
      results.add(JSON.stringify([cardExpiry('2026-11', '2026-11-30'), cardExpiry('2028-02', '2028-03-01'), cardExpiry('2027-01', '2026-12-15')]));
    }
    expect(results.size).toBe(1);
  });

  it("one instant is a different calendar day in different zones — the user's own day decides", () => {
    // 2026-11-30 20:00 UTC: already December 1st in Shanghai, still November 30th in Los Angeles.
    const instant = new Date(Date.UTC(2026, 10, 30, 20, 0));
    process.env.TZ = 'Asia/Shanghai';
    const shanghai = localDate(instant);
    process.env.TZ = 'America/Los_Angeles';
    const losAngeles = localDate(instant);
    expect([shanghai, losAngeles, utcDate(instant)]).toEqual(['2026-12-01', '2026-11-30', '2026-11-30']);
    expect(status('2026-11', shanghai)).toBe('expired');
    expect(status('2026-11', losAngeles)).toBe('expiring');
    // The web app sends its local date as today=, so the API filters by the same day the tags show.
  });

  it('localDate pads years and months', () => {
    process.env.TZ = 'UTC';
    expect(localDate(new Date(Date.UTC(2027, 0, 5, 12)))).toBe('2027-01-05');
  });
});
