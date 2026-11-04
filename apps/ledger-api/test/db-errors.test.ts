// M3-B2-C2: lib/dbErrors.ts — only SQLite's own messages from the two verified driver shapes
// (libsql, D1; shapes from the M3-B2-C2 probe, real errors in m3-delete-protection.test.ts) are read;
// drizzle's wrapper (which repeats bound values) and errors of any other shape are ignored.
import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { dbMessages, errorForLog } from '../src/lib/dbErrors.ts';
import { isForeignKeyViolation, isTriggerAbort, isUniqueViolation } from '../src/lib/guards.ts';
import { classifyWriteFailure } from '../src/services/transactionErrors.ts';

const FK = 'FOREIGN KEY constraint failed';
const libsqlBatch = (message: string, code: string) =>
  Object.assign(new Error(`SQLITE_CONSTRAINT: SQLITE_CONSTRAINT: ${message}`, { cause: Object.assign(new Error(message), { name: 'SqliteError', code }) }), {
    name: 'LibsqlBatchError',
    code: 'SQLITE_CONSTRAINT',
    extendedCode: code,
  });
const libsqlSingle = (message: string, code: string, params: unknown[]) =>
  new DrizzleQueryError('delete from "x" where "id" = ?', params, Object.assign(new Error(`SQLITE_CONSTRAINT: ${message}`, { cause: Object.assign(new Error(message), { name: 'SqliteError', code }) }), { name: 'LibsqlError', code: 'SQLITE_CONSTRAINT', extendedCode: code }));
const d1 = (message: string, extended: string) => {
  const tail = `: SQLITE_CONSTRAINT (extended: ${extended})`;
  return new Error(`D1_ERROR: ${message}${tail}`, { cause: new Error(`${message}${tail}`) });
};

describe('dbMessages: verified driver shapes only', () => {
  it('reads libsql (batch and single statement) and D1 messages; skips the drizzle wrapper', () => {
    expect(dbMessages(libsqlBatch(FK, 'SQLITE_CONSTRAINT_FOREIGNKEY'))).toEqual([`SQLITE_CONSTRAINT: SQLITE_CONSTRAINT: ${FK}`, FK]);
    expect(dbMessages(libsqlSingle(FK, 'SQLITE_CONSTRAINT_FOREIGNKEY', ['an id']))).toEqual([`SQLITE_CONSTRAINT: ${FK}`, FK]);
    expect(dbMessages(d1(FK, 'SQLITE_CONSTRAINT_FOREIGNKEY'))).toEqual([FK, FK]);
    expect(dbMessages(new DrizzleQueryError('q', ['p'], d1('CHECK constraint failed: a_ck', 'SQLITE_CONSTRAINT_CHECK')))).toEqual(['CHECK constraint failed: a_ck', 'CHECK constraint failed: a_ck']);
    expect(dbMessages(d1('LEDGER_CLASSIFICATION: x', 'SQLITE_CONSTRAINT_TRIGGER'))[0]).toBe('LEDGER_CLASSIFICATION: x');
  });

  it('ignores user text in bound values and every unverified shape', () => {
    const spoof = [FK, `D1_ERROR: ${FK}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)`, 'LEDGER_CLASSIFICATION: x', 'UNIQUE constraint failed: ledger_idempotency_keys.user_id, ledger_idempotency_keys.key'];
    // The wrapper's own message holds those values; its cause is a different, real failure.
    const wrapped = new DrizzleQueryError('insert into "x" values (?)', spoof, libsqlBatch('CHECK constraint failed: x_ck', 'SQLITE_CONSTRAINT_CHECK'));
    expect(dbMessages(wrapped).join(' | ')).not.toMatch(/FOREIGN KEY|LEDGER_|UNIQUE/);
    expect(isForeignKeyViolation(wrapped)).toBe(false);
    expect(isUniqueViolation(wrapped)).toBe(false);
    expect(classifyWriteFailure(wrapped)).toEqual({ kind: 'constraint' });
    // A wrapper with no driver error inside is nothing.
    expect(dbMessages(new DrizzleQueryError('q', spoof))).toEqual([]);
    const unverified: unknown[] = [
      new Error(FK), // plain, wrong shape
      Object.assign(new Error(FK), { code: 'SQLITE_CONSTRAINT' }), // plain with a code
      Object.assign(new Error(FK), { name: 'LibsqlError', code: 'NOT_SQLITE' }), // libsql name, wrong code
      Object.assign(new Error(FK), { name: 'SomethingElse', code: 'SQLITE_CONSTRAINT' }), // unknown class name
      new TypeError(`${FK}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)`), // D1 text in another class
      { message: `D1_ERROR: ${FK}: SQLITE_CONSTRAINT` }, // not an Error
      `D1_ERROR: ${FK}: SQLITE_CONSTRAINT`,
      new Error(`Failed query: x\nparams: ${FK}: SQLITE_CONSTRAINT`), // wrapper-like text in a plain Error
    ];
    for (const err of unverified) {
      expect(dbMessages(err), String((err as Error)?.message ?? err)).toEqual([]);
      expect(isForeignKeyViolation(err)).toBe(false);
      expect(classifyWriteFailure(err)).toEqual({ kind: 'unknown' });
    }
  });

  it('constraint kinds stay apart: a CHECK or UNIQUE failure is not a foreign-key failure; trigger codes match whole words', () => {
    expect(isForeignKeyViolation(d1(FK, 'SQLITE_CONSTRAINT_FOREIGNKEY'))).toBe(true);
    expect(isForeignKeyViolation(libsqlBatch(FK, 'SQLITE_CONSTRAINT_FOREIGNKEY'))).toBe(true);
    for (const err of [d1('CHECK constraint failed: accounts_country_ck', 'SQLITE_CONSTRAINT_CHECK'), libsqlBatch('UNIQUE constraint failed: institutions.name_key', 'SQLITE_CONSTRAINT_UNIQUE')]) {
      expect(isForeignKeyViolation(err)).toBe(false);
    }
    expect(isUniqueViolation(libsqlBatch('UNIQUE constraint failed: institutions.name_key', 'SQLITE_CONSTRAINT_UNIQUE'))).toBe(true);
    expect(isTriggerAbort(d1('BALANCE_ACCOUNT_KIND: x', 'SQLITE_CONSTRAINT_TRIGGER'), 'BALANCE_ACCOUNT_KIND')).toBe(true);
    expect(isTriggerAbort(d1('NOT_BALANCE_ACCOUNT_KIND_X: x', 'SQLITE_CONSTRAINT_TRIGGER'), 'BALANCE_ACCOUNT_KIND')).toBe(false);
    expect(classifyWriteFailure(d1(FK, 'SQLITE_CONSTRAINT_FOREIGNKEY'))).toEqual({ kind: 'foreign_key' });
  });
});

describe('errorForLog: the server log never carries drizzle query text or bound values', () => {
  it('withholds the wrapper, keeps names, SQLite codes, driver messages and stack frames', () => {
    const secret = ['Fictional Merchant 4711', 'private note', 123456789];
    const err = new Error('the transaction write failed', {
      cause: new DrizzleQueryError('insert into "transaction_events" ("merchant_name") values (?)', secret, libsqlBatch(FK, 'SQLITE_CONSTRAINT_FOREIGNKEY')),
    });
    const log = errorForLog(err);
    expect(log).toMatch(/^Error: the transaction write failed/);
    expect(log).toContain('DrizzleQueryError: (query and bound values withheld)');
    expect(log).toContain(`LibsqlBatchError [SQLITE_CONSTRAINT]: SQLITE_CONSTRAINT: SQLITE_CONSTRAINT: ${FK}`);
    expect(log).toContain(`SqliteError [SQLITE_CONSTRAINT_FOREIGNKEY]: ${FK}`);
    expect(log).toMatch(/\n\s+at /); // stack frames of the top error are kept
    for (const s of ['Fictional Merchant', 'private note', '123456789', 'insert into', 'Failed query', 'params:']) expect(log).not.toContain(s);
    // A wrapper at the top: no message, no stack (its stack's first line repeats the message).
    const top = errorForLog(new DrizzleQueryError('select ? as x', ['Fictional Merchant 4711'], d1(FK, 'SQLITE_CONSTRAINT_FOREIGNKEY')));
    expect(top).not.toMatch(/Fictional|select|params/);
    expect(top).toContain(`Error: D1_ERROR: ${FK}`);
    // A non-Error throw is described by its type only.
    expect(errorForLog('Fictional Merchant 4711')).toBe('non-Error string thrown (value withheld)');
    expect(errorForLog(new Error('x', { cause: { merchant: 'Fictional Merchant 4711' } }))).not.toContain('Fictional');
  });
});
