#!/usr/bin/env node
/**
 * Export the local ledger (data/z-ui.db) as SQL for Cloudflare D1:
 *
 *   npm run d1:export                      # → data/d1-import.sql
 *   npx wrangler d1 execute z-ui --remote --file=data/d1-import.sql
 *
 * Data only — the D1 schema comes from `wrangler d1 migrations apply`. Rows that cannot move are
 * skipped: sessions and login challenges, and passkeys (bound to the RP ID "localhost"; register
 * them again on the real domain). Use the same APP_ENC_KEY and SESSION_PEPPER as locally,
 * otherwise card numbers, the TOTP secret and the password stop working.
 *
 * Options: --db <path to .db>  --out <file>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const dbPath = resolve(arg('--db', resolve(ROOT, 'data/z-ui.db')));
const out = resolve(arg('--out', resolve(ROOT, 'data/d1-import.sql')));

const SKIP = new Set(['sessions', 'passkeys', 'auth_challenges', 'login_attempts', 'invites', '__drizzle_migrations', 'd1_migrations']);

const literal = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return `X'${Buffer.from(v instanceof ArrayBuffer ? new Uint8Array(v) : v).toString('hex')}'`;
  return `'${String(v).replaceAll("'", "''")}'`;
};
const ident = (s) => `"${s.replaceAll('"', '""')}"`;

const db = createClient({ url: `file:${dbPath}` });
const tables = (await db.execute("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%' order by rowid")).rows
  .map((r) => String(r.name))
  .filter((n) => !SKIP.has(n));

// Workers Free has ~10 ms CPU per request: a 100k-iteration password hash (~7 ms to verify)
// leaves no room for the rest of the login. Logging in once locally re-hashes at 50k.
const heavy = (await db.execute('select username, password_hash from users')).rows.filter((r) => Number(String(r.password_hash ?? '').split('$')[1]) > 50_000);
if (heavy.length) {
  console.error(`✗ password hash of ${heavy.map((r) => r.username).join(', ')} uses more than 50,000 PBKDF2 iterations.`);
  console.error('  Sign in locally once with password + code (npm run dev): it is re-hashed at 50,000. Then export again.');
  process.exit(1);
}

// Parents may come after children in creation order; D1 checks foreign keys at commit instead.
const lines = ['PRAGMA defer_foreign_keys = true;'];
const counts = {};
for (const table of tables) {
  const rs = await db.execute(`select * from ${ident(table)}`);
  counts[table] = rs.rows.length;
  if (!rs.rows.length) continue;
  const cols = rs.columns.map(ident).join(', ');
  for (const row of rs.rows) {
    // OR REPLACE: the Worker may already have written its default settings row.
    lines.push(`INSERT OR REPLACE INTO ${ident(table)} (${cols}) VALUES (${rs.columns.map((_, i) => literal(row[i])).join(', ')});`);
  }
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join('\n') + '\n');
db.close();

for (const [t, n] of Object.entries(counts)) if (n) console.log(`  ${t.padEnd(22)} ${n}`);
console.log(`\n✓ ${lines.length - 1} rows → ${out}`);
console.log('  Next: npx wrangler d1 execute z-ui --remote --file=' + out.replace(`${ROOT}/`, ''));
