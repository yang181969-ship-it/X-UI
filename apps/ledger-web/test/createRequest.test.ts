import { IDEMPOTENCY_KEY_HEADER, transactionCreateSchema } from '@xui/ledger-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.ts';
import { createTransaction } from '../src/api/transactions.ts';
import { outcomeOfError, preparePendingWrite, runPendingWrite, type StorageLike } from '../src/lib/pendingWrite.ts';

/**
 * The boundary between the pending write and the real request (M3-B4-C): what createTransaction
 * puts on the wire for a key and a parsed body, how answers come back, and a whole retry sequence
 * through the real client with fetch replaced.
 */

const body = transactionCreateSchema.parse({
  type: 'merchant_spend',
  occurredOn: '2026-10-20',
  eventCurrency: 'USD',
  eventAmount: 1000,
  merchantName: 'Contoso Cafe',
  merchantCountry: 'US',
  entries: [{ direction: 'out', accountId: 'acc-hk', currency: 'HKD', amountStatus: 'confirmed', amount: 7830 }],
});
const KEY = '0f8fad5b-d9cb-469f-a165-70867728950e';
const result = { operation: 'transaction.create', transactionId: 'txn-1', revision: 1 };

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
function stubFetch(answers: (() => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: String(init.body) });
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    return next();
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}
const json = (status: number, data: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const networkDown = () => () => Promise.reject(new TypeError('Failed to fetch'));

afterEach(() => vi.unstubAllGlobals());

class MemoryStorage implements StorageLike {
  map = new Map<string, string>();
  getItem = (k: string) => this.map.get(k) ?? null;
  setItem = (k: string, v: string) => void this.map.set(k, v);
  removeItem = (k: string) => void this.map.delete(k);
  key = (i: number) => [...this.map.keys()][i] ?? null;
  get length() {
    return this.map.size;
  }
}

describe('createTransaction (POST /api/transactions)', () => {
  it('sends the Idempotency-Key header, the CSRF header and exactly the parsed body', async () => {
    const calls = stubFetch([json(201, result)]);
    const r = await createTransaction(KEY, body);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/transactions');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers[IDEMPOTENCY_KEY_HEADER]).toBe(KEY);
    expect(calls[0]!.headers['x-xui-csrf']).toBe('1');
    expect(calls[0]!.body).toBe(JSON.stringify(body));
    expect(r).toEqual({ data: result, status: 201, replayed: false });
  });

  it('reads Idempotency-Replayed: true', async () => {
    stubFetch([json(201, result, { 'Idempotency-Replayed': 'true' })]);
    expect((await createTransaction(KEY, body)).replayed).toBe(true);
  });

  it('a definitive 4xx is an ApiError with its code and details; no answer / 5xx / timeout are unknown', async () => {
    stubFetch([json(409, { error: 'x', code: 'IDEMPOTENCY_CONFLICT', details: { operation: 'transaction.create', transactionId: 'txn-0' } })]);
    const conflict = await createTransaction(KEY, body).catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(ApiError);
    expect(conflict).toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT', details: { transactionId: 'txn-0' } });
    expect(outcomeOfError(conflict).kind).toBe('definitive');

    stubFetch([json(500, { error: 'internal error', code: 'INTERNAL' })]);
    expect(outcomeOfError(await createTransaction(KEY, body).catch((e: unknown) => e)).kind).toBe('unknown');
    stubFetch([networkDown()]);
    const down = await createTransaction(KEY, body).catch((e: unknown) => e);
    expect(down).toMatchObject({ status: 0, code: 'NETWORK' });
    expect(outcomeOfError(down).kind).toBe('unknown');
    stubFetch([() => Promise.reject(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }))]);
    const slow = await createTransaction(KEY, body).catch((e: unknown) => e);
    expect(slow).toMatchObject({ status: 0, code: 'TIMEOUT' });
    expect(outcomeOfError(slow).kind).toBe('unknown');
  });
});

describe('a pending create through the real client', () => {
  const deps = (storage: StorageLike) => ({ now: () => 1, sleep: async () => {}, storage });
  const prepared = () => {
    const r = preparePendingWrite(null, { userId: 'u1', operation: 'transaction.create', transactionId: null, body }, { now: () => 1, uuid: () => KEY });
    if (!r.ok) throw new Error('locked');
    return r.pending;
  };

  it('a lost response is retried with the same key and the same bytes; the replay ends it', async () => {
    const calls = stubFetch([networkDown(), json(201, result, { 'Idempotency-Replayed': 'true' })]);
    const storage = new MemoryStorage();
    const r = await runPendingWrite(prepared(), createTransaction, deps(storage));
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.headers[IDEMPOTENCY_KEY_HEADER])).toEqual([KEY, KEY]);
    expect(calls[1]!.body).toBe(calls[0]!.body);
    expect(r.outcome).toEqual({ kind: 'success', status: 201, replayed: true });
    expect(r.data).toEqual(result);
    expect(storage.length).toBe(0);
  });

  it('three unknown outcomes leave it stored for a manual retry; a 4xx stops at once', async () => {
    const calls = stubFetch([json(503, {}), networkDown(), json(502, {})]);
    const storage = new MemoryStorage();
    const r = await runPendingWrite(prepared(), createTransaction, deps(storage));
    expect(calls).toHaveLength(3);
    expect(r.pending?.state).toBe('unknown');
    expect(storage.length).toBe(1);

    const again = stubFetch([json(400, { error: 'x', code: 'CONFIRMED_DOMESTIC' })]);
    const r2 = await runPendingWrite(r.pending!, createTransaction, deps(storage));
    expect(again).toHaveLength(1);
    expect(again[0]!.headers[IDEMPOTENCY_KEY_HEADER]).toBe(KEY);
    expect(r2.pending?.state).toBe('failed');
    expect(storage.length).toBe(0);
  });
});
