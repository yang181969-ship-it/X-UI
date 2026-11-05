import {
  idSchema,
  isoDateSchema,
  normalizeNameKey,
  timeSchema,
  TRANSACTION_LIST_LIMIT_DEFAULT,
  transactionListQuerySchema,
  type AccountSummary,
  type CardSummary,
  type ChannelSummary,
  type TransactionDto,
  type TransactionEntryDto,
  type TransactionListDto,
  type TransactionListItem,
  type TransactionRevisionDto,
} from '@xui/ledger-shared';
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.ts';
import { accounts, cards, paymentChannels, transactionEntries, transactionEvents, transactions } from '../db/schema.ts';
import { base64UrlToBytes, bytesToBase64Url, utf8 } from '../lib/encoding.ts';
import { fail } from '../lib/http.ts';
import { accountSummary, cardSummary, channelSummary } from '../routes/summaries.ts';
import { LedgerWriteError } from './transactionErrors.ts';
import { byDirection, entryFacts, eventFacts } from './transactionResult.ts';

/**
 * Reading transactions (API_SPEC §5.3, §5.5; DATA_MODEL §10.1): only the caller's published
 * transactions (current_revision ≥ 1), each with its CURRENT version — superseded versions only
 * appear in the detail's revision list. Event and entry fields go through the same mappers as the
 * write result (eventFacts / entryFacts); account, card and channel are current summaries, the
 * entry's fundingAccountCountry is the saved snapshot. No totals: amounts are listed per entry in
 * their own currency, never summed or converted.
 *
 * List order (a total order): occurredOn desc, occurredTime desc with nulls last, the transaction's
 * createdAt desc, id desc. Paging is keyset: the cursor is that sort key of the last item RETURNED;
 * the next page holds the rows strictly after it. A cursor only encodes a position — any
 * well-formed one is accepted, and every query is still limited to the caller's rows.
 *
 * q (Q6): merchant name, counterparty name and the header's notes, compared after
 * normalizeNameKey (NFKC, trim, collapsed whitespace, lower case) on both sides — in the server,
 * since the database has no normalized columns. Candidates are read in sort order in batches of
 * LIST_SCAN_BATCH and filtered until limit + 1 matches are found or the rows run out, so a page is
 * full unless it is the last, and nextCursor is the last returned match, never the scan position.
 * Every value reaches SQL as a bound parameter.
 */

type C = { db: DB; userId: string };
type HeaderRow = typeof transactions.$inferSelect;
type EventRow = typeof transactionEvents.$inferSelect;
type EntryRow = typeof transactionEntries.$inferSelect;
type Query = z.infer<typeof transactionListQuerySchema>;

/** Candidate rows read per scan step while filtering by q. */
export const LIST_SCAN_BATCH = 100;
/** D1 binds at most 100 parameters per statement: id lists are chunked. */
const IN_CHUNK = 90;

// ------------------------------------------------------------------ cursor

export interface ListPosition {
  occurredOn: string;
  occurredTime: string | null;
  createdAt: number;
  id: string;
}

const CURSOR_VERSION = 1;
const cursorSchema = z.tuple([z.literal(CURSOR_VERSION), isoDateSchema, timeSchema.nullable(), z.int().min(0).max(Number.MAX_SAFE_INTEGER), idSchema]);

export function encodeCursor(p: ListPosition): string {
  return bytesToBase64Url(utf8.encode(JSON.stringify([CURSOR_VERSION, p.occurredOn, p.occurredTime, p.createdAt, p.id])));
}

const badCursor = (): never => fail(400, 'invalid query', 'VALIDATION', [{ code: 'custom', path: ['cursor'], message: 'invalid cursor' }]);

/** A position, or 400 VALIDATION (never a database error) for anything that is not a well-formed cursor. */
export function decodeCursor(cursor: string): ListPosition {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) badCursor();
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToBytes(cursor)));
  } catch {
    badCursor();
  }
  const r = cursorSchema.safeParse(raw);
  if (!r.success) badCursor();
  const [, occurredOn, occurredTime, createdAt, id] = r.data!;
  return { occurredOn, occurredTime, createdAt, id };
}

const positionOf = (h: HeaderRow, ev: EventRow): ListPosition => ({ occurredOn: ev.occurredOn, occurredTime: ev.occurredTime, createdAt: h.createdAt, id: h.id });

// ------------------------------------------------------------------ list query

// Explicitly qualified names for the hand-written conditions (drizzle may render a column of the
// outer table unqualified inside sql``).
const ON = sql`"transaction_events"."occurred_on"`;
const TIME = sql`"transaction_events"."occurred_time"`;
const CREATED = sql`"transactions"."created_at"`;
const ID = sql`"transactions"."id"`;

/** Rows strictly after `p` in the list order. */
function after(p: ListPosition): SQL {
  const tail = sql`(${CREATED} < ${p.createdAt} OR (${CREATED} = ${p.createdAt} AND ${ID} < ${p.id}))`;
  // Within one date: times desc, then the rows without a time.
  const laterTime = p.occurredTime === null ? sql`0` : sql`(${TIME} IS NULL OR ${TIME} < ${p.occurredTime})`;
  const sameTime = p.occurredTime === null ? sql`${TIME} IS NULL` : sql`${TIME} = ${p.occurredTime}`;
  return sql`(${ON} < ${p.occurredOn} OR (${ON} = ${p.occurredOn} AND (${laterTime} OR (${sameTime} AND ${tail}))))`;
}

/** The current version has an entry matching `cond` (entries of the same user only). */
const hasEntry = (userId: string, cond: SQL) =>
  sql`EXISTS (SELECT 1 FROM "transaction_entries" en WHERE en."event_id" = "transaction_events"."id" AND en."user_id" = ${userId} AND ${cond})`;

function listConditions(userId: string, q: Query): SQL[] {
  const conds: SQL[] = [eq(transactions.userId, userId), gte(transactions.currentRevision, 1)];
  if (q.status !== 'all') conds.push(eq(transactions.status, q.status));
  if (q.type) conds.push(eq(transactions.txnType, q.type));
  if (q.from) conds.push(gte(transactionEvents.occurredOn, q.from));
  if (q.to) conds.push(lte(transactionEvents.occurredOn, q.to));
  if (q.cardId) conds.push(eq(transactionEvents.cardId, q.cardId));
  if (q.channelId) conds.push(eq(transactionEvents.paymentChannelId, q.channelId));
  if (q.foreignStatus !== 'all') conds.push(eq(transactionEvents.foreignStatus, q.foreignStatus));
  if (q.recordMode) conds.push(eq(transactionEvents.recordMode, q.recordMode));
  if (q.accountId) conds.push(hasEntry(userId, sql`en."funding_account_id" = ${q.accountId}`));
  if (q.currency) conds.push(hasEntry(userId, sql`en."funding_currency" = ${q.currency}`));
  if (q.amountStatus) conds.push(hasEntry(userId, sql`en."amount_status" = ${q.amountStatus}`));
  return conds;
}

/** One step of candidates in list order: the caller's published transactions with their current version. */
function candidates(c: C, conds: SQL[], position: ListPosition | null, limit: number) {
  return c.db
    .select({ header: transactions, event: transactionEvents })
    .from(transactions)
    .innerJoin(
      transactionEvents,
      and(eq(transactionEvents.transactionId, transactions.id), eq(transactionEvents.userId, transactions.userId), eq(transactionEvents.revision, transactions.currentRevision)),
    )
    .where(and(...conds, ...(position ? [after(position)] : [])))
    .orderBy(desc(transactionEvents.occurredOn), asc(sql`${TIME} IS NULL`), desc(transactionEvents.occurredTime), desc(transactions.createdAt), desc(transactions.id))
    .limit(limit);
}

const matchesText = (h: HeaderRow, ev: EventRow, needle: string) => [ev.merchantName, ev.counterpartyName, h.notes].some((v) => v !== null && normalizeNameKey(v).includes(needle));

export async function listTransactions(c: C, q: Query): Promise<TransactionListDto> {
  const limit = q.limit ?? TRANSACTION_LIST_LIMIT_DEFAULT;
  const want = limit + 1;
  const needle = q.q === undefined ? '' : normalizeNameKey(q.q);
  const conds = listConditions(c.userId, q);
  const matches: { header: HeaderRow; event: EventRow }[] = [];
  let position = q.cursor === undefined ? null : decodeCursor(q.cursor);
  const step = needle ? Math.max(want, LIST_SCAN_BATCH) : want;
  for (;;) {
    const rows = await candidates(c, conds, position, step);
    for (const row of rows) {
      if (needle && !matchesText(row.header, row.event, needle)) continue;
      matches.push(row);
      if (matches.length === want) break;
    }
    if (matches.length === want || rows.length < step) break;
    // Continue scanning after the last candidate read (the cursor returned is still the last match).
    const last = rows[rows.length - 1]!;
    position = positionOf(last.header, last.event);
  }
  const page = matches.slice(0, limit);
  const items = await assemble(c, page);
  const lastReturned = page[page.length - 1];
  return { items, nextCursor: matches.length > limit && lastReturned ? encodeCursor(positionOf(lastReturned.header, lastReturned.event)) : null };
}

// ------------------------------------------------------------------ assembling DTOs

const chunks = <T>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / IN_CHUNK) }, (_, i) => xs.slice(i * IN_CHUNK, (i + 1) * IN_CHUNK));

async function byIds<R extends { id: string }>(ids: string[], read: (chunk: string[]) => Promise<R[]>): Promise<Map<string, R>> {
  const out = new Map<string, R>();
  for (const chunk of chunks([...new Set(ids)])) for (const r of await read(chunk)) out.set(r.id, r);
  return out;
}

const missing = (what: string): never => {
  throw new LedgerWriteError(`a published transaction references a missing ${what}`);
};

/** List items for (header, current event) pairs, in the given order. Every read is limited to the caller. */
async function assemble(c: C, rows: { header: HeaderRow; event: EventRow }[]): Promise<TransactionListItem[]> {
  if (!rows.length) return [];
  const u = c.userId;
  const entriesByEvent = new Map<string, EntryRow[]>();
  for (const chunk of chunks(rows.map((r) => r.event.id))) {
    for (const en of await c.db.select().from(transactionEntries).where(and(eq(transactionEntries.userId, u), inArray(transactionEntries.eventId, chunk)))) {
      entriesByEvent.set(en.eventId, [...(entriesByEvent.get(en.eventId) ?? []), en]);
    }
  }
  const allEntries = [...entriesByEvent.values()].flat();
  const accountMap = await byIds(allEntries.map((en) => en.fundingAccountId), (ids) => c.db.select(accountSummary).from(accounts).where(and(eq(accounts.userId, u), inArray(accounts.id, ids))));
  const cardIds = rows.map((r) => r.event.cardId).filter((id): id is string => id !== null);
  const cardMap = await byIds(cardIds, (ids) => c.db.select(cardSummary).from(cards).where(and(eq(cards.userId, u), inArray(cards.id, ids))));
  const channelIds = rows.map((r) => r.event.paymentChannelId).filter((id): id is string => id !== null);
  const channelMap = await byIds(channelIds, (ids) => c.db.select(channelSummary).from(paymentChannels).where(and(eq(paymentChannels.userId, u), inArray(paymentChannels.id, ids))));
  return rows.map(({ header, event }) => {
    const entries = entriesByEvent.get(event.id);
    if (!entries?.length) missing('entry');
    return listItem(header, event, entries!, accountMap, cardMap, channelMap);
  });
}

function listItem(
  h: HeaderRow,
  ev: EventRow,
  entries: EntryRow[],
  accountMap: Map<string, AccountSummary>,
  cardMap: Map<string, CardSummary>,
  channelMap: Map<string, ChannelSummary>,
): TransactionListItem {
  const entryDtos: TransactionEntryDto[] = [...entries].sort(byDirection).map((en) => ({ ...entryFacts(en), account: accountMap.get(en.fundingAccountId) ?? missing('account') }));
  return {
    id: h.id,
    txnType: h.txnType,
    status: h.status,
    currentRevision: h.currentRevision,
    notes: h.notes,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
    voidedAt: h.voidedAt,
    voidReason: h.voidReason,
    event: eventFacts(ev),
    entries: entryDtos,
    card: ev.cardId === null ? null : (cardMap.get(ev.cardId) ?? missing('card')),
    paymentChannel: ev.paymentChannelId === null ? null : (channelMap.get(ev.paymentChannelId) ?? missing('payment channel')),
  };
}

// ------------------------------------------------------------------ detail

/** GET /transactions/:id — any status; another user's and a missing transaction are the same null (404). */
export async function getTransaction(c: C, id: string): Promise<TransactionDto | null> {
  const [header] = await c.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.userId, c.userId), gte(transactions.currentRevision, 1)));
  if (!header) return null;
  // Every published version (≤ currentRevision) of this transaction, oldest first.
  const versions = await c.db
    .select()
    .from(transactionEvents)
    .where(and(eq(transactionEvents.transactionId, header.id), eq(transactionEvents.userId, c.userId), lte(transactionEvents.revision, header.currentRevision)))
    .orderBy(asc(transactionEvents.revision));
  const current = versions.find((v) => v.revision === header.currentRevision) ?? missing('current version');
  const [item] = await assemble(c, [{ header, event: current }]);
  return {
    ...item!,
    revisions: versions.map((v) => ({ revision: v.revision, revisionKind: v.revisionKind, correctionReason: v.correctionReason, createdAt: v.createdAt })),
  };
}

// ------------------------------------------------------------------ one version

/**
 * GET /transactions/:id/revisions/:revision (API_SPEC §5.6): one PUBLISHED version (≤ currentRevision)
 * of the caller's transaction, any status (voided too) — its event and entries exactly as saved
 * (snapshots included), each entry with the CURRENT account summary beside its saved jurisdiction.
 * Another user's, a missing or unpublished transaction, and a version above currentRevision (an
 * unpublished next version included) are the same null (404).
 */
export async function getRevision(c: C, id: string, revision: number): Promise<TransactionRevisionDto | null> {
  const [header] = await c.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.userId, c.userId), gte(transactions.currentRevision, 1)));
  if (!header || revision > header.currentRevision) return null;
  const [event] = await c.db
    .select()
    .from(transactionEvents)
    .where(and(eq(transactionEvents.transactionId, header.id), eq(transactionEvents.userId, c.userId), eq(transactionEvents.revision, revision)));
  if (!event) missing('published version');
  const [item] = await assemble(c, [{ header, event: event! }]);
  return { transactionId: header.id, txnType: header.txnType, revision: event!.revision, event: item!.event, entries: item!.entries };
}
