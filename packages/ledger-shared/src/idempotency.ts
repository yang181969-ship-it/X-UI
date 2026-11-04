import type { IdempotentOperation } from './enums.ts';

/**
 * Idempotency keys and request hashes of the financial writes (API_SPEC §5.0.3, DATA_MODEL §10.5).
 *
 * Request hash v1 (hash_version = 1): lower-case hex SHA-256 (WebCrypto) of the UTF-8 canonical
 * JSON of { v: 1, operation, transactionId (path id or null), body (the zod-parsed request body) }:
 * object keys sorted at every level, body.entries sorted by direction (out first), no whitespace,
 * integers written as JSON integers. Key order and entry order therefore never change the hash;
 * any value does. A key row keeps its hash_version, and a retry is compared with the hasher of
 * that version (REQUEST_HASHERS), so a future v2 never turns an old retry into a conflict.
 */

// Globals of every runtime this runs in (Node ≥ 22, workerd, browsers); declared here because the
// package compiles without DOM or Node typings.
declare const crypto: { readonly subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> } };
declare const TextEncoder: new () => { encode(input: string): Uint8Array };

export const IDEMPOTENCY_KEY_MIN = 16;
export const IDEMPOTENCY_KEY_MAX = 64;
/** Same rule as the ledger_idempotency_keys_key_ck CHECK. */
export const IDEMPOTENCY_KEY_PATTERN = /^[0-9A-Za-z_-]{16,64}$/;
export const isIdempotencyKey = (key: string): boolean => IDEMPOTENCY_KEY_PATTERN.test(key);

export const REQUEST_HASH_VERSION = 1;

const DIRECTION_ORDER: Record<string, number> = { out: 0, in: 1 };

/** The exact text hashed by v1 (exported for the fixed-vector tests). */
export function canonicalRequestV1(operation: IdempotentOperation, transactionId: string | null, body: unknown): string {
  return canonicalJson({ v: 1, operation, transactionId, body: sortEntries(body) });
}

export async function requestHashV1(operation: IdempotentOperation, transactionId: string | null, body: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequestV1(operation, transactionId, body)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type RequestHasher = (operation: IdempotentOperation, transactionId: string | null, body: unknown) => Promise<string>;

/** Hashers by hash_version: a stored key is always compared with its own version. */
export const REQUEST_HASHERS: Readonly<Record<number, RequestHasher>> = Object.freeze({ 1: requestHashV1 });

/** Hash a request with the hasher of `version` (a key row's hash_version). Throws for an unknown version. */
export function requestHash(version: number, operation: IdempotentOperation, transactionId: string | null, body: unknown): Promise<string> {
  const hasher = REQUEST_HASHERS[version];
  if (!hasher) throw new RangeError(`unknown request hash version: ${version}`);
  return hasher(operation, transactionId, body);
}

/** body.entries in direction order (out first); everything else as it is. Stable for equal directions. */
function sortEntries(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.entries)) return body;
  const entries = body.entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i)
    .map(({ e }) => e);
  return { ...body, entries };
}
const rank = (e: unknown) => (isPlainObject(e) && typeof e.direction === 'string' ? (DIRECTION_ORDER[e.direction] ?? 2) : 2);

/** JSON with keys sorted at every level and no whitespace; undefined object members are dropped (as JSON.stringify does). */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new RangeError('canonical JSON has no NaN or Infinity');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
      if (!isPlainObject(value)) throw new TypeError('canonical JSON takes plain objects, arrays and primitives only');
      const keys = Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonical JSON cannot encode a ${typeof value}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
