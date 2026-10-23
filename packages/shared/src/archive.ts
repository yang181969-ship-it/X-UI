import { daysInMonth, fromParts, isIsoDate, monthEnd, parts } from './date.ts';
import type { ArchiveRecordType, ArchiveStatus, DatePrecision, TransactionType, VerificationStatus } from './enums.ts';

/**
 * Dates of historical records. Each precision has exactly one stored shape:
 *   day      dateFrom = dateTo = the day
 *   month    the month's first and last day
 *   year     YYYY-01-01 … YYYY-12-31
 *   range    the two dates given (from ≤ to)
 *   unknown  both null
 * A time of day only goes with a day. Nothing here reads a clock or a time zone, and a month,
 * year or unknown date is never narrowed to a day that looks exact.
 */

/** Why a (precision, from, to) triple is not a valid stored date, or null if it is. */
export function archiveDateIssue(precision: DatePrecision, from: string | null | undefined, to: string | null | undefined): string | null {
  const f = from ?? null;
  const t = to ?? null;
  if (precision === 'unknown') return f === null && t === null ? null : 'an unknown date has no dates';
  if (f === null || t === null) return 'both dates are required';
  if (!isIsoDate(f) || !isIsoDate(t)) return 'invalid date (YYYY-MM-DD)';
  const { y, m, d } = parts(f);
  switch (precision) {
    case 'day':
      return f === t ? null : 'a day has the same start and end date';
    case 'month':
      return d === 1 && t === fromParts(y, m, daysInMonth(y, m)) ? null : 'a month runs from its first to its last day';
    case 'year':
      return f === fromParts(y, 1, 1) && t === fromParts(y, 12, 31) ? null : 'a year runs from 01-01 to 12-31';
    case 'range':
      return f <= t ? null : 'the range ends before it starts';
  }
}

/**
 * Stored dates for a period typed by the user: "YYYY-MM-DD" (day), "YYYY-MM" (month), "YYYY"
 * (year). Pure string work, so the browser's zone or today's date can't change the result.
 * Returns null for anything that isn't such a period.
 */
export function archivePeriod(precision: 'day' | 'month' | 'year', value: string): { dateFrom: string; dateTo: string } | null {
  if (precision === 'day') return isIsoDate(value) ? { dateFrom: value, dateTo: value } : null;
  if (precision === 'month') {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
    const first = `${value}-01`;
    return { dateFrom: first, dateTo: monthEnd(first) };
  }
  if (!/^\d{4}$/.test(value)) return null;
  return { dateFrom: `${value}-01-01`, dateTo: `${value}-12-31` };
}

/** The date as the user gave it: "2024-03-05", "2024-03", "2024", "2024-03-01 ~ 2024-04-15" or null (unknown). */
export function archiveDateLabel(r: { datePrecision: DatePrecision; dateFrom: string | null; dateTo: string | null }): string | null {
  if (r.datePrecision === 'unknown' || !r.dateFrom) return null;
  switch (r.datePrecision) {
    case 'day':
      return r.dateFrom;
    case 'month':
      return r.dateFrom.slice(0, 7);
    case 'year':
      return r.dateFrom.slice(0, 4);
    case 'range':
      return `${r.dateFrom} ~ ${r.dateTo}`;
  }
}

/**
 * Fields that describe the money itself. They are frozen once a record is converted: the
 * transaction made from it is the authoritative copy and is edited instead.
 */
export const ARCHIVE_FINANCIAL_KEYS = [
  'recordType',
  'datePrecision',
  'dateFrom',
  'dateTo',
  'occurredTime',
  'timeZone',
  'amount',
  'currency',
  'accountId',
  'fromAccountId',
  'toAccountId',
  'toAmount',
  'toCurrency',
  'assetCode',
  'assetQuantity',
  'feeAmount',
  'feeCurrency',
  'exchangeRate',
  'verificationStatus',
] as const;
export type ArchiveFinancialKey = (typeof ARCHIVE_FINANCIAL_KEYS)[number];

/** Record types that can become an ordinary transaction. */
export const CONVERTIBLE_RECORD_TYPES = ['expense', 'income', 'transfer'] as const satisfies readonly ArchiveRecordType[];

/**
 * Transaction types a record may be linked to. investment / crypto wait for their own modules;
 * other / unknown may match any ordinary entry. Stock-trade cash legs belong to the trades.
 */
export const ARCHIVE_LINK_TYPES: Record<ArchiveRecordType, readonly TransactionType[]> = {
  expense: ['expense'],
  income: ['income'],
  transfer: ['transfer'],
  investment: [],
  crypto: [],
  other: ['income', 'expense', 'transfer', 'adjustment'],
  unknown: ['income', 'expense', 'transfer', 'adjustment'],
};

/** Record types that may stay linked to a transaction of this type. */
export function recordTypesLinkableTo(txType: TransactionType): ArchiveRecordType[] {
  return (Object.keys(ARCHIVE_LINK_TYPES) as ArchiveRecordType[]).filter((rt) => ARCHIVE_LINK_TYPES[rt].includes(txType));
}

export type ConvertBlocker =
  | 'status'
  | 'type'
  | 'unverified'
  | 'date'
  | 'account'
  | 'amount'
  | 'currency'
  | 'fromAccount'
  | 'toAccount'
  | 'toCurrency'
  | 'toAmount'
  | 'fee';

interface ConvertCheck {
  status: ArchiveStatus;
  recordType: ArchiveRecordType;
  verificationStatus: VerificationStatus;
  datePrecision: DatePrecision;
  dateFrom: string | null;
  amount: number | null;
  currency: string | null;
  accountId: string | null;
  fromAccountId: string | null;
  toAccountId: string | null;
  toAmount: number | null;
  toCurrency: string | null;
  feeAmount: number | null;
}

/**
 * What stops a record from being converted, judged from the record alone (the API also checks
 * the accounts, their currencies and the ledger rules). Empty = it can be converted.
 * Nothing is ever filled in: a missing amount, currency or exact day has to be entered first.
 * Fees: null (unknown) and 0 (known: none) don't block. A fee above 0 is not booked by the
 * conversion, so such a record is refused rather than losing it — the principal and the fee are
 * recorded by hand and the principal is linked instead.
 */
export function archiveConvertBlockers(r: ConvertCheck): ConvertBlocker[] {
  const out: ConvertBlocker[] = [];
  if (r.status !== 'open') out.push('status');
  if (!(CONVERTIBLE_RECORD_TYPES as readonly string[]).includes(r.recordType)) return [...out, 'type'];
  if (r.verificationStatus !== 'verified') out.push('unverified');
  if (r.datePrecision !== 'day' || !r.dateFrom) out.push('date');
  if (!r.amount || r.amount <= 0) out.push('amount');
  if (!r.currency) out.push('currency');
  if (r.recordType === 'transfer') {
    if (!r.fromAccountId) out.push('fromAccount');
    if (!r.toAccountId) out.push('toAccount');
    if (!r.toCurrency) out.push('toCurrency');
    else if (r.currency && (r.toCurrency !== r.currency ? !r.toAmount : r.toAmount !== null && r.toAmount !== r.amount)) out.push('toAmount');
  } else if (!r.accountId) {
    out.push('account');
  }
  if (r.feeAmount !== null && r.feeAmount > 0) out.push('fee');
  return out;
}
