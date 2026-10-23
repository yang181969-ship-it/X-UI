import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schema from '../src/db/schema.ts';

/** Runs one read-only statement against the database under test and returns its rows. */
export type Query = (sql: string) => Promise<Record<string, unknown>[]>;

/** Tables the platforms add themselves (migration bookkeeping, D1 internals). */
const PLATFORM_TABLE = /^(__drizzle_migrations|d1_migrations|sqlite_sequence|_cf_.*)$/;

/**
 * Differences between the Drizzle schema (schema.ts) and a database built by running the
 * migrations: tables, columns (type, NOT NULL, primary key), indexes (unique, columns), foreign
 * keys (target, ON DELETE) and named CHECK constraints. Empty = the migrations produce exactly
 * the schema the code expects.
 */
export async function schemaDrift(q: Query): Promise<string[]> {
  const drift: string[] = [];
  const tables = (Object.values(schema) as unknown[]).filter((v): v is SQLiteTable => is(v, SQLiteTable)).map((t) => getTableConfig(t));
  const actualTables = (await q("select name, sql from sqlite_master where type = 'table'")).filter((r) => !PLATFORM_TABLE.test(String(r['name'])));
  const expectedNames = new Set(tables.map((t) => t.name));
  for (const r of actualTables) if (!expectedNames.has(String(r['name']))) drift.push(`unexpected table ${r['name']}`);

  for (const t of tables) {
    const ddl = String(actualTables.find((r) => r['name'] === t.name)?.['sql'] ?? '');
    if (!ddl) {
      drift.push(`missing table ${t.name}`);
      continue;
    }
    const cols = await q(`pragma table_info(${t.name})`);
    const pkCols = new Set([...t.columns.filter((c) => c.primary).map((c) => c.name), ...t.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name))]);
    if (cols.length !== t.columns.length) drift.push(`${t.name}: ${cols.length} columns, schema has ${t.columns.length}`);
    for (const c of t.columns) {
      const a = cols.find((r) => r['name'] === c.name);
      if (!a) {
        drift.push(`${t.name}.${c.name} missing`);
        continue;
      }
      if (String(a['type']).toLowerCase() !== c.getSQLType().toLowerCase()) drift.push(`${t.name}.${c.name} type ${a['type']} ≠ ${c.getSQLType()}`);
      const notNull = Number(a['notnull']) === 1;
      if (notNull !== (c.notNull || c.primary)) drift.push(`${t.name}.${c.name} notnull ${a['notnull']} ≠ ${c.notNull}`);
      const primary = Number(a['pk']) > 0;
      if (primary !== pkCols.has(c.name)) drift.push(`${t.name}.${c.name} primary key differs`);
    }

    // Indexes created by the migrations: declared ones, plus a unique index per .unique() column
    // and per unique() constraint (that is how drizzle-kit emits them for SQLite).
    const expectedIndexes = [
      ...t.indexes.map((ix) => ({ name: ix.config.name, unique: !!ix.config.unique, columns: ix.config.columns.map((c) => (c as { name: string }).name) })),
      ...t.columns.filter((c) => c.isUnique).map((c) => ({ name: c.uniqueName!, unique: true, columns: [c.name] })),
      ...t.uniqueConstraints.map((u) => ({ name: u.getName(), unique: true, columns: u.columns.map((c) => c.name) })),
    ];
    const indexes = (await q(`pragma index_list(${t.name})`)).filter((r) => r['origin'] === 'c');
    for (const ix of expectedIndexes) {
      const a = indexes.find((r) => r['name'] === ix.name);
      if (!a) {
        drift.push(`${t.name}: index ${ix.name} missing`);
        continue;
      }
      const unique = Number(a['unique']) === 1;
      if (unique !== ix.unique) drift.push(`${t.name}: index ${ix.name} uniqueness differs`);
      const actualCols = (await q(`pragma index_info(${ix.name})`)).map((r) => String(r['name']));
      if (actualCols.join(',') !== ix.columns.join(',')) drift.push(`${t.name}: index ${ix.name} on (${actualCols}) ≠ (${ix.columns})`);
    }
    if (indexes.length !== expectedIndexes.length) drift.push(`${t.name}: ${indexes.length} indexes, schema has ${expectedIndexes.length}`);

    const fks = await q(`pragma foreign_key_list(${t.name})`);
    for (const fk of t.foreignKeys) {
      const ref = fk.reference();
      const from = ref.columns.map((c) => c.name).join(',');
      const target = getTableConfig(ref.foreignTable).name;
      const a = fks.find((r) => r['from'] === from && r['table'] === target);
      if (!a) drift.push(`${t.name}: foreign key (${from}) → ${target} missing`);
      else if (String(a['on_delete']).toLowerCase() !== (fk.onDelete ?? 'no action')) drift.push(`${t.name}: foreign key (${from}) ON DELETE ${a['on_delete']} ≠ ${fk.onDelete ?? 'no action'}`);
    }
    if (fks.length !== t.foreignKeys.length) drift.push(`${t.name}: ${fks.length} foreign keys, schema has ${t.foreignKeys.length}`);

    for (const ck of t.checks) if (!ddl.includes(`CONSTRAINT "${ck.name}" CHECK`)) drift.push(`${t.name}: check ${ck.name} missing`);
    const actualChecks = ddl.match(/CONSTRAINT "[^"]+" CHECK/g) ?? [];
    if (actualChecks.length !== t.checks.length) drift.push(`${t.name}: ${actualChecks.length} checks, schema has ${t.checks.length}`);
  }
  return drift;
}
