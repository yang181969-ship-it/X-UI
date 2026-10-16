/**
 * Share quantities and stock prices are stored as integers ×1e6 ("micros") so fractional shares
 * and sub-cent prices never touch floating point. Money stays in minor units (money.ts).
 */

const SCALE = 1_000_000n;

/** "12.5" → 12_500_000. Accepts up to 6 fraction digits (extra digits are rounded). */
export function toMicros(s: string): number {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s.trim());
  if (!m) throw new Error(`not a decimal: ${s}`);
  const frac = (m[2] ?? '').padEnd(7, '0');
  let v = BigInt(m[1]!) * SCALE + BigInt(frac.slice(0, 6));
  if (Number(frac[6]) >= 5) v += 1n;
  return Number(v);
}

/** 12_500_000 → "12.5"; 1_000_000 → "1". */
export function microsToString(micros: number): string {
  const neg = micros < 0;
  const v = BigInt(Math.abs(Math.trunc(micros)));
  const int = v / SCALE;
  const frac = (v % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

function divRound(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n % d;
  return r * 2n >= d ? q + 1n : q;
}

/** quantity × price in minor units of a currency with `decimals` digits (half-up). */
export function grossMinor(qtyMicros: number, priceMicros: number, decimals = 2): number {
  return Number(divRound(BigInt(qtyMicros) * BigInt(priceMicros), 10n ** BigInt(12 - decimals)));
}

/** Price per share (micros) from a total amount in minor units. */
export function priceFromAmount(amountMinor: number, qtyMicros: number, decimals = 2): number {
  return Number(divRound(BigInt(amountMinor) * 10n ** BigInt(12 - decimals), BigInt(qtyMicros)));
}

/**
 * A decimal string (price, average cost) rounded half-up to minor units: "333.333333" → 33333,
 * "150" → 15000. Prices are kept with 6 decimals but shown with the currency's 2.
 */
export function decimalToMinor(s: string, decimals = 2): number {
  const neg = s.trim().startsWith('-');
  const micros = BigInt(Math.abs(toMicros(neg ? s.trim().slice(1) : s)));
  const v = Number(divRound(micros, 10n ** BigInt(6 - decimals)));
  return neg ? -v : v;
}
