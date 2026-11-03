import type { AccountSummary, CardLinkRole, CardLinkStatus, CardStatus, SpendingSkipReason, SpendingSourceCandidate, SpendingSourceResult } from '@xui/ledger-shared';
import { and, eq, ne, sql, type SQL } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { accountCardLinks, accountCurrencies, auditLog } from '../db/schema.ts';
import type { AuditAction } from '../lib/audit.ts';
import { rowAsSelect, type Batch } from './accounts.ts';
import type { AuditEntry } from './cards.ts';

/**
 * Card ↔ account link rules (API_SPEC §3.5, DATA_MODEL §3.5, §5). Links are many-to-many: a card
 * may fund from several accounts and an account may back several cards. Every multi-statement
 * write is one db.batch() — a single transaction on libsql and on D1 — and every condition the
 * route checked first is re-checked by the statements themselves, so a concurrent change can make
 * a write do nothing (the route then re-reads and answers 404 / 400 / 409), never half of it.
 * - At most one default spending source per card and currency scope: "set default" clears the old
 *   default and sets the new one in the same batch, in that order, so no statement ever sees two
 *   (the partial unique index account_card_links_default_uq is the last line of defence).
 * - The audit records of API_SPEC §3.7 (card_link.create / end / delete) are INSERT … SELECT from
 *   the link row in the same batch as the change, conditioned like it: written exactly when the
 *   change is.
 */

export type LinkRow = Required<typeof accountCardLinks.$inferInsert>;
type LinkKey = { id: string; userId: string };

const ownLink = (link: LinkKey, ...more: (SQL | undefined)[]) => and(eq(accountCardLinks.id, link.id), eq(accountCardLinks.userId, link.userId), ...more);

/**
 * INSERT INTO audit_log … SELECT … FROM account_card_links WHERE (this link, this user[, cond]).
 * detail is { id, cardId, accountId } read from the row — ids only, never notes or the request.
 */
export function linkAuditStatement(db: DB, action: Extract<AuditAction, `card_link.${string}`>, link: LinkKey, entry: AuditEntry, cond?: SQL) {
  const row = {
    id: sql`${entry.id}`.as('id'),
    userId: sql`${link.userId}`.as('user_id'),
    action: sql`${action}`.as('action'),
    detail: sql`json_object('id', ${accountCardLinks.id}, 'cardId', ${accountCardLinks.cardId}, 'accountId', ${accountCardLinks.accountId})`.as('detail'),
    ip: sql`${entry.ip}`.as('ip'),
    createdAt: sql`${entry.now}`.as('created_at'),
  } satisfies Record<keyof typeof auditLog.$inferSelect, unknown>;
  return db.insert(auditLog).select(db.select(row).from(accountCardLinks).where(ownLink(link, cond)));
}

/**
 * Make `link` the default spending source of its card and currency scope: clear the scope's other
 * default, then set this one. Both statements only act while the link is (still, inside the
 * transaction) an active spending_source of the user's; otherwise neither changes anything and
 * the caller sees zero rows from the second. Card and currency scope of a link never change.
 */
export function setDefaultStatements(db: DB, link: LinkKey & { cardId: string; currency: string | null }, now: number) {
  const eligible = sql`EXISTS (SELECT 1 FROM account_card_links t WHERE t.id = ${link.id} AND t.user_id = ${link.userId} AND t.status = 'active' AND t.role = 'spending_source')`;
  return [
    db
      .update(accountCardLinks)
      .set({ isDefault: false, updatedAt: now })
      .where(
        and(
          eq(accountCardLinks.userId, link.userId),
          eq(accountCardLinks.cardId, link.cardId),
          sql`ifnull(${accountCardLinks.currency}, '') = ${link.currency ?? ''}`,
          eq(accountCardLinks.isDefault, true),
          ne(accountCardLinks.id, link.id),
          eligible,
        ),
      ),
    db
      .update(accountCardLinks)
      .set({ isDefault: true, updatedAt: now })
      .where(ownLink(link, eq(accountCardLinks.status, 'active'), eq(accountCardLinks.role, 'spending_source')))
      .returning({ id: accountCardLinks.id }),
  ] as const;
}

/**
 * POST /card-links. The link is inserted as not default; with a currency scope it is an
 * INSERT … SELECT from that account currency while it is active, so a currency closed (or removed)
 * after the route's check writes nothing. Then, if asked, set-default (which only acts if the new
 * row exists), then the audit record (likewise). A link to a card or account deleted in between
 * fails its composite foreign key and the batch rolls back; so does a duplicate (unique index).
 */
export function linkCreateBatch(db: DB, row: LinkRow, makeDefault: boolean, audit: AuditEntry): Batch {
  const insert = row.currency
    ? db
        .insert(accountCardLinks)
        .select(
          db
            .select(rowAsSelect(accountCardLinks, { ...row, isDefault: false }))
            .from(accountCurrencies)
            .where(
              and(
                eq(accountCurrencies.accountId, row.accountId),
                eq(accountCurrencies.userId, row.userId),
                eq(accountCurrencies.currency, row.currency),
                eq(accountCurrencies.status, 'active'),
              ),
            ) as never,
        )
    : db.insert(accountCardLinks).values({ ...row, isDefault: false });
  return [insert, ...(makeDefault ? setDefaultStatements(db, row, row.createdAt) : []), linkAuditStatement(db, 'card_link.create', row, audit)];
}

/**
 * POST /card-links/:id/end: the audit record, then the update — both only while the link is not
 * ended yet, so ending twice (or concurrently) records and changes nothing the second time.
 * Ending clears the default flag (the CHECK allows defaults on active links only).
 */
export function linkEndBatch(db: DB, link: LinkKey, endedOn: string, audit: AuditEntry): Batch {
  const open = ne(accountCardLinks.status, 'ended');
  return [
    linkAuditStatement(db, 'card_link.end', link, audit, open),
    db
      .update(accountCardLinks)
      .set({ status: 'ended', isDefault: false, endedOn, updatedAt: audit.now })
      .where(ownLink(link, open))
      .returning({ id: accountCardLinks.id }),
  ];
}

/** DELETE /card-links/:id (correcting mistakes): audit record read from the row, then the delete. */
export function linkDeleteBatch(db: DB, link: LinkKey, audit: AuditEntry): Batch {
  return [linkAuditStatement(db, 'card_link.delete', link, audit), db.delete(accountCardLinks).where(ownLink(link)).returning({ id: accountCardLinks.id })];
}

// ------------------------------------------------------------------ spending-source recommendation

export interface SourceLink {
  id: string;
  accountId: string;
  currency: string | null;
  role: CardLinkRole;
  status: CardLinkStatus;
  isDefault: boolean;
  priority: number | null;
  createdAt: number;
}
export interface SourceInput {
  link: SourceLink;
  account: AccountSummary;
  /** Every currency of the link's account. */
  currencies: { currency: string; isDefault: boolean; status: 'active' | 'closed'; sort: number }[];
}

/** scope(link): the active currencies the link can fund from — its own currency if active, else every active one of the account (default first, then by sort). */
export function linkScope({ link, currencies }: SourceInput): string[] {
  const active = currencies.filter((c) => c.status === 'active');
  if (link.currency !== null) return active.some((c) => c.currency === link.currency) ? [link.currency] : [];
  return [...active].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.sort - b.sort || a.currency.localeCompare(b.currency)).map((c) => c.currency);
}

/** rank: default first, currency-specific before all-currency, priority ascending (none last), oldest, then id (a total order: stable results). */
export function compareLinks(a: SourceLink, b: SourceLink): number {
  return (
    Number(b.isDefault) - Number(a.isDefault) ||
    Number(b.currency !== null) - Number(a.currency !== null) ||
    (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) ||
    a.createdAt - b.createdAt ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function skipReason(input: SourceInput, scope: string[]): SpendingSkipReason | null {
  if (input.link.role !== 'spending_source') return 'not_spending_source';
  if (input.link.status !== 'active') return 'link_suspended';
  if (input.account.status !== 'active') return 'account_inactive';
  if (scope.length === 0) return 'currency_closed';
  return null;
}

/**
 * GET /cards/:id/spending-source (DATA_MODEL §5). Pure: the route reads the card, its links and
 * their accounts' currencies (one consistent snapshot) and nothing is written.
 * - The card must be active, else no_match / card_inactive (expiry is not status: an expired but
 *   active card is still considered — expiry.ts).
 * - Eligible link: spending_source, active, its account active, a non-empty scope. Ended links are
 *   history and not considered at all.
 * - A currency match beats the default flag: any eligible link whose scope holds the event
 *   currency wins over a default that would need a conversion. Among equals, rank decides.
 * - Only exact_currency names a funding currency; conversion_required lists the source's active
 *   currencies as candidates and never picks one (not even the account default). No rate, no amount.
 */
export function recommendSpendingSource(cardStatus: CardStatus, eventCurrency: string, inputs: SourceInput[]): SpendingSourceResult {
  if (cardStatus !== 'active') return { match: 'no_match', eventCurrency, reason: 'card_inactive', considered: [] };
  const considered: SpendingSourceCandidate[] = inputs
    .filter((i) => i.link.status !== 'ended')
    .sort((a, b) => compareLinks(a.link, b.link))
    .map((i) => {
      const scope = linkScope(i);
      const skipped = skipReason(i, scope);
      return {
        linkId: i.link.id,
        account: i.account,
        currency: i.link.currency,
        role: i.link.role,
        status: i.link.status,
        isDefault: i.link.isDefault,
        priority: i.link.priority,
        scope,
        skipped,
        exact: skipped === null && scope.includes(eventCurrency),
      };
    });
  // Stable partition of the ranked list: exact, then convertible, then skipped.
  const tier = (c: SpendingSourceCandidate) => (c.exact ? 0 : c.skipped === null ? 1 : 2);
  considered.sort((a, b) => tier(a) - tier(b));
  const best = considered[0];
  if (best && best.exact) return { match: 'exact_currency', eventCurrency, accountId: best.account.id, linkId: best.linkId, fundingCurrency: eventCurrency, considered };
  if (best && best.skipped === null) {
    return { match: 'conversion_required', eventCurrency, accountId: best.account.id, linkId: best.linkId, fundingCurrency: null, candidateCurrencies: best.scope, considered };
  }
  return { match: 'no_match', eventCurrency, reason: 'no_eligible_link', considered };
}
