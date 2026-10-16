import { and, asc, eq, inArray } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { mergeExtra, type CustomFieldEntity, fieldsFor } from '@z-ui/shared';
import type { DB } from '../db/client.ts';
import { accountCurrencies, accounts, cards, categories, institutions, tags } from '../db/schema.ts';
import type { Deps } from '../env.ts';
import { fail, notFound } from './http.ts';

/** Run statements atomically (libsql transaction / D1 batch). */
export async function runBatch(db: DB, ops: BatchItem<'sqlite'>[]) {
  if (ops.length === 0) return;
  await db.batch(ops as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
}

// Ownership lookups: a row that belongs to someone else is indistinguishable from a missing one.

export async function ownInstitution(db: DB, userId: string, id: string) {
  const [r] = await db.select().from(institutions).where(and(eq(institutions.id, id), eq(institutions.userId, userId)));
  return r ?? notFound('institution');
}

export async function ownAccount(db: DB, userId: string, id: string) {
  const [r] = await db.select().from(accounts).where(and(eq(accounts.id, id), eq(accounts.userId, userId)));
  return r ?? notFound('account');
}

/** Currencies held by an account, primary first. */
export async function currenciesOf(db: DB, accountId: string): Promise<string[]> {
  const rows = await db
    .select({ currency: accountCurrencies.currency })
    .from(accountCurrencies)
    .where(eq(accountCurrencies.accountId, accountId))
    .orderBy(asc(accountCurrencies.sort));
  return rows.map((r) => r.currency);
}

/** Resolve the currency for a booking on an account: the requested one (must be held) or the primary. */
export async function accountCurrency(db: DB, account: { id: string; currency: string; name: string }, requested?: string | null) {
  if (!requested || requested === account.currency) return account.currency;
  const held = await currenciesOf(db, account.id);
  if (!held.includes(requested)) fail(400, `${account.name} does not hold ${requested}`, 'CURRENCY_NOT_HELD');
  return requested;
}

export async function ownCard(db: DB, userId: string, id: string) {
  const [r] = await db.select().from(cards).where(and(eq(cards.id, id), eq(cards.userId, userId)));
  return r ?? notFound('card');
}

export async function ownCategory(db: DB, userId: string, id: string) {
  const [r] = await db.select().from(categories).where(and(eq(categories.id, id), eq(categories.userId, userId)));
  return r ?? notFound('category');
}

export async function assertOwnTags(db: DB, userId: string, ids: string[] | undefined) {
  const unique = [...new Set(ids ?? [])];
  if (unique.length === 0) return [];
  const rows = await db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.userId, userId), inArray(tags.id, unique)));
  if (rows.length !== unique.length) notFound('tag');
  return unique;
}

export function assertCurrency(deps: Deps, code: string) {
  if (!deps.config.get().currencies.some((c) => c.code === code)) {
    fail(400, `currency ${code} is not enabled in the config`, 'UNKNOWN_CURRENCY');
  }
}

/** Validate custom field values from the request against config and merge over stored values. */
export function applyExtra(
  deps: Deps,
  entity: CustomFieldEntity,
  stored: Record<string, unknown>,
  incoming: Record<string, unknown> | undefined,
) {
  const r = mergeExtra(fieldsFor(deps.config.get(), entity), stored, incoming);
  if (!r.ok) fail(400, r.errors.join('; '), 'CUSTOM_FIELDS', r.errors);
  return r.value;
}

/** Drop undefined keys so partial updates don't overwrite columns with NULL. */
export function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
