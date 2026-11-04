import { accountUpdateSchema, normalizeNameKey, type AccountCurrencyInput, type AccountUpdate } from '@xui/ledger-shared';
import { and, eq, getTableColumns, inArray, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { z } from 'zod';
import type { DB } from '../db/client.ts';
import { accountCurrencies, accounts, auditLog, cards, institutions, paymentChannels } from '../db/schema.ts';
import type { AuditAction } from '../lib/audit.ts';

/**
 * Account service rules. PATCH /accounts/:id goes through accountPatchValues, so the column set it
 * writes can only come from accountUpdateSchema. Multi-statement writes (an account with its
 * currencies, replacing the currency list) are built here as one db.batch(): D1 has no interactive
 * transactions, and a batch is all-or-nothing on both libsql and D1.
 */

type Statement = BatchItem<'sqlite'>;
export type Batch = [Statement, ...Statement[]];
type CurrencyRow = typeof accountCurrencies.$inferInsert;

/**
 * INSERT INTO audit_log … SELECT … FROM accounts WHERE (this account, this user) — for DELETE
 * /accounts/:id (M3-B2-C2, Q8). Placed before the delete in the same batch, it reads the row that
 * is about to be deleted: written exactly when the account still exists inside that transaction,
 * rolled back with the delete when the delete is refused or anything else fails. detail is { id },
 * as before (never the name or other account data).
 */
export function accountAuditStatement(db: DB, action: AuditAction, account: { id: string; userId: string }, entry: { id: string; ip: string | null; now: number }) {
  const row = {
    id: sql`${entry.id}`.as('id'),
    userId: sql`${account.userId}`.as('user_id'),
    action: sql`${action}`.as('action'),
    detail: sql`json_object('id', ${accounts.id})`.as('detail'),
    ip: sql`${entry.ip}`.as('ip'),
    createdAt: sql`${entry.now}`.as('created_at'),
  } satisfies Record<keyof typeof auditLog.$inferSelect, unknown>;
  return db.insert(auditLog).select(
    db
      .select(row)
      .from(accounts)
      .where(and(eq(accounts.id, account.id), eq(accounts.userId, account.userId))),
  );
}

/** account_currencies rows for a validated currency list: sort = position in the list. */
export function currencyRows(accountId: string, userId: string, list: readonly AccountCurrencyInput[], now: number): CurrencyRow[] {
  return list.map((c, i) => ({
    accountId,
    userId,
    currency: c.code,
    isDefault: c.isDefault === true,
    status: c.status ?? 'active',
    sort: i,
    createdAt: now,
  }));
}

/** Every column of the accounts row, defaults included. */
export type AccountRow = Required<typeof accounts.$inferInsert>;

/**
 * POST /accounts: the account, then one INSERT per currency. Not one multi-row INSERT: D1 binds
 * at most 100 parameters per statement, and 30 currencies × 7 columns would not fit.
 *
 * New accounts may only be opened at an active institution of the same user. The route checks
 * that first; the batch re-checks it in the same transaction, so archiving the institution
 * between the check and the write can't slip through: the account row is an
 * INSERT … SELECT … FROM institutions WHERE (this institution, this user, active), which writes
 * nothing once the institution is archived (or gone). The currency INSERTs that follow — there is always at least one — then
 * fail their (account_id, user_id) foreign key, and the whole batch rolls back. Writers are
 * serialized (SQLite and D1 alike), so the archive lands either before the batch (refused) or
 * after it (the account existed before the institution was archived).
 */
export function accountCreateBatch(db: DB, account: AccountRow, currencies: CurrencyRow[]): Batch {
  return [insertIfInstitutionActive(db, accounts, account, account.institutionId), ...currencies.map((row) => db.insert(accountCurrencies).values(row))];
}

/**
 * INSERT INTO <table> SELECT <row's values> FROM institutions WHERE (institutionId, row.userId,
 * active): writes the row while the institution is an active one of the same user, and nothing
 * (without an error) otherwise. Used for new accounts, new cards and new payment channels with a
 * provider, which need an active institution; the statement re-checks inside the batch what the
 * route checked before it (or, for channels, is the only check).
 * Built with the query builder, not db.run(sql``): drizzle's D1 batch can't bind raw SQL.
 */
export function insertIfInstitutionActive<T extends typeof accounts | typeof cards | typeof paymentChannels>(db: DB, table: T, row: Required<T['$inferInsert']>, institutionId: string) {
  const activeInstitution = and(eq(institutions.id, institutionId), eq(institutions.userId, row.userId), eq(institutions.status, 'active'));
  // The generic table type is too wide for drizzle's select-shape check; the values are built from its own columns.
  return db.insert(table as typeof accounts).select(db.select(rowAsSelect(table, row)).from(institutions).where(activeInstitution) as never);
}

/** Every column of `row` as a bound value aliased to its column name: the select list of an INSERT … SELECT. */
export function rowAsSelect(table: Parameters<typeof getTableColumns>[0], row: Record<string, unknown>): Record<string, SQL.Aliased> {
  return Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([key, column]) => {
      const value = row[key];
      if (value === undefined) throw new Error(`rowAsSelect: no value for ${column.name}`);
      return [key, sql`${value}`.as(column.name)];
    }),
  );
}

export interface CurrencyReplacePlan {
  /** Currencies on the account that the new list leaves out (deleted by the batch). */
  removed: string[];
  batch: Batch;
}

/**
 * PUT /accounts/:id/currencies: turn the stored currencies into `next`. Order matters for the
 * partial unique index "one default per account": the old default is cleared first, then every
 * row gets its new default flag, status and position, so no statement ever sees two defaults.
 * Rows that stay keep their created_at. The caller checks references before removing currencies;
 * a link (or, from M3, an entry) created in between makes the DELETE fail its NO ACTION foreign
 * key and the whole batch rolls back.
 */
export function currencyReplacePlan(
  db: DB,
  account: { id: string; userId: string },
  existing: readonly string[],
  next: readonly AccountCurrencyInput[],
  now: number,
): CurrencyReplacePlan {
  const own = (...more: ReturnType<typeof eq>[]) => and(eq(accountCurrencies.accountId, account.id), eq(accountCurrencies.userId, account.userId), ...more);
  const keep = new Set<string>(next.map((c) => c.code));
  const removed = existing.filter((code) => !keep.has(code));
  const have = new Set(existing);
  const statements: Statement[] = [db.update(accountCurrencies).set({ isDefault: false }).where(own(eq(accountCurrencies.isDefault, true)))];
  if (removed.length) statements.push(db.delete(accountCurrencies).where(own(inArray(accountCurrencies.currency, removed))));
  for (const row of currencyRows(account.id, account.userId, next, now)) {
    statements.push(
      have.has(row.currency)
        ? db.update(accountCurrencies).set({ isDefault: row.isDefault, status: row.status, sort: row.sort }).where(own(eq(accountCurrencies.currency, row.currency)))
        : db.insert(accountCurrencies).values(row),
    );
  }
  statements.push(db.update(accounts).set({ updatedAt: now }).where(and(eq(accounts.id, account.id), eq(accounts.userId, account.userId))));
  const [first, ...rest] = statements;
  return { removed, batch: [first!, ...rest] };
}

/** Columns an account PATCH may write. institution_id is deliberately not one of them. */
export type AccountPatchColumns = Partial<
  Pick<
    typeof accounts.$inferInsert,
    'name' | 'nameKey' | 'accountType' | 'depositKind' | 'accountCountry' | 'numberHint' | 'status' | 'openedOn' | 'closedOn' | 'notes' | 'sort'
  >
> & { updatedAt: number };

export type AccountPatchResult = { ok: true; values: AccountPatchColumns } | { ok: false; code: 'VALIDATION'; issues: z.core.$ZodIssue[] };

/** Fields that can never be changed by PATCH, whatever the body says (the schema already refuses them). */
export const IMMUTABLE_ACCOUNT_FIELDS = ['institutionId', 'userId', 'id', 'createdAt'] as const;

/**
 * Validate a PATCH body and turn it into the update for the accounts row. The institution an
 * account was opened with is immutable: { institutionId } (or any other unknown field) is a
 * VALIDATION error — when the contracting legal entity changes, the user creates a new account.
 * An empty body is refused too (nothing to update).
 */
export function accountPatchValues(body: unknown, now: number): AccountPatchResult {
  const parsed = accountUpdateSchema.safeParse(body);
  if (!parsed.success) return { ok: false, code: 'VALIDATION', issues: parsed.error.issues };
  const patch: AccountUpdate = parsed.data;
  if (Object.keys(patch).length === 0) {
    return { ok: false, code: 'VALIDATION', issues: [{ code: 'custom', path: [], message: 'nothing to update', input: body }] };
  }
  const values: AccountPatchColumns = { updatedAt: now };
  if (patch.name !== undefined) {
    values.name = patch.name;
    values.nameKey = normalizeNameKey(patch.name);
  }
  if (patch.accountType !== undefined) values.accountType = patch.accountType;
  if (patch.depositKind !== undefined) values.depositKind = patch.depositKind;
  if (patch.accountCountry !== undefined) values.accountCountry = patch.accountCountry;
  if (patch.numberHint !== undefined) values.numberHint = patch.numberHint;
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.openedOn !== undefined) values.openedOn = patch.openedOn;
  if (patch.closedOn !== undefined) values.closedOn = patch.closedOn;
  if (patch.notes !== undefined) values.notes = patch.notes;
  if (patch.sort !== undefined) values.sort = patch.sort;
  return { ok: true, values };
}
