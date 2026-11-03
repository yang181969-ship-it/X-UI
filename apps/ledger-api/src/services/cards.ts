import { cardUpdateSchema, ledgerErrorCode, normalizeNameKey, type CardUpdate } from '@xui/ledger-shared';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { DB } from '../db/client.ts';
import { accountCardLinks, accountCurrencies, accounts, auditLog, cards } from '../db/schema.ts';
import type { AuditAction } from '../lib/audit.ts';
import { insertIfInstitutionActive, type AccountRow, type Batch } from './accounts.ts';

/**
 * Card service rules (API_SPEC §3.4). Cards hold metadata only: no PAN, BIN, CVV, PIN or holder
 * name exists anywhere in the schema, so none can be written (strict request schemas refuse the
 * fields; free text is scanned by the route).
 */

/** Every column of the cards row, defaults included. */
export type CardRow = Required<typeof cards.$inferInsert>;
type CurrencyRow = typeof accountCurrencies.$inferInsert;
type LinkRow = typeof accountCardLinks.$inferInsert;

/** A prepaid card's stored-value account, its one (default) currency and the default spending link to it. */
export interface StoredValueRows {
  account: AccountRow;
  currency: CurrencyRow;
  link: LinkRow;
}

/** Id, client IP and time of the audit record a card write produces. */
export interface AuditEntry {
  id: string;
  ip: string | null;
  now: number;
}

/**
 * INSERT INTO audit_log … SELECT … FROM cards WHERE (this card, this user). Placed in the same
 * batch as the card write, it is written exactly when the card row exists inside that transaction:
 * a create that wrote no card (issuer archived in between) or a delete of a card that is already
 * gone records nothing, and a failing audit insert rolls the card write back with it. detail is
 * { id, last4 } read from the row itself, plus the given ids — never names, notes or the request.
 */
export function cardAuditStatement(db: DB, action: AuditAction, card: { id: string; userId: string }, entry: AuditEntry, ids: Record<string, string> = {}) {
  const pairs: SQL[] = [sql`'id', ${cards.id}`, sql`'last4', ${cards.last4}`, ...Object.entries(ids).map(([key, value]) => sql`${key}, ${value}`)];
  const row = {
    id: sql`${entry.id}`.as('id'),
    userId: sql`${card.userId}`.as('user_id'),
    action: sql`${action}`.as('action'),
    detail: sql`json_object(${sql.join(pairs, sql`, `)})`.as('detail'),
    ip: sql`${entry.ip}`.as('ip'),
    createdAt: sql`${entry.now}`.as('created_at'),
  } satisfies Record<keyof typeof auditLog.$inferSelect, unknown>;
  return db.insert(auditLog).select(
    db
      .select(row)
      .from(cards)
      .where(and(eq(cards.id, card.id), eq(cards.userId, card.userId))),
  );
}

/**
 * POST /cards: one db.batch() — a single transaction on libsql and on D1. New cards need an active
 * issuer of the same user, re-checked inside the batch like new accounts
 * (insertIfInstitutionActive): the card row is an INSERT … SELECT that writes nothing once the
 * issuer is archived or gone.
 * - Card alone: card → audit. A card write of zero rows is no error (and writes no audit), so the
 *   route reads the card back afterwards.
 * - With a stored-value account (prepaid only): card → account → currency → link → audit. If the
 *   card was not written, the link fails its (card_id, user_id) foreign key; if the account was
 *   not written (its institution archived), the currency fails its (account_id, user_id) key.
 * Any failing statement — those keys, a constraint, a database error, the audit insert — rolls the
 * whole batch back: no card, account, currency, link or audit record is left behind.
 */
export function cardCreateBatch(db: DB, card: CardRow, storedValue: StoredValueRows | undefined, audit: AuditEntry): Batch {
  const insertCard = insertIfInstitutionActive(db, cards, card, card.issuerInstitutionId);
  if (!storedValue) return [insertCard, cardAuditStatement(db, 'card.create', card, audit)];
  return [
    insertCard,
    insertIfInstitutionActive(db, accounts, storedValue.account, storedValue.account.institutionId),
    db.insert(accountCurrencies).values(storedValue.currency),
    db.insert(accountCardLinks).values(storedValue.link),
    cardAuditStatement(db, 'card.create', card, audit, { accountId: storedValue.account.id, linkId: storedValue.link.id! }),
  ];
}

/** Columns a card PATCH may write: never id, user_id or created_at (the schema refuses them as unknown fields). */
export type CardPatchColumns = Partial<
  Pick<typeof cards.$inferInsert, 'issuerInstitutionId' | 'name' | 'network' | 'cardType' | 'form' | 'last4' | 'issuingCountry' | 'expiresOn' | 'status' | 'notes' | 'sort'>
> & { updatedAt: number };

export type CardPatchResult = { ok: true; patch: CardUpdate; values: CardPatchColumns } | { ok: false; code: 'VALIDATION' | 'CARD_TYPE_UNSUPPORTED'; issues: z.core.$ZodIssue[] };

/**
 * Validate a PATCH /cards/:id body and turn it into the update. Unknown fields (userId, id,
 * createdAt, pan, cvv, force, …) are a VALIDATION error, a card type other than debit / prepaid
 * is CARD_TYPE_UNSUPPORTED, an empty body is refused. Database checks (is the new issuer the
 * caller's and active) are the route's.
 */
export function cardPatchValues(body: unknown, now: number): CardPatchResult {
  const parsed = cardUpdateSchema.safeParse(body);
  if (!parsed.success) return { ok: false, code: ledgerErrorCode(parsed.error), issues: parsed.error.issues };
  const patch = parsed.data;
  if (Object.keys(patch).length === 0) return { ok: false, code: 'VALIDATION', issues: [{ code: 'custom', path: [], message: 'nothing to update', input: undefined }] };
  const values: CardPatchColumns = { updatedAt: now };
  if (patch.issuerInstitutionId !== undefined) values.issuerInstitutionId = patch.issuerInstitutionId;
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.network !== undefined) values.network = patch.network;
  if (patch.cardType !== undefined) values.cardType = patch.cardType;
  if (patch.form !== undefined) values.form = patch.form;
  if (patch.last4 !== undefined) values.last4 = patch.last4;
  if (patch.issuingCountry !== undefined) values.issuingCountry = patch.issuingCountry;
  if (patch.expiresOn !== undefined) values.expiresOn = patch.expiresOn;
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.notes !== undefined) values.notes = patch.notes;
  if (patch.sort !== undefined) values.sort = patch.sort;
  return { ok: true, patch, values };
}

/** Search key of a card for `q`: name and issuer name normalized like name_key, plus the last four digits. */
export const cardSearchText = (card: { name: string; last4: string }, issuerName: string) => `${normalizeNameKey(card.name)}\n${normalizeNameKey(issuerName)}\n${card.last4}`;
