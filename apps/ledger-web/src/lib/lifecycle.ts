import {
  classify,
  parseAmount,
  scanSensitive,
  settlementCorrectionSchema,
  snapshotCorrectionSchema,
  transactionVoidSchema,
  type Classification,
  type EntryDirection,
  type EntryFacts,
  type EventFacts,
  type ForeignStatus,
  type MerchantScope,
  type SettlementCorrection,
  type SnapshotCorrection,
  type TransactionEntryDto,
  type TransactionVoid,
  type TransferScope,
  type TxnType,
} from '@xui/ledger-shared';
import { formatMoney } from './money.ts';
import type { DraftIssue } from './txnDraft.ts';

/**
 * Lifecycle requests on an existing transaction (API_SPEC §5.7, §5.8; M3-B4-D): settlement,
 * snapshot correction and void, each built only through the shared schemas and parseAmount. The
 * base revision is the one the form was opened on (or that the user explicitly rebased to after a
 * REVISION_CONFLICT): it is part of the request, so a rebase is new content and gets a new key.
 * Nothing here decides a classification: the snapshot preview runs the one shared classify() and is
 * labelled as a preview; the server's saved result is what counts (CONFIRMED_DOMESTIC included).
 */

type Built<T> = { ok: true; body: T } | { ok: false; issues: DraftIssue[] };
const blankToNull = (s: string) => (s.trim() === '' ? null : s.trim());

function reasonIssues(reason: string | null, required: boolean): DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (required && reason === null) issues.push({ field: 'reason', code: 'required' });
  for (const hit of scanSensitive({ reason })) issues.push({ field: 'reason', code: 'sensitive', detail: hit.kind });
  return issues;
}

// ------------------------------------------------------------------ settlement

/** Per pending direction: settle it now (an own transfer may settle one side only) and the amount typed. */
export type SettlementDraft = Partial<Record<EntryDirection, { selected: boolean; amountText: string }>>;

/** The entries a settlement may settle: the current version's pending ones only. */
export const pendingEntries = <E extends Pick<EntryFacts, 'amountStatus'>>(entries: readonly E[]) => entries.filter((e) => e.amountStatus === 'pending');

/**
 * Settlement: only pending directions, each amount parsed with the entry's SAVED exponent (a
 * settlement copies exponents, Q-B3-3); everything else is carried by the server — including a
 * closed currency on the same account (a lawful carry-over: no acknowledgement).
 */
export function buildSettlementRequest(entries: readonly EntryFacts[], draft: SettlementDraft, ctx: { baseRevision: number; reason: string }): Built<SettlementCorrection> {
  const issues: DraftIssue[] = [];
  const out: { direction: EntryDirection; amount: number }[] = [];
  for (const e of pendingEntries(entries)) {
    const d = draft[e.direction];
    if (!d?.selected) continue;
    const text = d.amountText.trim();
    if (text === '') {
      issues.push({ field: `entry.${e.direction}.amount`, code: 'empty' });
      continue;
    }
    const r = parseAmount(text, e.currencyExponent);
    if (r.ok) out.push({ direction: e.direction, amount: r.minor });
    else issues.push({ field: `entry.${e.direction}.amount`, code: r.error });
  }
  if (out.length === 0 && issues.length === 0) issues.push({ field: 'form', code: 'noneSelected' });
  const reason = blankToNull(ctx.reason);
  issues.push(...reasonIssues(reason, false));
  if (issues.length) return { ok: false, issues };
  const parsed = settlementCorrectionSchema.safeParse({ kind: 'settlement', baseRevision: ctx.baseRevision, reason, entries: out });
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => ({ field: 'form', code: 'invalid' as const, detail: i.message })) };
  return { ok: true, body: parsed.data };
}

// ------------------------------------------------------------------ snapshot correction

/** New values (null = keep). */
export interface SnapshotDraft {
  homeRegion: string | null;
  countries: Partial<Record<EntryDirection, string | null>>;
}

/** Only values that differ from the saved snapshot are sent; each must differ (the server refuses an unchanged one). */
export function snapshotChanges(event: Pick<EventFacts, 'homeRegion'>, entries: readonly Pick<EntryFacts, 'direction' | 'fundingAccountCountry'>[], d: SnapshotDraft) {
  const homeRegion = d.homeRegion !== null && d.homeRegion !== event.homeRegion ? d.homeRegion : null;
  const countries = entries.flatMap((e) => {
    const v = d.countries[e.direction] ?? null;
    return v !== null && v !== e.fundingAccountCountry ? [{ direction: e.direction, fundingAccountCountry: v }] : [];
  });
  return { homeRegion, entries: countries };
}

export function buildSnapshotRequest(event: Pick<EventFacts, 'homeRegion'>, entries: readonly Pick<EntryFacts, 'direction' | 'fundingAccountCountry'>[], d: SnapshotDraft, ctx: { baseRevision: number; reason: string }): Built<SnapshotCorrection> {
  const changes = snapshotChanges(event, entries, d);
  const issues: DraftIssue[] = [];
  if (changes.homeRegion === null && changes.entries.length === 0) issues.push({ field: 'form', code: 'noSnapshotChange' });
  issues.push(...reasonIssues(blankToNull(ctx.reason), true));
  if (issues.length) return { ok: false, issues };
  const parsed = snapshotCorrectionSchema.safeParse({ kind: 'snapshot_correction', baseRevision: ctx.baseRevision, reason: ctx.reason.trim(), ...changes });
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => ({ field: 'form', code: 'invalid' as const, detail: i.message })) };
  return { ok: true, body: parsed.data };
}

export interface ClassificationView {
  merchantScope: MerchantScope | null;
  transferScope: TransferScope | null;
  foreignStatus: ForeignStatus;
}

/**
 * The classification the snapshot correction would give, by the ONE shared classify() over the
 * snapshots it changes (DATA_MODEL §10.8) — a preview only: the server recomputes it and refuses a
 * confirmed-domestic result (CONFIRMED_DOMESTIC), which the preview never bypasses.
 */
export function previewSnapshotClassification(txnType: TxnType, event: Pick<EventFacts, 'homeRegion' | 'merchantCountry' | 'counterparty'>, entries: readonly Pick<EntryFacts, 'direction' | 'fundingAccountCountry'>[], d: SnapshotDraft): Classification {
  const c = snapshotChanges(event, entries, d);
  return classify({
    txnType,
    homeRegion: c.homeRegion ?? event.homeRegion,
    merchantCountry: event.merchantCountry,
    counterpartyCountry: event.counterparty?.country ?? null,
    entries: entries.map((e) => ({ direction: e.direction, fundingAccountCountry: c.entries.find((x) => x.direction === e.direction)?.fundingAccountCountry ?? e.fundingAccountCountry })),
  });
}

// ------------------------------------------------------------------ void

export function buildVoidRequest(ctx: { baseRevision: number; reason: string; confirmed: boolean }): Built<TransactionVoid> {
  const issues: DraftIssue[] = [];
  if (!ctx.confirmed) issues.push({ field: 'confirm', code: 'required' });
  const reason = blankToNull(ctx.reason);
  issues.push(...reasonIssues(reason, false));
  if (issues.length) return { ok: false, issues };
  const parsed = transactionVoidSchema.safeParse({ baseRevision: ctx.baseRevision, reason });
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => ({ field: 'reason', code: 'invalid' as const, detail: i.message })) };
  return { ok: true, body: parsed.data };
}

// ------------------------------------------------------------------ what changed between two versions (REVISION_CONFLICT)

export interface VersionLike {
  revision: number;
  event: EventFacts;
  entries: readonly TransactionEntryDto[];
}

export interface FactChange {
  /** i18n key suffix under transactions.detail (or entry.<dir>). */
  field: string;
  before: string;
  after: string;
}

const show = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? '—' : v);
const money = (amount: number | null, exponent: number | null, currency: string | null) => (currency === null ? '—' : amount === null || exponent === null ? `${currency} …` : `${currency} ${formatMoney(amount, exponent)}`);
const entryText = (e: TransactionEntryDto | undefined) =>
  e ? `${e.account.name} · ${e.amountStatus === 'pending' ? `${e.currency} …` : money(e.amount, e.currencyExponent, e.currency)} · ${e.fundingAccountCountry}` : '—';

/**
 * The facts and snapshots that differ between the version a draft was based on and the current one
 * — shown when the server answers REVISION_CONFLICT, so the user sees what someone else changed
 * before choosing how to go on. Display only.
 */
export function diffVersions(base: VersionLike, current: VersionLike): FactChange[] {
  const a = base.event;
  const b = current.event;
  const changes: FactChange[] = [];
  const cmp = (field: string, x: string, y: string) => {
    if (x !== y) changes.push({ field, before: x, after: y });
  };
  cmp('recordMode', a.recordMode, b.recordMode);
  cmp('occurredOn', a.occurredOn, b.occurredOn);
  cmp('occurredTime', show(a.occurredTime), show(b.occurredTime));
  cmp('postedOn', show(a.postedOn), show(b.postedOn));
  cmp('eventAmount', money(a.eventAmount, a.eventCurrencyExponent, a.eventCurrency), money(b.eventAmount, b.eventCurrencyExponent, b.eventCurrency));
  cmp('merchant', show(a.merchantName), show(b.merchantName));
  cmp('merchantCountry', show(a.merchantCountry), show(b.merchantCountry));
  cmp('card', show(a.cardId), show(b.cardId));
  cmp('channel', show(a.paymentChannelId), show(b.paymentChannelId));
  cmp('transferMethod', show(a.transferMethod), show(b.transferMethod));
  cmp('counterpartyName', show(a.counterparty?.name), show(b.counterparty?.name));
  cmp('counterpartyCountry', show(a.counterparty?.country), show(b.counterparty?.country));
  cmp('counterpartyInstitution', show(a.counterparty?.institution), show(b.counterparty?.institution));
  cmp('counterpartyHint', show(a.counterparty?.accountHint), show(b.counterparty?.accountHint));
  cmp('homeRegion', a.homeRegion, b.homeRegion);
  cmp('foreignStatus', a.foreignStatus, b.foreignStatus);
  for (const dir of ['out', 'in'] as const) {
    cmp(`entry.${dir}`, entryText(base.entries.find((e) => e.direction === dir)), entryText(current.entries.find((e) => e.direction === dir)));
  }
  return changes;
}
