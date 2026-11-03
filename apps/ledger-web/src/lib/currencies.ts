import { CURRENCY_CODES, type CurrencyCode } from '@xui/ledger-shared';

const cache = new Map<string, Intl.DisplayNames | null>();

function displayNames(lang: string): Intl.DisplayNames | null {
  if (!cache.has(lang)) {
    let dn: Intl.DisplayNames | null = null;
    try {
      dn = new Intl.DisplayNames([lang], { type: 'currency' });
    } catch {
      /* very old browser: show codes */
    }
    cache.set(lang, dn);
  }
  return cache.get(lang)!;
}

/** Localized name of an ISO 4217 code. */
export function currencyName(code: string, lang: string): string {
  try {
    return displayNames(lang)?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Shown first in currency pickers; the rest follow alphabetically by code. */
const COMMON: readonly CurrencyCode[] = ['USD', 'EUR', 'GBP', 'HKD', 'CNY', 'JPY', 'SGD', 'AUD', 'CAD', 'CHF', 'MOP', 'TWD'];

/** Every currency as Select options ("USD · 美元"), common ones first. */
export function currencyOptions(lang: string, exclude: readonly string[] = []): { value: CurrencyCode; label: string }[] {
  const skip = new Set(exclude);
  const rest = CURRENCY_CODES.filter((c) => !COMMON.includes(c));
  return [...COMMON, ...rest].filter((c) => !skip.has(c)).map((code) => ({ value: code, label: `${code} · ${currencyName(code, lang)}` }));
}
