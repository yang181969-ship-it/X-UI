import { canonicalRequestV1, IDEMPOTENT_OPERATIONS, isIdempotencyKey, type IdempotentOperation } from '@xui/ledger-shared';

/**
 * The browser side of a financial write's idempotency (API_SPEC §5.0.3, PRODUCT_SPEC §7.8; B4-A
 * §6, decisions Q1 and Q8). Pure logic: no React, no fetch, no global storage — the caller passes
 * the storage, the clock, the key generator and the send function, so every branch is unit-tested.
 * Not yet connected to any write (M3-B4-B); create, correct and void use it from B4-C on.
 *
 * Rules:
 * - The key is generated on the first submit, never on mount (StrictMode double effects and
 *   re-renders therefore never mint a key), with crypto.randomUUID().
 * - A submit of the same parsed request (canonicalRequestV1 equal: key order and entry order do not
 *   matter, any value does) reuses the key AND the original body object, byte for byte.
 * - Different content gets a new key — unless the previous attempt's outcome is unknown: then the
 *   write is locked; only the original request may be retried (or the user explicitly abandons it),
 *   because the first one may have been committed and a new key would write twice.
 * - Outcomes: 2xx (replay included) → success, cleared; any 4xx → definitive (the server keeps no
 *   key for a failed request), never retried automatically, the key is kept in memory for an
 *   identical resubmit; 409 IDEMPOTENCY_CONFLICT → the key is burned and discarded; status 0
 *   (network), 5xx or anything that is not an API answer → unknown.
 * - Unknown → retried automatically twice with the same key and body (1 s, then 3 s), then left
 *   for a manual retry. sessionStorage holds a write only while its outcome is unknown (a record in
 *   storage always means "may or may not be saved"), per user id; it is removed on success, a
 *   definitive answer, an explicit abandon, and sign-out (clearAllPendingWrites).
 */

export type PendingState = 'ready' | 'sending' | 'unknown' | 'failed';

export interface PendingWrite {
  v: 1;
  userId: string;
  operation: IdempotentOperation;
  /** The path id of a correction / void; null for a create. */
  transactionId: string | null;
  key: string;
  /** The zod-parsed request body — what is sent, and resent unchanged. */
  body: unknown;
  /** canonicalRequestV1(operation, transactionId, body). */
  canonical: string;
  state: PendingState;
  /** Requests sent with this key. */
  attempts: number;
  createdAt: number;
  updatedAt: number;
  /** The last failed answer (status 0 = no answer). */
  last: { status: number; code: string | null } | null;
}

export type Outcome =
  | { kind: 'success'; status: number; replayed: boolean }
  | { kind: 'definitive'; status: number; code: string | null }
  | { kind: 'unknown'; status: number; code: string | null };

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export interface WriteInput {
  userId: string;
  operation: IdempotentOperation;
  transactionId: string | null;
  /** The parsed body (the shared zod schema's output, defaults filled). */
  body: unknown;
}

export interface PrepareDeps {
  now(): number;
  /** Key generator; crypto.randomUUID() in the browser. */
  uuid(): string;
}

/** Automatic retries of an unknown outcome (Q8): two, after 1 s and 3 s. */
export const RETRY_DELAYS: readonly number[] = [1000, 3000];
export const STORAGE_PREFIX = 'xui-v1-pending-write:';

export const defaultUuid = () => crypto.randomUUID();

/** One pending write per form: the create form, or one operation on one transaction. */
export const slotOf = (operation: IdempotentOperation, transactionId: string | null) => `${operation}:${transactionId ?? 'new'}`;
const storageKey = (userId: string, slot: string) => `${STORAGE_PREFIX}${encodeURIComponent(userId)}:${slot}`;

/** The form must not change the request: a request is in flight, or the last outcome is unknown. */
export const isLocked = (p: PendingWrite | null): boolean => p !== null && (p.state === 'sending' || p.state === 'unknown');

// ------------------------------------------------------------------ state transitions

export type PrepareResult = { ok: true; pending: PendingWrite; reused: boolean } | { ok: false; reason: 'in_flight' | 'unknown_outcome'; pending: PendingWrite };

/**
 * The write to send for `input`, given the previous one of the same form (`prev`, possibly
 * restored from storage). Same content → the previous key and body; different content → a new key,
 * refused while a request is in flight or the previous outcome is unknown.
 */
export function preparePendingWrite(prev: PendingWrite | null, input: WriteInput, deps: PrepareDeps): PrepareResult {
  const canonical = canonicalRequestV1(input.operation, input.transactionId, input.body);
  const same = prev !== null && prev.userId === input.userId && prev.operation === input.operation && prev.transactionId === input.transactionId;
  if (same && prev.state === 'sending') return { ok: false, reason: 'in_flight', pending: prev };
  if (same && prev.canonical === canonical) return { ok: true, pending: prev, reused: true };
  if (same && prev.state === 'unknown') return { ok: false, reason: 'unknown_outcome', pending: prev };
  const key = deps.uuid();
  if (!isIdempotencyKey(key)) throw new RangeError('generated idempotency key does not match the API format');
  const now = deps.now();
  return {
    ok: true,
    reused: false,
    pending: { v: 1, userId: input.userId, operation: input.operation, transactionId: input.transactionId, key, body: input.body, canonical, state: 'ready', attempts: 0, createdAt: now, updatedAt: now, last: null },
  };
}

export function markSending(p: PendingWrite, now: number): PendingWrite {
  return { ...p, state: 'sending', attempts: p.attempts + 1, updatedAt: now };
}

/** What the response (or its absence) means for the request. */
export function outcomeOfError(e: unknown): Outcome {
  const status = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : null;
  const rawCode = (e as { code?: unknown })?.code;
  const code = typeof rawCode === 'string' ? rawCode : null;
  if (status === null || status === 0 || status >= 500) return { kind: 'unknown', status: status ?? 0, code };
  return { kind: 'definitive', status, code };
}

/**
 * After an answer: success → null (nothing pending); IDEMPOTENCY_CONFLICT → null (the key is used
 * by other content: never send it again); another definitive answer → failed (key kept for an
 * identical resubmit); unknown → unknown.
 */
export function settle(p: PendingWrite, outcome: Outcome, now: number): PendingWrite | null {
  if (outcome.kind === 'success') return null;
  if (outcome.kind === 'definitive' && outcome.code === 'IDEMPOTENCY_CONFLICT') return null;
  return { ...p, state: outcome.kind === 'unknown' ? 'unknown' : 'failed', updatedAt: now, last: { status: outcome.status, code: outcome.code } };
}

/** The page is going away with a request in flight: its outcome becomes unknown (persist it). */
export function markUnloading(p: PendingWrite, now: number): PendingWrite {
  return p.state === 'sending' ? { ...p, state: 'unknown', updatedAt: now } : p;
}

// ------------------------------------------------------------------ storage (unknown outcomes only)

/** Keep storage in step with the write: stored exactly while its outcome is unknown. A request in flight leaves storage as it is. */
export function syncPendingWrite(storage: StorageLike | null, slotUserId: string, slot: string, p: PendingWrite | null): void {
  if (!storage || p?.state === 'sending') return;
  try {
    const k = storageKey(slotUserId, slot);
    if (p?.state === 'unknown') storage.setItem(k, JSON.stringify(p));
    else storage.removeItem(k);
  } catch {
    /* storage full or blocked: memory still holds the write */
  }
}

function revive(raw: string | null, userId: string): PendingWrite | null {
  if (raw === null) return null;
  try {
    const p = JSON.parse(raw) as PendingWrite;
    if (p?.v !== 1 || p.userId !== userId || p.state !== 'unknown') return null;
    if (!(IDEMPOTENT_OPERATIONS as readonly string[]).includes(p.operation) || !isIdempotencyKey(p.key)) return null;
    if (p.transactionId !== null && typeof p.transactionId !== 'string') return null;
    if (p.operation === 'transaction.create' ? p.transactionId !== null : p.transactionId === null) return null;
    // The body must still be exactly what was hashed and sent.
    if (canonicalRequestV1(p.operation, p.transactionId, p.body) !== p.canonical) return null;
    if (!Number.isInteger(p.attempts) || !Number.isFinite(p.createdAt) || !Number.isFinite(p.updatedAt)) return null;
    return p;
  } catch {
    return null;
  }
}

/** The unknown-outcome write of `userId` in `slot` (after a reload). Malformed or foreign records are removed. */
export function loadPendingWrite(storage: StorageLike | null, userId: string, slot: string): PendingWrite | null {
  if (!storage) return null;
  try {
    const k = storageKey(userId, slot);
    const raw = storage.getItem(k);
    const p = revive(raw, userId);
    if (raw !== null && !p) storage.removeItem(k);
    return p;
  } catch {
    return null;
  }
}

/** Every unknown-outcome write of `userId` (another user's records are never read). */
export function listPendingWrites(storage: StorageLike | null, userId: string): PendingWrite[] {
  if (!storage) return [];
  const prefix = `${STORAGE_PREFIX}${encodeURIComponent(userId)}:`;
  const out: PendingWrite[] = [];
  try {
    for (const k of allKeys(storage)) {
      if (!k.startsWith(prefix)) continue;
      const p = loadPendingWrite(storage, userId, k.slice(prefix.length));
      if (p) out.push(p);
    }
  } catch {
    /* blocked storage */
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** The user gave up on the write (after being told it may have been saved). */
export function abandonPendingWrite(storage: StorageLike | null, userId: string, slot: string): null {
  syncPendingWrite(storage, userId, slot, null);
  return null;
}

/** Sign-out: every pending write of every user in this tab. */
export function clearAllPendingWrites(storage: StorageLike | null): void {
  if (!storage) return;
  try {
    for (const k of allKeys(storage)) if (k.startsWith(STORAGE_PREFIX)) storage.removeItem(k);
  } catch {
    /* blocked storage */
  }
}

function allKeys(storage: StorageLike): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k !== null) keys.push(k);
  }
  return keys;
}

/** window.sessionStorage when usable (private modes may throw). */
export function browserSessionStorage(): StorageLike | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ sending with retries

export type SendFn<T> = (key: string, body: unknown) => Promise<{ data: T; status: number; replayed: boolean }>;

export interface RunDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  storage: StorageLike | null;
  retryDelays?: readonly number[];
  /**
   * Cancels the remaining automatic retries (the user abandoned the write, the form went away, or
   * the user signed out). A cancelled run sends nothing more, reports nothing more, and never
   * stores an unknown outcome again; a success or definitive answer still clears storage.
   */
  signal?: { readonly aborted: boolean };
}

export interface RunResult<T> {
  /** null after success, a burned key or a cancelled run; otherwise the write (failed or unknown). */
  pending: PendingWrite | null;
  outcome: Outcome | { kind: 'aborted' };
  data?: T;
  error?: unknown;
}

/**
 * Send `p` with its own key and body; retry an unknown outcome after each of `retryDelays` (never a
 * 4xx), then stop. `onChange` sees every state (sending, unknown, …) for the UI. Call it again with
 * the returned write for a manual retry.
 */
export async function runPendingWrite<T>(p: PendingWrite, send: SendFn<T>, deps: RunDeps, onChange?: (p: PendingWrite | null) => void): Promise<RunResult<T>> {
  const delays = deps.retryDelays ?? RETRY_DELAYS;
  const slot = slotOf(p.operation, p.transactionId);
  let cur = p;
  const aborted = () => deps.signal?.aborted === true;
  for (let attempt = 0; ; attempt++) {
    if (aborted()) return { pending: null, outcome: { kind: 'aborted' } };
    cur = markSending(cur, deps.now());
    onChange?.(cur);
    try {
      const res = await send(cur.key, cur.body);
      const outcome: Outcome = { kind: 'success', status: res.status, replayed: res.replayed };
      syncPendingWrite(deps.storage, cur.userId, slot, null);
      if (aborted()) return { pending: null, outcome: { kind: 'aborted' } };
      onChange?.(null);
      return { pending: null, outcome, data: res.data };
    } catch (e) {
      const outcome = outcomeOfError(e);
      const next = settle(cur, outcome, deps.now());
      if (aborted()) {
        // Cancelled: never store "unknown" again (abandoned / signed out); a definitive answer still clears.
        if (next?.state !== 'unknown') syncPendingWrite(deps.storage, cur.userId, slot, next);
        return { pending: null, outcome: { kind: 'aborted' } };
      }
      syncPendingWrite(deps.storage, cur.userId, slot, next);
      onChange?.(next);
      if (!next || outcome.kind !== 'unknown' || attempt >= delays.length) return { pending: next, outcome, error: e };
      cur = next;
      await deps.sleep(delays[attempt]!);
    }
  }
}
