import {
  cardLinkCreateSchema,
  cardLinkEndSchema,
  cardLinkUpdateSchema,
  epochDay,
  utcDate,
  type CardLinkDto,
  type CardLinkStatus,
  type DuplicateDetails,
  type LinkStateDetails,
} from '@xui/ledger-shared';
import { and, eq, ne, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { accountCardLinks, accounts, cards } from '../db/schema.ts';
import type { AppBindings } from '../env.ts';
import { isForeignKeyViolation, isUniqueViolation, nothingToUpdate, rejectSensitive } from '../lib/guards.ts';
import { body, errorChain, fail, notFound, optionalBody } from '../lib/http.ts';
import { newId } from '../lib/id.ts';
import { linkCreateBatch, linkDeleteBatch, linkEndBatch, setDefaultStatements, type LinkRow } from '../services/cardLinks.ts';
import { selectLinkDtos, toLinkDto } from './summaries.ts';

/**
 * Card ↔ account links (API_SPEC §3.5). Many-to-many: a card may have several links (to several
 * accounts, currency scopes and roles) and an account may back several cards. Every query is
 * scoped to the signed-in user: another user's link, card or account is a 404 like a missing one,
 * and the composite foreign keys refuse cross-user rows at the database whatever the route does.
 * - Lifecycle: active ⇄ suspended (PATCH) → ended (POST /end, final: the record and its dates stay
 *   as history; a new link is created instead). Suspending or ending clears the default flag;
 *   resuming does not restore it. DELETE is only for correcting mistakes.
 * - Ended links may still have their notes edited; any other change is 409 LINK_STATE.
 * - Changing the role away from spending_source clears the default flag too (only spending
 *   sources can be defaults — the CHECK agrees).
 * - Card, account and currency scope are fixed once created (no PATCH field): to change them, end
 *   the link (keeping its history) and create another.
 * - Each rule is enforced in one place, by the write itself — composite foreign keys, the unique
 *   index of unfinished links, INSERT … SELECT from an active account currency, UPDATE … WHERE on
 *   the link's status and role — so there is no separate pre-check a concurrent request could slip
 *   past. When a write is refused or changes nothing, the route re-reads to give the reason.
 * - Freezing or closing the account, the card or an account currency changes no link: those
 *   sources are just not recommended (GET /cards/:id/spending-source) until restored.
 */

type C = Context<AppBindings>;

const ownLink = (c: C, id: string) => and(eq(accountCardLinks.id, id), eq(accountCardLinks.userId, c.var.user.id));

async function linkRow(c: C, id: string) {
  const [row] = await c.var.deps.db.select().from(accountCardLinks).where(ownLink(c, id));
  return row;
}

async function loadDto(c: C, id: string): Promise<CardLinkDto> {
  const [r] = await selectLinkDtos(c.var.deps.db).where(ownLink(c, id));
  if (!r) notFound('card link');
  return toLinkDto(r);
}

const linkState = (status: CardLinkStatus): never =>
  fail(409, status === 'ended' ? 'the link has ended — create a new link instead' : 'the link is suspended — resume it first', 'LINK_STATE', { status } satisfies LinkStateDetails);

const duplicate = (existingId: string): never =>
  fail(409, 'the card already has an unfinished link to this account with the same currency scope and role', 'DUPLICATE', { existingId } satisfies DuplicateDetails);

const currencyNotOnAccount = (currency: string): never => fail(400, `${currency} is not an active currency of the account`, 'CURRENCY_NOT_ON_ACCOUNT', { currency });

const invalid = (path: string, message: string): never => fail(400, 'validation failed', 'VALIDATION', [{ code: 'custom', path: [path], message }]);

/** The unique index of unfinished links (card, account, currency scope, role) refused a write. */
const isOpenDuplicate = (err: unknown) => isUniqueViolation(err) && /account_card_links_open_uq|account_card_links\.card_id/.test(errorChain(err));

/** The unfinished link with this card, account, currency scope and role (other than `except`). */
async function openTwin(c: C, l: { cardId: string; accountId: string; currency: string | null; role: string }, except?: string) {
  const [twin] = await c.var.deps.db
    .select({ id: accountCardLinks.id })
    .from(accountCardLinks)
    .where(
      and(
        eq(accountCardLinks.userId, c.var.user.id),
        eq(accountCardLinks.cardId, l.cardId),
        eq(accountCardLinks.accountId, l.accountId),
        sql`ifnull(${accountCardLinks.currency}, '') = ${l.currency ?? ''}`,
        eq(accountCardLinks.role, l.role as LinkRow['role']),
        ne(accountCardLinks.status, 'ended'),
        except ? ne(accountCardLinks.id, except) : undefined,
      ),
    );
  return twin?.id;
}

const exists = async (c: C, table: typeof cards | typeof accounts, id: string) =>
  (await c.var.deps.db.select({ id: table.id }).from(table).where(and(eq(table.id, id), eq(table.userId, c.var.user.id)))).length > 0;

/** After a link write that changed nothing: the link is gone (404), or its role (400) or status (409) forbids the change. */
async function explainNoChange(c: C, id: string, needsSpendingRole = false): Promise<never> {
  const now = await linkRow(c, id);
  if (!now) notFound('card link');
  if (needsSpendingRole && now.role !== 'spending_source') invalid('role', 'only a spending_source link can be the default');
  if (now.status === 'active') throw new Error('card link write changed nothing although the link is active');
  return linkState(now.status);
}

const auditEntry = (c: C) => {
  const now = c.var.deps.now();
  return { id: newId(now), ip: c.var.ip, now };
};

export const cardLinkRoutes = new Hono<AppBindings>()
  .post('/', async (c) => {
    const input = await body(c, cardLinkCreateSchema);
    rejectSensitive({ notes: input.notes });
    const now = c.var.deps.now();
    const row: LinkRow = {
      id: newId(now),
      userId: c.var.user.id,
      cardId: input.cardId,
      accountId: input.accountId,
      currency: input.currency ?? null,
      role: input.role ?? 'spending_source',
      isDefault: false,
      priority: input.priority ?? null,
      status: 'active',
      startedOn: input.startedOn ?? null,
      endedOn: null,
      notes: input.notes ?? null,
      createdAt: now,
      updatedAt: now,
    };
    const { db } = c.var.deps;
    // Another user's card or account (or a missing one) is a 404, never revealing it exists.
    const missingRef = async () => {
      if (!(await exists(c, cards, row.cardId))) notFound('card');
      if (!(await exists(c, accounts, row.accountId))) notFound('account');
    };
    try {
      await db.batch(linkCreateBatch(db, row, input.isDefault === true, auditEntry(c)));
    } catch (err) {
      // Not the caller's card or account: the composite foreign keys refuse the row — or, when that
      // other user has the very same link, the (not user-scoped) unique index refuses it first.
      // Ownership is settled before a duplicate is reported, so a 409 never reveals another user's link.
      if (isForeignKeyViolation(err) || isOpenDuplicate(err)) await missingRef();
      if (isOpenDuplicate(err)) duplicate((await openTwin(c, row)) ?? row.id);
      throw err;
    }
    const [written] = await selectLinkDtos(db).where(ownLink(c, row.id));
    if (!written) {
      // The INSERT … SELECT found no such active currency of the caller's account: a foreign or
      // missing account, or a currency the account does not hold (any more) or has closed.
      await missingRef();
      if (row.currency) currencyNotOnAccount(row.currency);
      throw new Error('card link create wrote nothing');
    }
    return c.json(toLinkDto(written), 201);
  })

  .patch('/:id', async (c) => {
    const patch = await body(c, cardLinkUpdateSchema);
    if (Object.keys(patch).length === 0) nothingToUpdate();
    rejectSensitive({ notes: patch.notes });
    const id = c.req.param('id');
    const values: Partial<LinkRow> = { updatedAt: c.var.deps.now() };
    if (patch.role !== undefined) values.role = patch.role;
    if (patch.priority !== undefined) values.priority = patch.priority;
    if (patch.notes !== undefined) values.notes = patch.notes;
    if (patch.status !== undefined) values.status = patch.status;
    // Whatever the flag is: only an active spending source can stay the default.
    if (patch.status === 'suspended' || (patch.role !== undefined && patch.role !== 'spending_source')) values.isDefault = false;
    // Ended is final — only the notes may still change. The UPDATE itself checks, so a concurrent /end wins.
    const changesState = patch.role !== undefined || patch.priority !== undefined || patch.status !== undefined;

    const { db } = c.var.deps;
    let updated: { id: string }[];
    try {
      [updated] = await db.batch([
        db
          .update(accountCardLinks)
          .set(values)
          .where(and(ownLink(c, id), changesState ? ne(accountCardLinks.status, 'ended') : undefined))
          .returning({ id: accountCardLinks.id }),
      ]);
    } catch (err) {
      // A new role that another unfinished link of the same card, account and scope already has.
      const current = isOpenDuplicate(err) ? await linkRow(c, id) : undefined;
      if (current) duplicate((await openTwin(c, { ...current, role: patch.role ?? current.role }, id)) ?? id);
      throw err;
    }
    if (!updated.length) await explainNoChange(c, id);
    return c.json(await loadDto(c, id));
  })

  .post('/:id/default', async (c) => {
    await optionalBody(c, z.strictObject({}));
    const id = c.req.param('id');
    // Read for the card and currency scope (both fixed); the rules are checked by the batch itself.
    const current = await linkRow(c, id);
    if (!current) notFound('card link');
    if (!current.isDefault) {
      const { db } = c.var.deps;
      const [, set] = await db.batch(setDefaultStatements(db, current, c.var.deps.now()));
      if (!set.length) await explainNoChange(c, id, true);
    }
    return c.json(await loadDto(c, id));
  })

  .post('/:id/end', async (c) => {
    const input = await optionalBody(c, cardLinkEndSchema);
    const id = c.req.param('id');
    const current = await linkRow(c, id);
    if (!current) notFound('card link');
    const today = utcDate(c.var.deps.now());
    const endedOn = input.endedOn ?? today;
    // A calendar date of the caller's: at most a day ahead of UTC's (time zones), and not before the start (fixed once created).
    if (epochDay(endedOn)! > epochDay(today)! + 1) invalid('endedOn', 'endedOn is in the future');
    if (current.startedOn && endedOn < current.startedOn) invalid('endedOn', 'endedOn is before startedOn');

    const { db } = c.var.deps;
    // Audit and update only while the link is not ended yet: ending twice is a 409 with nothing written.
    const [, ended] = await db.batch(linkEndBatch(db, current, endedOn, auditEntry(c)));
    if (!ended.length) await explainNoChange(c, id);
    return c.json(await loadDto(c, id));
  })

  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    const { db } = c.var.deps;
    // The audit record and the delete in one batch; missing, another user's or already deleted → 404, no audit.
    const [, deleted] = await db.batch(linkDeleteBatch(db, { id, userId: c.var.user.id }, auditEntry(c)));
    if (!deleted.length) notFound('card link');
    return c.json({ ok: true });
  });
