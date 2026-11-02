import { accountUpdateSchema, normalizeNameKey, type AccountUpdate } from '@xui/ledger-shared';
import type { z } from 'zod';
import type { accounts } from '../db/schema.ts';

/**
 * Account service rules that do not need the database. PATCH /accounts/:id (M2-B2) goes through
 * accountPatchValues, so the column set it writes can only come from accountUpdateSchema.
 */

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
