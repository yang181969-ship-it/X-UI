/**
 * Rows the historical_records table itself must refuse (and accept), whatever the API does.
 * Shared by the libSQL and the local D1 tests so both databases are held to the same list.
 * Each is merged over a valid "unknown date" row.
 */

export const REFUSED_ROWS: [string, Record<string, unknown>][] = [
  ['month ending on its 2nd day', { datePrecision: 'month', dateFrom: '2024-02-01', dateTo: '2024-02-02' }],
  ['month ending a day early (leap year)', { datePrecision: 'month', dateFrom: '2024-02-01', dateTo: '2024-02-28' }],
  ['month ending on a day that does not exist', { datePrecision: 'month', dateFrom: '2023-02-01', dateTo: '2023-02-29' }],
  ['month running into the next', { datePrecision: 'month', dateFrom: '2024-02-01', dateTo: '2024-03-31' }],
  ['month not starting on the 1st', { datePrecision: 'month', dateFrom: '2024-02-02', dateTo: '2024-02-29' }],
  ['day 2024-02-30', { datePrecision: 'day', dateFrom: '2024-02-30', dateTo: '2024-02-30' }],
  ['day 2023-02-29', { datePrecision: 'day', dateFrom: '2023-02-29', dateTo: '2023-02-29' }],
  ['month 13', { datePrecision: 'day', dateFrom: '2024-13-01', dateTo: '2024-13-01' }],
  ['unpadded date', { datePrecision: 'day', dateFrom: '2024-2-5', dateTo: '2024-2-5' }],
  ['day with two dates', { datePrecision: 'day', dateFrom: '2024-03-10', dateTo: '2024-03-11' }],
  ['day without dates', { datePrecision: 'day' }],
  ['year ending early', { datePrecision: 'year', dateFrom: '2024-01-01', dateTo: '2024-12-30' }],
  ['year starting late', { datePrecision: 'year', dateFrom: '2024-01-02', dateTo: '2024-12-31' }],
  ['year spanning two', { datePrecision: 'year', dateFrom: '2024-01-01', dateTo: '2025-12-31' }],
  ['range from an invalid date', { datePrecision: 'range', dateFrom: '2024-02-30', dateTo: '2024-03-05' }],
  ['range ending before it starts', { datePrecision: 'range', dateFrom: '2024-03-05', dateTo: '2024-03-04' }],
  ['range without an end', { datePrecision: 'range', dateFrom: '2024-03-05' }],
  ['unknown date with dates', { datePrecision: 'unknown', dateFrom: '2024-03-05', dateTo: '2024-03-05' }],
  ['unknown precision', { datePrecision: 'week', dateFrom: '2024-03-04', dateTo: '2024-03-10' }],
  ['time with a month', { datePrecision: 'month', dateFrom: '2024-02-01', dateTo: '2024-02-29', occurredTime: '10:00' }],
  ['time zone with a year', { datePrecision: 'year', dateFrom: '2024-01-01', dateTo: '2024-12-31', timeZone: 'Asia/Shanghai' }],
  ['time with an unknown date', { occurredTime: '10:00' }],
  ['time 24:00', { datePrecision: 'day', dateFrom: '2024-03-10', dateTo: '2024-03-10', occurredTime: '24:00' }],
  ['time 9:30', { datePrecision: 'day', dateFrom: '2024-03-10', dateTo: '2024-03-10', occurredTime: '9:30' }],
  ['time 09:60', { datePrecision: 'day', dateFrom: '2024-03-10', dateTo: '2024-03-10', occurredTime: '09:60' }],
  ['unknown status', { status: 'bogus' }],
  ['unknown record type', { recordType: 'stock' }],
  ['converted without a transaction', { status: 'converted', convertedAt: 1 }],
  ['version 0', { version: 0 }],
  ['amount 0', { amount: 0, currency: 'CNY' }],
  ['fractional amount', { amount: 1.5, currency: 'CNY' }],
  ['amount without currency', { amount: 100 }],
  ['received amount without currency', { toAmount: 100 }],
  ['fee without currency', { feeAmount: 5 }],
  ['negative fee', { feeAmount: -1, feeCurrency: 'CNY' }],
];

export const ACCEPTED_ROWS: [string, Record<string, unknown>][] = [
  ['unknown date', {}],
  ['leap day', { datePrecision: 'day', dateFrom: '2024-02-29', dateTo: '2024-02-29', occurredTime: '23:59', timeZone: 'America/New_York' }],
  ['day with only a time zone', { datePrecision: 'day', dateFrom: '2024-03-10', dateTo: '2024-03-10', timeZone: 'Asia/Shanghai' }],
  ['February of a leap year', { datePrecision: 'month', dateFrom: '2024-02-01', dateTo: '2024-02-29' }],
  ['February of a common year', { datePrecision: 'month', dateFrom: '2023-02-01', dateTo: '2023-02-28' }],
  ['December', { datePrecision: 'month', dateFrom: '2025-12-01', dateTo: '2025-12-31' }],
  ['year', { datePrecision: 'year', dateFrom: '1999-01-01', dateTo: '1999-12-31' }],
  ['one-day range', { datePrecision: 'range', dateFrom: '2024-03-05', dateTo: '2024-03-05' }],
  ['fee known to be none', { feeAmount: 0 }],
  ['amounts with currencies', { amount: 1, currency: 'CNY', toAmount: 2, toCurrency: 'HKD', feeAmount: 3, feeCurrency: 'USD' }],
];
