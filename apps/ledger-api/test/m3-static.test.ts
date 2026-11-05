// M3-B3-D: static checks of the M3 history guarantees (TEST_PLAN DEL-2; DATA_MODEL §10.5, §10.11;
// API_SPEC §5.12). The source of apps/ledger-api/src is read as text (comments stripped):
// - the only delete of a row of the four M3 tables is S0, the expired-key cleanup (the user's own
//   correct / void keys with expires_at <= now); no UPDATE of an event, entry or key row and no
//   upsert / REPLACE on them; the header is updated only by the write chains and the notes PATCH;
// - no route deletes or replaces a transaction;
// - the foreign keys from the M3 tables to M2 data (read from a migrated database, not from 0002's
//   text) are exactly the four NO ACTION keys the M2 delete paths explain with a reference count
//   over every version and every status — so an older version or a voided transaction keeps its
//   account, currency, card and channel, whatever later versions use;
// - the financial write code keeps no module-level mutable state (no in-process lock or cache):
//   concurrency is the database's.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers.ts';

const SRC = join(import.meta.dirname, '..', 'src');
const M3_TABLES = { transactions: 'transactions', transactionEvents: 'transaction_events', transactionEntries: 'transaction_entries', ledgerIdempotencyKeys: 'ledger_idempotency_keys' } as const;
const M3_SQL = Object.values(M3_TABLES) as string[];

function sources(dir = SRC): [string, string][] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    if (!name.endsWith('.ts')) return [];
    return [[relative(SRC, path).replaceAll('\\', '/'), stripComments(readFileSync(path, 'utf8'))] as [string, string]];
  });
}
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\w])\/\/.*$/gm, '$1');

/** Every `.<method>(<identifier>` call in the source: [file, identifier]. */
const calls = (files: [string, string][], method: string) =>
  files.flatMap(([file, text]) => [...text.matchAll(new RegExp(`\\.${method}\\(\\s*(\\w+)`, 'g'))].map((m) => [file, m[1]!] as const));
/** Every raw SQL `<verb> … <table>` naming one of the M3 tables. */
const rawSql = (files: [string, string][], pattern: string) =>
  files.flatMap(([file, text]) => [...text.matchAll(new RegExp(`${pattern}\\s+[\`"']?(\\w+)`, 'gi'))].filter((m) => M3_SQL.includes(m[1]!.toLowerCase())).map((m) => [file, m[0]] as const));

/** The text of a top-level function (to its closing brace at column 0) or arrow constant (to its semicolon) named `name`. */
function definition(text: string, name: string): string {
  const fn = text.search(new RegExp(`^(export )?(async )?function ${name}\\(`, 'm'));
  if (fn !== -1) return text.slice(fn, text.indexOf('\n}', fn) + 2);
  const arrow = text.search(new RegExp(`^(export )?const ${name} = `, 'm'));
  expect(arrow, name).toBeGreaterThanOrEqual(0);
  return text.slice(arrow, text.indexOf(';\n', arrow) + 1);
}

describe('DEL-2 and the history guarantees, statically', () => {
  const files = sources();
  const file = (name: string) => files.find(([f]) => f === name)?.[1] ?? '';
  let t: TestEnv;
  beforeAll(async () => {
    t = await setup();
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it('reads the whole server source', () => {
    expect(files.length).toBeGreaterThan(30);
    for (const f of ['services/transactionWrite.ts', 'services/transactionReferences.ts', 'routes/transactions.ts', 'routes/accounts.ts', 'routes/cards.ts', 'routes/channels.ts']) expect(file(f), f).not.toBe('');
  });

  it('DEL-2: the only delete of an M3 row is S0 — this user’s correct / void keys with expires_at <= now — used by the three write chains; no raw SQL DELETE of an M3 table', () => {
    const m3Deletes = calls(files, 'delete').filter(([, id]) => id in M3_TABLES);
    expect(m3Deletes).toEqual([['services/transactionWrite.ts', 'ledgerIdempotencyKeys']]);
    const write = file('services/transactionWrite.ts');
    const s0 = definition(write, 'expiredKeys').replace(/\s+/g, ' ');
    expect(s0).toContain('db.delete(ledgerIdempotencyKeys).where(and(eq(ledgerIdempotencyKeys.userId, u), isNotNull(ledgerIdempotencyKeys.expiresAt), lte(ledgerIdempotencyKeys.expiresAt, now)))');
    expect([...write.matchAll(/S0: expiredKeys\(db, x\.u, x\.now\)/g)]).toHaveLength(3); // create, void, correct
    expect(files.filter(([, text]) => text.includes('expiredKeys(')).map(([f]) => f)).toEqual(['services/transactionWrite.ts']);
    expect(rawSql(files, 'DELETE\\s+FROM')).toEqual([]);
    // Rows of a user disappear otherwise only with the user (DEL-4): the one user delete is setup's
    // removal of a pending (never signed-in) first user.
    expect(calls(files, 'delete').filter(([, id]) => id === 'users')).toEqual([['routes/setup.ts', 'users']]);
    expect(file('routes/setup.ts')).toMatch(/\.delete\(users\)\.where\(eq\(users\.status, 'pending'\)\)/);
  });

  it('no UPDATE of a version, entry or key row; the header only through the write chains and the notes PATCH; no upsert or REPLACE on an M3 table', () => {
    const updates = calls(files, 'update').filter(([, id]) => id in M3_TABLES);
    expect(updates.every(([, id]) => id === 'transactions'), JSON.stringify(updates)).toBe(true);
    expect([...new Set(updates.map(([f]) => f))].sort()).toEqual(['services/transactionNotes.ts', 'services/transactionWrite.ts']);
    expect(rawSql(files, 'UPDATE')).toEqual([]);
    expect(rawSql(files, '(?:INSERT\\s+OR\\s+\\w+|REPLACE)\\s+INTO')).toEqual([]);
    for (const [f, text] of files) {
      for (const m of text.matchAll(/\.insert\(\s*(\w+)\s*\)[\s\S]{0,400}?\.onConflictDo(Update|Nothing)/g)) expect(m[1]! in M3_TABLES, `${f}: ${m[0].slice(0, 80)}`).toBe(false);
    }
    // The notes PATCH writes notes and updated_at only.
    expect(definition(file('services/transactionNotes.ts'), 'updateNotes').replace(/\s+/g, ' ')).toMatch(/\.update\(transactions\)\s?\.set\(\{ notes(: notes)?, updatedAt: (\w+\.)?now \}\)/);
  });

  it('no route deletes or replaces a transaction: /api/transactions has exactly the create, read, summary, correct, void and notes routes', () => {
    const routes = t.app.routes.filter((r) => r.path.startsWith('/api/transactions') && r.method !== 'ALL').map((r) => `${r.method} ${r.path}`);
    expect([...new Set(routes)].sort()).toEqual(
      [
        'GET /api/transactions',
        'POST /api/transactions',
        'GET /api/transactions/summary',
        'GET /api/transactions/:id',
        'GET /api/transactions/:id/revisions/:revision',
        'POST /api/transactions/:id/revisions',
        'POST /api/transactions/:id/void',
        'PATCH /api/transactions/:id/notes',
      ].sort(),
    );
    // M3-B5-B: /summary is registered before the dynamic /:id (API_SPEC §5).
    expect(routes.indexOf('GET /api/transactions/summary')).toBeLessThan(routes.indexOf('GET /api/transactions/:id'));
  });

  it('SUM-3: no floating-point aggregate anywhere in the server (no TOTAL( or AVG(); summary amounts are merged segment text', () => {
    for (const [f, text] of files) expect(text, f).not.toMatch(/\b(TOTAL|AVG)\s*\(/i);
    const summary = file('services/transactionSummary.ts');
    expect(summary).toMatch(/CAST\(SUM\(\$\{EN_AMOUNT\} \/ \$\{SEGMENT\}\) AS TEXT\)/);
    expect(summary).toMatch(/CAST\(SUM\(\$\{EN_AMOUNT\} % \$\{SEGMENT\}\) AS TEXT\)/);
    expect(summary).toMatch(/mergeSegmentedSum\(hi, lo\)/);
    expect(summary).not.toMatch(/SUM\("transaction_entries"\."amount"\)|SUM\(\$\{EN_AMOUNT\}\)/);
  });

  it('the foreign keys from M3 to M2 data are exactly four NO ACTION keys, each explained by its M2 delete path with a count over every version and status; users cascade', async () => {
    type Fk = { table: string; from: string[]; to: string[]; onDelete: string };
    const fks: (Fk & { child: string })[] = [];
    for (const child of M3_SQL) {
      const r = await t.client.execute(`PRAGMA foreign_key_list(${child})`);
      const byId = new Map<number, Fk>();
      for (const row of r.rows) {
        const id = Number(row.id);
        const fk = byId.get(id) ?? { table: String(row.table), from: [], to: [], onDelete: String(row.on_delete) };
        fk.from[Number(row.seq)] = String(row.from);
        fk.to[Number(row.seq)] = String(row.to);
        byId.set(id, fk);
      }
      for (const fk of byId.values()) fks.push({ child, ...fk });
    }
    const describeFk = (fk: Fk & { child: string }) => `${fk.child}(${fk.from.join(',')}) → ${fk.table}(${fk.to.join(',')}) ${fk.onDelete}`;
    const m2 = fks.filter((fk) => !M3_SQL.includes(fk.table) && fk.table !== 'users').map(describeFk).sort();
    expect(m2).toEqual(
      [
        'transaction_entries(funding_account_id,user_id) → accounts(id,user_id) NO ACTION',
        'transaction_entries(funding_account_id,user_id,funding_currency) → account_currencies(account_id,user_id,currency) NO ACTION',
        'transaction_events(card_id,user_id) → cards(id,user_id) NO ACTION',
        'transaction_events(payment_channel_id,user_id) → payment_channels(id,user_id) NO ACTION',
      ].sort(),
    );
    expect(fks.filter((fk) => fk.table === 'users').map(describeFk).sort()).toEqual(M3_SQL.map((c) => `${c}(user_id) → users(id) CASCADE`).sort());

    // Each NO ACTION parent → the M2 path that deletes it, the count that explains the refusal, and
    // the referencing column. The counts read every version and every status: no revision,
    // current_revision, status or voided condition.
    const refs = file('services/transactionReferences.ts');
    const protection: [string, string, string, string, string][] = [
      ['accounts', 'routes/accounts.ts', "delete('/:id'", 'transactionsUsingAccount', 'transactionEntries.fundingAccountId'],
      ['account_currencies', 'routes/accounts.ts', "put('/:id/currencies'", 'currenciesUsedByEntries', 'transactionEntries.fundingCurrency'],
      ['cards', 'routes/cards.ts', "delete('/:id'", 'transactionsUsingCard', 'transactionEvents.cardId'],
      ['payment_channels', 'routes/channels.ts', "delete('/:id'", 'transactionsUsingChannel', 'transactionEvents.paymentChannelId'],
    ];
    expect(protection.map(([parent]) => parent).sort()).toEqual(fks.filter((fk) => fk.onDelete === 'NO ACTION' && !M3_SQL.includes(fk.table)).map((fk) => fk.table).sort());
    for (const [parent, route, path, counter, column] of protection) {
      expect(file(route), `${parent}: ${route} has ${path}`).toContain(`.${path}`);
      expect(file(route), `${parent}: ${route} calls ${counter}`).toMatch(new RegExp(`\\b${counter}\\(`));
      const body = definition(refs, counter);
      expect(body, counter).toContain(column);
      expect(body, counter).toMatch(/eq\(transaction(Entries|Events)\.userId, userId\)/);
      expect(body, counter).not.toMatch(/revision|currentRevision|status|voided/i);
    }
    expect(await t.client.execute('PRAGMA foreign_keys').then((r) => Number(r.rows[0]![0]))).toBe(1);
  });

  it('the financial write code holds no module-level mutable state — no lock, queue or cache decides between concurrent requests', () => {
    const writePath = files.filter(([f]) => /^(services\/transaction\w+|routes\/transactions)\.ts$/.test(f));
    expect(writePath.length).toBeGreaterThanOrEqual(10);
    for (const [f, text] of writePath) {
      expect(text, f).not.toMatch(/^(export )?(let|var)\s/m);
      expect(text, f).not.toMatch(/^(export )?const \w+(: [^=]+)? = new (Map|WeakMap|Array)\b/m);
      expect(text, f).not.toMatch(/\b(mutex|semaphore|inFlight|pendingWrites|queue)\b/i);
    }
  });
});
