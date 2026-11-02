import { createClient } from '@libsql/client';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, openV1Db } from '../src/db/client.ts';
import { MIGRATIONS_TABLE, writeIdentity } from '../src/db/identity.ts';
import { withDbDir } from './helpers.ts';

// R-2: a database created by M1 (migration 0000 only) gets 0001 on its next start, keeps its
// data, and later starts apply nothing.
const M2_TABLES = ['user_preferences', 'institutions', 'accounts', 'account_currencies', 'cards', 'account_card_links', 'payment_channels', 'payment_channel_sources'];

describe('migration 0001 on an existing M1 database', () => {
  it('applies only 0001, keeps the M1 rows, and is not applied again', () =>
    withDbDir('xui-m2-upgrade-', async (dir, track) => {
      // An M1-only migrations folder: 0000 and a journal that ends there.
      const m1 = join(dir, 'm1-migrations');
      mkdirSync(join(m1, 'meta'), { recursive: true });
      const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
      expect(journal.entries.map((e) => e.tag).slice(0, 2)).toEqual(['0000_init', '0001_m2_accounts']);
      writeFileSync(join(m1, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }));
      copyFileSync(join(MIGRATIONS_DIR, '0000_init.sql'), join(m1, '0000_init.sql'));

      const url = `file:${join(dir, 'x-ui-v1.db')}`;
      const raw = track(createClient({ url }));
      await writeIdentity(raw, 1);
      await migrate(drizzle(raw), { migrationsFolder: m1, migrationsTable: MIGRATIONS_TABLE });
      await raw.execute("INSERT INTO users (id, username, display_name, role, status, webauthn_user_id, created_at, updated_at) VALUES ('m1-user', 'owner', 'Owner', 'admin', 'active', 'wa', 1, 1)");
      await raw.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('ui.example', '"kept"', 1)`);
      const tablesBefore = (await raw.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name));
      for (const t of M2_TABLES) expect(tablesBefore).not.toContain(t);
      raw.close();

      const first = await openV1Db(url, { legacyPaths: [] });
      track(first.client);
      expect(first.identity).toBe('v1');
      expect(first.applied).toBe(journal.entries.length - 1);
      const tables = (await first.client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name));
      for (const t of M2_TABLES) expect(tables).toContain(t);
      expect((await first.client.execute('SELECT id FROM users')).rows.map((r) => r.id)).toEqual(['m1-user']);
      expect((await first.client.execute('SELECT value FROM settings')).rows.map((r) => r.value)).toEqual(['"kept"']);
      // The new tables work with the M1 user right away; preferences start at the defaults.
      await first.client.execute("INSERT INTO user_preferences (user_id, created_at, updated_at) VALUES ('m1-user', 1, 1)");
      expect((await first.client.execute('SELECT home_region FROM user_preferences')).rows.map((r) => r.home_region)).toEqual(['CN']);
      await first.client.execute(
        "INSERT INTO institutions (id, user_id, name, name_key, institution_type, created_at, updated_at) VALUES ('i1', 'm1-user', 'Wise', 'wise', 'emi', 1, 1)",
      );
      first.client.close();

      const again = await openV1Db(url, { legacyPaths: [] });
      track(again.client);
      expect(again.applied).toBe(0);
      expect(Number((await again.client.execute(`SELECT count(*) AS n FROM ${MIGRATIONS_TABLE}`)).rows[0]!.n)).toBe(journal.entries.length);
      expect(Number((await again.client.execute('SELECT count(*) AS n FROM institutions')).rows[0]!.n)).toBe(1);
    }));

  it('0001 only creates the eight M2 tables (and their indexes and triggers) and never touches an M1 table', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0001_m2_accounts.sql'), 'utf8');
    const created = [...sql.matchAll(/CREATE TABLE `(\w+)`/g)].map((m) => m[1]).sort();
    expect(created).toEqual([...M2_TABLES].sort());
    for (const m of sql.matchAll(/CREATE (?:UNIQUE )?INDEX `\w+` ON `(\w+)`/g)) expect(M2_TABLES).toContain(m[1]);
    for (const m of sql.matchAll(/CREATE TRIGGER `\w+` [^\n]*? ON `(\w+)`/g)) expect(M2_TABLES).toContain(m[1]);
    // Every statement is a CREATE (no ALTER / DROP / INSERT / UPDATE / DELETE).
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean);
    expect(statements.length).toBeGreaterThan(7);
    for (const s of statements) expect(s).toMatch(/^CREATE (TABLE|UNIQUE INDEX|INDEX|TRIGGER) `/);
    // The drizzle-kit expression-index bug (a quoted `ifnull("col"` "column") must not come back.
    expect(sql).not.toMatch(/`ifnull\(/);
  });
});
