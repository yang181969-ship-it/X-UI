/**
 * Free-text sensitive-data scan (DATA_MODEL §6.2). A hit is a 400 SENSITIVE_DATA with no way to
 * skip it. The scan only reports what kind of data it found and in which field — never the
 * matched text, so a card number typed into a note is not echoed back or logged.
 *
 * - card_number: 13–19 digits, optionally separated by spaces or '-', that pass the Luhn check.
 *   Digits are grouped at the separators; every run of consecutive groups holding 13–19 digits
 *   is checked, so "ref 12 4111 1111 1111 1111" is still caught.
 * - secret_code: cvv / cvc / cvv2 / pin / 安全码 / 密码 followed by 3–6 digits ("PIN=0000").
 * The text is NFKC-normalized first, so full-width digits and letters are caught too.
 */

export type SensitiveKind = 'card_number' | 'secret_code';

export interface SensitiveHit {
  field: string;
  kind: SensitiveKind;
}

const PAN_MIN = 13;
const PAN_MAX = 19;

export function luhnValid(digits: string): boolean {
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
  return digits.length > 0 && sum % 10 === 0;
}

/** Digit runs whose groups are separated by at most two spaces / hyphens. */
const DIGIT_RUN = /\d+(?:[ -]{1,2}\d+)*/g;
const SECRET_CODE = /(?:(?<![a-z])(?:cvv2|cvv|cvc|pin)(?![a-z])|安全码|密码)\s*[:=#-]?\s*\d{3,6}(?!\d)/i;

function hasCardNumber(text: string): boolean {
  for (const m of text.matchAll(DIGIT_RUN)) {
    const groups = m[0].split(/[ -]+/);
    for (let start = 0; start < groups.length; start++) {
      let digits = '';
      for (let end = start; end < groups.length; end++) {
        digits += groups[end];
        if (digits.length > PAN_MAX) break;
        if (digits.length >= PAN_MIN && luhnValid(digits)) return true;
      }
    }
  }
  return false;
}

/** The kind of sensitive data in `text`, or null. */
export function detectSensitive(text: string): SensitiveKind | null {
  const s = text.normalize('NFKC');
  if (hasCardNumber(s)) return 'card_number';
  if (SECRET_CODE.test(s)) return 'secret_code';
  return null;
}

/** Scan the given free-text fields (null / undefined are skipped); one hit per offending field. */
export function scanSensitive(fields: Record<string, string | null | undefined>): SensitiveHit[] {
  const hits: SensitiveHit[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    const kind = detectSensitive(value);
    if (kind) hits.push({ field, kind });
  }
  return hits;
}
