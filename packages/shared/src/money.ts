/**
 * Money is always stored as an integer count of the currency's minor unit
 * (cents for USD, yen for JPY, fils for KWD). Never use floats for amounts.
 */

const DECIMAL_RE = /^([+-])?(\d*)(?:\.(\d*))?$/;

/**
 * Parse a user-entered decimal ("1,234.56", "-0.5", 12.3) into minor units.
 * Extra fraction digits are rounded half away from zero.
 * Returns null when the input is not a number.
 */
export function toMinor(input: string | number, decimals: number): number | null {
  let s = typeof input === 'number' ? numberToPlainString(input) : input;
  s = s.replace(/[,\s_]/g, '');
  const m = DECIMAL_RE.exec(s);
  if (!m) return null;
  const [, sign, intPartRaw = '', fracRaw = ''] = m;
  if (intPartRaw === '' && fracRaw === '') return null;

  const intPart = intPartRaw === '' ? '0' : intPartRaw;
  const kept = fracRaw.slice(0, decimals).padEnd(decimals, '0');
  const roundUp = fracRaw.length > decimals && Number(fracRaw[decimals]) >= 5;

  let value = BigInt(intPart + kept);
  if (roundUp) value += 1n;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const n = Number(value);
  return sign === '-' && n !== 0 ? -n : n;
}

/** Minor units to a plain decimal string without grouping: 123456, 2 → "1234.56". */
export function fromMinor(minor: number, decimals: number): string {
  const neg = minor < 0;
  const digits = Math.abs(Math.trunc(minor)).toString();
  if (decimals === 0) return (neg ? '-' : '') + digits;
  const padded = digits.padStart(decimals + 1, '0');
  const head = padded.slice(0, -decimals);
  const tail = padded.slice(-decimals);
  return `${neg ? '-' : ''}${head}.${tail}`;
}

/** Minor units to a JS number in major units. Only for display/inputs, never for sums. */
export function minorToMajorNumber(minor: number, decimals: number): number {
  return Number(fromMinor(minor, decimals));
}

export interface FormatMoneyOptions {
  locale?: string;
  /** Show the currency symbol/code. Default true. */
  showCurrency?: boolean;
  /** Always prefix + for positive values (useful for transaction lists). */
  signDisplay?: 'auto' | 'always' | 'exceptZero' | 'never';
  /**
   * Explicit symbol from the config (e.g. "HK$"). Intl's narrow symbols are ambiguous
   * across locales — HKD, SGD, USD can all render as "$".
   */
  symbol?: string;
}

export function formatMoney(
  minor: number,
  currency: string,
  decimals: number,
  opts: FormatMoneyOptions = {},
): string {
  const { locale = 'zh-CN', showCurrency = true, signDisplay = 'auto', symbol } = opts;
  const major = minorToMajorNumber(minor, decimals);
  if (symbol !== undefined) {
    const body = new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(Math.abs(major));
    const plus = (signDisplay === 'always' || signDisplay === 'exceptZero') && minor > 0;
    const sign = minor < 0 && signDisplay !== 'never' ? '-' : plus ? '+' : '';
    return `${sign}${showCurrency ? symbol : ''}${body}`;
  }
  try {
    return new Intl.NumberFormat(locale, {
      style: showCurrency ? 'currency' : 'decimal',
      currency: showCurrency ? currency : undefined,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      signDisplay,
    }).format(major);
  } catch {
    // Unknown ISO code (custom currencies): fall back to "CODE 1,234.56".
    const body = new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      signDisplay,
    }).format(major);
    return showCurrency ? `${currency} ${body}` : body;
  }
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) return 'NaN';
  // Avoid exponent notation for very small/large numbers.
  return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}
