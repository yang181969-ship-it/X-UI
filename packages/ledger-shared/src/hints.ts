import type { AccountCurrencyStatus, AccountStatus, CardLinkStatus, CardStatus, ChannelStatus, EntryDirection, RecordMode } from './enums.ts';
import { epochDay, expiryLastDay } from './expiry.ts';

/**
 * Non-blocking hints for a transaction being entered (API_SPEC §5.13, B4-A Q3). Computed in the
 * browser from the current data the read APIs return (accounts, card detail with its links,
 * channel), shown before submitting, for reference only.
 *
 * A hint is never a fact and never a rule: it is not saved, not sent, not part of the request
 * hash, the classification or the statistics, and it never blocks, changes or fills a request.
 * Every constraint (entry shape, registered and closed currencies — P7 —, snapshots, the
 * classification and its checks, concurrency, idempotency) is enforced by the API and the database
 * whatever is shown here. Records in any status may be used (closed accounts, expired cards,
 * archived channels are allowed, PRODUCT_SPEC §7.6); the hints only point it out.
 */

export const TRANSACTION_HINT_CODES = [
  /**
   * A backfill whose occurrence date is before today (PRODUCT_SPEC §7.6): a backfill is the user's
   * declaration; the system verifies neither that it happened nor the state of the account,
   * currency or card at the time. Never changes the date, never blocks.
   */
  'backfill_past_date',
  /** The entry's account is frozen now. */
  'account_frozen',
  /** The entry's account is closed now. */
  'account_closed',
  /** The entry's currency is closed on its account now. */
  'currency_closed',
  /** The card is frozen now. */
  'card_frozen',
  /** The card is deactivated (closed) now. */
  'card_closed',
  /** The card's last valid day is before the occurrence date. */
  'card_expired',
  /** The card has no active link to the entry's account. */
  'card_no_active_link',
  /** The payment channel is archived now. */
  'channel_archived',
] as const;
export type TransactionHintCode = (typeof TRANSACTION_HINT_CODES)[number];

export interface TransactionHint {
  code: TransactionHintCode;
  /** The entry it is about (account, currency and link hints). */
  direction?: EntryDirection;
  /** currency_closed: the currency. */
  currency?: string;
  /** card_expired: the card's last valid day (YYYY-MM-DD). */
  lastDay?: string;
  /** backfill_past_date: the occurrence date. */
  occurredOn?: string;
}

/** The parts of an AccountDto / AccountListItem a hint reads. */
export interface HintAccount {
  id: string;
  status: AccountStatus;
  currencies: readonly { currency: string; status: AccountCurrencyStatus }[];
}

/** The parts of a CardDetail a hint reads (its links, ended ones included, as the detail lists them). */
export interface HintCard {
  id: string;
  status: CardStatus;
  expiresOn: string | null;
  links: readonly { accountId: string; status: CardLinkStatus }[];
}

/** The parts of a PaymentChannelDto a hint reads. */
export interface HintChannel {
  id: string;
  status: ChannelStatus;
}

export interface TransactionHintInput {
  /** YYYY-MM-DD, or null while not chosen (no expiry hint then). */
  occurredOn: string | null;
  /** With today: the backfill hint (omitted: no backfill hint). */
  recordMode?: RecordMode;
  /** The user's local date, YYYY-MM-DD. */
  today?: string;
  /** The entries being entered; account / currency null while not chosen. */
  entries: readonly { direction: EntryDirection; account: HintAccount | null; currency: string | null }[];
  card: HintCard | null;
  channel: HintChannel | null;
}

/** The hints for `input`, in a fixed order: the backfill date, per entry (account, currency, link), then card, then channel. */
export function transactionHints(input: TransactionHintInput): TransactionHint[] {
  const hints: TransactionHint[] = [];
  const { occurredOn, today } = input;
  if (input.recordMode === 'backfill' && occurredOn && today && epochDay(occurredOn) !== null && epochDay(today) !== null && occurredOn < today) {
    hints.push({ code: 'backfill_past_date', occurredOn });
  }
  const { card } = input;
  for (const e of input.entries) {
    const a = e.account;
    if (!a) continue;
    if (a.status === 'frozen') hints.push({ code: 'account_frozen', direction: e.direction });
    if (a.status === 'closed') hints.push({ code: 'account_closed', direction: e.direction });
    if (e.currency !== null && a.currencies.some((c) => c.currency === e.currency && c.status === 'closed')) {
      hints.push({ code: 'currency_closed', direction: e.direction, currency: e.currency });
    }
    if (card && !card.links.some((l) => l.accountId === a.id && l.status === 'active')) hints.push({ code: 'card_no_active_link', direction: e.direction });
  }
  if (card) {
    if (card.status === 'frozen') hints.push({ code: 'card_frozen' });
    if (card.status === 'closed') hints.push({ code: 'card_closed' });
    const lastDay = card.expiresOn === null ? null : expiryLastDay(card.expiresOn);
    if (lastDay !== null && input.occurredOn !== null && epochDay(input.occurredOn) !== null && input.occurredOn > lastDay) {
      hints.push({ code: 'card_expired', lastDay });
    }
  }
  if (input.channel?.status === 'archived') hints.push({ code: 'channel_archived' });
  return hints;
}
