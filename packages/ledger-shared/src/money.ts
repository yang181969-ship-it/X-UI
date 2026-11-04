/**
 * Amounts of X-UI v1 transactions (DATA_MODEL §10.1, §10.12; API_SPEC §5.0.2).
 *
 * - A single amount is a positive integer in the currency's minor unit, 1 … 999 999 999 999 999.
 *   That is below 2^53, so one amount is exact as a JSON / JS number end to end; the database
 *   CHECK (typeof = 'integer' AND BETWEEN …) and the zod schemas enforce the same range.
 * - Sums can exceed 2^53 (and int64 for SUM over enough rows): they are computed in SQL as two
 *   segments, CAST(SUM(amount / 10^9) AS TEXT) and CAST(SUM(amount % 10^9) AS TEXT), merged here
 *   with BigInt and returned as decimal strings — never a JS number, TOTAL() or AVG().
 * - Text amounts ("78.30") are parsed with string and BigInt arithmetic only: no float ever
 *   touches an amount, and more decimal places than the currency has are refused, not rounded.
 */

export const AMOUNT_MIN = 1;
export const AMOUNT_MAX = 999_999_999_999_999;

/** Divisor of the segmented sums (§10.12). */
export const SUM_SEGMENT = 1_000_000_000;
/** int64 overflows once one group holds more than ~9.2 × 10^9 rows of segments; assert well below. */
export const SUM_GROUP_ROWS_MAX = 9_000_000_000;

/** A valid single amount: a safe integer in [AMOUNT_MIN, AMOUNT_MAX]. */
export function isMinorAmount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= AMOUNT_MIN && v <= AMOUNT_MAX;
}

export type AmountParseError =
  /** not plain ASCII digits with an optional "." and fraction (signs, spaces, separators, exponents, full-width digits) */
  | 'format'
  /** more decimal places than the currency has */
  | 'scale'
  /** zero */
  | 'zero'
  /** above AMOUNT_MAX */
  | 'range';
export type AmountParseResult = { ok: true; minor: number } | { ok: false; error: AmountParseError };

const AMOUNT_TEXT = /^([0-9]+)(?:\.([0-9]+))?$/;

/**
 * "78.30" with exponent 2 → 7830; "1000" with exponent 0 → 1000; "1.234" with exponent 3 → 1234.
 * Fewer decimal places than the currency has are padded ("1.5" USD → 150); more are an error
 * ("1.001" USD, "1.0" JPY). No sign, whitespace, thousands separator, exponent or non-ASCII digit.
 */
export function parseAmount(text: string, exponent: number): AmountParseResult {
  assertExponent(exponent);
  const m = AMOUNT_TEXT.exec(text);
  if (!m) return { ok: false, error: 'format' };
  const whole = m[1]!;
  const fraction = m[2] ?? '';
  if (fraction.length > exponent) return { ok: false, error: 'scale' };
  const minor = BigInt(whole + fraction.padEnd(exponent, '0'));
  if (minor === 0n) return { ok: false, error: 'zero' };
  if (minor > BigInt(AMOUNT_MAX)) return { ok: false, error: 'range' };
  return { ok: true, minor: Number(minor) };
}

/**
 * A minor-unit amount as a decimal string with exactly `exponent` decimal places: 7830 (2) →
 * "78.30", 1000 (0) → "1000". Takes a number (one amount), a bigint or a decimal string (a sum,
 * possibly above 2^53). No grouping, no currency symbol — that is the UI's job.
 */
export function formatAmount(minor: number | bigint | string, exponent: number): string {
  assertExponent(exponent);
  let digits: string;
  if (typeof minor === 'number') {
    if (!Number.isSafeInteger(minor)) throw new RangeError(`not a safe integer amount: ${minor}`);
    digits = String(minor);
  } else if (typeof minor === 'bigint') {
    digits = minor.toString();
  } else {
    if (!/^-?[0-9]+$/.test(minor)) throw new RangeError(`not a decimal integer string: ${minor}`);
    digits = BigInt(minor).toString();
  }
  const negative = digits.startsWith('-');
  if (negative) digits = digits.slice(1);
  if (exponent === 0) return (negative ? '-' : '') + digits;
  const padded = digits.padStart(exponent + 1, '0');
  return `${negative ? '-' : ''}${padded.slice(0, -exponent)}.${padded.slice(-exponent)}`;
}

/**
 * Merge the two segments of a §10.12 sum (`hi` = SUM(amount / 10^9), `lo` = SUM(amount % 10^9),
 * both CAST AS TEXT by SQL) into the exact total as a decimal string.
 */
export function mergeSegmentedSum(hi: string, lo: string): string {
  for (const part of [hi, lo]) if (!/^[0-9]+$/.test(part)) throw new RangeError(`not a non-negative decimal integer string: ${part}`);
  return (BigInt(hi) * BigInt(SUM_SEGMENT) + BigInt(lo)).toString();
}

function assertExponent(exponent: number) {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 4) throw new RangeError(`currency exponent must be 0–4: ${exponent}`);
}
