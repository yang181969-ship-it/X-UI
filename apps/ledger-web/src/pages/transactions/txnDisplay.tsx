import type { EntryDirection, EventFacts, TransactionEntryDto, TxnType } from '@xui/ledger-shared';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { MoneyText } from '../../components/MoneyText.tsx';

/** Shared bits of the transaction list, detail and revision views. Display only. */

type Facts = { txnType: TxnType; event: EventFacts; entries: Pick<TransactionEntryDto, 'direction'>[] };

const directionKey = (type: TxnType) => (type === 'merchant_spend' || type === 'merchant_refund' ? 'merchant' : type);

/** "第三方汇款 · 汇出" for single-entry transfers; the type alone otherwise. */
export function typeLabel({ txnType, entries }: Facts, t: TFunction): string {
  const type = t(`transactions.types.${txnType}`);
  const single = entries.length === 1 && (txnType === 'third_party_transfer' || txnType === 'own_transfer');
  return single ? `${type} · ${t(`transactions.directions.${directionKey(txnType)}.${entries[0]!.direction}`)}` : type;
}

/** The merchant, or the counterparty of a transfer (null when the record names neither). */
export function subjectOf({ txnType, event, entries }: Facts, t: TFunction): string | null {
  if (txnType === 'merchant_spend' || txnType === 'merchant_refund') return event.merchantName;
  const cp = event.counterparty;
  if (cp?.name) return cp.name;
  if (txnType === 'own_transfer' && entries.length === 1) return t('transactions.counterpartySelf');
  return null;
}

/** One entry: direction, the account's current name, and its amount in its own currency. */
export function EntryLine({ entry, link = false }: { entry: TransactionEntryDto; link?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="txn-entry" data-direction={entry.direction} data-currency={entry.currency} data-amount-status={entry.amountStatus}>
      <DirectionMark direction={entry.direction} />
      <span className="txn-entry-account">{link ? <Link to={`/accounts/${encodeURIComponent(entry.account.id)}`}>{entry.account.name}</Link> : entry.account.name}</span>
      <MoneyText amount={entry.amount} exponent={entry.currencyExponent} currency={entry.currency} />
      <span className="sr-only">{t(`transactions.amountStatus.${entry.amountStatus}`)}</span>
    </div>
  );
}

export function DirectionMark({ direction }: { direction: EntryDirection }) {
  const { t } = useTranslation();
  return (
    <span className={`txn-direction is-${direction}`} title={t(`transactions.entryDirection.${direction}`)}>
      {direction === 'out' ? '↑' : '↓'} {t(`transactions.entryDirection.${direction}`)}
    </span>
  );
}

/** The event (record) amount: what the receipt or transfer slip says, in its own currency. */
export function EventAmount({ event }: { event: EventFacts }) {
  const { t } = useTranslation();
  if (event.eventAmount === null) return <span className="muted">{event.eventCurrency ? `${event.eventCurrency} · ` : ''}{t('transactions.eventAmountUnknown')}</span>;
  return <MoneyText amount={event.eventAmount} exponent={event.eventCurrencyExponent} currency={event.eventCurrency} />;
}

export const dateOf = (event: EventFacts) => (event.occurredTime ? `${event.occurredOn} ${event.occurredTime}` : event.occurredOn);
