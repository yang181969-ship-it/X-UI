import { createClient } from '@libsql/client';
import { existsSync, linkSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openLibsql as openLegacyDb } from '../../api/src/db/client.ts';
import { MIGRATIONS_DIR, openV1Db } from '../src/db/client.ts';
import {
  assertV1DbPath,
  DbIdentityError,
  IDENTITY_KEY,
  IDENTITY_VALUE,
  LEGACY_MIGRATIONS_TABLE,
  META_TABLE,
  META_TABLE_DDL,
  MIGRATIONS_TABLE,
  writeIdentity,
} from '../src/db/identity.ts';
import { defaultDbPath, legacyDbPaths, REPO_ROOT } from '../src/node.ts';
import { dirFingerprint, withDbDir } from './helpers.ts';

const url = (dir: string, name = 'x-ui-v1.db') => `file:${join(dir, name)}`;
/** Every v1 migration (0000 M1 auth, 0001 M2 accounts, …). */
const MIGRATION_COUNT = (JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as { entries: unknown[] }).entries.length;

async function tables(dir: string, name: string, track: <C extends ReturnType<typeof createClient>>(c: C) => C) {
  const c = track(createClient({ url: url(dir, name) }));
  const r = await c.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
  c.close();
  return r.rows.map((row) => String(row.name));
}

async function expectRefused(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DbIdentityError);
  expect((err as DbIdentityError).code).toBe(code);
}

describe('first start and restarts', () => {
  it('initializes a fresh database: marker first, then the v1 migrations in their own log', () =>
    withDbDir('xui-id-', async (dir, track) => {
      const first = await openV1Db(url(dir), { legacyPaths: [], now: () => 1_700_000_000_000 });
      track(first.client);
      expect(first.identity).toBe('empty');
      expect(first.applied).toBe(MIGRATION_COUNT);
      const meta = await first.client.execute(`SELECT key, value, created_at FROM ${META_TABLE}`);
      expect(meta.rows.map((r) => [r.key, r.value, Number(r.created_at)])).toEqual([[IDENTITY_KEY, IDENTITY_VALUE, 1_700_000_000_000]]);
      first.client.close();

      const names = await tables(dir, 'x-ui-v1.db', track);
      expect(names).toContain(MIGRATIONS_TABLE);
      expect(names).toContain(META_TABLE);
      expect(names).not.toContain(LEGACY_MIGRATIONS_TABLE);
      // M1 auth/settings tables plus the eight M2 and four M3 tables — nothing copied from the legacy schema.
      expect(names.filter((n) => !n.startsWith('_') && n !== META_TABLE).sort()).toEqual(
        ['audit_log', 'auth_challenges', 'login_attempts', 'passkeys', 'recovery_codes', 'sessions', 'settings', 'users']
          .concat(['user_preferences', 'institutions', 'accounts', 'account_currencies', 'cards', 'account_card_links', 'payment_channels', 'payment_channel_sources'])
          .concat(['transactions', 'transaction_events', 'transaction_entries', 'ledger_idempotency_keys'])
          .sort(),
      );
    }));

  it('does not re-run migrations on later starts and keeps the original marker', () =>
    withDbDir('xui-id-', async (dir, track) => {
      track((await openV1Db(url(dir), { legacyPaths: [], now: () => 111 })).client).close();
      for (let i = 0; i < 3; i++) {
        const again = await openV1Db(url(dir), { legacyPaths: [], now: () => 999 });
        track(again.client);
        expect(again.identity).toBe('v1');
        expect(again.applied).toBe(0);
        const log = await again.client.execute(`SELECT count(*) AS n FROM ${MIGRATIONS_TABLE}`);
        expect(Number(log.rows[0]!.n)).toBe(MIGRATION_COUNT);
        const meta = await again.client.execute(`SELECT created_at FROM ${META_TABLE}`);
        expect(meta.rows.map((r) => Number(r.created_at))).toEqual([111]);
        again.client.close();
      }
    }));

  it('resumes after a first start that stopped between the marker and the migrations', () =>
    withDbDir('xui-id-', async (dir, track) => {
      const raw = track(createClient({ url: url(dir) }));
      await writeIdentity(raw, 5);
      raw.close();
      const opened = await openV1Db(url(dir), { legacyPaths: [] });
      track(opened.client);
      expect(opened.identity).toBe('v1');
      expect(opened.applied).toBe(MIGRATION_COUNT);
    }));

  it('starts over after a first start that stopped with only an empty migration log', () =>
    withDbDir('xui-id-', async (dir, track) => {
      const raw = track(createClient({ url: url(dir) }));
      await raw.execute(`CREATE TABLE ${MIGRATIONS_TABLE} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`);
      raw.close();
      const opened = await openV1Db(url(dir), { legacyPaths: [] });
      track(opened.client);
      expect(opened.identity).toBe('empty');
      expect(opened.applied).toBe(MIGRATION_COUNT);
    }));

  it('accepts an existing zero-byte file as a fresh database', () =>
    withDbDir('xui-id-', async (dir, track) => {
      writeFileSync(join(dir, 'x-ui-v1.db'), '');
      const opened = await openV1Db(url(dir), { legacyPaths: [] });
      track(opened.client);
      expect(opened.identity).toBe('empty');
    }));
});

describe('refusing databases that are not X-UI v1', () => {
  it('refuses a legacy Z-UI database before writing anything to it', () =>
    withDbDir('xui-id-', async (dir, track) => {
      // A real legacy database, created by the legacy app's own migrations (under another name).
      const legacy = await openLegacyDb(url(dir, 'legacy.db'));
      track((legacy as unknown as { $client: ReturnType<typeof createClient> }).$client).close();
      const before = dirFingerprint(dir);
      const tablesBefore = await tables(dir, 'legacy.db', track);
      expect(tablesBefore).toContain(LEGACY_MIGRATIONS_TABLE);

      await expectRefused(openV1Db(url(dir, 'legacy.db'), { legacyPaths: [] }), 'LEGACY_DB');

      expect(dirFingerprint(dir)['legacy.db']).toBe(before['legacy.db']);
      const tablesAfter = await tables(dir, 'legacy.db', track);
      expect(tablesAfter).toEqual(tablesBefore);
      expect(tablesAfter).not.toContain(MIGRATIONS_TABLE);
      expect(tablesAfter).not.toContain(META_TABLE);
    }));

  it('refuses an unknown database with tables but no marker', () =>
    withDbDir('xui-id-', async (dir, track) => {
      const raw = track(createClient({ url: url(dir) }));
      await raw.execute('CREATE TABLE notes (id integer primary key, body text)');
      raw.close();
      const before = dirFingerprint(dir);
      await expectRefused(openV1Db(url(dir), { legacyPaths: [] }), 'FOREIGN_DB');
      expect(dirFingerprint(dir)['x-ui-v1.db']).toBe(before['x-ui-v1.db']);
    }));

  it('refuses a wrong or missing identity value', () =>
    withDbDir('xui-id-', async (dir, track) => {
      const raw = track(createClient({ url: url(dir) }));
      await raw.execute(META_TABLE_DDL);
      raw.close();
      await expectRefused(openV1Db(url(dir), { legacyPaths: [] }), 'IDENTITY_MISMATCH');

      const raw2 = track(createClient({ url: url(dir) }));
      await raw2.execute({ sql: `INSERT INTO ${META_TABLE} (key, value, created_at) VALUES (?, 'z-ui', 0)`, args: [IDENTITY_KEY] });
      raw2.close();
      await expectRefused(openV1Db(url(dir), { legacyPaths: [] }), 'IDENTITY_MISMATCH');
    }));

  it('refuses a v1 database that also carries the legacy migration log', () =>
    withDbDir('xui-id-', async (dir, track) => {
      track((await openV1Db(url(dir), { legacyPaths: [] })).client).close();
      const raw = track(createClient({ url: url(dir) }));
      await raw.execute(`CREATE TABLE ${LEGACY_MIGRATIONS_TABLE} (id integer)`);
      raw.close();
      await expectRefused(openV1Db(url(dir), { legacyPaths: [] }), 'LEGACY_DB');
    }));
});

describe('path guard (runs before any file is opened)', () => {
  it('refuses the legacy file name anywhere, without creating it', () =>
    withDbDir('xui-id-', async (dir) => {
      await expectRefused(openV1Db(url(dir, 'z-ui.db'), { legacyPaths: [] }), 'LEGACY_PATH');
      await expectRefused(openV1Db(url(dir, 'Z-UI.DB'), { legacyPaths: [] }), 'LEGACY_PATH');
      expect(existsSync(join(dir, 'z-ui.db'))).toBe(false);
    }));

  it('refuses a configured legacy path, also through a hard link', () =>
    withDbDir('xui-id-', async (dir) => {
      const legacy = join(dir, 'family.db');
      writeFileSync(legacy, 'legacy bytes');
      linkSync(legacy, join(dir, 'alias.db'));
      await expectRefused(openV1Db(url(dir, 'family.db'), { legacyPaths: [legacy] }), 'LEGACY_PATH');
      await expectRefused(openV1Db(url(dir, 'alias.db'), { legacyPaths: [legacy] }), 'LEGACY_PATH');
      expect(readFileSync(legacy, 'utf8')).toBe('legacy bytes');
    }));

  it('accepts only local file: URLs', () => {
    for (const bad of ['libsql://example.turso.io', 'http://127.0.0.1:8080', ':memory:', 'file:']) {
      expect(() => assertV1DbPath(bad, []), bad).toThrowError(DbIdentityError);
    }
  });

  it('guards the real repository paths: data/z-ui.db is refused, the v1 default is separate', () => {
    const legacyPaths = legacyDbPaths(REPO_ROOT, {});
    expect(legacyPaths).toEqual([resolve(REPO_ROOT, 'data/z-ui.db')]);
    // Pure check: throws before the legacy file is opened.
    expect(() => assertV1DbPath(`file:${resolve(REPO_ROOT, 'data/z-ui.db')}`, legacyPaths)).toThrowError(/legacy/);
    expect(defaultDbPath()).toBe(resolve(REPO_ROOT, 'data/x-ui-v1.db'));
    expect(assertV1DbPath(`file:${defaultDbPath()}`, legacyPaths)).toBe(defaultDbPath());
    // DATABASE_URL (the legacy app's variable), if exported, is treated as legacy too.
    expect(legacyDbPaths(REPO_ROOT, { DATABASE_URL: 'file:/elsewhere/family.db' })).toContain(resolve('/elsewhere/family.db'));
  });
});

describe('migration 0000', () => {
  it('re-asserts the same marker idempotently (also creates it on D1)', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0000_init.sql'), 'utf8').replace(/\r\n/g, '\n');
    expect(sql).toContain(META_TABLE_DDL);
    expect(sql).toContain(`INSERT OR IGNORE INTO \`${META_TABLE}\` (\`key\`, \`value\`, \`created_at\`) VALUES ('${IDENTITY_KEY}', '${IDENTITY_VALUE}',`);
    expect(sql).not.toMatch(/CREATE TABLE `xui_v1_meta`/);
  });
});
