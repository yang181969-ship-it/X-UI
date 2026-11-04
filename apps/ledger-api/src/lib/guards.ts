import { scanSensitive } from '@xui/ledger-shared';
import { dbErrorText } from './dbErrors.ts';
import { fail } from './http.ts';

/** Request guards and database-error checks shared by the M2 routes. */

/** 400 SENSITIVE_DATA naming the fields (never the matched text). No bypass exists. */
export function rejectSensitive(fields: Record<string, string | null | undefined>) {
  const hits = scanSensitive(fields);
  if (hits.length) fail(400, 'free text looks like a card number or a security code', 'SENSITIVE_DATA', { fields: hits });
}

/** 400 VALIDATION for an empty PATCH body. */
export const nothingToUpdate = (): never => fail(400, 'nothing to update', 'VALIDATION', [{ code: 'custom', path: [], message: 'nothing to update' }]);

/** LIKE pattern for a literal substring (escape with '\'). */
export const likeContains = (s: string) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

// Only SQLite's own messages from verified driver errors are read (dbErrors.ts) — never drizzle's
// wrapper, whose text repeats the bound values (user input): user text can't fake a constraint.
export const isUniqueViolation = (err: unknown) => /UNIQUE constraint failed/.test(dbErrorText(err));
export const isForeignKeyViolation = (err: unknown) => /FOREIGN KEY constraint failed/.test(dbErrorText(err));
/** A RAISE(ABORT, '<code>: …') from one of the M2 triggers. */
export const isTriggerAbort = (err: unknown, code: string) => new RegExp(`\\b${code}\\b`).test(dbErrorText(err));
