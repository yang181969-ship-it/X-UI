import {
  IDEMPOTENCY_REPLAYED_HEADER,
  latestOccurredOn,
  transactionCreateSchema,
  transactionListQuerySchema,
  transactionShapeProblem,
  type EntryShapeDetails,
} from '@xui/ledger-shared';
import { Hono } from 'hono';
import type { AppBindings } from '../env.ts';
import { rejectSensitive } from '../lib/guards.ts';
import { body, fail, notFound, query } from '../lib/http.ts';
import { createTransaction } from '../services/transactionCreate.ts';
import { answerStoredKey, findKey, fingerprint, idempotencyKey } from '../services/transactionIdempotency.ts';
import { getTransaction, listTransactions } from '../services/transactionRead.ts';

/**
 * M3 transactions (API_SPEC §5). M3-B2: POST /transactions, GET /transactions and GET
 * /transactions/:id — corrections, voids, notes and the revision view come with M3-B3, the summary
 * with M3-B5 (which must be registered before /:id).
 *
 * POST order (API_SPEC §5.0.3, §5.4): auth / Origin / CSRF / size (app middleware) → the
 * Idempotency-Key header → the request on its own (strict body, occurredOn at most the day after
 * the server's UTC date, sensitive text, Entry shape — nothing here reads the database) → the
 * request hash, once → the caller's stored key (replay / 409 / 500) → createTransaction().
 */
export const transactionRoutes = new Hono<AppBindings>().post('/', async (c) => {
  const key = idempotencyKey(c);
  const input = await body(c, transactionCreateSchema);
  if (input.occurredOn > latestOccurredOn(c.var.deps.now())) {
    fail(400, 'validation failed', 'VALIDATION', [{ code: 'custom', path: ['occurredOn'], message: 'occurredOn is at most the day after the current UTC date' }]);
  }
  rejectSensitive({
    merchantName: input.merchantName,
    'counterparty.name': input.counterparty?.name,
    'counterparty.institution': input.counterparty?.institution,
    'counterparty.accountHint': input.counterparty?.accountHint,
    notes: input.notes,
  });
  const rule = transactionShapeProblem(input);
  if (rule) fail(400, 'the entries or fields do not fit the transaction type', 'ENTRY_SHAPE', { rule } satisfies EntryShapeDetails);

  const request = await fingerprint(c.var.deps, 'transaction.create', null, input);
  const stored = await findKey(c.var.deps.db, c.var.user.id, key);
  const out = stored ? await answerStoredKey(c.var.deps, stored, request) : await createTransaction(c, input, key, request);
  if (out.replayed) c.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
  return c.json(out.result, out.status);
})

  /** GET /transactions (API_SPEC §5.3): the caller's transactions, current versions, keyset pages. */
  .get('/', async (c) => c.json(await listTransactions({ db: c.var.deps.db, userId: c.var.user.id }, query(c, transactionListQuerySchema))))

  /** GET /transactions/:id (API_SPEC §5.5): any status; another user's or a missing one → the same 404. */
  .get('/:id', async (c) => {
    const dto = await getTransaction({ db: c.var.deps.db, userId: c.var.user.id }, c.req.param('id'));
    if (!dto) notFound('transaction');
    return c.json(dto);
  });
