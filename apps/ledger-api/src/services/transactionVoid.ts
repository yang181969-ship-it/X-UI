import type { RevisionConflictDetails, TransactionVoid } from '@xui/ledger-shared';
import { and, eq, gte } from 'drizzle-orm';
import type { Context } from 'hono';
import { transactions } from '../db/schema.ts';
import type { AppBindings } from '../env.ts';
import { fail, notFound } from '../lib/http.ts';
import { newId } from '../lib/id.ts';
import { classifyWriteFailure, LedgerWriteError } from './transactionErrors.ts';
import { committedOutcome, takenKeyOutcome, type RequestFingerprint, type WriteOutcome } from './transactionIdempotency.ts';
import { voidBatch } from './transactionWrite.ts';

/**
 * POST /transactions/:id/void after the request itself passed and its key was not live (API_SPEC
 * §5.8; DATA_MODEL §10.10 "作废"):
 *
 * 1. The caller's published transaction (another user's, a missing one and an unpublished header
 *    are the same 404) → voided: 409 TRANSACTION_VOIDED (before anything else, Q-B3-4) → not at
 *    baseRevision: 409 REVISION_CONFLICT { currentRevision }.
 * 2. The void chain in one batch; a void is no version (no event, no entry, current_revision kept).
 * 3. After the batch (DATA_MODEL §10.10):
 *    - committed with this request's op id → 200 with the void's TransactionWriteResult; with
 *      another op id (gate G closed) or the key's primary key refused → the stored key answers;
 *    - key row incomplete (S1 voided nothing: the transaction was voided or moved on meanwhile) or a
 *      foreign key refused → step 1 again, as the caller sees it now; nothing explains it → 500;
 *    - anything else, LEDGER_* included → 500. A void reads no snapshot source, so there is no
 *      controlled retry (nothing it could re-read would justify one).
 */

type C = Context<AppBindings>;

/**
 * The caller's published transaction, open at baseRevision — shared by the void and the corrections
 * (API_SPEC §5.7.1 steps 5–6, §5.8): 404 (another user's, a missing and an unpublished header alike)
 * → 409 TRANSACTION_VOIDED (whatever baseRevision, Q-B3-4) → 409 REVISION_CONFLICT { currentRevision }.
 */
export async function assertCurrent(c: C, id: string, baseRevision: number) {
  const [header] = await c.var.deps.db
    .select({ status: transactions.status, currentRevision: transactions.currentRevision, txnType: transactions.txnType })
    .from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.userId, c.var.user.id), gte(transactions.currentRevision, 1)));
  if (!header) notFound('transaction');
  if (header.status === 'voided') fail(409, 'the transaction is voided — it can not be corrected or voided again', 'TRANSACTION_VOIDED');
  if (header.currentRevision !== baseRevision) {
    fail(409, 'baseRevision is not the current revision of the transaction', 'REVISION_CONFLICT', { currentRevision: header.currentRevision } satisfies RevisionConflictDetails);
  }
  return header!;
}

export async function voidTransaction(c: C, id: string, input: TransactionVoid, key: string, request: RequestFingerprint, now: number): Promise<WriteOutcome> {
  const { db } = c.var.deps;
  const u = c.var.user.id;
  await assertCurrent(c, id, input.baseRevision);
  const O = newId(now);
  try {
    await db.batch(
      voidBatch(db, {
        u,
        T: id,
        O,
        A: newId(now),
        now,
        ip: c.var.ip,
        key,
        requestHash: request.hash,
        hashVersion: request.hashVersion,
        baseRevision: input.baseRevision,
        reason: input.reason,
      }),
    );
  } catch (err) {
    const failure = classifyWriteFailure(err);
    if (failure.kind === 'key_taken') return takenKeyOutcome(c.var.deps, u, key, request, now, err);
    if (failure.kind === 'key_incomplete' || failure.kind === 'foreign_key') {
      await assertCurrent(c, id, input.baseRevision);
      throw new LedgerWriteError('the void did not complete and re-reading does not explain why', { cause: err });
    }
    throw new LedgerWriteError('the void failed', { cause: err });
  }
  return committedOutcome(c.var.deps, u, key, O, request, now);
}
