import {
  IDEMPOTENCY_REPLAYED_HEADER,
  latestOccurredOn,
  transactionCorrectionSchema,
  transactionCreateSchema,
  transactionListQuerySchema,
  transactionNotesSchema,
  transactionShapeProblem,
  transactionSummaryQuerySchema,
  transactionVoidSchema,
  type EntryShapeDetails,
} from '@xui/ledger-shared';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../env.ts';
import { rejectSensitive } from '../lib/guards.ts';
import { body, fail, notFound, query } from '../lib/http.ts';
import { correctTransaction } from '../services/transactionCorrect.ts';
import { createTransaction } from '../services/transactionCreate.ts';
import { idempotencyKey, idempotentWrite, type WriteOutcome } from '../services/transactionIdempotency.ts';
import { updateNotes } from '../services/transactionNotes.ts';
import { getRevision, getTransaction, listTransactions } from '../services/transactionRead.ts';
import { summarizeTransactions } from '../services/transactionSummary.ts';
import { voidTransaction } from '../services/transactionVoid.ts';

/**
 * M3 transactions (API_SPEC §5). M3-B2: POST /transactions, GET /transactions, GET /transactions/:id.
 * M3-B3-B: POST /:id/void, PATCH /:id/notes, GET /:id/revisions/:revision. M3-B3-C: POST
 * /:id/revisions (settlement, fact_correction, snapshot_correction). M3-B5-B: GET /summary, registered
 * before /:id so the dynamic route never captures it.
 *
 * Financial writes (create, correct, void): auth / Origin / CSRF / size (app middleware) → the
 * Idempotency-Key header → the request on its own (strict body, sensitive text, occurredOn and, for
 * a create, the Entry shape — nothing here reads the database; a fact correction's Entry shape
 * depends on the stored type and comes after the key, Q-B3-1) → idempotentWrite(): the request
 * hash, once → the caller's live key (replay / 409 / 500) → the write. Each request reads the server
 * time once; the key lookup, the batch's S0 and the new key row all use that one value.
 */

type C = Context<AppBindings>;

const respond = (c: C, out: WriteOutcome) => {
  if (out.replayed) c.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
  return c.json(out.result, out.status);
};

/** occurredOn may be at most the day after the server's UTC date (API_SPEC §5.0.2). */
const assertOccurredOn = (occurredOn: string, now: number) => {
  if (occurredOn > latestOccurredOn(now)) {
    fail(400, 'validation failed', 'VALIDATION', [{ code: 'custom', path: ['occurredOn'], message: 'occurredOn is at most the day after the current UTC date' }]);
  }
};

/** A path revision: a canonical decimal positive integer (no sign, no leading zero, ASCII digits, ≤ 2^53 − 1). */
const revisionParamSchema = z.strictObject({
  revision: z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/)
    .transform(Number)
    .pipe(z.int().max(Number.MAX_SAFE_INTEGER)),
});

export const transactionRoutes = new Hono<AppBindings>()
  /** POST /transactions (API_SPEC §5.4). */
  .post('/', async (c) => {
    const key = idempotencyKey(c);
    const input = await body(c, transactionCreateSchema);
    const now = c.var.deps.now();
    assertOccurredOn(input.occurredOn, now);
    rejectSensitive({
      merchantName: input.merchantName,
      'counterparty.name': input.counterparty?.name,
      'counterparty.institution': input.counterparty?.institution,
      'counterparty.accountHint': input.counterparty?.accountHint,
      notes: input.notes,
    });
    const rule = transactionShapeProblem(input);
    if (rule) fail(400, 'the entries or fields do not fit the transaction type', 'ENTRY_SHAPE', { rule } satisfies EntryShapeDetails);
    return respond(c, await idempotentWrite(c, key, now, 'transaction.create', null, input, (request) => createTransaction(c, input, key, request, now)));
  })

  /** GET /transactions (API_SPEC §5.3): the caller's transactions, current versions, keyset pages. */
  .get('/', async (c) => c.json(await listTransactions({ db: c.var.deps.db, userId: c.var.user.id }, query(c, transactionListQuerySchema))))

  /** GET /transactions/summary (API_SPEC §5.10): per original currency; must stay before /:id. */
  .get('/summary', async (c) => c.json(await summarizeTransactions({ db: c.var.deps.db, userId: c.var.user.id }, query(c, transactionSummaryQuerySchema))))

  /** GET /transactions/:id (API_SPEC §5.5): any status; another user's or a missing one → the same 404. */
  .get('/:id', async (c) => {
    const dto = await getTransaction({ db: c.var.deps.db, userId: c.var.user.id }, c.req.param('id'));
    if (!dto) notFound('transaction');
    return c.json(dto);
  })

  /**
   * GET /transactions/:id/revisions/:revision (API_SPEC §5.6): a malformed revision is a 400 decided
   * by the request alone (another user's transaction too); then 404 / 200.
   */
  .get('/:id/revisions/:revision', async (c) => {
    const param = revisionParamSchema.safeParse({ revision: c.req.param('revision') });
    if (!param.success) fail(400, 'invalid path parameter', 'VALIDATION', param.error.issues);
    const dto = await getRevision({ db: c.var.deps.db, userId: c.var.user.id }, c.req.param('id'), param.data!.revision);
    if (!dto) notFound('transaction revision');
    return c.json(dto);
  })

  /**
   * POST /transactions/:id/void (API_SPEC §5.8): key → strict body, sensitive reason → live key
   * (replay 200 / 409 / 500) → 404 → 409 TRANSACTION_VOIDED → 409 REVISION_CONFLICT → the void chain.
   */
  .post('/:id/void', async (c) => {
    const key = idempotencyKey(c);
    const input = await body(c, transactionVoidSchema);
    rejectSensitive({ reason: input.reason });
    const now = c.var.deps.now();
    const id = c.req.param('id');
    return respond(c, await idempotentWrite(c, key, now, 'transaction.void', id, input, (request) => voidTransaction(c, id, input, key, request, now)));
  })

  /**
   * POST /transactions/:id/revisions (API_SPEC §5.7, §5.7.1): key → strict body (kind, recordMode of
   * a fact correction, occurredOn), sensitive text → live key (replay 201 / 409 / 500) → the
   * correction (404 → 409 TRANSACTION_VOIDED → 409 REVISION_CONFLICT → checks against version r).
   */
  .post('/:id/revisions', async (c) => {
    const key = idempotencyKey(c);
    const input = await body(c, transactionCorrectionSchema);
    const now = c.var.deps.now();
    if (input.kind === 'fact_correction') {
      assertOccurredOn(input.occurredOn, now);
      rejectSensitive({
        merchantName: input.merchantName,
        'counterparty.name': input.counterparty?.name,
        'counterparty.institution': input.counterparty?.institution,
        'counterparty.accountHint': input.counterparty?.accountHint,
        reason: input.reason,
      });
    } else rejectSensitive({ reason: input.reason });
    const id = c.req.param('id');
    return respond(c, await idempotentWrite(c, key, now, 'transaction.correct', id, input, (request) => correctTransaction(c, id, input, key, request, now)));
  })

  /** PATCH /transactions/:id/notes (API_SPEC §5.9): no Idempotency-Key is read, no version, no audit. */
  .patch('/:id/notes', async (c) => {
    const input = await body(c, transactionNotesSchema);
    rejectSensitive({ notes: input.notes });
    const dto = await updateNotes({ db: c.var.deps.db, userId: c.var.user.id, now: c.var.deps.now() }, c.req.param('id'), input.notes);
    if (!dto) notFound('transaction');
    return c.json(dto);
  });
