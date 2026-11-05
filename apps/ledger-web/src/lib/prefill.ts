import type { SpendingSourceResult } from '@xui/ledger-shared';
import { amountToInput } from './money.ts';

/**
 * Pre-filling a draft from derived data (the spending-source recommendation, API_SPEC §5.13)
 * without ever overwriting what the user has typed or chosen. A recommendation refetches
 * (staleTime 0) and changes with the card and the event currency; each new result may fill only
 * the fields the user has not touched.
 */

/** `current` with `patch` applied to the fields the user has not touched (the same object when nothing changes). */
export function mergeUntouched<T extends object>(current: T, touched: ReadonlySet<keyof T>, patch: Partial<T>): T {
  let next = current;
  for (const k of Object.keys(patch) as (keyof T)[]) {
    if (touched.has(k) || Object.is(current[k], patch[k])) continue;
    if (next === current) next = { ...current };
    next[k] = patch[k] as T[keyof T];
  }
  return next;
}

/**
 * A recommendation applied to one entry: mergeUntouched, except that the event amount only stands
 * in for the funding amount in the recommended currency — when the user chose another currency,
 * an untouched amount is cleared instead of showing a figure in the wrong currency.
 */
export function applyEntryPrefill(cur: EntryPrefill, touched: ReadonlySet<keyof EntryPrefill>, patch: Partial<EntryPrefill>): EntryPrefill {
  const p = { ...patch };
  const currency = touched.has('currency') || !('currency' in p) ? cur.currency : p.currency;
  if (p.amountText && p.currency !== undefined && currency !== p.currency) p.amountText = '';
  return mergeUntouched(cur, touched, p);
}

/** The funding entry fields a recommendation can fill. */
export interface EntryPrefill {
  accountId: string | null;
  currency: string | null;
  amountText: string;
}

/**
 * What a spending-source result fills (API_SPEC §5.13), applied to UNTOUCHED fields only — so the
 * untouched fields always follow the latest recommendation and never keep a stale one:
 * exact_currency → the account, the currency and the event amount as the funding amount (editable;
 * the two are saved separately); conversion_required → the account only: the funding currency and
 * amount are cleared so the user chooses them from the real record; no_match → the untouched fields
 * are cleared for the user to choose. In backfill mode the recommendation is a reference only and
 * fills nothing (PRODUCT_SPEC §7.6); the user may apply it explicitly (recordMode 'current' here).
 */
export function spendingSourcePrefill(result: SpendingSourceResult, opts: { recordMode: 'current' | 'backfill'; eventAmount: number | null }): Partial<EntryPrefill> {
  if (opts.recordMode === 'backfill') return {};
  if (result.match === 'exact_currency') {
    return { accountId: result.accountId, currency: result.fundingCurrency, ...(opts.eventAmount !== null && { amountText: amountToInput(opts.eventAmount, result.fundingCurrency) }) };
  }
  if (result.match === 'conversion_required') return { accountId: result.accountId, currency: null, amountText: '' };
  return { accountId: null, currency: null, amountText: '' };
}
