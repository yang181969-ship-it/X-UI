import { accountUpdateSchema, normalizeNameKey, type AccountCurrencyInput, type AccountUpdate } from '@xui/ledger-shared';
import { and, eq, getTableColumns, inArray, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { z } from 'zod';
import type { DB } from '../db/client.ts';
import { accountCurrencies, accounts, institutions } from '../db/schema.ts';

/**
 * Account service rules. PATCH /accounts/:id goes through accountPatchValues, so the column set it
 * writes can only come from accountUpdateSchema. Multi-statement writes (an account with its
 * currencies, replacing the currency list) are built here as one db.batch(): D1 has no interactive
 * transactions, and a batch is all-or-nothing on both libsql and D1.
 */

type Statement = BatchItem<'sqlite'>;
export type Batch = [Statement, ...Statement[]];
type CurrencyRow = typeof accountCurrencies.$inferInsert;

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
  // The row's values, selected FROM its institution: one row while it is active, none otherwise.
  // (Built with the query builder, not db.run(sql``): drizzle's D1 batch can't bind raw SQL.)
  const values = Object.fromEntries(
    Object.entries(getTableColumns(accounts)).map(([key, column]) => {
      const value = account[key as keyof AccountRow];
      if (value === undefined) throw new Error(`accountCreateBatch: no value for ${column.name}`);
      return [key, sql`${value}`.as(column.name)];
    }),
  ) as Record<keyof AccountRow, SQL.Aliased>;
  const activeInstitution = and(eq(institutions.id, account.institutionId), eq(institutions.userId, account.userId), eq(institutions.status, 'active'));
  const insertAccount = db.insert(accounts).select(db.select(values).from(institutions).where(activeInstitution));
  return [insertAccount, ...currencies.map((row) => db.insert(accountCurrencies).values(row))];
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
