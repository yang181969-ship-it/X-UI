import { canonicalRequestV1, isIdempotencyKey, transactionCreateSchema } from '@xui/ledger-shared';
import { describe, expect, it, vi } from 'vitest';
import {
  abandonPendingWrite,
  clearAllPendingWrites,
  defaultUuid,
  isLocked,
  listPendingWrites,
  loadPendingWrite,
  markSending,
  markUnloading,
  outcomeOfError,
  preparePendingWrite,
  RETRY_DELAYS,
  runPendingWrite,
  settle,
  slotOf,
  STORAGE_PREFIX,
  syncPendingWrite,
  type PendingWrite,
  type SendFn,
  type StorageLike,
  type WriteInput,
} from '../src/lib/pendingWrite.ts';

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  get length() {
    return this.map.size;
  }
}

/** An ApiError-like failure (status 0 = no answer). */
const apiError = (status: number, code?: string) => Object.assign(new Error(code ?? 'error'), { status, code });

// A parsed create body (the shared schema fills the defaults), entries in direction order.
const parsedCreate = (amount = 7830) =>
  transactionCreateSchema.parse({
    type: 'own_transfer',
    occurredOn: '2026-10-20',
    eventCurrency: 'HKD',
    eventAmount: 100000,
    entries: [
      { direction: 'out', accountId: 'acc-a', currency: 'HKD', amountStatus: 'confirmed', amount: 100000 },
      { direction: 'in', accountId: 'acc-b', currency: 'USD', amountStatus: 'confirmed', amount },
    ],
  });

const input = (body: unknown = parsedCreate(), over: Partial<WriteInput> = {}): WriteInput => ({ userId: 'user-1', operation: 'transaction.create', transactionId: null, body, ...over });

let n = 0;
const deps = () => ({ now: () => 1_000 + n, uuid: vi.fn(() => `key-${String(++n).padStart(16, '0')}`) });

function prepared(body: unknown = parsedCreate(), over: Partial<WriteInput> = {}): PendingWrite {
  const r = preparePendingWrite(null, input(body, over), deps());
  if (!r.ok) throw new Error('unexpected lock');
  return r.pending;
}

describe('idempotency key generation', () => {
  it('uses crypto.randomUUID keys in the API format, a new one each time', () => {
    const a = defaultUuid();
    const b = defaultUuid();
    expect(isIdempotencyKey(a)).toBe(true);
    expect(isIdempotencyKey(b)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('generates the key on the first submit only (prepare), once', () => {
    const d = deps();
    const r = preparePendingWrite(null, input(), d);
    expect(r.ok).toBe(true);
    expect(d.uuid).toHaveBeenCalledTimes(1);
    if (r.ok) {
      expect(r.reused).toBe(false);
      expect(r.pending.state).toBe('ready');
      expect(r.pending.attempts).toBe(0);
      expect(isIdempotencyKey(r.pending.key)).toBe(true);
    }
  });

  it('refuses a generator whose key the API would reject', () => {
    expect(() => preparePendingWrite(null, input(), { now: () => 0, uuid: () => 'short' })).toThrow(RangeError);
    expect(() => preparePendingWrite(null, input(), { now: () => 0, uuid: () => 'has.a.dot.in.it.0123' })).toThrow(RangeError);
  });

  it('two forms never share a key', () => {
    expect(prepared().key).not.toBe(prepared().key);
  });
});

describe('canonicalRequestV1 comparison', () => {
  it('key order and entry order do not change the request; any value does', () => {
    const body = parsedCreate();
    const shuffled = { ...Object.fromEntries(Object.entries(body).reverse()), entries: [...body.entries].reverse() };
    expect(canonicalRequestV1('transaction.create', null, shuffled)).toBe(canonicalRequestV1('transaction.create', null, body));
    expect(canonicalRequestV1('transaction.create', null, parsedCreate(7831))).not.toBe(canonicalRequestV1('transaction.create', null, body));
  });

  it('the same parsed request reuses the key and the ORIGINAL body object', () => {
    const first = prepared();
    const body = parsedCreate();
    const shuffled = { ...Object.fromEntries(Object.entries(body).reverse()), entries: [...body.entries].reverse() };
    const d = deps();
    const again = preparePendingWrite({ ...first, state: 'failed' }, input(shuffled), d);
    expect(again.ok && again.reused).toBe(true);
    expect(d.uuid).not.toHaveBeenCalled();
    if (again.ok) {
      expect(again.pending.key).toBe(first.key);
      expect(again.pending.body).toBe(first.body);
    }
  });

  it('a value change gets a new key when nothing is unknown', () => {
    const first = prepared();
    for (const state of ['ready', 'failed'] as const) {
      const r = preparePendingWrite({ ...first, state }, input(parsedCreate(9999)), deps());
      expect(r.ok && !r.reused).toBe(true);
      if (r.ok) expect(r.pending.key).not.toBe(first.key);
    }
  });

  it('another user, operation or transaction never inherits the key', () => {
    const first = prepared();
    for (const over of [{ userId: 'user-2' }, { operation: 'transaction.void' as const, transactionId: 'txn-1' }]) {
      const r = preparePendingWrite(first, input(first.body, over), deps());
      expect(r.ok && !r.reused).toBe(true);
    }
    const voidA = prepared({ baseRevision: 1, reason: null }, { operation: 'transaction.void', transactionId: 'txn-a' });
    const voidB = preparePendingWrite(voidA, input({ baseRevision: 1, reason: null }, { operation: 'transaction.void', transactionId: 'txn-b' }), deps());
    expect(voidB.ok && !voidB.reused).toBe(true);
  });
});

describe('locking', () => {
  it('an unknown outcome locks the content: only the original request may be retried', () => {
    const unknown = { ...prepared(), state: 'unknown' as const };
    expect(isLocked(unknown)).toBe(true);
    const changed = preparePendingWrite(unknown, input(parsedCreate(1)), deps());
    expect(changed).toMatchObject({ ok: false, reason: 'unknown_outcome' });
    const same = preparePendingWrite(unknown, input(parsedCreate()), deps());
    expect(same.ok && same.reused && same.pending.key === unknown.key).toBe(true);
  });

  it('a request in flight refuses any second submit', () => {
    const sending = markSending(prepared(), 5);
    expect(isLocked(sending)).toBe(true);
    expect(preparePendingWrite(sending, input(parsedCreate()), deps())).toMatchObject({ ok: false, reason: 'in_flight' });
  });

  it('ready and failed writes do not lock; nothing pending does not lock', () => {
    expect(isLocked(prepared())).toBe(false);
    expect(isLocked({ ...prepared(), state: 'failed' })).toBe(false);
    expect(isLocked(null)).toBe(false);
  });
});

describe('outcomes', () => {
  it('classifies answers: no answer and 5xx are unknown, every 4xx is definitive', () => {
    expect(outcomeOfError(apiError(0, 'NETWORK')).kind).toBe('unknown');
    expect(outcomeOfError(apiError(500, 'INTERNAL')).kind).toBe('unknown');
    expect(outcomeOfError(apiError(502)).kind).toBe('unknown');
    expect(outcomeOfError(apiError(503)).kind).toBe('unknown');
    expect(outcomeOfError(new TypeError('Failed to fetch')).kind).toBe('unknown');
    expect(outcomeOfError(undefined).kind).toBe('unknown');
    for (const [status, code] of [
      [400, 'VALIDATION'],
      [400, 'ENTRY_SHAPE'],
      [400, 'CONFIRMED_DOMESTIC'],
      [401, 'UNAUTHENTICATED'],
      [403, 'CSRF'],
      [404, 'NOT_FOUND'],
      [409, 'REVISION_CONFLICT'],
      [409, 'TRANSACTION_VOIDED'],
      [409, 'CONCURRENT_CHANGE'],
      [409, 'IDEMPOTENCY_CONFLICT'],
    ] as const) {
      expect(outcomeOfError(apiError(status, code))).toEqual({ kind: 'definitive', status, code });
    }
  });

  it('settle: success clears; a burned key clears; definitive fails; unknown stays unknown', () => {
    const p = markSending(prepared(), 10);
    expect(settle(p, { kind: 'success', status: 201, replayed: false }, 11)).toBeNull();
    expect(settle(p, { kind: 'definitive', status: 409, code: 'IDEMPOTENCY_CONFLICT' }, 11)).toBeNull();
    expect(settle(p, { kind: 'definitive', status: 400, code: 'VALIDATION' }, 11)).toMatchObject({ state: 'failed', key: p.key, last: { status: 400, code: 'VALIDATION' } });
    expect(settle(p, { kind: 'unknown', status: 0, code: 'NETWORK' }, 11)).toMatchObject({ state: 'unknown', key: p.key, last: { status: 0, code: 'NETWORK' } });
  });

  it('a burned key is never reused, even for the same content', () => {
    const p = prepared();
    const after = settle(markSending(p, 1), outcomeOfError(apiError(409, 'IDEMPOTENCY_CONFLICT')), 2);
    const r = preparePendingWrite(after, input(p.body), deps());
    expect(r.ok && !r.reused && r.pending.key !== p.key).toBe(true);
  });

  it('markSending counts attempts; markUnloading turns an in-flight request into an unknown one', () => {
    const s = markSending(markSending(prepared(), 1), 2);
    expect(s.attempts).toBe(2);
    expect(markUnloading(s, 3).state).toBe('unknown');
    const failed = { ...prepared(), state: 'failed' as const };
    expect(markUnloading(failed, 3)).toBe(failed);
  });
});

describe('sessionStorage (unknown outcomes only)', () => {
  const slot = slotOf('transaction.create', null);

  it('stores only an unknown write; failed / success / abandon remove it; sending leaves it as it is', () => {
    const s = new MemoryStorage();
    const p = prepared();
    syncPendingWrite(s, 'user-1', slot, p);
    expect(s.length).toBe(0);
    syncPendingWrite(s, 'user-1', slot, { ...p, state: 'failed' });
    expect(s.length).toBe(0);
    const unknown = { ...p, state: 'unknown' as const, attempts: 1 };
    syncPendingWrite(s, 'user-1', slot, unknown);
    expect(s.length).toBe(1);
    syncPendingWrite(s, 'user-1', slot, markSending(unknown, 9));
    expect(s.length).toBe(1);
    syncPendingWrite(s, 'user-1', slot, null);
    expect(s.length).toBe(0);
    syncPendingWrite(s, 'user-1', slot, unknown);
    expect(abandonPendingWrite(s, 'user-1', slot)).toBeNull();
    expect(s.length).toBe(0);
  });

  it('restores the exact key and body after a reload, and the re-parsed request reuses them', () => {
    const s = new MemoryStorage();
    const p = { ...markSending(prepared(), 1), state: 'unknown' as const };
    syncPendingWrite(s, 'user-1', slot, p);
    const restored = loadPendingWrite(s, 'user-1', slot);
    expect(restored).toEqual(p);
    // A new page parses the same form again: equal content, not the same object.
    const r = preparePendingWrite(restored, input(parsedCreate()), deps());
    expect(r.ok && r.reused && r.pending.key === p.key).toBe(true);
    expect(preparePendingWrite(restored, input(parsedCreate(5)), deps())).toMatchObject({ ok: false, reason: 'unknown_outcome' });
  });

  it('isolates users: another user never reads or lists the write', () => {
    const s = new MemoryStorage();
    const a = { ...prepared(), state: 'unknown' as const };
    const b = { ...prepared(parsedCreate(), { userId: 'user-2' }), state: 'unknown' as const };
    syncPendingWrite(s, 'user-1', slot, a);
    syncPendingWrite(s, 'user-2', slot, b);
    expect(loadPendingWrite(s, 'user-1', slot)?.key).toBe(a.key);
    expect(loadPendingWrite(s, 'user-2', slot)?.key).toBe(b.key);
    expect(listPendingWrites(s, 'user-1').map((p) => p.key)).toEqual([a.key]);
    expect(listPendingWrites(s, 'user-3')).toEqual([]);
    // A record copied under another user's slot is not that user's.
    s.setItem(`${STORAGE_PREFIX}user-3:${slot}`, JSON.stringify(a));
    expect(loadPendingWrite(s, 'user-3', slot)).toBeNull();
    expect(s.getItem(`${STORAGE_PREFIX}user-3:${slot}`)).toBeNull();
  });

  it('drops malformed, tampered or non-unknown records', () => {
    const s = new MemoryStorage();
    const p = { ...prepared(), state: 'unknown' as const };
    const k = `${STORAGE_PREFIX}user-1:${slot}`;
    for (const raw of ['{not json', JSON.stringify({ ...p, body: parsedCreate(1) }), JSON.stringify({ ...p, state: 'failed' }), JSON.stringify({ ...p, key: 'bad key' }), JSON.stringify({ ...p, v: 2 }), JSON.stringify({ ...p, transactionId: 'x' })]) {
      s.setItem(k, raw);
      expect(loadPendingWrite(s, 'user-1', slot)).toBeNull();
      expect(s.getItem(k)).toBeNull();
    }
  });

  it('sign-out clears every pending write of every user, and nothing else', () => {
    const s = new MemoryStorage();
    syncPendingWrite(s, 'user-1', slot, { ...prepared(), state: 'unknown' });
    syncPendingWrite(s, 'user-2', slotOf('transaction.void', 't1'), { ...prepared({ baseRevision: 1, reason: null }, { userId: 'user-2', operation: 'transaction.void', transactionId: 't1' }), state: 'unknown' });
    s.setItem('xui-v1-lang', 'zh-CN');
    clearAllPendingWrites(s);
    expect([...s.map.keys()]).toEqual(['xui-v1-lang']);
  });

  it('works without storage (blocked or private mode)', () => {
    const p = { ...prepared(), state: 'unknown' as const };
    expect(() => syncPendingWrite(null, 'user-1', slot, p)).not.toThrow();
    expect(loadPendingWrite(null, 'user-1', slot)).toBeNull();
    expect(listPendingWrites(null, 'user-1')).toEqual([]);
    expect(() => clearAllPendingWrites(null)).not.toThrow();
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
      key: () => null,
      length: 0,
    };
    expect(() => syncPendingWrite(throwing, 'user-1', slot, p)).not.toThrow();
    expect(loadPendingWrite(throwing, 'user-1', slot)).toBeNull();
  });
});

describe('runPendingWrite (automatic retries, Q8)', () => {
  const setup = () => {
    const storage = new MemoryStorage();
    const sleeps: number[] = [];
    const runDeps = { now: () => 50, sleep: async (ms: number) => void sleeps.push(ms), storage };
    const states: (string | null)[] = [];
    const onChange = (p: PendingWrite | null) => states.push(p?.state ?? null);
    return { storage, sleeps, runDeps, states, onChange };
  };
  const ok = { data: { transactionId: 't1' }, status: 201, replayed: false };

  it('the retry delays are 1 s then 3 s', () => {
    expect(RETRY_DELAYS).toEqual([1000, 3000]);
  });

  it('success on the first try: one request, nothing stored', async () => {
    const { storage, sleeps, runDeps, states, onChange } = setup();
    const p = prepared();
    const send = vi.fn<SendFn<typeof ok.data>>(async () => ok);
    const r = await runPendingWrite(p, send, runDeps, onChange);
    expect(r).toMatchObject({ pending: null, outcome: { kind: 'success', status: 201, replayed: false }, data: ok.data });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(p.key, p.body);
    expect(sleeps).toEqual([]);
    expect(storage.length).toBe(0);
    expect(states).toEqual(['sending', null]);
  });

  it('passes a replay through (Idempotency-Replayed)', async () => {
    const { runDeps } = setup();
    const r = await runPendingWrite(prepared(), async () => ({ ...ok, replayed: true }), runDeps);
    expect(r.outcome).toEqual({ kind: 'success', status: 201, replayed: true });
  });

  it('an unknown outcome is retried twice (1 s, 3 s) with the same key and body object, then left for a manual retry', async () => {
    const { storage, sleeps, runDeps, states, onChange } = setup();
    const p = prepared();
    const send = vi.fn<SendFn<unknown>>(async () => {
      throw apiError(0, 'NETWORK');
    });
    const r = await runPendingWrite(p, send, runDeps, onChange);
    expect(send).toHaveBeenCalledTimes(3);
    for (const call of send.mock.calls) {
      expect(call[0]).toBe(p.key);
      expect(call[1]).toBe(p.body);
    }
    expect(sleeps).toEqual([1000, 3000]);
    expect(r.outcome.kind).toBe('unknown');
    expect(r.pending).toMatchObject({ state: 'unknown', key: p.key, attempts: 3 });
    expect(loadPendingWrite(storage, 'user-1', slotOf('transaction.create', null))?.key).toBe(p.key);
    expect(states).toEqual(['sending', 'unknown', 'sending', 'unknown', 'sending', 'unknown']);

    // Manual recovery: the same write again (same key); a replay clears it.
    const again = await runPendingWrite(r.pending!, async (key) => ({ data: { key }, status: 201, replayed: true }), runDeps);
    expect(again.data).toEqual({ key: p.key });
    expect(again.pending).toBeNull();
    expect(storage.length).toBe(0);
  });

  it('5xx then success: two requests, cleared', async () => {
    const { storage, sleeps, runDeps } = setup();
    const send = vi.fn<SendFn<typeof ok.data>>().mockRejectedValueOnce(apiError(500, 'INTERNAL')).mockResolvedValueOnce(ok);
    const r = await runPendingWrite(prepared(), send, runDeps);
    expect(send).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1000]);
    expect(r.pending).toBeNull();
    expect(storage.length).toBe(0);
  });

  it('a 4xx is never retried and never stored', async () => {
    for (const [status, code] of [
      [400, 'VALIDATION'],
      [404, 'NOT_FOUND'],
      [409, 'REVISION_CONFLICT'],
      [409, 'CONCURRENT_CHANGE'],
    ] as const) {
      const { storage, sleeps, runDeps } = setup();
      const p = prepared();
      const send = vi.fn<SendFn<unknown>>(async () => {
        throw apiError(status, code);
      });
      const r = await runPendingWrite(p, send, runDeps);
      expect(send).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
      expect(r.pending).toMatchObject({ state: 'failed', key: p.key });
      expect(storage.length).toBe(0);
    }
  });

  it('an unknown outcome followed by a definitive answer clears storage', async () => {
    const { storage, runDeps } = setup();
    const send = vi.fn<SendFn<unknown>>().mockRejectedValueOnce(apiError(503)).mockRejectedValueOnce(apiError(409, 'REVISION_CONFLICT'));
    const r = await runPendingWrite(prepared(), send, runDeps);
    expect(send).toHaveBeenCalledTimes(2);
    expect(r.pending?.state).toBe('failed');
    expect(storage.length).toBe(0);
  });

  it('cancelled during the backoff (abandoned, page gone, signed out): nothing more is sent, reported or stored', async () => {
    const { storage, runDeps } = setup();
    const signal = { aborted: false };
    const states: (string | null)[] = [];
    const send = vi.fn<SendFn<unknown>>(async () => {
      throw apiError(0, 'NETWORK');
    });
    // The user abandons while the run waits for its first retry; abandoning clears storage.
    const sleep = async () => {
      signal.aborted = true;
      storage.map.clear();
    };
    const r = await runPendingWrite(prepared(), send, { ...runDeps, sleep, signal }, (p) => states.push(p?.state ?? null));
    expect(send).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ pending: null, outcome: { kind: 'aborted' } });
    expect(states).toEqual(['sending', 'unknown']); // nothing after the cancel
    expect(storage.length).toBe(0);
  });

  it('cancelled while a request is in flight: an unknown answer is not stored again; a success still clears storage', async () => {
    const slot = slotOf('transaction.create', null);
    for (const answer of ['unknown', 'success'] as const) {
      const { storage, runDeps } = setup();
      const signal = { aborted: false };
      const p = prepared();
      syncPendingWrite(storage, 'user-1', slot, { ...p, state: 'unknown' }); // restored from a reload
      const states: (string | null)[] = [];
      const r = await runPendingWrite(
        p,
        async () => {
          signal.aborted = true; // the user signs out / leaves while the request is out
          if (answer === 'unknown') {
            storage.map.clear(); // sign-out cleared storage
            throw apiError(503);
          }
          return { data: {}, status: 201, replayed: true };
        },
        { ...runDeps, signal },
        (x) => states.push(x?.state ?? null),
      );
      expect(r.outcome).toEqual({ kind: 'aborted' });
      expect(states).toEqual(['sending']);
      expect(storage.length).toBe(0);
    }
  });

  it('a run cancelled before it starts sends nothing', async () => {
    const { runDeps } = setup();
    const send = vi.fn<SendFn<unknown>>();
    const r = await runPendingWrite(prepared(), send, { ...runDeps, signal: { aborted: true } });
    expect(send).not.toHaveBeenCalled();
    expect(r.outcome).toEqual({ kind: 'aborted' });
  });

  it('IDEMPOTENCY_CONFLICT discards the write', async () => {
    const { storage, runDeps } = setup();
    const r = await runPendingWrite(
      prepared(),
      async () => {
        throw apiError(409, 'IDEMPOTENCY_CONFLICT');
      },
      runDeps,
    );
    expect(r.pending).toBeNull();
    expect(r.outcome).toEqual({ kind: 'definitive', status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(storage.length).toBe(0);
  });
});
