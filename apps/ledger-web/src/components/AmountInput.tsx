import { Input } from 'antd';
import { useTranslation } from 'react-i18next';
import { parseAmountInput, type AmountInputProblem, type AmountInputResult } from '../lib/money.ts';

/**
 * Amount entry for one currency. The value is always the typed string (never a number, so no float
 * ever touches it); it is parsed by the shared parseAmount with the currency's ISO 4217 exponent
 * when the request is built. Not InputNumber: that parses through floats and would round.
 */
export function AmountInput({
  value,
  onChange,
  currency,
  disabled,
  id,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (text: string) => void;
  currency: string | null;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
}) {
  return (
    <Input
      id={id}
      aria-label={ariaLabel}
      className="amount-input num"
      inputMode="decimal"
      autoComplete="off"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      suffix={<span className="muted">{currency ?? ''}</span>}
      maxLength={24}
    />
  );
}

/** The translated problem of an amount text, or null when it parses. */
export function useAmountProblem() {
  const { t } = useTranslation();
  return (result: AmountInputResult): string | null => (result.ok ? null : t(`transactions.amountErrors.${result.error satisfies AmountInputProblem}`));
}

export { parseAmountInput };
