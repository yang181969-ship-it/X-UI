/**
 * ISO code lists used by X-UI v1. Display names come from Intl.DisplayNames in the browser, so
 * only the codes are kept here.
 *
 * Sources (checked 2026-11-02; test/ledger-shared.test.ts pins the counts):
 * - ISO 3166-1 alpha-2: the 249 officially assigned code elements as listed in "ISO 3166-1
 *   alpha-2", Wikipedia, revision reviewed 2026-10-28 (mirrors the ISO 3166 Maintenance Agency /
 *   ISO Online Browsing Platform). Newest assignments: BQ, CW, SX (2010), SS (2011).
 * - ISO 4217: SIX Group "List One: Currency, fund and precious metal codes" (the ISO 4217
 *   maintenance agency), list-one.xml with Pblshd="2026-09-17" — 178 distinct codes =
 *   CURRENCY_CODES (155) + EXCLUDED_CURRENCY_CODES (23).
 * When ISO publishes a change, update the list, the source line above and the counts in the test.
 */

/**
 * ISO 3166-1 alpha-2: all 249 officially assigned codes. User-assigned codes (XK and the like)
 * are not included.
 */
export const COUNTRY_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ',
  'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ',
  'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ',
  'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET',
  'FI', 'FJ', 'FK', 'FM', 'FO', 'FR',
  'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY',
  'HK', 'HM', 'HN', 'HR', 'HT', 'HU',
  'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT',
  'JE', 'JM', 'JO', 'JP',
  'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ',
  'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY',
  'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ',
  'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ',
  'OM',
  'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY',
  'QA',
  'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SY', 'SZ',
  'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ',
  'UA', 'UG', 'UM', 'US', 'UY', 'UZ',
  'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU',
  'WF', 'WS',
  'YE', 'YT',
  'ZA', 'ZM', 'ZW',
] as const;
export type CountryCode = (typeof COUNTRY_CODES)[number];

/**
 * ISO 4217 codes of circulating currencies. Excluded (DATA_MODEL §1): precious metals (XAU, XAG,
 * XPT, XPD), the testing and "no currency" codes (XTS, XXX), bond-market and accounting units
 * (XBA, XBB, XBC, XBD, XDR, XSU, XUA, XAD), fund codes (BOV, CHE, CHW, CLF, COU, MXV, USN, UYI,
 * UYW). Withdrawn codes (HRK, SLL, ZWL, CUC, ANG — replaced by EUR, SLE, ZWG, CUP, XCG) are no
 * longer in List One.
 */
export const CURRENCY_CODES = [
  'AED', 'AFN', 'ALL', 'AMD', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
  'BAM', 'BBD', 'BDT', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD',
  'CAD', 'CDF', 'CHF', 'CLP', 'CNY', 'COP', 'CRC', 'CUP', 'CVE', 'CZK',
  'DJF', 'DKK', 'DOP', 'DZD',
  'EGP', 'ERN', 'ETB', 'EUR',
  'FJD', 'FKP',
  'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD',
  'HKD', 'HNL', 'HTG', 'HUF',
  'IDR', 'ILS', 'INR', 'IQD', 'IRR', 'ISK',
  'JMD', 'JOD', 'JPY',
  'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT',
  'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LYD',
  'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN',
  'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD',
  'OMR',
  'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG',
  'QAR',
  'RON', 'RSD', 'RUB', 'RWF',
  'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL',
  'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS',
  'UAH', 'UGX', 'USD', 'UYU', 'UZS',
  'VED', 'VES', 'VND', 'VUV',
  'WST',
  'XAF', 'XCD', 'XCG', 'XOF', 'XPF',
  'YER',
  'ZAR', 'ZMW', 'ZWG',
] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

/** List One codes that are never accepted (tests assert none is in CURRENCY_CODES). */
export const EXCLUDED_CURRENCY_CODES = [
  'XAU', 'XAG', 'XPT', 'XPD', 'XTS', 'XXX',
  'XBA', 'XBB', 'XBC', 'XBD', 'XDR', 'XSU', 'XUA', 'XAD',
  'BOV', 'CHE', 'CHW', 'CLF', 'COU', 'MXV', 'USN', 'UYI', 'UYW',
] as const;

const COUNTRY_SET: ReadonlySet<string> = new Set(COUNTRY_CODES);
const CURRENCY_SET: ReadonlySet<string> = new Set(CURRENCY_CODES);

export const isCountryCode = (v: string): v is CountryCode => COUNTRY_SET.has(v);
export const isCurrencyCode = (v: string): v is CurrencyCode => CURRENCY_SET.has(v);
