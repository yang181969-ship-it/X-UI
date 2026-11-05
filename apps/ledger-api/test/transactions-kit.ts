// M3-B2 transaction API test kit: the two engines (libsql temporary file database, wrangler's local
// in-memory D1 — never a remote D1), a signed-in user with fictional institutions, accounts, a
// card and a channel created through the M2 API, request builders and database probes.
import { expect, vi } from 'vitest';
import { CSRF_HEADER } from '../src/auth/middleware.ts';
import { startD1App } from './d1-app.ts';
import { login, makeUser, ORIGIN, setup, type TestEnv } from './helpers.ts';
import { correctChain, nid, steps, voidChain, type CorrectIn, type EventFactsIn } from './m3-ledger.ts';

export type Rows = Record<string, unknown>[];
export interface Engine {
  name: 'libsql' | 'd1';
  t: TestEnv;
  all: (sql: string, ...args: unknown[]) => Promise<Rows>;
  exec: (sql: string, ...args: unknown[]) => Promise<unknown>;
  ping: () => Promise<void>;
  dispose: () => Promise<void>;
}

async function libsqlEngine(): Promise<Engine> {
  const t = await setup();
  return {
    name: 'libsql',
    t,
    all: async (sql, ...args) => {
      const r = await t.client.execute({ sql, args: args as never });
      return r.rows.map((row) => Object.fromEntries(r.columns.map((col, i) => [col, row[i]])));
    },
    exec: (sql, ...args) => t.client.execute({ sql, args: args as never }),
    ping: async () => {},
    dispose: () => t.cleanup(),
  };
}

async function d1Engine(name: string): Promise<Engine> {
  const h = await startD1App(name);
  return { name: 'd1', t: h.t, all: h.all, exec: (sql, ...args) => h.d1.prepare(sql).bind(...args).run(), ping: h.ping, dispose: h.dispose };
}

export const startEngine = (name: 'libsql' | 'd1', label: string) => (name === 'libsql' ? libsqlEngine() : d1Engine(label));

export type Api = Awaited<ReturnType<typeof login>>;
type Body = Record<string, unknown>;

let seq = 0;
/** A valid, unique idempotency key (16–64 of [0-9A-Za-z_-]). */
export const newKey = () => `key-${Date.now().toString(36)}-${String(++seq).padStart(6, '0')}`;

/**
 * A user with: institution I; accounts HK (bank, HK: HKD default, USD), BE (e_money, BE: USD
 * default, EUR, GBP closed), CN (bank, CN: CNY default), US (bank, US: USD default); card K;
 * channel PP. Home region CN (no preferences row).
 */
export async function seedUser(e: Engine, prefix = 'u') {
  const u = await makeUser(e.t, `${e.name}-${prefix}-${++seq}`);
  const api = await login(e.t, u);
  const created = async (path: string, body: Body) => {
    const r = await api.post(path, body);
    expect(r.status, `${path} ${JSON.stringify(r.json)}`).toBe(201);
    return r.json;
  };
  const I = (await created('/api/institutions', { name: `Bank ${++seq}`, country: 'GB', institutionType: 'bank' })).id as string;
  const account = async (name: string, accountType: string, accountCountry: string, currencies: { code: string; isDefault?: boolean }[]) =>
    (await created('/api/accounts', { institutionId: I, name: `${name} ${++seq}`, accountType, accountCountry, currencies })).id as string;
  const HK = await account('HK', 'bank', 'HK', [{ code: 'HKD', isDefault: true }, { code: 'USD' }]);
  const BE = await account('BE', 'e_money', 'BE', [{ code: 'USD', isDefault: true }, { code: 'EUR' }, { code: 'GBP' }]);
  await e.exec("UPDATE account_currencies SET status = 'closed' WHERE account_id = ? AND currency = 'GBP'", BE);
  const CN = await account('CN', 'bank', 'CN', [{ code: 'CNY', isDefault: true }]);
  const US = await account('US', 'bank', 'US', [{ code: 'USD', isDefault: true }]);
  const K = (await created('/api/cards', { issuerInstitutionId: I, name: `Card ${++seq}`, network: 'visa', cardType: 'debit', last4: '4321', issuingCountry: 'BE' })).card.id as string;
  const PP = (await created('/api/payment-channels', { name: `Wallet ${++seq}`, channelType: 'payment_service' })).id as string;
  const post = (body: Body, key: string | null = newKey(), headers: Record<string, string> = {}) =>
    api.req('POST', '/api/transactions', body, key === null ? headers : { 'idempotency-key': key, ...headers });
  /** A POST with a key, the response body as the exact bytes the server sent (no JSON parsing). */
  const bytesAt = async (path: string, body: Body, key: string) => {
    const res = await e.t.app.request(path, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        [CSRF_HEADER]: '1',
        'content-type': 'application/json',
        'idempotency-key': key,
        cookie: [...api.jar].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: JSON.stringify(body),
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, res, bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  };
  const postBytes = (body: Body, key: string) => bytesAt('/api/transactions', body, key);
  /** POST /transactions/:id/void (M3-B3-B). */
  const voidTx = (T: string, body: Body, key: string | null = newKey(), headers: Record<string, string> = {}) =>
    api.req('POST', `/api/transactions/${T}/void`, body, key === null ? headers : { 'idempotency-key': key, ...headers });
  const voidBytes = (T: string, body: Body, key: string) => bytesAt(`/api/transactions/${T}/void`, body, key);
  /** POST /transactions/:id/revisions (M3-B3-C). */
  const correct = (T: string, body: Body, key: string | null = newKey(), headers: Record<string, string> = {}) =>
    api.req('POST', `/api/transactions/${T}/revisions`, body, key === null ? headers : { 'idempotency-key': key, ...headers });
  const correctBytes = (T: string, body: Body, key: string) => bytesAt(`/api/transactions/${T}/revisions`, body, key);
  /** PATCH /transactions/:id/notes (M3-B3-B). */
  const notes = (T: string, body: unknown, headers: Record<string, string> = {}) => api.req('PATCH', `/api/transactions/${T}/notes`, body, headers);
  /** Sign in again in the same cookie jar (sessions expire after 7 idle days; tests move the clock by weeks). */
  const relogin = async () => {
    const fresh = await login(e.t, u);
    api.jar.clear();
    for (const [k, v] of fresh.jar) api.jar.set(k, v);
  };
  return { id: u.user.id, api, I, HK, BE, CN, US, K, PP, post, postBytes, voidTx, voidBytes, correct, correctBytes, notes, relogin };
}
export type Seed = Awaited<ReturnType<typeof seedUser>>;

/** A foreign spend: HK account, HKD 78.30 for USD 10.00 at a US merchant, card K. */
export const spend = (s: Seed, x: Body = {}): Body => ({
  type: 'merchant_spend',
  occurredOn: '2026-10-14',
  occurredTime: '14:05',
  eventCurrency: 'USD',
  eventAmount: 1000,
  merchantName: 'Example Store',
  merchantCountry: 'US',
  cardId: s.K,
  entries: [{ direction: 'out', accountId: s.HK, currency: 'HKD', amountStatus: 'confirmed', amount: 7830 }],
  ...x,
});

/** A complete fact correction built from a create body (no type / notes / declaredHomeRegion; recordMode stated, M3-B3-C). */
export const factOf = (create: Body, x: Body = {}): Body => {
  const { type: _t, notes: _n, declaredHomeRegion: _d, ...rest } = create;
  return { kind: 'fact_correction', baseRevision: 1, reason: 'facts were wrong', recordMode: 'current', ...rest, ...x };
};

/** HK → BE own transfer between two registered accounts (USD 1 000.00 out, USD 999.00 in). */
export const ownTransfer = (s: Seed, x: Body = {}): Body => ({
  type: 'own_transfer',
  occurredOn: '2026-10-14',
  eventCurrency: 'USD',
  eventAmount: 100000,
  transferMethod: 'swift',
  entries: [
    { direction: 'out', accountId: s.HK, currency: 'USD', amountStatus: 'confirmed', amount: 100000 },
    { direction: 'in', accountId: s.BE, currency: 'USD', amountStatus: 'confirmed', amount: 99900 },
  ],
  ...x,
});

export const M3_TABLES = ['transactions', 'transaction_events', 'transaction_entries', 'ledger_idempotency_keys'] as const;

/** Rows of one user in the four M3 tables, and that user's transaction.* audit records. */
export async function counts(e: Engine, userId: string) {
  const out: Record<string, number> = {};
  for (const t of M3_TABLES) out[t] = Number((await e.all(`SELECT count(*) AS n FROM ${t} WHERE user_id = ?`, userId))[0]!.n);
  out.audit = Number((await e.all("SELECT count(*) AS n FROM audit_log WHERE user_id = ? AND action LIKE 'transaction.%'", userId))[0]!.n);
  return out;
}
export const NONE = { transactions: 0, transaction_events: 0, transaction_entries: 0, ledger_idempotency_keys: 0, audit: 0 };
export const ONE_SPEND = { transactions: 1, transaction_events: 1, transaction_entries: 1, ledger_idempotency_keys: 1, audit: 1 };

/** Every row of the M3 tables and audit_log ("nothing changed" checks). */
export async function ledgerDump(e: Engine) {
  const out: Record<string, Rows> = {};
  for (const t of [...M3_TABLES, 'audit_log']) out[t] = await e.all(`SELECT * FROM ${t} ORDER BY rowid`);
  return out;
}

export const eventRow = async (e: Engine, transactionId: string) => (await e.all('SELECT * FROM transaction_events WHERE transaction_id = ? ORDER BY revision', transactionId))[0]!;
export const entryRows = async (e: Engine, eventId: string) => e.all("SELECT * FROM transaction_entries WHERE event_id = ? ORDER BY CASE direction WHEN 'out' THEN 0 ELSE 1 END", eventId);
export const keyRow = async (e: Engine, userId: string, key: string) => (await e.all('SELECT * FROM ledger_idempotency_keys WHERE user_id = ? AND key = ?', userId, key))[0];

/** The generic answer to anything the server can't explain. */
export const INTERNAL = { error: 'internal error', code: 'INTERNAL' };

/** Words that must never appear in an error response (database internals). */
export const LEAKS = /LEDGER_|constraint|FOREIGN KEY|UNIQUE|NOT NULL|CHECK|SQLITE|D1_ERROR|transaction_e|ledger_idempotency|account_currencies|audit_log|Failed query/i;

/** Run `fn` while a BEFORE trigger on `table` raises `message` (console noise of the 500 is muted). */
export async function raising<R>(e: Engine, table: string, event: 'INSERT' | 'UPDATE' | 'DELETE', when: string | null, message: string, fn: () => Promise<R>): Promise<R> {
  const name = `test_raise_${table}_${++seq}`;
  await e.exec(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table}${when ? ` FOR EACH ROW WHEN ${when}` : ''} BEGIN SELECT RAISE(ABORT, '${message}'); END`);
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    quiet.mockRestore();
    await e.exec(`DROP TRIGGER ${name}`);
  }
}

/**
 * An error shaped exactly like the given engine's driver reports a SQLite failure (shapes verified
 * by the M3-B2-C2 probe; lib/dbErrors.ts trusts only these): libsql's LibsqlBatchError → SqliteError,
 * D1's "D1_ERROR: <message>: SQLITE_CONSTRAINT (extended: …)" → "<message>: …".
 */
export function driverError(engine: Engine['name'], message: string, extended: string): Error {
  if (engine === 'libsql') {
    const inner = Object.assign(new Error(message), { name: 'SqliteError', code: extended });
    return Object.assign(new Error(`SQLITE_CONSTRAINT: SQLITE_CONSTRAINT: ${message}`, { cause: inner }), { name: 'LibsqlBatchError', code: 'SQLITE_CONSTRAINT', extendedCode: extended });
  }
  const tail = `: SQLITE_CONSTRAINT (extended: ${extended})`;
  return new Error(`D1_ERROR: ${message}${tail}`, { cause: new Error(`${message}${tail}`) });
}

/** Mute the 500 log while `fn` runs. */
export async function quietly<R>(fn: () => Promise<R>): Promise<R> {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    quiet.mockRestore();
  }
}

/**
 * Spy on db.batch: each entry of `hooks` wraps one call in order (before / after the real batch,
 * or instead of it, or on a transformed statement list); later calls run unchanged. Returns the spy
 * (call count = write attempts).
 */
export function batchHooks(
  e: Engine,
  hooks: { before?: () => Promise<unknown>; after?: (error: unknown) => Promise<unknown>; replace?: () => Promise<never>; transform?: (batch: readonly unknown[]) => readonly unknown[] }[],
) {
  const db = e.t.db;
  const original = db.batch.bind(db);
  let call = 0;
  return vi.spyOn(db, 'batch').mockImplementation(async (batch) => {
    const h = hooks[call++];
    if (!h) return original(batch as never);
    if (h.replace) return h.replace();
    await h.before?.();
    try {
      const r = await original((h.transform ? h.transform(batch as readonly unknown[]) : batch) as never);
      await h.after?.(undefined);
      return r;
    } catch (err) {
      await h.after?.(err);
      throw err;
    }
  });
}

// ------------------------------------------------------------------ versions through the M3-B1 chains (no correction route before M3-B3-C; voidTxn predates the void route)

/** A new version r+1 through the M3-B1 fact-correction chain (facts changed, snapshots carried). */
export async function factCorrection(e: Engine, s: Seed, T: string, changes: Partial<EventFactsIn>, entryChange?: { accountId: string; currency: string }) {
  const r = Number((await e.all('SELECT current_revision FROM transactions WHERE id = ?', T))[0]!.current_revision);
  const prev = (await e.all('SELECT * FROM transaction_events WHERE transaction_id = ? AND revision = ?', T, r))[0]!;
  const prevEntries = await entryRows(e, String(prev.id));
  const facts: EventFactsIn = {
    recordMode: prev.record_mode as never, occurredOn: String(prev.occurred_on), occurredTime: prev.occurred_time as string | null, postedOn: prev.posted_on as string | null,
    eventCurrency: prev.event_currency as string | null, eventAmount: prev.event_amount as number | null, eventCurrencyExponent: prev.event_currency_exponent as number | null,
    merchantName: prev.merchant_name as string | null, merchantCountry: prev.merchant_country as string | null, cardId: prev.card_id as string | null,
    paymentChannelId: prev.payment_channel_id as string | null, transferMethod: prev.transfer_method as string | null, counterpartyKind: prev.counterparty_kind as never,
    counterpartyName: prev.counterparty_name as string | null, counterpartyCountry: prev.counterparty_country as string | null,
    counterpartyInstitution: prev.counterparty_institution as string | null, counterpartyAccountHint: prev.counterparty_account_hint as string | null,
    ...changes,
  };
  const x: CorrectIn = {
    u: s.id, T, E: nid('E'), O: nid('O'), A: nid('A'), now: e.t.clock.t, ip: null, key: newKey(), requestHash: '0'.repeat(64), hashVersion: 1,
    baseRevision: r, kind: 'fact_correction', reason: `fix ${r}`, facts, correctedHomeRegion: null,
    classification: { merchantScope: prev.merchant_scope as string | null, transferScope: prev.transfer_scope as string | null, foreignStatus: String(prev.foreign_status) },
    entries: prevEntries.map((en) =>
      entryChange
        ? { id: nid('N'), direction: en.direction as never, accountId: entryChange.accountId, currency: entryChange.currency, amount: en.amount as number | null, amountStatus: en.amount_status as never, exponent: 2, closedCurrencyAck: false }
        : { id: nid('N'), direction: en.direction as never, accountId: String(en.funding_account_id), currency: String(en.funding_currency), amount: en.amount as number | null, amountStatus: en.amount_status as never, exponent: Number(en.currency_exponent), closedCurrencyAck: false, carriedFromEntryId: String(en.id) },
    ),
  };
  await e.t.db.batch(steps(correctChain(e.t.db, x)));
  return { revision: r + 1, eventId: x.E, entryIds: x.entries.map((en) => en.id) };
}
export async function voidTxn(e: Engine, s: Seed, T: string, reason: string | null = null) {
  const r = Number((await e.all('SELECT current_revision FROM transactions WHERE id = ?', T))[0]!.current_revision);
  await e.t.db.batch(steps(voidChain(e.t.db, { u: s.id, T, now: e.t.clock.t, ip: null, key: newKey(), requestHash: '0'.repeat(64), hashVersion: 1, baseRevision: r, reason, O: nid('O'), A: nid('A') })));
}
