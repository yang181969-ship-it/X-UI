import { CLASSIFIER_VERSION, type EntryDirection, type ForeignStatus, type MerchantScope, type TransferScope, type TxnType } from './enums.ts';

/**
 * Region classification v1 (DATA_MODEL §10.8; classifier_version = 1). The same rules are written
 * in SQL in the tx_publish_classification trigger (C6), which re-derives them from the saved
 * snapshots when a version is published; test/m3-schema.test.ts checks that the two agree on
 * every combination (REG-2).
 *
 * Inputs are snapshots only: the event's home_region, merchant_country and counterparty_country,
 * and each entry's funding_account_country. Nothing else — no receiving-account details, IBAN or
 * BIC prefix, transfer method, card issuing country, institution seat, currency, channel region or
 * IP address — may decide a side (§10.8.1).
 *
 * Unknown (null) is never equal or unequal to the home region: it is its own state, and
 * 'undetermined' is not 'domestic'.
 */

export type Side = 'domestic' | 'foreign' | 'unknown';

/** One side against the home region: null → unknown, = home → domestic, otherwise foreign. */
export function side(country: string | null, homeRegion: string): Side {
  if (country === null) return 'unknown';
  return country === homeRegion ? 'domestic' : 'foreign';
}

export interface ClassificationInput {
  txnType: TxnType;
  homeRegion: string;
  /** Spend / refund only (null: unknown merchant country). */
  merchantCountry: string | null;
  /** Transfers only: the jurisdiction of the side that has no entry (null: unknown, third party only). */
  counterpartyCountry: string | null;
  /** The version's entries (1, or 2 for an own transfer between two registered accounts). */
  entries: readonly { direction: EntryDirection; fundingAccountCountry: string }[];
}

export interface Classification {
  classifierVersion: typeof CLASSIFIER_VERSION;
  merchantScope: MerchantScope | null;
  transferScope: TransferScope | null;
  foreignStatus: ForeignStatus;
}

export function classify(input: ClassificationInput): Classification {
  const { txnType, homeRegion: h, entries } = input;
  if (entries.length === 0) throw new RangeError('a version to classify has at least one entry');
  const out = entries.find((e) => e.direction === 'out')?.fundingAccountCountry ?? null;
  const inn = entries.find((e) => e.direction === 'in')?.fundingAccountCountry ?? null;

  if (txnType === 'merchant_spend' || txnType === 'merchant_refund') {
    const a = (out ?? inn)!;
    const m = input.merchantCountry;
    const foreignStatus: ForeignStatus = a !== h || (m !== null && m !== h) ? 'foreign' : m === null ? 'undetermined' : 'domestic';
    return { classifierVersion: CLASSIFIER_VERSION, merchantScope: side(m, h), transferScope: null, foreignStatus };
  }

  // Transfers: F = sending side, T = receiving side; the side without an entry is the counterparty.
  const f = out ?? input.counterpartyCountry;
  const t = inn ?? input.counterpartyCountry;
  return { classifierVersion: CLASSIFIER_VERSION, merchantScope: null, transferScope: transferScope(f, t, h), foreignStatus: transferForeignStatus(f, t, h) };
}

function transferScope(f: string | null, t: string | null, h: string): TransferScope {
  if (f === null) return t === h ? 'unknown_to_domestic' : 'unknown_to_foreign';
  if (t === null) return f === h ? 'domestic_to_unknown' : 'foreign_to_unknown';
  if (f === h && t === h) return 'domestic_local';
  if (f === h) return 'outbound';
  if (t === h) return 'inbound';
  return t === f ? 'foreign_local' : 'foreign_cross_border';
}

function transferForeignStatus(f: string | null, t: string | null, h: string): ForeignStatus {
  if ((f !== null && f !== h) || (t !== null && t !== h)) return 'foreign';
  return f !== null && t !== null ? 'domestic' : 'undetermined';
}
