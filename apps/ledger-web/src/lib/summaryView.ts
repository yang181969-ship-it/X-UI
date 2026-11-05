import type { EntryDirection, SummaryGroup, TransactionSummaryDto, TxnType } from '@xui/ledger-shared';

/**
 * How the overview lays out GET /transactions/summary (M3-B5-B). The server's groups are the
 * classification; this module only arranges them:
 *
 * - one card per (currency, saved exponent) of a block — never one card for two currencies or two
 *   exponents of one currency;
 * - six fixed rows per card: merchant spend, merchant refund, own transfer out, own transfer in,
 *   third-party out, third-party in — never added to each other (no net spending, refunds never
 *   offset spending, the two sides of an own transfer are never summed);
 * - a row merges the groups of that block × type × direction × currency × exponent that differ
 *   only in merchant side, transfer scope or account side, with BigInt on the exact decimal strings
 *   (never a JS number); the groups themselves stay available as the row's details.
 *
 * A row's count is the sum of its groups' counts. That is a number of transactions: one version
 * has at most one entry per direction, and each entry is in exactly one group. Counts are never
 * added across rows, directions, blocks or currencies — the transaction totals come from the
 * server (transactionCount / pendingTransactionCount).
 */

export const ACTIVITY_ROWS = [
  { key: 'spend', txnType: 'merchant_spend', direction: 'out' },
  { key: 'refund', txnType: 'merchant_refund', direction: 'in' },
  { key: 'ownOut', txnType: 'own_transfer', direction: 'out' },
  { key: 'ownIn', txnType: 'own_transfer', direction: 'in' },
  { key: 'thirdOut', txnType: 'third_party_transfer', direction: 'out' },
  { key: 'thirdIn', txnType: 'third_party_transfer', direction: 'in' },
] as const satisfies readonly { key: string; txnType: TxnType; direction: EntryDirection }[];
export type ActivityKey = (typeof ACTIVITY_ROWS)[number]['key'];

/** The row a type × direction belongs to (every valid pair has exactly one). */
export function activityKey(txnType: TxnType, direction: EntryDirection): ActivityKey | null {
  return ACTIVITY_ROWS.find((r) => r.txnType === txnType && r.direction === direction)?.key ?? null;
}

export interface ActivityRow {
  key: ActivityKey;
  txnType: TxnType;
  direction: EntryDirection;
  /** Exact minor-unit decimal string; null when nothing was recorded (shown as "—", never as 0). */
  amount: string | null;
  count: number;
  /** The server's groups behind this row (merchant side, transfer scope, account side). */
  details: SummaryGroup[];
}

export interface CurrencyCard {
  currency: string;
  exponent: number;
  rows: ActivityRow[];
}

/** Exact sum of minor-unit decimal strings (BigInt only). */
export function addAmounts(amounts: readonly string[]): string {
  let total = 0n;
  for (const a of amounts) {
    if (!/^[0-9]+$/.test(a)) throw new RangeError(`not a minor-unit decimal string: ${a}`);
    total += BigInt(a);
  }
  return total.toString();
}

const cardKey = (g: Pick<SummaryGroup, 'currency' | 'currencyExponent'>) => `${g.currency}#${g.currencyExponent}`;

/** One block's groups as currency cards, sorted by currency then exponent. */
export function currencyCards(groups: readonly SummaryGroup[]): CurrencyCard[] {
  const byCard = new Map<string, SummaryGroup[]>();
  for (const g of groups) byCard.set(cardKey(g), [...(byCard.get(cardKey(g)) ?? []), g]);
  return [...byCard.values()]
    .map((gs) => ({
      currency: gs[0]!.currency,
      exponent: gs[0]!.currencyExponent,
      rows: ACTIVITY_ROWS.map(({ key, txnType, direction }) => {
        const details = gs.filter((g) => g.txnType === txnType && g.direction === direction);
        return {
          key,
          txnType,
          direction,
          amount: details.length ? addAmounts(details.map((g) => g.amount)) : null,
          count: details.reduce((n, g) => n + g.count, 0),
          details,
        };
      }),
    }))
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : a.exponent - b.exponent));
}

/** "—" for an empty row, otherwise the count as text (the UI adds its unit). */
export const countText = (count: number) => (count === 0 ? '—' : String(count));

export type PendingRow = TransactionSummaryDto['pending'][number];

/** Pending entries (counts only — a pending amount does not exist): the server's order. */
export function pendingEntryCount(pending: readonly PendingRow[]): number {
  return pending.reduce((n, p) => n + p.count, 0);
}

/** More than one saved home region in the period: the UI says each transaction kept its own. */
export const mixedHomeRegions = (s: Pick<TransactionSummaryDto, 'homeRegions'>) => s.homeRegions.length > 1;

/** Nothing at all in the period. */
export const isEmptySummary = (s: TransactionSummaryDto) => s.transactionCount === 0;
