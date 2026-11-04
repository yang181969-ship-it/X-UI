import { createClient } from '@libsql/client';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, openV1Db } from '../src/db/client.ts';
import { DbIdentityError, MIGRATIONS_TABLE, writeIdentity } from '../src/db/identity.ts';
import { withDbDir } from './helpers.ts';

// DB-M3-2: a database created by M2 (migrations 0000 + 0001) gets only 0002 on its next start, keeps
// its data and every M1 / M2 object byte for byte, and later starts apply nothing. 0000 and 0001
// stay byte-identical to what M1 / M2 shipped; 0002 only creates the four M3 tables, their indexes
// and the 21 triggers.
const M3_TABLES = ['ledger_idempotency_keys', 'transaction_entries', 'transaction_events', 'transactions'];
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const journal = () => JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };

/** sqlite_master objects other than the M3 ones (and SQLite's own), by type and name. */
async function preM3Objects(c: ReturnType<typeof createClient>) {
  const r = await c.execute("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
  return r.rows.filter((row) => !M3_TABLES.includes(String(row.tbl_name))).map((row) => [String(row.type), String(row.name), String(row.tbl_name), String(row.sql)]);
}

describe('migration 0002 (DB-M3-2)', () => {
  it('0000 and 0001 (and their snapshots) are byte-identical to the M1 / M2 releases', () => {
    // Pinned at commit 60f9ddf (M3-Freeze); any change to a shipped migration must fail here.
    expect(sha256(join(MIGRATIONS_DIR, '0000_init.sql'))).toBe('4a58f149c67fcc1633042914a7b9e06b3385f90f8a3edb7fb9afad88dfdc9233');
    expect(sha256(join(MIGRATIONS_DIR, '0001_m2_accounts.sql'))).toBe('ec381f1375c3976c9ddac9c9c5f04ebce193da662bf98a6230112457a72e07e7');
    expect(sha256(join(MIGRATIONS_DIR, 'meta/0000_snapshot.json'))).toBe('809e8409de79a373e3b87c7188b4eb8f6d32e3a98bfe1d1389cdf7da13f6fee4');
    expect(sha256(join(MIGRATIONS_DIR, 'meta/0001_snapshot.json'))).toBe('a64b0187eb0e40b48890a9621032e0e5dea61a30a19aaab4f9546227c537c19d');
    expect(journal().entries.map((e) => e.tag)).toEqual(['0000_init', '0001_m2_accounts', '0002_m3_transactions']);
  });

  it('only creates the four M3 tables, their indexes and triggers (every statement a CREATE on an M3 table)', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0002_m3_transactions.sql'), 'utf8');
    expect([...sql.matchAll(/CREATE TABLE `(\w+)`/g)].map((m) => m[1]).sort()).toEqual(M3_TABLES);
    for (const m of sql.matchAll(/CREATE (?:UNIQUE )?INDEX `\w+` ON `(\w+)`/g)) expect(M3_TABLES).toContain(m[1]);
    const triggers = [...sql.matchAll(/CREATE TRIGGER `(\w+)` [^\n]*? ON `(\w+)`/g)];
    expect(triggers).toHaveLength(21);
    for (const m of triggers) expect(M3_TABLES).toContain(m[2]);
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean);
    // Every statement is a CREATE: no ALTER, DROP, INSERT, UPDATE or DELETE — in particular no table
    // rebuild (DATA_MODEL §10.11: DROP TABLE would bypass the delete guards).
    for (const s of statements) expect(s).toMatch(/^CREATE (TABLE|UNIQUE INDEX|INDEX|TRIGGER) `/);
    expect(statements).toHaveLength(4 + 16 + 21);
    // drizzle-kit's partial-index quirk is fixed by hand (as the header comment says).
    expect(statements.join('\n')).not.toMatch(/"transaction_entries"\."/);
    expect(statements.join('\n')).toContain("WHERE `txn_type` <> 'own_transfer'");
  });

  it('an M2 database gets only 0002: data and every M1 / M2 object unchanged; foreign_key_check empty; later starts apply nothing', () =>
    withDbDir('xui-m3-upgrade-', async (dir, track) => {
      // An M2-only migrations folder: 0000 + 0001 and a journal that ends there.
      const m2 = join(dir, 'm2-migrations');
      mkdirSync(join(m2, 'meta'), { recursive: true });
      const j = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as { entries: unknown[] };
      writeFileSync(join(m2, 'meta/_journal.json'), JSON.stringify({ ...j, entries: j.entries.slice(0, 2) }));
      for (const f of ['0000_init.sql', '0001_m2_accounts.sql']) copyFileSync(join(MIGRATIONS_DIR, f), join(m2, f));

      const url = `file:${join(dir, 'x-ui-v1.db')}`;
      const raw = track(createClient({ url }));
      await raw.execute('PRAGMA foreign_keys = ON');
      await writeIdentity(raw, 1);
      await migrate(drizzle(raw), { migrationsFolder: m2, migrationsTable: MIGRATIONS_TABLE });
      // M2 data of one user.
      for (const s of [
        "INSERT INTO users (id, username, display_name, role, status, webauthn_user_id, created_at, updated_at) VALUES ('u1', 'owner', 'Owner', 'admin', 'active', 'wa', 1, 1)",
        "INSERT INTO user_preferences (user_id, home_region, created_at, updated_at) VALUES ('u1', 'HK', 1, 1)",
        "INSERT INTO institutions (id, user_id, name, name_key, institution_type, created_at, updated_at) VALUES ('i1', 'u1', 'Wise', 'wise', 'emi', 1, 1)",
        "INSERT INTO accounts (id, user_id, institution_id, name, name_key, account_type, account_country, created_at, updated_at) VALUES ('a1', 'u1', 'i1', 'W', 'w', 'e_money', 'BE', 1, 1)",
        "INSERT INTO account_currencies (account_id, user_id, currency, is_default, created_at) VALUES ('a1', 'u1', 'USD', 1, 1)",
        "INSERT INTO cards (id, user_id, issuer_institution_id, name, network, card_type, last4, issuing_country, created_at, updated_at) VALUES ('k1', 'u1', 'i1', 'K', 'visa', 'debit', '1234', 'BE', 1, 1)",
      ]) await raw.execute(s);
      const objectsBefore = await preM3Objects(raw);
      const rowsBefore = (await raw.execute('SELECT * FROM accounts')).rows.map((r) => ({ ...r }));
      for (const t of M3_TABLES) expect(objectsBefore.some(([, n]) => n === t)).toBe(false);
      raw.close();

      const first = await openV1Db(url, { legacyPaths: [] });
      track(first.client);
      expect(first.identity).toBe('v1');
      expect(first.applied).toBe(1);
      const c = first.client;
      expect(await preM3Objects(c)).toEqual(objectsBefore);
      expect((await c.execute('SELECT * FROM accounts')).rows.map((r) => ({ ...r }))).toEqual(rowsBefore);
      const names = (await c.execute("SELECT type, name FROM sqlite_master WHERE tbl_name IN ('transactions', 'transaction_events', 'transaction_entries', 'ledger_idempotency_keys')")).rows;
      expect(names.filter((r) => r.type === 'table').map((r) => String(r.name)).sort()).toEqual(M3_TABLES);
      expect(names.filter((r) => r.type === 'trigger')).toHaveLength(21);
      expect(names.filter((r) => r.type === 'index' && !String(r.name).startsWith('sqlite_autoindex'))).toHaveLength(16);
      expect((await c.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
      expect(Number((await c.execute('PRAGMA foreign_keys')).rows[0]![0])).toBe(1);
      // The ledger works for the M2 user right away (the constraints themselves: m3-schema.test.ts).
      await c.execute("INSERT INTO transactions (id, user_id, txn_type, created_at, updated_at) VALUES ('t1', 'u1', 'merchant_spend', 2, 2)");
      first.client.close();

      const again = await openV1Db(url, { legacyPaths: [] });
      track(again.client);
      expect(again.applied).toBe(0);
      expect(Number((await again.client.execute(`SELECT count(*) AS n FROM ${MIGRATIONS_TABLE}`)).rows[0]!.n)).toBe(3);
      expect(await preM3Objects(again.client)).toEqual(objectsBefore);
    }));

  it('a fresh database gets the whole chain in one start; identity guards still refuse unmarked or legacy databases', () =>
    withDbDir('xui-m3-fresh-', async (dir, track) => {
      const fresh = await openV1Db(`file:${join(dir, 'x-ui-v1.db')}`, { legacyPaths: [] });
      track(fresh.client);
      expect(fresh.identity).toBe('empty');
      expect(fresh.applied).toBe(3);
      const legacyUrl = `file:${join(dir, 'legacy.db')}`;
      const legacy = track(createClient({ url: legacyUrl }));
      await legacy.execute('CREATE TABLE transaction_tags (id text)');
      legacy.close();
      await expect(openV1Db(legacyUrl, { legacyPaths: [] })).rejects.toBeInstanceOf(DbIdentityError);
      await expect(openV1Db(`file:${join(dir, 'z-ui.db')}`, { legacyPaths: [] })).rejects.toThrow(/legacy Z-UI database file name/);
    }));
});
