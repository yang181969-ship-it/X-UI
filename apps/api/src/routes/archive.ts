import { and, count, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import {
  ARCHIVE_FINANCIAL_KEYS,
  ARCHIVE_LINK_TYPES,
  ARCHIVE_STATUSES,
  archiveConvertBlockers,
  historicalActionSchema,
  historicalLinkSchema,
  historicalQuerySchema,
  historicalRecordSchema,
  historicalRecordUpdateSchema,
  historicalVerificationSchema,
  transactionSchema,
  type ArchiveStatus,
  type HistoricalRecordDetailDto,
  type HistoricalRecordDto,
  type HistoricalRecordInput,
} from '@z-ui/shared';
import type { DB } from '../db/client.ts';
import { historicalRecords, transactions } from '../db/schema.ts';
import type { AppBindings } from '../env.ts';
import { anchorLeg, fittingAnchor } from '../lib/archive.ts';
import { body, errorChain, fail, notFound, query } from '../lib/http.ts';
import { newId } from '../lib/id.ts';
import { assertCurrency, ownAccount, runBatch } from '../lib/ledger.ts';
import { insertLegOpsWhen, planLegs, toDtos } from './transactions.ts';

/**
 * Historical records (the archive). Nothing here changes balances: a record reaches the ledger
 * only by being converted, which books it through the transactions logic (planLegs, balance
 * recalculation included) in the same batch that marks it converted.
 *
 * Concurrency: every write is a compare-and-swap on the record's version (incremented by each
 * write, including the ledger's releases in lib/archive.ts). A request acting on an older read —
 * or on an older version the client sent — changes nothing and gets 409 ARCHIVE_CHANGED.
 */

type Row = typeof historicalRecords.$inferSelect;
type C = Context<AppBindings>;
/** Every stored field of a record that a request sets (full replace). */
type Fields = { [K in keyof HistoricalRecordInput]-?: undefined extends HistoricalRecordInput[K] ? Exclude<HistoricalRecordInput[K], undefined> | null : HistoricalRecordInput[K] };

const FIELD_KEYS = Object.keys(historicalRecordSchema.shape) as (keyof Fields)[];

const changed = (): never => fail(409, 'the record was changed meanwhile — reload it and try again', 'ARCHIVE_CHANGED');

export function toRecordDto(r: Row): HistoricalRecordDto {
  const { userId: _u, ...rest } = r;
  return { ...rest, convertBlockers: archiveConvertBlockers(r) };
}

async function ownRecord(db: DB, userId: string, id: string): Promise<Row> {
  const [r] = await db
    .select()
    .from(historicalRecords)
    .where(and(eq(historicalRecords.id, id), eq(historicalRecords.userId, userId)));
  return r ?? notFound('historical record');
}

/** The record as read, refused at once if the client saw another version of it. */
async function recordAt(db: DB, userId: string, id: string, version: number | undefined): Promise<Row> {
  const r = await ownRecord(db, userId, id);
  if (version !== undefined && version !== r.version) changed();
  return r;
}

/** Full replace: anything left out of the request is stored as null. */
function fieldsOf(input: HistoricalRecordInput): Fields {
  return Object.fromEntries(FIELD_KEYS.map((k) => [k, input[k] ?? null])) as Fields;
}

/** Accounts must be the user's own and currencies enabled (their decimals give the minor units). */
async function checkRefs(c: C, f: Fields) {
  const { db } = c.var.deps;
  for (const id of new Set([f.accountId, f.fromAccountId, f.toAccountId])) if (id) await ownAccount(db, c.var.user.id, id);
  for (const cur of new Set([f.currency, f.toCurrency, f.feeCurrency])) if (cur) assertCurrency(c.var.deps, cur);
}

/** The record still at the version this request read (an SQL condition). */
const atVersion = (read: Row) => and(eq(historicalRecords.id, read.id), eq(historicalRecords.userId, read.userId), eq(historicalRecords.version, read.version))!;

/**
 * A condition a write needs besides the record's version — checked by the same statement that
 * writes, so nothing can change between the check and the write — and the error when only it fails.
 */
interface WriteCondition {
  holds: SQL;
  otherwise: () => never;
}

/**
 * One-statement compare-and-swap: writes `values` (and the next version) only if the record is
 * still at the version read and `condition` holds; otherwise nothing is written and the request
 * gets 409 (ARCHIVE_CHANGED, or the condition's own error when the record itself is unchanged).
 */
async function writeAsRead(db: DB, read: Row, values: Partial<Row>, now: number, condition?: WriteCondition) {
  let rows: { id: string }[];
  try {
    rows = await db
      .update(historicalRecords)
      .set({ ...values, version: read.version + 1, updatedAt: now })
      .where(condition ? and(atVersion(read), condition.holds) : atVersion(read))
      .returning({ id: historicalRecords.id });
  } catch (err) {
    const text = errorChain(err);
    if (text.includes('historical_records.linked_transaction_id')) fail(409, 'that transaction is already linked to another record', 'ARCHIVE_TX_TAKEN');
    // The transaction picked for a link was deleted meanwhile.
    if (text.includes('FOREIGN KEY')) changed();
    throw err;
  }
  if (rows.length) return;
  // Nothing written. Only to choose the error: was it the record or the condition?
  if (condition) {
    const [current] = await db
      .select({ version: historicalRecords.version })
      .from(historicalRecords)
      .where(and(eq(historicalRecords.id, read.id), eq(historicalRecords.userId, read.userId)));
    if (current?.version === read.version) condition.otherwise();
  }
  changed();
}

/** A transaction and, for a transfer, its other leg. */
async function txWithLegs(db: DB, userId: string, id: string) {
  const [tx] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.userId, userId)));
  if (!tx) return [];
  if (!tx.transferGroupId) return [tx];
  return db
    .select()
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.transferGroupId, tx.transferGroupId)));
}

async function detail(c: C, id: string): Promise<HistoricalRecordDetailDto> {
  const { db } = c.var.deps;
  const userId = c.var.user.id;
  const r = await ownRecord(db, userId, id);
  const legs = r.linkedTransactionId ? await txWithLegs(db, userId, r.linkedTransactionId) : [];
  // Sending leg first.
  legs.sort((a, b) => a.amount - b.amount);
  return { ...toRecordDto(r), linkedTransactions: await toDtos(db, userId, legs) };
}

function buildWhere(userId: string, q: ReturnType<typeof historicalQuerySchema.parse>): SQL {
  const conds: SQL[] = [eq(historicalRecords.userId, userId)];
  if (q.status !== 'all') conds.push(eq(historicalRecords.status, q.status));
  if (q.recordType) conds.push(eq(historicalRecords.recordType, q.recordType));
  if (q.datePrecision) conds.push(eq(historicalRecords.datePrecision, q.datePrecision));
  if (q.verificationStatus) conds.push(eq(historicalRecords.verificationStatus, q.verificationStatus));
  if (q.q) {
    const pattern = `%${q.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    conds.push(
      or(
        ...[historicalRecords.title, historicalRecords.counterparty, historicalRecords.purpose, historicalRecords.referenceNumber, historicalRecords.note].map(
          (col) => sql`${col} like ${pattern} escape '\\'`,
        ),
      )!,
    );
  }
  return and(...conds)!;
}

/** Latest first; unknown dates last (NULL sorts last when descending), then by entry order. */
const order = [desc(historicalRecords.dateFrom), desc(historicalRecords.occurredTime), desc(historicalRecords.createdAt), desc(historicalRecords.id)];

/** The transaction request a record stands for; only called once archiveConvertBlockers is empty. */
function conversionRequest(r: Row) {
  const details = {
    occurredAt: r.dateFrom,
    occurredTime: r.occurredTime,
    timeZone: r.timeZone,
    purpose: r.purpose,
    paymentChannel: r.paymentChannel,
    referenceNumber: r.referenceNumber,
    evidenceSource: r.evidenceSource,
    verificationStatus: r.verificationStatus,
    counterparty: r.counterparty,
    // With no merchant, purpose or note the entry would be anonymous: the title says what it was.
    note: r.note ?? (r.counterparty || r.purpose ? null : r.title),
    tagIds: [],
  };
  if (r.recordType === 'transfer') {
    return {
      ...details,
      type: 'transfer',
      fromAccountId: r.fromAccountId,
      toAccountId: r.toAccountId,
      fromCurrency: r.currency,
      toCurrency: r.toCurrency,
      amount: r.amount,
      toAmount: r.toAmount,
    };
  }
  return { ...details, type: r.recordType, accountId: r.accountId, currency: r.currency, amount: r.amount };
}

export const archiveRoutes = new Hono<AppBindings>()
  .get('/', async (c) => {
    const q = query(c, historicalQuerySchema);
    const { db } = c.var.deps;
    const userId = c.var.user.id;
    const where = buildWhere(userId, q);
    const [rows, [total], byStatus] = await Promise.all([
      db
        .select()
        .from(historicalRecords)
        .where(where)
        .orderBy(...order)
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize),
      db.select({ n: count() }).from(historicalRecords).where(where),
      db
        .select({ status: historicalRecords.status, n: count() })
        .from(historicalRecords)
        .where(eq(historicalRecords.userId, userId))
        .groupBy(historicalRecords.status),
    ]);
    const counts = Object.fromEntries(ARCHIVE_STATUSES.map((s) => [s, byStatus.find((b) => b.status === s)?.n ?? 0])) as Record<ArchiveStatus, number>;
    return c.json({ items: rows.map(toRecordDto), total: total?.n ?? 0, page: q.page, pageSize: q.pageSize, counts });
  })

  .get('/:id', async (c) => c.json(await detail(c, c.req.param('id'))))

  .post('/', async (c) => {
    const f = fieldsOf(await body(c, historicalRecordSchema));
    await checkRefs(c, f);
    const { db, now } = c.var.deps;
    const t = now();
    const id = newId(t);
    await db.insert(historicalRecords).values({ ...f, id, userId: c.var.user.id, status: 'open', version: 1, createdAt: t, updatedAt: t });
    return c.json(await detail(c, id), 201);
  })

  /**
   * Full replace of the record's fields. A converted record keeps its financial fields; a linked
   * one keeps a kind that fits its transaction (unlink first to change it to one that doesn't).
   */
  .put('/:id', async (c) => {
    const { version, ...input } = await body(c, historicalRecordUpdateSchema);
    const f = fieldsOf(input);
    const { db, now } = c.var.deps;
    const userId = c.var.user.id;
    const cur = await recordAt(db, userId, c.req.param('id'), version);
    if (cur.status === 'converted') {
      const diff = ARCHIVE_FINANCIAL_KEYS.filter((k) => f[k] !== cur[k]);
      if (diff.length) fail(409, 'a converted record keeps its amounts, accounts and date — edit the transaction instead', 'ARCHIVE_LOCKED', diff);
    }
    if (cur.status === 'linked' && f.recordType !== cur.recordType) {
      const [tx] = await db
        .select({ type: transactions.type })
        .from(transactions)
        .where(and(eq(transactions.id, cur.linkedTransactionId!), eq(transactions.userId, userId)));
      if (!tx || !ARCHIVE_LINK_TYPES[f.recordType].includes(tx.type)) {
        fail(409, `a ${f.recordType} record cannot stay linked to a ${tx?.type ?? 'missing'} transaction — unlink it first`, 'ARCHIVE_LINK_INCOMPATIBLE', {
          transactionType: tx?.type ?? null,
        });
      }
    }
    await checkRefs(c, f);
    // A linked record keeps a kind that fits its transaction *as it is when this is written*:
    // the transaction may have changed type since it was read above.
    const incompatible = (): never => fail(409, `a ${f.recordType} record cannot stay linked to that transaction — unlink it first`, 'ARCHIVE_LINK_INCOMPATIBLE');
    const stillFits =
      cur.status === 'linked' ? { holds: fittingAnchor(historicalRecords.linkedTransactionId, historicalRecords.userId, ARCHIVE_LINK_TYPES[f.recordType]), otherwise: incompatible } : undefined;
    await writeAsRead(db, cur, f, now(), stillFits);
    return c.json(await detail(c, cur.id));
  })

  .patch('/:id/verification', async (c) => {
    const { verificationStatus, version } = await body(c, historicalVerificationSchema);
    const { db, now } = c.var.deps;
    const cur = await recordAt(db, c.var.user.id, c.req.param('id'), version);
    if (cur.status === 'converted' && verificationStatus !== cur.verificationStatus) {
      fail(409, 'a converted record stays verified — edit the transaction instead', 'ARCHIVE_LOCKED', ['verificationStatus']);
    }
    await writeAsRead(db, cur, { verificationStatus }, now());
    return c.json(await detail(c, cur.id));
  })

  /** Ignore an open record; it is kept and can be reopened. */
  .post('/:id/dismiss', async (c) => {
    const { version } = await body(c, historicalActionSchema);
    const { db, now } = c.var.deps;
    const cur = await recordAt(db, c.var.user.id, c.req.param('id'), version);
    if (cur.status !== 'open') fail(409, 'only open records can be dismissed', 'ARCHIVE_STATUS');
    await writeAsRead(db, cur, { status: 'dismissed' }, now());
    return c.json(await detail(c, cur.id));
  })

  .post('/:id/reopen', async (c) => {
    const { version } = await body(c, historicalActionSchema);
    const { db, now } = c.var.deps;
    const cur = await recordAt(db, c.var.user.id, c.req.param('id'), version);
    if (cur.status !== 'dismissed') fail(409, 'only dismissed records can be reopened', 'ARCHIVE_STATUS');
    await writeAsRead(db, cur, { status: 'open' }, now());
    return c.json(await detail(c, cur.id));
  })

  /**
   * Point an open record at an existing transaction the user picked. No transaction is created
   * and no balance changes. A transfer is linked through its sending leg (both legs count as taken).
   */
  .post('/:id/link', async (c) => {
    const { transactionId, version } = await body(c, historicalLinkSchema);
    const { db, now } = c.var.deps;
    const userId = c.var.user.id;
    const cur = await recordAt(db, userId, c.req.param('id'), version);
    if (cur.status !== 'open') fail(409, 'only open records can be linked', 'ARCHIVE_STATUS');
    const allowed = ARCHIVE_LINK_TYPES[cur.recordType];
    if (allowed.length === 0) fail(409, `${cur.recordType} records wait for their own module`, 'ARCHIVE_TYPE_DEFERRED');
    const legs = await txWithLegs(db, userId, transactionId);
    if (legs.length === 0) notFound('transaction');
    const tx = legs.find((l) => l.id === transactionId)!;
    if (!allowed.includes(tx.type)) fail(400, `a ${cur.recordType} record cannot be linked to a ${tx.type} transaction`, 'ARCHIVE_TYPE_MISMATCH');
    const [taken] = await db
      .select({ id: historicalRecords.id })
      .from(historicalRecords)
      .where(and(eq(historicalRecords.userId, userId), inArray(historicalRecords.linkedTransactionId, legs.map((l) => l.id))));
    if (taken) fail(409, 'that transaction is already linked to another record', 'ARCHIVE_TX_TAKEN');
    // Written only if, at that moment, the anchor still exists, is the user's, has a type this
    // record fits and is still its entry's anchor; the unique index settles a race between two
    // records. Checks above only choose a clearer error for the common cases.
    const anchor = anchorLeg(legs).id;
    await writeAsRead(db, cur, { status: 'linked', linkedTransactionId: anchor, linkLostAt: null }, now(), {
      holds: fittingAnchor(anchor, userId, allowed),
      otherwise: () => fail(409, 'the transaction was changed or deleted meanwhile — pick it again', 'ARCHIVE_TX_CHANGED'),
    });
    return c.json(await detail(c, cur.id));
  })

  /**
   * Undo a link: the record goes back to open with its content unchanged; the transaction and
   * every balance stay as they are. A converted record is undone by deleting its transaction.
   */
  .post('/:id/unlink', async (c) => {
    const { version } = await body(c, historicalActionSchema);
    const { db, now } = c.var.deps;
    const cur = await recordAt(db, c.var.user.id, c.req.param('id'), version);
    if (cur.status === 'converted') fail(409, 'the transaction was created from this record — delete it to undo the conversion', 'ARCHIVE_CONVERTED');
    if (cur.status !== 'linked') fail(409, 'the record is not linked', 'ARCHIVE_STATUS');
    await writeAsRead(db, cur, { status: 'open', linkedTransactionId: null }, now());
    return c.json(await detail(c, cur.id));
  })

  /**
   * Book a verified expense / income / transfer with an exact day as a real transaction. The
   * request goes through the same validation and leg planning as POST /transactions. One batch:
   *   1. each leg: INSERT … SELECT … WHERE the record is still open at the version read
   *      (all legs see the same state: both legs of a transfer, or none);
   *   2. the balance recalculation (unchanged by legs that weren't written);
   *   3. the record → converted, again only at that version: otherwise its status is set to NULL,
   *      which NOT NULL turns into an error that rolls the whole batch back (libSQL and D1 alike).
   * A stale request therefore writes nothing, by two independent guards, and gets 409.
   */
  .post('/:id/convert', async (c) => {
    const { version } = await body(c, historicalActionSchema);
    const { db, now } = c.var.deps;
    const userId = c.var.user.id;
    const cur = await recordAt(db, userId, c.req.param('id'), version);
    const blockers = archiveConvertBlockers(cur);
    if (blockers.length) {
      const [first] = blockers;
      if (first === 'status') fail(409, `the record is ${cur.status}`, 'ARCHIVE_STATUS', blockers);
      if (first === 'type') fail(409, `${cur.recordType} records cannot become an ordinary transaction`, 'ARCHIVE_TYPE_NOT_CONVERTIBLE', blockers);
      fail(400, `the record is not ready to convert: ${blockers.join(', ')}`, 'ARCHIVE_NOT_READY', blockers);
    }
    const parsed = transactionSchema.safeParse(conversionRequest(cur));
    if (!parsed.success) fail(400, 'the record does not make a valid transaction', 'ARCHIVE_NOT_READY', parsed.error.issues);
    const legs = await planLegs(c, parsed.data, {});
    const t = now();
    const stillOpen = and(atVersion(cur), eq(historicalRecords.status, 'open'), isNull(historicalRecords.linkedTransactionId))!;
    const { rows, ops } = insertLegOpsWhen(db, userId, legs, t, sql`exists (select 1 from ${historicalRecords} where ${stillOpen})`);
    const anchor = anchorLeg(rows).id;
    try {
      await runBatch(db, [
        ...ops,
        db
          .update(historicalRecords)
          .set({
            status: sql`case when ${stillOpen} then 'converted' else null end`,
            linkedTransactionId: anchor,
            convertedAt: t,
            linkLostAt: null,
            version: cur.version + 1,
            updatedAt: t,
          })
          .where(and(eq(historicalRecords.id, cur.id), eq(historicalRecords.userId, userId))),
      ]);
    } catch (err) {
      if (errorChain(err).includes('historical_records.status')) changed();
      throw err;
    }
    const out = await detail(c, cur.id);
    // Belt and braces: the record must now point at exactly the legs this request wrote.
    if (out.status !== 'converted' || out.linkedTransactionId !== anchor || out.linkedTransactions.length !== rows.length) changed();
    return c.json(out);
  });
