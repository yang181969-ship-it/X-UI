import { AMOUNT_STATUSES, isCurrencyCode, RECORD_MODES, TXN_TYPES, type AmountStatus, type CurrencyCode, type RecordMode, type TransactionListQuery, type TxnType } from '@xui/ledger-shared';

/**
 * The transaction list filters (API_SPEC §5.3) as URL search params, so a refresh or a shared link
 * restores them. The URL is the only source of truth; values that are not valid for the API are
 * dropped rather than sent (the API would answer 400). `cursor` is never put in the URL — paging
 * restarts from the top after a reload.
 *
 * foreignStatus offers foreign / undetermined only (B4-A Q5): confirmed-domestic versions are never
 * saved (P2), so that filter would always be empty.
 */

export const LIST_FOREIGN_STATUSES = ['foreign', 'undetermined'] as const;
export type ListForeignStatus = (typeof LIST_FOREIGN_STATUSES)[number];
export const LIST_STATUSES = ['active', 'voided', 'all'] as const;
export type ListStatus = (typeof LIST_STATUSES)[number];

export interface TxnFilters {
  from?: string;
  to?: string;
  type?: TxnType;
  foreignStatus?: ListForeignStatus;
  amountStatus?: AmountStatus;
  recordMode?: RecordMode;
  /** Absent = active (the API default). */
  status?: Exclude<ListStatus, 'active'>;
  accountId?: string;
  cardId?: string;
  channelId?: string;
  currency?: CurrencyCode;
  q?: string;
  /** Page size (1–100). Not offered in the UI; kept when a link carries it. */
  limit?: number;
}

export const FILTER_KEYS = ['from', 'to', 'type', 'foreignStatus', 'amountStatus', 'recordMode', 'status', 'accountId', 'cardId', 'channelId', 'currency', 'q', 'limit'] as const;
export const SEARCH_MAX = 80;

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ID = /^\S{1,64}$/;
const oneOf = <T extends string>(list: readonly T[], v: string | null): T | undefined => (v !== null && (list as readonly string[]).includes(v) ? (v as T) : undefined);

export function parseFilters(params: URLSearchParams): TxnFilters {
  const f: TxnFilters = {};
  for (const k of ['from', 'to'] as const) {
    const v = params.get(k);
    if (v && DATE.test(v)) f[k] = v;
  }
  if (f.from && f.to && f.from > f.to) delete f.to;
  const set = <K extends keyof TxnFilters>(k: K, v: TxnFilters[K] | undefined) => {
    if (v !== undefined) f[k] = v;
  };
  set('type', oneOf(TXN_TYPES, params.get('type')));
  set('foreignStatus', oneOf(LIST_FOREIGN_STATUSES, params.get('foreignStatus')));
  set('amountStatus', oneOf(AMOUNT_STATUSES, params.get('amountStatus')));
  set('recordMode', oneOf(RECORD_MODES, params.get('recordMode')));
  set('status', oneOf(['voided', 'all'] as const, params.get('status')));
  for (const k of ['accountId', 'cardId', 'channelId'] as const) {
    const v = params.get(k);
    if (v && ID.test(v)) f[k] = v;
  }
  const currency = params.get('currency');
  if (currency && isCurrencyCode(currency)) f.currency = currency;
  const q = params.get('q')?.trim();
  if (q) f.q = q.slice(0, SEARCH_MAX);
  const limit = params.get('limit');
  if (limit && /^[1-9]\d{0,2}$/.test(limit) && Number(limit) <= 100) f.limit = Number(limit);
  return f;
}

/** Filters → search params (only the set ones, in a fixed order). */
export function filtersToParams(f: TxnFilters): URLSearchParams {
  const p = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    const v = f[k];
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  return p;
}

/** The list request (the cursor is added per page by the query). */
export function filtersToQuery(f: TxnFilters): TransactionListQuery {
  const { limit, status, ...rest } = f;
  return { ...rest, status: status ?? 'active', ...(limit !== undefined && { limit: String(limit) }) };
}

/** The quick views above the list: all (active), pending amounts, voided. */
export const QUICK_VIEWS = ['all', 'pending', 'voided'] as const;
export type QuickView = (typeof QUICK_VIEWS)[number];

/** The quick view the filters match, or null when the status / amount filters were set by hand. */
export function quickViewOf(f: TxnFilters): QuickView | null {
  if (f.status === 'voided' && !f.amountStatus) return 'voided';
  if (!f.status && f.amountStatus === 'pending') return 'pending';
  if (!f.status && !f.amountStatus) return 'all';
  return null;
}

export function applyQuickView(f: TxnFilters, view: QuickView): TxnFilters {
  const { status: _s, amountStatus: _a, ...rest } = f;
  if (view === 'pending') return { ...rest, amountStatus: 'pending' };
  if (view === 'voided') return { ...rest, status: 'voided' };
  return rest;
}

/** How many filters besides the search text are set (the mobile filter badge). */
export function activeFilterCount(f: TxnFilters): number {
  return (['from', 'type', 'foreignStatus', 'amountStatus', 'recordMode', 'status', 'accountId', 'cardId', 'channelId', 'currency'] as const).filter((k) => f[k] !== undefined).length;
}
