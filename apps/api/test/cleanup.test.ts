// Database setup and teardown in the tests: every client gets closed and every temporary
// directory removed, also when something fails halfway — the failures are injected below.
import { createClient, type InStatement } from '@libsql/client';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'libsql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openLibsql } from '../src/db/client.ts';
import { RM_ATTEMPTS, dbClient, removeDbDir, setup, withDbDir } from './helpers.ts';

const inject = vi.hoisted(() => ({
  /** Fail execute() of the statement containing this text. */
  sql: null as string | null,
  migrate: null as Error | null,
  /** Throw from close() — after really closing the client. */
  close: null as Error | null,
  rm: null as Error | null,
  createApp: null as Error | null,
  /** Every client created, in order. */
  opened: [] as { url: string; client: import('@libsql/client').Client; closeCalls: number }[],
}));

vi.mock('@libsql/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@libsql/client')>();
  const createClient: typeof actual.createClient = (config) => {
    const real = actual.createClient(config);
    const entry = { url: config.url, client: real, closeCalls: 0 };
    inject.opened.push(entry);
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'execute') {
          return (stmt: InStatement, ...rest: unknown[]) => {
            const sql = typeof stmt === 'string' ? stmt : stmt.sql;
            if (inject.sql && sql.includes(inject.sql)) return Promise.reject(new Error(`injected failure: ${sql}`));
            return (target.execute as (...a: unknown[]) => unknown)(stmt, ...rest);
          };
        }
        if (prop === 'close') {
          return () => {
            entry.closeCalls++;
            target.close();
            if (inject.close) throw inject.close;
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  };
  return { ...actual, createClient };
});

vi.mock('drizzle-orm/libsql/migrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm/libsql/migrator')>();
  const migrate: typeof actual.migrate = async (...args) => {
    if (inject.migrate) throw inject.migrate;
    return actual.migrate(...args);
  };
  return { ...actual, migrate };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const rmSync: typeof actual.rmSync = (...args) => {
    if (inject.rm) throw inject.rm;
    return actual.rmSync(...args);
  };
  return { ...actual, default: { ...actual, rmSync }, rmSync };
});

vi.mock('../src/app.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app.ts')>();
  const createApp: typeof actual.createApp = (...args) => {
    if (inject.createApp) throw inject.createApp;
    return actual.createApp(...args);
  };
  return { ...actual, createApp };
});

afterEach(() => {
  inject.sql = inject.migrate = inject.close = inject.rm = inject.createApp = null;
  inject.opened.length = 0;
});

const lastOpened = () => inject.opened.at(-1)!;
/** Directory of a `file:` database URL. */
const dirOf = (url: string) => dirname(url.slice('file:'.length));
const newDir = () => mkdtempSync(join(tmpdir(), 'zui-cleanup-'));
const rmFailure = () => Object.assign(new Error('injected rm failure'), { code: 'EACCES' });

describe('openLibsql', () => {
  it('returns a working database whose client can be closed and removed', async () => {
    const dir = newDir();
    const db = await openLibsql(`file:${join(dir, 'test.db')}`);
    expect((await dbClient(db).execute('SELECT count(*) AS n FROM users')).rows[0]).toMatchObject({ n: 0 });
    expect(dbClient(db).closed).toBe(false);
    await removeDbDir(dir, [dbClient(db)]);
    expect(lastOpened().client.closed).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('closes its client when a PRAGMA fails', async () => {
    const dir = newDir();
    inject.sql = 'journal_mode';
    await expect(openLibsql(`file:${join(dir, 'test.db')}`)).rejects.toThrow('injected failure: PRAGMA journal_mode = WAL');
    expect(lastOpened()).toMatchObject({ closeCalls: 1 });
    expect(lastOpened().client.closed).toBe(true);
    await removeDbDir(dir); // no EPERM: nothing holds the file any more
    expect(existsSync(dir)).toBe(false);
  });

  it('closes its client when a migration fails, rethrowing the same error', async () => {
    const dir = newDir();
    const err = new Error('injected migration failure');
    inject.migrate = err;
    await expect(openLibsql(`file:${join(dir, 'test.db')}`)).rejects.toBe(err);
    expect(lastOpened().client.closed).toBe(true);
    await removeDbDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('keeps the original error when closing fails too', async () => {
    const dir = newDir();
    const err = new Error('injected migration failure');
    inject.migrate = err;
    inject.close = new Error('injected close failure');
    const thrown = await openLibsql(`file:${join(dir, 'test.db')}`).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([err, inject.close]);
    expect((thrown as AggregateError).cause).toBe(err);
    expect((thrown as AggregateError).message).toContain('injected migration failure');
    inject.close = null;
    await removeDbDir(dir);
    expect(existsSync(dir)).toBe(false);
  });
});

describe('setup()', () => {
  it('closes the database and removes its directory on cleanup', async () => {
    const t = await setup();
    const { url, client } = lastOpened();
    await t.cleanup();
    expect(client.closed).toBe(true);
    expect(existsSync(dirOf(url))).toBe(false);
  });

  it('removes its directory when the database cannot be initialized', async () => {
    const err = new Error('injected migration failure');
    inject.migrate = err;
    await expect(setup()).rejects.toBe(err);
    const { url, client } = lastOpened();
    expect(client.closed).toBe(true);
    expect(existsSync(dirOf(url))).toBe(false);
  });

  it('closes the database when a later step fails', async () => {
    const err = new Error('injected createApp failure');
    inject.createApp = err;
    await expect(setup()).rejects.toBe(err);
    const { url, client } = lastOpened();
    expect(client.closed).toBe(true);
    expect(existsSync(dirOf(url))).toBe(false);
  });

  it('reports the original error first when the cleanup fails as well', async () => {
    const err = new Error('injected migration failure');
    inject.migrate = err;
    inject.rm = rmFailure();
    const thrown = await setup().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([err, inject.rm]);
    expect((thrown as AggregateError).message).toBe('injected migration failure (cleanup failed too: injected rm failure)');
    const { url } = lastOpened();
    expect(existsSync(dirOf(url))).toBe(true);
    inject.rm = null;
    await removeDbDir(dirOf(url));
    expect(existsSync(dirOf(url))).toBe(false);
  });
});

describe('withDbDir', () => {
  it('closes clients and removes the directory when an assertion fails', async () => {
    let dir = '';
    const thrown = await withDbDir('zui-cleanup-', async (d, track) => {
      dir = d;
      const c = track(createClient({ url: `file:${join(d, 'test.db')}` }));
      await c.execute('CREATE TABLE x (a)');
      expect(1).toBe(2);
    }).catch((e: unknown) => e);
    expect((thrown as Error).message).toContain('expected 1 to be 2');
    expect(lastOpened().client.closed).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('keeps the body error when the cleanup fails as well', async () => {
    let dir = '';
    const err = new Error('body failed');
    inject.rm = rmFailure();
    const thrown = await withDbDir('zui-cleanup-', async (d) => {
      dir = d;
      throw err;
    }).catch((e: unknown) => e);
    expect((thrown as AggregateError).errors).toEqual([err, inject.rm]);
    inject.rm = null;
    await removeDbDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('accepts clients that were already closed or registered twice', async () => {
    let dir = '';
    await withDbDir('zui-cleanup-', async (d, track) => {
      dir = d;
      const c = track(createClient({ url: `file:${join(d, 'test.db')}` }));
      track(c);
      await c.execute('CREATE TABLE x (a)');
      c.close();
    });
    expect(lastOpened().closeCalls).toBe(2); // once by the body, once by the cleanup
    expect(existsSync(dir)).toBe(false);
  });

  it('still closes the other clients and removes the directory when one close fails', async () => {
    let dir = '';
    const thrown = await withDbDir('zui-cleanup-', async (d, track) => {
      dir = d;
      const a = track(createClient({ url: `file:${join(d, 'a.db')}` }));
      const b = track(createClient({ url: `file:${join(d, 'b.db')}` }));
      await a.execute('CREATE TABLE x (a)');
      await b.execute('CREATE TABLE x (a)');
      inject.close = new Error('injected close failure');
    }).catch((e: unknown) => e);
    // Each failing close is reported, and none of them stops the rest of the cleanup.
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([inject.close, inject.close]);
    expect(inject.opened.map((o) => o.client.closed)).toEqual([true, true]);
    expect(existsSync(dir)).toBe(false);
  });
});

// A statement that is still referenced keeps a closed libsql database open on Windows, so the
// directory deterministically can't be deleted — what removeDbDir does when GC can't help.
describe.runIf(process.platform === 'win32')('removeDbDir with a file that stays in use', () => {
  it('gives up after a bounded number of attempts and reports the error', async () => {
    const dir = newDir();
    const db = new Database(join(dir, 'test.db'));
    const held: { stmt: { all(): unknown[] } | null } = { stmt: db.prepare<[]>('SELECT 1') };
    held.stmt!.all();
    db.close();

    const start = Date.now();
    const thrown = (await removeDbDir(dir).catch((e: unknown) => e)) as NodeJS.ErrnoException;
    expect(['EBUSY', 'EPERM']).toContain(thrown.code);
    expect(Date.now() - start).toBeLessThan(2000); // RM_ATTEMPTS short waits, not a long sleep
    expect(RM_ATTEMPTS).toBeLessThanOrEqual(5);
    expect(existsSync(dir)).toBe(true);

    // Without --expose-gc the error says how to fix it, and still carries the original one.
    const gc = globalThis.gc;
    globalThis.gc = undefined;
    try {
      const noGc = (await removeDbDir(dir).catch((e: unknown) => e)) as Error;
      expect(noGc.message).toContain('--expose-gc');
      expect(['EBUSY', 'EPERM']).toContain((noGc.cause as NodeJS.ErrnoException).code);
    } finally {
      globalThis.gc = gc;
    }

    held.stmt = null; // releases the file once collected
    await removeDbDir(dir);
    expect(existsSync(dir)).toBe(false);
  });
});
