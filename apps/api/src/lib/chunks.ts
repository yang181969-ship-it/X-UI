/** Cloudflare D1 rejects statements with more than 100 bound parameters. */
export const D1_MAX_PARAMS = 100;

/**
 * Workers Free: at most 50 subrequests per request, and D1 queries count against it
 * ("queries per Worker invocation"). A db.batch() is one round trip. The tests fail any API
 * request whose D1 calls + outgoing fetches exceed this.
 */
export const MAX_SUBREQUESTS = 50;

/**
 * Cloudflare D1 allows at most 100 bound parameters per statement, so multi-row inserts and
 * long IN (...) lists are split. (The test database enforces the same limit.)
 */

/** Split rows so each multi-row INSERT stays within the parameter limit. */
export function chunkRows<T extends object>(rows: T[], reserved = 0): T[][] {
  if (rows.length === 0) return [];
  const cols = Math.max(...rows.map((r) => Object.keys(r).length), 1);
  const size = Math.max(1, Math.floor((D1_MAX_PARAMS - reserved) / cols));
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** Split an id list for IN (...) lookups (leaves room for a few other parameters). */
export function chunkIds<T>(ids: T[], size = 80): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** Run an IN-list query per chunk and concatenate the results. */
export async function inChunks<T, R>(ids: T[], fn: (chunk: T[]) => Promise<R[]>, size = 80): Promise<R[]> {
  if (ids.length === 0) return [];
  const parts = await Promise.all(chunkIds(ids, size).map(fn));
  return parts.flat();
}
