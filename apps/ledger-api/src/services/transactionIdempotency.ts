import {
  IDEMPOTENCY_KEY_HEADER,
  isIdempotencyKey,
  REQUEST_HASH_VERSION,
  REQUEST_HASHERS,
  type IdempotencyConflictDetails,
  type IdempotentOperation,
  type TransactionWriteResult,
} from '@xui/ledger-shared';
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import type { DB } from '../db/client.ts';
import { ledgerIdempotencyKeys } from '../db/schema.ts';
import type { AppBindings, Deps } from '../env.ts';
import { fail } from '../lib/http.ts';
import { LedgerWriteError } from './transactionErrors.ts';
import { writeResult, type KeyRow } from './transactionResult.ts';

/**
 * Route-level idempotency of the financial writes (API_SPEC §5.0.3, DATA_MODEL §10.5 / §10.10).
 *
 * The key is per user (primary key (user_id, key)). A request's hash is computed once, from the
 * zod-parsed body, and kept for the whole request — a controlled retry reuses it. A stored key is
 * always compared with the hasher of its own hash_version: same hash → replay of the immutable
 * first result (status from the key row, header Idempotency-Replayed: true); different → 409
 * IDEMPOTENCY_CONFLICT with that key row's own operation and transaction id; a version this
 * server does not know → generic 500, neither replay nor conflict (Q9).
 *
 * Concurrency is the database's: gate G and the primary key decide which of two requests with one
 * key writes. Nothing here is a process-local lock.
 */

type C = Context<AppBindings>;

/** The Idempotency-Key header: 400 IDEMPOTENCY_KEY_REQUIRED when missing, IDEMPOTENCY_KEY_INVALID when malformed. */
export function idempotencyKey(c: C): string {
  const key = c.req.header(IDEMPOTENCY_KEY_HEADER);
  if (key === undefined || key === '') fail(400, 'the Idempotency-Key header is required for this request', 'IDEMPOTENCY_KEY_REQUIRED');
  if (!isIdempotencyKey(key)) fail(400, 'the Idempotency-Key header must be 16–64 characters of 0-9, A-Z, a-z, _ and -', 'IDEMPOTENCY_KEY_INVALID');
  return key;
}

const hashing = (deps: Deps) => deps.requestHash ?? { version: REQUEST_HASH_VERSION, hashers: REQUEST_HASHERS };

export interface RequestFingerprint {
  operation: IdempotentOperation;
  transactionId: string | null;
  /** The zod-parsed body. */
  body: unknown;
  hashVersion: number;
  /** Hash of the request under hashVersion — computed once per request. */
  hash: string;
}

/** Hash a parsed request with the current version (once per request). */
export async function fingerprint(deps: Deps, operation: IdempotentOperation, transactionId: string | null, body: unknown): Promise<RequestFingerprint> {
  const { version, hashers } = hashing(deps);
  const hasher = hashers[version];
  if (!hasher) throw new LedgerWriteError(`no hasher for the current request hash version ${version}`);
  return { operation, transactionId, body, hashVersion: version, hash: await hasher(operation, transactionId, body) };
}

export async function findKey(db: DB, userId: string, key: string): Promise<KeyRow | undefined> {
  const [row] = await db
    .select()
    .from(ledgerIdempotencyKeys)
    .where(and(eq(ledgerIdempotencyKeys.userId, userId), eq(ledgerIdempotencyKeys.key, key)));
  return row;
}

export type WriteOutcome = { status: 200 | 201; result: TransactionWriteResult; replayed: boolean };

/** A request whose key is already stored: replay (same request), 409 (different), 500 (unknown hash version). */
export async function answerStoredKey(deps: Deps, row: KeyRow, request: RequestFingerprint): Promise<WriteOutcome> {
  let same: boolean;
  if (row.hashVersion === request.hashVersion) same = row.requestHash === request.hash;
  else {
    const hasher = hashing(deps).hashers[row.hashVersion];
    if (!hasher) throw new LedgerWriteError(`stored key has unknown request hash version ${row.hashVersion}`);
    same = row.requestHash === (await hasher(request.operation, request.transactionId, request.body));
  }
  if (!same) {
    fail(409, 'this Idempotency-Key was already used for a different request', 'IDEMPOTENCY_CONFLICT', {
      operation: row.operation,
      transactionId: row.transactionId,
    } satisfies IdempotencyConflictDetails);
  }
  return { status: row.responseStatus as 200 | 201, result: await writeResult(deps.db, row), replayed: true };
}
