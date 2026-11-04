/**
 * SQLite's own messages from a database error — the one place the API reads why a statement failed
 * (M2 guards in guards.ts, the transaction write chain in services/transactionErrors.ts).
 *
 * Only errors of the two verified driver shapes count (M3-B2-C2 probe, libsql and local D1):
 *
 * - libsql: LibsqlError / LibsqlBatchError / SqliteError with a string `code` starting with
 *   "SQLITE_" (e.g. code SQLITE_CONSTRAINT_FOREIGNKEY, message "FOREIGN KEY constraint failed").
 * - D1: a plain Error whose whole message is "[D1_ERROR: ]<sqlite message>: SQLITE_X (extended:
 *   SQLITE_Y)"; the sqlite message part is taken.
 *
 * drizzle's DrizzleQueryError ("Failed query: <sql>\nparams: <bound values>") is never read: bound
 * values are user text, so a name or note spelling "FOREIGN KEY constraint failed" or
 * "LEDGER_CLASSIFICATION:" must not change how a failure is classified. SQLite never puts bound
 * values into its own messages. Any error of another shape contributes nothing — the caller then
 * treats the failure as unexplained (a generic 500), never as a known constraint.
 *
 * These are format checks of what the drivers throw, not proof of where an error came from (D1's
 * errors are plain Errors). They are sound because every caller applies them only to the error
 * caught directly around one database call (db.batch / insert / update / delete), where the only
 * code that can throw is the driver; user input can reach an error only as drizzle's bound values,
 * which are never read. Do not apply them to errors from anywhere else.
 */

import { DrizzleQueryError } from 'drizzle-orm';

const LIBSQL_ERRORS = new Set(['LibsqlError', 'LibsqlBatchError', 'SqliteError']);
const D1_MESSAGE = /^(?:D1_ERROR: )?([\s\S]+): SQLITE_[A-Z_]+(?: \(extended: SQLITE_[A-Z_]+\))?$/;

/** The SQLite messages of the trusted driver errors in an error's cause chain (outermost first). */
export function dbMessages(err: unknown): string[] {
  const out: string[] = [];
  for (let e: unknown = err, depth = 0; e && depth < 10; e = (e as { cause?: unknown }).cause, depth++) {
    if (!(e instanceof Error)) continue;
    const code = (e as { code?: unknown }).code;
    if (LIBSQL_ERRORS.has(e.name) && typeof code === 'string' && code.startsWith('SQLITE_')) {
      out.push(e.message);
      continue;
    }
    // D1 throws plain Errors; drizzle's wrapper (another class) never matches because its message starts with "Failed query:".
    if (e.constructor === Error) {
      const m = D1_MESSAGE.exec(e.message);
      if (m && !e.message.startsWith('Failed query:')) out.push(m[1]!);
    }
  }
  return out;
}

/** dbMessages joined (for pattern tests). */
export const dbErrorText = (err: unknown) => dbMessages(err).join(' | ');

/**
 * An unhandled error as written to the server log: each cause's name, SQLite code and message, and
 * the top error's stack frames — but never drizzle's query text or bound values (user input such as
 * names, notes, merchants and amounts), and never the value of a non-Error throw.
 */
export function errorForLog(err: unknown): string {
  const lines: string[] = [];
  for (let e: unknown = err, depth = 0; e && depth < 10; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof DrizzleQueryError) {
      lines.push('DrizzleQueryError: (query and bound values withheld)');
      continue;
    }
    if (!(e instanceof Error)) {
      lines.push(`non-Error ${typeof e} thrown (value withheld)`);
      break;
    }
    const code = (e as { code?: unknown }).code;
    lines.push(`${e.name}${typeof code === 'string' ? ` [${code}]` : ''}: ${e.message}`);
  }
  const frames = err instanceof Error && !(err instanceof DrizzleQueryError) ? (err.stack ?? '').split('\n').filter((l) => /^\s+at /.test(l)) : [];
  return [...lines.map((l, i) => (i ? `  caused by ${l}` : l)), ...frames].join('\n');
}
