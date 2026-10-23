import { describe, expect, it } from 'vitest';
import { archiveConvertBlockers, archiveDateIssue, archiveDateLabel, archivePeriod, historicalRecordSchema } from '../src/index.ts';

describe('historical record dates', () => {
  it('builds the stored dates of a typed day, month or year from the text alone', () => {
    expect(archivePeriod('day', '2024-02-29')).toEqual({ dateFrom: '2024-02-29', dateTo: '2024-02-29' });
    expect(archivePeriod('day', '2023-02-29')).toBeNull();
    expect(archivePeriod('month', '2024-02')).toEqual({ dateFrom: '2024-02-01', dateTo: '2024-02-29' });
    expect(archivePeriod('month', '2023-02')).toEqual({ dateFrom: '2023-02-01', dateTo: '2023-02-28' });
    expect(archivePeriod('month', '2025-12')).toEqual({ dateFrom: '2025-12-01', dateTo: '2025-12-31' });
    expect(archivePeriod('month', '2025-13')).toBeNull();
    expect(archivePeriod('year', '1999')).toEqual({ dateFrom: '1999-01-01', dateTo: '1999-12-31' });
    expect(archivePeriod('year', '99')).toBeNull();
  });

  it('accepts exactly one stored shape per precision', () => {
    expect(archiveDateIssue('unknown', null, null)).toBeNull();
    expect(archiveDateIssue('unknown', '2024-01-01', null)).not.toBeNull();
    expect(archiveDateIssue('day', '2024-01-01', '2024-01-01')).toBeNull();
    expect(archiveDateIssue('day', '2024-01-01', '2024-01-02')).not.toBeNull();
    expect(archiveDateIssue('month', '2024-02-01', '2024-02-29')).toBeNull();
    expect(archiveDateIssue('month', '2024-02-01', '2024-02-28')).not.toBeNull();
    expect(archiveDateIssue('year', '2024-01-01', '2024-12-31')).toBeNull();
    expect(archiveDateIssue('year', '2024-01-01', '2025-12-31')).not.toBeNull();
    expect(archiveDateIssue('range', '2024-01-05', '2024-01-05')).toBeNull();
    expect(archiveDateIssue('range', '2024-01-05', '2024-01-04')).not.toBeNull();
    expect(archiveDateIssue('range', '2024-01-05', null)).not.toBeNull();
  });

  it('shows a date as precisely as it is known', () => {
    const label = (datePrecision: any, dateFrom: string | null, dateTo: string | null) => archiveDateLabel({ datePrecision, dateFrom, dateTo });
    expect(label('day', '2024-03-05', '2024-03-05')).toBe('2024-03-05');
    expect(label('month', '2024-03-01', '2024-03-31')).toBe('2024-03');
    expect(label('year', '2024-01-01', '2024-12-31')).toBe('2024');
    expect(label('range', '2024-03-01', '2024-04-15')).toBe('2024-03-01 ~ 2024-04-15');
    expect(label('unknown', null, null)).toBeNull();
  });

  it('validates a request without inventing anything', () => {
    expect(historicalRecordSchema.parse({ title: 'x' })).toEqual({ title: 'x', recordType: 'unknown', datePrecision: 'unknown', verificationStatus: 'pending' });
    expect(historicalRecordSchema.safeParse({ title: 'x', datePrecision: 'month', dateFrom: '2024-02-01', dateTo: '2024-02-29', occurredTime: '00:00' }).success).toBe(false);
    expect(historicalRecordSchema.safeParse({ title: 'x', amount: 100 }).success).toBe(false);
    expect(historicalRecordSchema.parse({ title: 'x', feeAmount: 0 }).feeAmount).toBe(0);
    expect(historicalRecordSchema.safeParse({ title: 'x', feeAmount: 5 }).success).toBe(false);
    expect(historicalRecordSchema.safeParse({ title: 'x', feeAmount: -1, feeCurrency: 'CNY' }).success).toBe(false);
    expect(historicalRecordSchema.parse({ title: 'x', assetQuantity: ' 0.000000000000000001 ' }).assetQuantity).toBe('0.000000000000000001');
  });

  it('lists what stands between a record and a transaction', () => {
    const base = {
      status: 'open',
      recordType: 'expense',
      verificationStatus: 'verified',
      datePrecision: 'day',
      dateFrom: '2024-01-01',
      amount: 100,
      currency: 'CNY',
      accountId: 'a',
      fromAccountId: null,
      toAccountId: null,
      toAmount: null,
      toCurrency: null,
      feeAmount: null,
    } as const;
    expect(archiveConvertBlockers(base)).toEqual([]);
    expect(archiveConvertBlockers({ ...base, recordType: 'crypto' })).toEqual(['type']);
    expect(archiveConvertBlockers({ ...base, status: 'linked', verificationStatus: 'partial' })).toEqual(['status', 'unverified']);
    expect(archiveConvertBlockers({ ...base, recordType: 'transfer', accountId: null, fromAccountId: 'a', toAccountId: 'b', toCurrency: 'CNY' })).toEqual([]);
    expect(archiveConvertBlockers({ ...base, recordType: 'transfer', accountId: null, fromAccountId: 'a', toAccountId: 'b', toCurrency: 'USD' })).toEqual(['toAmount']);
    // Fees: unknown (null) and known-none (0) don't block; a real fee does.
    expect(archiveConvertBlockers({ ...base, feeAmount: 0 })).toEqual([]);
    expect(archiveConvertBlockers({ ...base, feeAmount: 1 })).toEqual(['fee']);
  });
});
