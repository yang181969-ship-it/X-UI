export const CARD_BRANDS = [
  'visa',
  'mastercard',
  'amex',
  'unionpay',
  'jcb',
  'discover',
  'diners',
  'maestro',
  'other',
] as const;
export type CardBrand = (typeof CARD_BRANDS)[number];

export const CARD_FUNDING = ['credit', 'debit', 'prepaid'] as const;
export type CardFunding = (typeof CARD_FUNDING)[number];

/** Physical plastic vs. virtual card (online-only number, often issued under a physical card). */
export const CARD_FORMS = ['physical', 'virtual'] as const;
export type CardForm = (typeof CARD_FORMS)[number];

export const CARD_STATUSES = ['active', 'frozen', 'closed'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

/** Spending limit scope for (mostly virtual) cards. */
export const LIMIT_PERIODS = ['transaction', 'month', 'total'] as const;
export type LimitPeriod = (typeof LIMIT_PERIODS)[number];

export interface BrandMeta {
  label: string;
  /** Valid PAN lengths. */
  lengths: number[];
  /** Digit grouping used when displaying the number. */
  groups: number[];
}

export const BRAND_META: Record<CardBrand, BrandMeta> = {
  visa: { label: 'Visa', lengths: [13, 16, 19], groups: [4, 4, 4, 4, 3] },
  mastercard: { label: 'Mastercard', lengths: [16], groups: [4, 4, 4, 4] },
  amex: { label: 'American Express', lengths: [15], groups: [4, 6, 5] },
  unionpay: { label: 'UnionPay', lengths: [16, 17, 18, 19], groups: [4, 4, 4, 4, 3] },
  jcb: { label: 'JCB', lengths: [16, 17, 18, 19], groups: [4, 4, 4, 4, 3] },
  discover: { label: 'Discover', lengths: [16, 17, 18, 19], groups: [4, 4, 4, 4, 3] },
  diners: { label: 'Diners Club', lengths: [14, 16, 19], groups: [4, 6, 4] },
  maestro: { label: 'Maestro', lengths: [12, 13, 14, 15, 16, 17, 18, 19], groups: [4, 4, 4, 4, 3] },
  other: { label: 'Card', lengths: [12, 13, 14, 15, 16, 17, 18, 19], groups: [4, 4, 4, 4, 3] },
};

export function normalizePan(input: string): string {
  return input.replace(/[\s-]/g, '');
}

export function luhnValid(pan: string): boolean {
  const digits = normalizePan(pan);
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function inRange(prefix: string, len: number, lo: number, hi: number): boolean {
  if (prefix.length < len) return false;
  const n = Number(prefix.slice(0, len));
  return n >= lo && n <= hi;
}

/** Detect the card network from the first digits (works with a full PAN or a BIN). */
export function detectBrand(panOrBin: string): CardBrand {
  const p = normalizePan(panOrBin);
  if (!/^\d+$/.test(p)) return 'other';
  if (p.startsWith('34') || p.startsWith('37')) return 'amex';
  if (inRange(p, 4, 3528, 3589)) return 'jcb';
  if (inRange(p, 3, 300, 305) || p.startsWith('36') || p.startsWith('38') || p.startsWith('39')) {
    return 'diners';
  }
  if (p.startsWith('4')) return 'visa';
  if (inRange(p, 2, 51, 55) || inRange(p, 4, 2221, 2720)) return 'mastercard';
  // UnionPay owns 62; checked before Discover's co-branded 622126–622925 range.
  if (p.startsWith('62') || p.startsWith('81')) return 'unionpay';
  if (p.startsWith('6011') || inRange(p, 3, 644, 649) || p.startsWith('65')) return 'discover';
  if (p.startsWith('50') || inRange(p, 2, 56, 69)) return 'maestro';
  return 'other';
}

/** BIN/IIN to store: always the first 6 digits. */
export function binOf(pan: string): string {
  return normalizePan(pan).slice(0, 6);
}

/** Public BIN record (from the open BIN list), stored with a card and shown in BIN lookup. */
export interface BinInfo {
  bin: string;
  scheme?: string;
  type?: string;
  level?: string;
  issuer?: string;
  country?: string;
  countryName?: string;
  phone?: string;
  url?: string;
  /** Date the public record was last confirmed by its source (YYYY-MM-DD). */
  seen?: string;
  /** library = from the public BIN list; manual = corrected by hand (wins over the list). */
  source?: 'library' | 'manual';
}

export function last4Of(pan: string): string {
  return normalizePan(pan).slice(-4);
}

/** Group digits for display: "4242424242424242" → "4242 4242 4242 4242". */
export function formatPan(pan: string, brand: CardBrand = detectBrand(pan)): string {
  const digits = normalizePan(pan);
  const out: string[] = [];
  let i = 0;
  for (const g of BRAND_META[brand].groups) {
    if (i >= digits.length) break;
    out.push(digits.slice(i, i + g));
    i += g;
  }
  if (i < digits.length) out.push(digits.slice(i));
  return out.join(' ');
}

/** Masked display like Stripe: "•••• 4242". */
export function maskPan(last4: string): string {
  return `•••• ${last4}`;
}

export interface PanCheck {
  ok: boolean;
  brand: CardBrand;
  reason?: 'format' | 'length' | 'luhn';
  /** Accepted, but worth a hint (UnionPay numbers that fail Luhn). */
  warning?: 'luhn';
}

/**
 * Many UnionPay debit cards (62…) are issued without a Luhn check digit, so for UnionPay a
 * failed checksum is only a warning.
 */
export function checkPan(pan: string): PanCheck {
  const digits = normalizePan(pan);
  const brand = detectBrand(digits);
  if (!/^\d+$/.test(digits)) return { ok: false, brand, reason: 'format' };
  if (!BRAND_META[brand].lengths.includes(digits.length)) return { ok: false, brand, reason: 'length' };
  if (!luhnValid(digits)) return brand === 'unionpay' ? { ok: true, brand, warning: 'luhn' } : { ok: false, brand, reason: 'luhn' };
  return { ok: true, brand };
}

export function maxPanLength(brand: CardBrand): number {
  return Math.max(...BRAND_META[brand].lengths);
}

export interface PanInputState {
  digits: string;
  brand: CardBrand;
  /** Length is a valid length for the brand and the number checks out. */
  valid: boolean;
  /** Show an error now. While typing this only happens once the brand's maximum length is
   *  reached (a 16-digit UnionPay may still become 19); on blur any incomplete number errs. */
  error: 'length' | 'luhn' | null;
  warning: 'luhn' | null;
}

/** Live validation for the card-number field: quiet until the number is complete. */
export function panInputState(raw: string, blurred = false): PanInputState {
  const digits = normalizePan(raw).replace(/\D/g, '');
  const brand = detectBrand(digits);
  const check = checkPan(digits);
  const atMax = digits.length >= maxPanLength(brand);
  let error: PanInputState['error'] = null;
  if (digits.length > 0 && !check.ok && (atMax || blurred)) error = check.reason === 'luhn' ? 'luhn' : 'length';
  return { digits, brand, valid: check.ok, error, warning: check.warning ?? null };
}

/**
 * Stripe-style expiry typing: "1" → "1", "12" → "12 / ", "4" → "04 / ", "1225" → "12 / 25".
 * Deleting the slash also deletes the month's last digit.
 */
export function formatExpiryInput(prev: string, next: string): string {
  // Pasted "12/2025" or "1/25".
  const pasted = /^\s*(\d{1,2})\s*\/\s*(\d{2}|\d{4})\s*$/.exec(next);
  let digits = pasted ? pasted[1]!.padStart(2, '0') + pasted[2]!.slice(-2) : next.replace(/\D/g, '');
  const deletingSlash = next.length < prev.length && prev.endsWith(' / ') && !next.endsWith(' / ');
  if (deletingSlash && digits.length === 2) digits = digits.slice(0, 1);
  if (digits.length === 1 && Number(digits) > 1) digits = `0${digits}`;
  if (digits.length >= 2 && Number(digits.slice(0, 2)) > 12) digits = `0${digits}`;
  if (digits.startsWith('00')) digits = '0';
  digits = digits.slice(0, 4);
  if (digits.length < 2) return digits;
  if (digits.length === 2 && deletingSlash) return digits;
  return `${digits.slice(0, 2)} / ${digits.slice(2)}`;
}

/** "MM / YY" → { month, year } or null while incomplete/invalid. */
export function parseExpiry(text: string): { month: number; year: number } | null {
  const m = /^(\d{2}) \/ (\d{2})$/.exec(text.trim());
  if (!m) return null;
  const month = Number(m[1]);
  if (month < 1 || month > 12) return null;
  return { month, year: 2000 + Number(m[2]) };
}

export function isExpired(expMonth: number, expYear: number, today = new Date()): boolean {
  const y = today.getFullYear();
  const m = today.getMonth() + 1;
  return expYear < y || (expYear === y && expMonth < m);
}
