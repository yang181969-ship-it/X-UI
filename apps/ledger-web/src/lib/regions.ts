import { COUNTRY_CODES, type CountryCode } from '@xui/ledger-shared';

const cache = new Map<string, Intl.DisplayNames | null>();

function displayNames(lang: string): Intl.DisplayNames | null {
  if (!cache.has(lang)) {
    let dn: Intl.DisplayNames | null = null;
    try {
      dn = new Intl.DisplayNames([lang], { type: 'region' });
    } catch {
      /* very old browser: show codes */
    }
    cache.set(lang, dn);
  }
  return cache.get(lang)!;
}

/** Localized name of an ISO 3166-1 alpha-2 code (HK, MO and TW are regions of their own). */
export function regionName(code: string, lang: string): string {
  try {
    return displayNames(lang)?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Every country / region as Select options, sorted by localized name. */
export function regionOptions(lang: string): { value: CountryCode; label: string }[] {
  const collator = new Intl.Collator(lang);
  return COUNTRY_CODES.map((code) => ({ value: code, label: `${regionName(code, lang)} (${code})` })).sort((a, b) => collator.compare(a.label, b.label));
}
