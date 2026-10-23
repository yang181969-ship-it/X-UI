import type { DB } from '../src/db/client.ts';
import { historicalRecords } from '../src/db/schema.ts';
import type { Deps } from '../src/env.ts';

/**
 * Run `other` (typically another API request) inside the request under test: after it has read
 * the record and before its first write to it — the next db.batch(), or the next UPDATE of
 * historical_records being executed. The test clock doesn't move, so both requests happen in
 * the same millisecond. Returns whether `other` ran.
 */
export async function interleave(deps: Deps, other: () => Promise<unknown>, run: () => Promise<unknown>): Promise<boolean> {
  const real = deps.db;
  let pending = true;
  const takeTurn = async () => {
    if (!pending) return;
    pending = false;
    await other();
  };
  /** An UPDATE statement that lets `other` run first when it is awaited (where/returning return it). */
  const awaitsTurn = <T extends object>(statement: T): T =>
    new Proxy(statement, {
      get(target, prop, receiver) {
        if (prop === 'then' && pending) {
          return (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) =>
            takeTurn().then(() => (target as unknown as PromiseLike<unknown>).then(ok, fail), fail);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  /** db.update(table) gives a builder whose .set() creates the statement: hook that one. */
  const hooked = <T extends object>(builder: T): T =>
    new Proxy(builder, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        return prop === 'set' && typeof v === 'function' ? (...args: unknown[]) => awaitsTurn(v.apply(target, args)) : v;
      },
    });
  deps.db = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'batch') return async (ops: Parameters<DB['batch']>[0]) => (await takeTurn(), real.batch(ops));
      if (prop === 'update') return (table: Parameters<DB['update']>[0]) => (pending && table === historicalRecords ? hooked(real.update(table)) : real.update(table));
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  try {
    await run();
  } finally {
    deps.db = real;
  }
  return !pending;
}
