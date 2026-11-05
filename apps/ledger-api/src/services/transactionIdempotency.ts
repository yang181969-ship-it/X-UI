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
 *
 * Logical expiry (M3-B3-B.0, API_SPEC §5.0.3, DATA_MODEL §10.5): a correct / void key row with
 * expires_at <= now is no key at all — never replayed, never a conflict, never a 500 for its
 * hash_version. Create keys (expires_at NULL) never expire. Every request reads the server time
 * ONCE (`now`) and uses it for the lookup, the batch's S0 and the new key row, so a row this request
 * found expired is deleted by its own S0 before gate G is evaluated. Ignoring the row here does not
 * make the key reusable by itself — the database does (S0, gate G, primary key); a committed batch
 * that still finds this request's key on an expired row means S0 did not run: a broken invariant (500).
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

/** The caller's key row as stored — expired or not (post-batch checks; see liveKey for lookups). */
export async function findKey(db: DB, userId: string, key: string): Promise<KeyRow | undefined> {
  const [row] = await db
    .select()
    .from(ledgerIdempotencyKeys)
    .where(and(eq(ledgerIdempotencyKeys.userId, userId), eq(ledgerIdempotencyKeys.key, key)));
  return row;
}

/** expires_at <= now: a correct / void key past its 30 days (create keys have no expiry). */
export const isExpired = (row: Pick<KeyRow, 'expiresAt'>, now: number) => row.expiresAt !== null && row.expiresAt <= now;

/** The caller's key as a lookup sees it: a logically expired row is no key. */
export async function liveKey(db: DB, userId: string, key: string, now: number): Promise<KeyRow | undefined> {
  const row = await findKey(db, userId, key);
  return row && !isExpired(row, now) ? row : undefined;
}

export type WriteOutcome = { status: 200 | 201; result: TransactionWriteResult; replayed: boolean };

/** A request whose (live) key is already stored: replay (same request), 409 (different), 500 (unknown hash version). */
export async function answerStoredKey(deps: Deps, row: KeyRow, request: RequestFingerprint, now: number): Promise<WriteOutcome> {
  // Only a post-batch read can hand an expired row here: this request's S0 should have deleted it.
  if (isExpired(row, now)) throw new LedgerWriteError('an expired key row survived the write batch');
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

/**
 * The outcome of a write batch that committed (DATA_MODEL §10.10): the key row carries this
 * request's op id → its own first result; another op id (gate G was closed: a request with the same
 * key committed first) → that stored key answers. No key row at all → a broken invariant (500).
 */
export async function committedOutcome(deps: Deps, userId: string, key: string, opId: string, request: RequestFingerprint, now: number): Promise<WriteOutcome> {
  const row = await findKey(deps.db, userId, key);
  if (!row) throw new LedgerWriteError('the write batch committed without its key row');
  if (row.opId === opId) return { status: row.responseStatus as 200 | 201, result: await writeResult(deps.db, row), replayed: false };
  return answerStoredKey(deps, row, request, now);
}

/** The key's primary key refused the batch (rolled back): the request that took the key answers. */
export async function takenKeyOutcome(deps: Deps, userId: string, key: string, request: RequestFingerprint, now: number, cause: unknown): Promise<WriteOutcome> {
  const row = await findKey(deps.db, userId, key);
  if (!row) throw new LedgerWriteError('the key was refused as taken but is not stored', { cause });
  return answerStoredKey(deps, row, request, now);
}

/**
 * The route-level frame of every financial write (API_SPEC §5.0.3): the request's hash (once), the
 * caller's live key — replay / 409 / 500 — or, without one, the write itself.
 */
export async function idempotentWrite(
  c: C,
  key: string,
  now: number,
  operation: IdempotentOperation,
  transactionId: string | null,
  body: unknown,
  write: (request: RequestFingerprint) => Promise<WriteOutcome>,
): Promise<WriteOutcome> {
  const request = await fingerprint(c.var.deps, operation, transactionId, body);
  const stored = await liveKey(c.var.deps.db, c.var.user.id, key, now);
  return stored ? answerStoredKey(c.var.deps, stored, request, now) : write(request);
}
