import { currencyExponent, formatAmount, isCurrencyCode, parseAmount, type AmountParseError } from '@xui/ledger-shared';

/**
 * Display and input helpers for transaction amounts (API_SPEC §5.0.2). Amounts are minor-unit
 * integers formatted by the shared formatAmount (string / BigInt arithmetic) and grouped here as
 * text — never through a float, never summed, never converted. Each amount is shown with its own
 * currency; there is no total of any kind.
 */

/** "1234567.89" → "1,234,567.89" (grouping of the integer part only, as text). */
export function groupDigits(decimal: string): string {
  const negative = decimal.startsWith('-');
  const body = negative ? decimal.slice(1) : decimal;
  const dot = body.indexOf('.');
  const whole = dot === -1 ? body : body.slice(0, dot);
  const fraction = dot === -1 ? '' : body.slice(dot);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction}`;
}

/** A saved amount with its saved exponent: 783000, 2 → "7,830.00". */
export function formatMoney(minor: number | string | bigint, exponent: number): string {
  return groupDigits(formatAmount(minor, exponent));
}

export type AmountInputProblem = AmountParseError | 'empty' | 'currency';
export type AmountInputResult = { ok: true; minor: number } | { ok: false; error: AmountInputProblem };

/**
 * Parse what the user typed for `currency` with the shared parseAmount and the currency's ISO 4217
 * exponent. The input state is always the typed string; only surrounding whitespace is ignored.
 * Errors: empty, currency (none or unknown chosen), format, scale, zero, range.
 */
export function parseAmountInput(text: string, currency: string | null | undefined): AmountInputResult {
  const s = text.trim();
  if (s === '') return { ok: false, error: 'empty' };
  if (!currency || !isCurrencyCode(currency)) return { ok: false, error: 'currency' };
  const r = parseAmount(s, currencyExponent(currency));
  return r.ok ? { ok: true, minor: r.minor } : { ok: false, error: r.error };
}

/** A minor amount back to input text for `currency` (prefill): 7830 USD → "78.30" (no grouping). */
export function amountToInput(minor: number, currency: string): string {
  return formatAmount(minor, currencyExponent(currency));
}
