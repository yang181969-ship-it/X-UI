import { LEDGER_DB_ERROR_CODES, type LedgerDbErrorCode } from '@xui/ledger-shared';
import { dbErrorText } from '../lib/dbErrors.ts';

/**
 * What a failed financial write batch says about itself — for the server only (DATA_MODEL §10.10,
 * TEST_PLAN ISO-6 / ISO-7). None of this ever reaches a response: the route decides the HTTP answer
 * by re-reading what the caller can see, and anything it can't explain is a generic 500.
 *
 * Only SQLite's own messages from verified driver errors are read (lib/dbErrors.ts, shared with the
 * M2 guards). drizzle's DrizzleQueryError wrapper repeats the SQL and the bound parameters, and
 * parameters hold user text (a merchant name could spell "LEDGER_CLASSIFICATION:"), so it is never
 * read; an error of no verified shape is "unknown" (a generic 500, never retried).
 */
export type WriteFailure =
  /** A key-row result column was NULL: some step of the chain did not reach its final state (rolled back). */
  | { kind: 'key_incomplete' }
  /** A composite foreign key refused a bound id (card, channel) — rolled back. */
  | { kind: 'foreign_key' }
  /** The (user_id, key) primary key: the key was taken by another request — rolled back. */
  | { kind: 'key_taken' }
  /** RAISE(ABORT, '<LEDGER_*>: …') from a migration 0002 trigger — rolled back. */
  | { kind: 'ledger'; code: LedgerDbErrorCode }
  /** Any other constraint (CHECK, another UNIQUE, NOT NULL) — rolled back, but never caused by a valid request. */
  | { kind: 'constraint' }
  /** Not a statement error the database reported: the outcome (committed or not) is unknown. */
  | { kind: 'unknown' };

const LEDGER_CODES = new Set<string>(LEDGER_DB_ERROR_CODES);

export function classifyWriteFailure(err: unknown): WriteFailure {
  const text = dbErrorText(err);
  // A RAISE message starts with its code; SQLite never puts bound values into its own messages.
  for (const m of text.matchAll(/(?<![A-Za-z0-9_])(LEDGER_[A-Z_]+):/g)) if (LEDGER_CODES.has(m[1]!)) return { kind: 'ledger', code: m[1] as LedgerDbErrorCode };
  if (/NOT NULL constraint failed: ledger_idempotency_keys\.(result_revision|result_event_id|audit_id)\b/.test(text)) return { kind: 'key_incomplete' };
  if (/UNIQUE constraint failed: ledger_idempotency_keys\.user_id, ledger_idempotency_keys\.key\b/.test(text)) return { kind: 'key_taken' };
  if (/FOREIGN KEY constraint failed/.test(text)) return { kind: 'foreign_key' };
  if (/(CHECK|UNIQUE|NOT NULL|PRIMARY KEY) constraint failed/.test(text)) return { kind: 'constraint' };
  return { kind: 'unknown' };
}

/** A failure the route could not explain from what the caller can see: logged, answered with a generic 500. */
export class LedgerWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LedgerWriteError';
  }
}
