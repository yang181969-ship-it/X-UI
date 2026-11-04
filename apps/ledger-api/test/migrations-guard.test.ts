// Guard for every v1 migration (present and future): drizzle-kit has produced broken SQL here
// before — it splits expression index columns such as ifnull("currency", '') at the comma and
// quotes each piece as a column name. These checks run on the files and journal alone, plus one
// apply on an in-memory database, so a bad migration fails CI before anyone runs it.
import { createClient } from '@libsql/client';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unstable_splitSqlQuery } from 'wrangler';
import { MIGRATIONS_DIR } from '../src/db/client.ts';

const BREAKPOINT = '--> statement-breakpoint';

interface Journal {
  dialect: string;
  entries: { idx: number; tag: string; when: number; breakpoints: boolean }[];
}
const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as Journal;
const sqlOf = (tag: string) => readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8');

/** Triggers that must exist after the whole chain (a later table rebuild must re-create them). */
const REQUIRED_TRIGGERS = [
  // M2 (0001)
  'accounts_balance_kind_update',
  'accounts_institution_immutable',
  'payment_channels_balance_kind_insert',
  'payment_channels_balance_kind_update',
  // M3 (0002, DATA_MODEL §10.7.2)
  'tx_insert_guard',
  'tx_update_guard',
  'tx_publish_entry_count',
  'tx_publish_own_shape',
  'tx_publish_event_amount',
  'tx_publish_classification',
  'tx_publish_domestic',
  'tx_no_delete',
  'ev_immutable',
  'ev_insert_order',
  'ev_snapshot_source',
  'ev_kind_guard',
  'ev_no_delete',
  'en_immutable',
  'en_insert_open',
  'en_snapshot_source',
  'en_kind_guard',
  'en_closed_currency',
  'en_no_delete',
  'key_immutable',
  'key_create_no_delete',
];

/** SQL with string literals and comments blanked out (same length), for structural scans. */
function code(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, (m) => `'${' '.repeat(m.length - 2)}'`).replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** Drizzle-style statements: split at breakpoints, comments dropped, empty chunks kept (they are an error). */
const chunks = (sql: string) => sql.split(BREAKPOINT).map((c) => c.replace(/^\s*--.*$/gm, '').trim());

/** Problems in one migration file; [] when it is fine. Exported shape kept simple for the self-test below. */
function problemsIn(sql: string): string[] {
  const out: string[] = [];
  const statements = chunks(sql);
  statements.forEach((s, i) => {
    if (!s) out.push(`statement ${i + 1} is empty (an empty breakpoint chunk breaks the migrator)`);
  });

  for (const s of statements.filter(Boolean)) {
    const c = code(s);
    const head = s.split('\n')[0]!.slice(0, 90);
    // Every quoted identifier must be a plain name: a quote around "ifnull(…" or " '')" means
    // drizzle-kit split an expression into fake column names.
    for (const m of c.matchAll(/`([^`]*)`/g)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(m[1]!)) out.push(`bad quoted identifier \`${m[1]}\` in: ${head}`);
    }
    for (const m of c.matchAll(/"([^"]*)"/g)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(m[1]!)) out.push(`bad quoted identifier "${m[1]}" in: ${head}`);
    }
    let depth = 0;
    for (const ch of c) {
      if (ch === '(') depth++;
      if (ch === ')' && --depth < 0) break;
    }
    if (depth !== 0) out.push(`unbalanced parentheses in: ${head}`);

    const index = /^CREATE (UNIQUE )?INDEX (?:IF NOT EXISTS )?`(\w+)` ON `(\w+)` \(([\s\S]*?)\)(?: WHERE ([\s\S]+?))?;?$/.exec(c.trim());
    if (/^CREATE (UNIQUE )?INDEX/.test(c.trim())) {
      if (!index) {
        out.push(`index statement does not parse: ${head}`);
        continue;
      }
      // Column list: plain `col` or an unquoted expression such as ifnull(`col`, '').
      const cols = splitTopLevel(s.slice(s.indexOf('(') + 1, s.indexOf('(') + 1 + index[4]!.length));
      for (const col of cols) {
        const t = col.trim();
        if (/^`\w+`$/.test(t)) continue;
        if (/^[a-z_]+\(.*\)$/i.test(t) && !t.startsWith('`')) continue;
        out.push(`index ${index[2]}: column "${t}" is neither \`name\` nor an expression`);
      }
    }
  }
  return out;
}

/** Split on commas that are not inside parentheses or string literals. */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]!;
    if (ch === "'") inStr = !inStr;
    if (!inStr && ch === '(') depth++;
    if (!inStr && ch === ')') depth--;
    if (!inStr && depth === 0 && ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

describe('migration guard: journal and files agree', () => {
  it('journal entries are 0…n-1, ordered, and each has its SQL file and snapshot', () => {
    expect(journal.dialect).toBe('sqlite');
    expect(journal.entries.length).toBeGreaterThanOrEqual(2);
    journal.entries.forEach((e, i) => {
      expect(e.idx, e.tag).toBe(i);
      expect(e.tag, e.tag).toMatch(new RegExp(`^${String(i).padStart(4, '0')}_[a-z0-9_]+$`));
      expect(e.breakpoints, e.tag).toBe(true);
      expect(existsSync(join(MIGRATIONS_DIR, `${e.tag}.sql`)), `${e.tag}.sql`).toBe(true);
      expect(existsSync(join(MIGRATIONS_DIR, 'meta', `${e.tag.slice(0, 4)}_snapshot.json`)), `${e.tag} snapshot`).toBe(true);
      if (i > 0) expect(e.when, e.tag).toBeGreaterThan(journal.entries[i - 1]!.when);
    });
  });

  it('every SQL file and snapshot belongs to a journal entry', () => {
    const tags = journal.entries.map((e) => e.tag);
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).map((f) => f.slice(0, -4)).sort()).toEqual([...tags].sort());
    expect(readdirSync(join(MIGRATIONS_DIR, 'meta')).filter((f) => f.endsWith('_snapshot.json')).sort()).toEqual(tags.map((t) => `${t.slice(0, 4)}_snapshot.json`).sort());
  });

  it('snapshots form one chain (prevId → previous id)', () => {
    const snaps = journal.entries.map((e) => JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta', `${e.tag.slice(0, 4)}_snapshot.json`), 'utf8')) as { id: string; prevId: string });
    snaps.forEach((s, i) => {
      if (i > 0) expect(s.prevId, journal.entries[i]!.tag).toBe(snaps[i - 1]!.id);
    });
    expect(new Set(snaps.map((s) => s.id)).size).toBe(snaps.length);
  });
});

describe('migration guard: SQL of every migration', () => {
  for (const { tag } of journal.entries) {
    it(`${tag}: identifiers, expression indexes, parentheses, no empty statements`, () => {
      expect(problemsIn(sqlOf(tag))).toEqual([]);
    });

    it(`${tag}: wrangler's splitter (wrangler d1 migrations apply) sees the same statements as drizzle`, () => {
      // A trigger body or a missing breakpoint would make the two counts differ.
      expect(unstable_splitSqlQuery(sqlOf(tag)).length).toBe(chunks(sqlOf(tag)).filter(Boolean).length);
    });
  }

  it('the whole chain applies on a fresh database; expression indexes really index expressions; triggers exist', async () => {
    const c = createClient({ url: ':memory:' });
    try {
      for (const { tag } of journal.entries) for (const s of chunks(sqlOf(tag)).filter(Boolean)) await c.execute(s);
      const indexes = (await c.execute("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")).rows;
      for (const ix of indexes) {
        const cols = (await c.execute(`PRAGMA index_xinfo(\`${String(ix.name)}\`)`)).rows.filter((r) => Number(r.key) === 1);
        const expressions = cols.filter((r) => Number(r.cid) === -2).length;
        // Each ifnull(…) in the declaration must be an expression column (cid = -2), not a named one.
        expect(expressions, String(ix.name)).toBe((String(ix.sql).match(/\bifnull\(/gi) ?? []).length);
        expect(cols.length, String(ix.name)).toBeGreaterThan(0);
      }
      const triggers = (await c.execute("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")).rows.map((r) => String(r.name));
      for (const t of REQUIRED_TRIGGERS) expect(triggers).toContain(t);
    } finally {
      c.close();
    }
  });
});

describe('migration guard: self-test', () => {
  it('rejects the SQL drizzle-kit actually generated for these indexes', () => {
    // Verbatim drizzle-kit 0.31.11 output for account_card_links_open_uq and institutions_user_name_country_uq.
    const generated = [
      "CREATE UNIQUE INDEX `account_card_links_open_uq` ON `account_card_links` (`card_id`,`account_id`,`ifnull(\"currency\"`,` '')`,`role`) WHERE \"account_card_links\".\"status\" <> 'ended';",
      "CREATE UNIQUE INDEX `institutions_user_name_country_uq` ON `institutions` (`user_id`,`name_key`,`ifnull(\"country\"`,` '')`);",
    ].join(`${BREAKPOINT}\n`);
    const problems = problemsIn(generated);
    expect(problems.some((p) => p.includes('bad quoted identifier `ifnull("currency"`'))).toBe(true);
    expect(problems.some((p) => p.includes('bad quoted identifier `ifnull("country"`'))).toBe(true);
    expect(problems.some((p) => p.includes("bad quoted identifier ` '')`"))).toBe(true);
  });

  it('rejects empty statements and unbalanced parentheses; accepts the fixed form', () => {
    expect(problemsIn(`CREATE TABLE \`t\` (\`a\` text);${BREAKPOINT}\n${BREAKPOINT}\nCREATE INDEX \`i\` ON \`t\` (\`a\`);`)).toEqual([
      'statement 2 is empty (an empty breakpoint chunk breaks the migrator)',
    ]);
    expect(problemsIn('CREATE INDEX `i` ON `t` (ifnull(`a`, \'\');')[0]).toMatch(/unbalanced|does not parse/);
    expect(problemsIn("CREATE UNIQUE INDEX `i` ON `t` (`a`,ifnull(`b`, ''),`c`) WHERE `s` <> 'ended';")).toEqual([]);
  });
});
