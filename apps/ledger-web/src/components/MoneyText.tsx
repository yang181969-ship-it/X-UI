import { useTranslation } from 'react-i18next';
import { formatMoney } from '../lib/money.ts';

/**
 * One amount in its own currency, formatted with the exponent saved with it (EntryFacts
 * currencyExponent / EventFacts eventCurrencyExponent — never re-derived). A pending amount is shown
 * as pending, never estimated. There is deliberately no way to pass several amounts: nothing in the
 * UI adds amounts up or converts them.
 */
export function MoneyText({ amount, exponent, currency, className }: { amount: number | null; exponent: number | null; currency: string | null; className?: string }) {
  const { t } = useTranslation();
  if (currency === null) return <span className="muted">—</span>;
  const pending = amount === null || exponent === null;
  return (
    <span className={`money num ${pending ? 'is-pending' : ''} ${className ?? ''}`} data-currency={currency} data-amount={pending ? '' : String(amount)}>
      <span className="money-currency">{currency}</span> <span className="money-value">{pending ? t('transactions.pending') : formatMoney(amount, exponent)}</span>
    </span>
  );
}
