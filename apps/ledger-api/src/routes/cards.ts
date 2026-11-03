import {
  cardCreateSchema,
  cardExpiry,
  cardListQuerySchema,
  DEFAULT_EXPIRING_WITHIN_DAYS,
  epochDay,
  ledgerErrorCode,
  normalizeNameKey,
  utcDate,
  type AccountSummary,
  type CardCreateResult,
  type CardDetail,
  type CardDto,
  type CardListItem,
  type InstitutionSummary,
} from '@xui/ledger-shared';
import { and, asc, eq, ne, sql, type SQL } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { accountCardLinks, accounts, cards, institutions, paymentChannels, paymentChannelSources } from '../db/schema.ts';
import type { AppBindings } from '../env.ts';
import { isForeignKeyViolation, rejectSensitive } from '../lib/guards.ts';
import { body, fail, notFound, query } from '../lib/http.ts';
import { newId } from '../lib/id.ts';
import type { AccountRow } from '../services/accounts.ts';
import { cardAuditStatement, cardCreateBatch, cardPatchValues, cardSearchText, type CardRow, type StoredValueRows } from '../services/cards.ts';
import { accountDto } from './accounts.ts';
import { accountSummary, cardSummary, channelSummary, institutionSummary, toLinkDto } from './summaries.ts';

/**
 * Debit and prepaid cards (API_SPEC §3.4). Every query is scoped to the signed-in user; another
 * user's card — or another user's institution named as issuer — is a 404 like a missing one.
 * - Metadata only. There is no card-number field anywhere: the strict schemas refuse pan,
 *   cardNumber, bin, cvv, cvc, pin, holderName (400 VALIDATION), last4 is exactly four digits, and
 *   name / notes are scanned for card numbers and security codes (400 SENSITIVE_DATA, no bypass;
 *   the error names the field, never the text). Audit records hold the card id and last4 only.
 * - Four regions never stand in for each other: the issuer's country (institutions.country), the
 *   card's issuing country (display only), the account_country of linked accounts, and the
 *   network. Nothing here infers one from another.
 * - New cards need an active issuer (409 INSTITUTION_ARCHIVED), re-checked inside the write batch;
 *   cards of an archived institution stay readable and editable. Moving a card to another issuer
 *   (correcting a wrong pick) needs an active one too.
 * - Expiry (expires_on, YYYY-MM) is derived on read (expiry.ts) and never changes the status:
 *   expired is not closed, and freezing / closing is the user's choice.
 * - DELETE is for correcting mistakes: it removes the card's links (history included) and channel
 *   sources with it, never the accounts. From M3, a card used by a transaction can't be deleted.
 */

type C = Context<AppBindings>;
type CardRowSelect = typeof cards.$inferSelect;

const toDto = (r: CardRowSelect, issuer: InstitutionSummary): CardDto => ({
  id: r.id,
  issuerInstitutionId: r.issuerInstitutionId,
  issuer,
  name: r.name,
  network: r.network,
  cardType: r.cardType,
  form: r.form,
  last4: r.last4,
  issuingCountry: r.issuingCountry,
  expiresOn: r.expiresOn,
  status: r.status,
  notes: r.notes,
  sort: r.sort,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** Cards joined with their issuer (same user on both sides, as the composite key requires). */
const selectCards = (c: C) =>
  c.var.deps.db
    .select({ row: cards, issuer: institutionSummary })
    .from(cards)
    .innerJoin(institutions, and(eq(institutions.id, cards.issuerInstitutionId), eq(institutions.userId, cards.userId)));

const ownCard = (c: C, id: string) => and(eq(cards.id, id), eq(cards.userId, c.var.user.id));

async function loadDto(c: C, id: string): Promise<CardDto> {
  const [r] = await selectCards(c).where(ownCard(c, id));
  if (!r) notFound('card');
  return toDto(r.row, r.issuer);
}

/** An institution of the caller's (any status), or undefined — another user's institution looks missing. */
async function institutionState(c: C, id: string) {
  const [inst] = await c.var.deps.db
    .select({ id: institutions.id, status: institutions.status })
    .from(institutions)
    .where(and(eq(institutions.id, id), eq(institutions.userId, c.var.user.id)));
  return inst;
}

/** 404 for a missing / foreign institution, 409 for an archived one. */
async function requireActiveInstitution(c: C, id: string) {
  const inst = await institutionState(c, id);
  if (!inst) notFound('institution');
  if (inst.status !== 'active') institutionArchived(inst.id);
}

const institutionArchived = (institutionId: string): never =>
  fail(409, 'the institution is archived — restore it before adding a card to it', 'INSTITUTION_ARCHIVED', { institutionId });

const inUse = (): never => fail(409, 'the card is still referenced — close it instead', 'IN_USE');

/** Parse a body with the card-type-aware error code (credit → CARD_TYPE_UNSUPPORTED). */
async function cardBody<S extends z.ZodType>(c: C, schema: S): Promise<z.infer<S>> {
  const r = schema.safeParse(await body(c, z.unknown()));
  if (!r.success) fail(400, 'validation failed', ledgerErrorCode(r.error), r.error.issues);
  return r.data;
}

/** The caller's "today" for expiry: their own calendar date if sent (at most a day away from UTC's, as time zones allow), else UTC's. */
function expiryToday(c: C, sent: string | undefined): string {
  const utc = utcDate(c.var.deps.now());
  if (sent === undefined) return utc;
  if (Math.abs(epochDay(sent)! - epochDay(utc)!) > 1) fail(400, 'invalid query', 'VALIDATION', [{ code: 'custom', path: ['today'], message: 'today must be the current date in some time zone' }]);
  return sent;
}

export const cardRoutes = new Hono<AppBindings>()
  .get('/', async (c) => {
    const q = query(c, cardListQuerySchema);
    const uid = c.var.user.id;
    const conds: SQL[] = [eq(cards.userId, uid)];
    if (q.status === undefined) conds.push(ne(cards.status, 'closed'));
    else if (q.status !== 'all') conds.push(eq(cards.status, q.status));
    if (q.network) conds.push(eq(cards.network, q.network));
    if (q.type) conds.push(eq(cards.cardType, q.type));
    if (q.form) conds.push(eq(cards.form, q.form));
    if (q.issuerId) conds.push(eq(cards.issuerInstitutionId, q.issuerId));
    // Correlated subquery written out by hand: drizzle would render the outer columns unqualified.
    if (q.accountId) {
      conds.push(
        sql`EXISTS (SELECT 1 FROM account_card_links l WHERE l.user_id = "cards"."user_id" AND l.card_id = "cards"."id" AND l.account_id = ${q.accountId} AND l.status <> 'ended')`,
      );
    }
    const { db } = c.var.deps;
    const [rows, linked] = await Promise.all([
      selectCards(c)
        .where(and(...conds))
        .orderBy(asc(cards.sort), asc(cards.name), asc(cards.id)),
      // Accounts with an unfinished link, per card.
      db
        .select({ cardId: accountCardLinks.cardId, account: accountSummary })
        .from(accountCardLinks)
        .innerJoin(accounts, and(eq(accounts.id, accountCardLinks.accountId), eq(accounts.userId, accountCardLinks.userId)))
        .where(and(eq(accountCardLinks.userId, uid), ne(accountCardLinks.status, 'ended')))
        .orderBy(asc(accounts.sort), asc(accounts.nameKey), asc(accounts.id)),
    ]);
    const accountsByCard = new Map<string, AccountSummary[]>();
    for (const l of linked) {
      const list = accountsByCard.get(l.cardId) ?? [];
      if (!list.some((a) => a.id === l.account.id)) list.push(l.account);
      accountsByCard.set(l.cardId, list);
    }

    // Name search (NFKC, like name_key — cards have no stored key) and expiry are evaluated here.
    const needle = q.q === undefined ? '' : normalizeNameKey(q.q);
    const expiryFilter = q.expiry ?? (q.expiringWithinDays !== undefined ? 'expiring' : undefined);
    const today = expiryFilter || q.today !== undefined ? expiryToday(c, q.today) : '';
    const within = q.expiringWithinDays ?? DEFAULT_EXPIRING_WITHIN_DAYS;
    const items: CardListItem[] = rows
      .filter((r) => !needle || cardSearchText(r.row, r.issuer.name).includes(needle))
      .filter((r) => !expiryFilter || cardExpiry(r.row.expiresOn, today, within).status === expiryFilter)
      .map((r) => ({ ...toDto(r.row, r.issuer), linkedAccounts: accountsByCard.get(r.row.id) ?? [] }));
    return c.json(items);
  })

  .post('/', async (c) => {
    const input = await cardBody(c, cardCreateSchema);
    const sv = input.createStoredValueAccount;
    rejectSensitive({ name: input.name, notes: input.notes, 'createStoredValueAccount.name': sv?.name });
    const uid = c.var.user.id;
    // A foreign or missing institution is a 404 (never revealing its status); an archived own one is a 409.
    await requireActiveInstitution(c, input.issuerInstitutionId);
    const svInstitutionId = sv ? (sv.institutionId ?? input.issuerInstitutionId) : null;
    if (svInstitutionId && svInstitutionId !== input.issuerInstitutionId) await requireActiveInstitution(c, svInstitutionId);

    const now = c.var.deps.now();
    const id = newId(now);
    const card: CardRow = {
      id,
      userId: uid,
      issuerInstitutionId: input.issuerInstitutionId,
      name: input.name,
      network: input.network,
      cardType: input.cardType,
      form: input.form ?? 'physical',
      last4: input.last4,
      issuingCountry: input.issuingCountry,
      expiresOn: input.expiresOn ?? null,
      status: input.status ?? 'active',
      notes: input.notes ?? null,
      sort: input.sort ?? 0,
      createdAt: now,
      updatedAt: now,
    };
    let storedValue: StoredValueRows | undefined;
    if (sv && svInstitutionId) {
      const account: AccountRow = {
        id: newId(now),
        userId: uid,
        institutionId: svInstitutionId,
        name: sv.name,
        nameKey: normalizeNameKey(sv.name),
        accountType: 'stored_value',
        depositKind: null,
        // Entered by the user, never taken from the card's issuing country.
        accountCountry: sv.accountCountry,
        numberHint: null,
        status: 'active',
        openedOn: null,
        closedOn: null,
        notes: null,
        sort: 0,
        createdAt: now,
        updatedAt: now,
      };
      storedValue = {
        account,
        currency: { accountId: account.id, userId: uid, currency: sv.currency, isDefault: true, status: 'active', sort: 0, createdAt: now },
        // The stored-value account is the card's default spending source for every currency.
        link: { id: newId(now), userId: uid, cardId: id, accountId: account.id, currency: null, role: 'spending_source', isDefault: true, status: 'active', createdAt: now, updatedAt: now },
      };
    }

    const { db } = c.var.deps;
    // The issuer (or the account's institution) archived or deleted between the check and the batch.
    const lostRace = async (): Promise<never> => {
      for (const instId of [input.issuerInstitutionId, svInstitutionId]) if (instId) await requireActiveInstitution(c, instId);
      throw new Error('card create wrote nothing although its institutions are active');
    };
    try {
      await db.batch(cardCreateBatch(db, card, storedValue, { id: newId(now), ip: c.var.ip, now }));
    } catch (err) {
      // With a stored-value account, a row that was not written makes the next one fail its foreign key: all rolled back.
      if (isForeignKeyViolation(err)) await lostRace();
      throw err;
    }
    const [written] = await selectCards(c).where(ownCard(c, id));
    if (!written) await lostRace(); // card alone: the INSERT … SELECT wrote zero rows (and no audit)

    const result: CardCreateResult = { card: toDto(written!.row, written!.issuer) };
    if (storedValue) {
      result.account = await accountDto(c, storedValue.account.id);
      const [link] = await db
        .select({ link: accountCardLinks, card: cardSummary, account: accountSummary })
        .from(accountCardLinks)
        .innerJoin(cards, and(eq(cards.id, accountCardLinks.cardId), eq(cards.userId, accountCardLinks.userId)))
        .innerJoin(accounts, and(eq(accounts.id, accountCardLinks.accountId), eq(accounts.userId, accountCardLinks.userId)))
        .where(and(eq(accountCardLinks.userId, uid), eq(accountCardLinks.id, storedValue.link.id)));
      result.link = toLinkDto(link!);
    }
    return c.json(result, 201);
  })

  .get('/:id', async (c) => {
    const id = c.req.param('id');
    const dto = await loadDto(c, id);
    const { db } = c.var.deps;
    const uid = c.var.user.id;
    const [links, channels, sources] = await Promise.all([
      db
        .select({ link: accountCardLinks, card: cardSummary, account: accountSummary })
        .from(accountCardLinks)
        .innerJoin(cards, and(eq(cards.id, accountCardLinks.cardId), eq(cards.userId, accountCardLinks.userId)))
        .innerJoin(accounts, and(eq(accounts.id, accountCardLinks.accountId), eq(accounts.userId, accountCardLinks.userId)))
        .where(and(eq(accountCardLinks.userId, uid), eq(accountCardLinks.cardId, id)))
        .orderBy(asc(accountCardLinks.createdAt), asc(accountCardLinks.id)),
      // Channels listing the card as an active funding source.
      db
        .selectDistinct(channelSummary)
        .from(paymentChannelSources)
        .innerJoin(paymentChannels, and(eq(paymentChannels.id, paymentChannelSources.channelId), eq(paymentChannels.userId, paymentChannelSources.userId)))
        .where(and(eq(paymentChannelSources.userId, uid), eq(paymentChannelSources.cardId, id), eq(paymentChannelSources.status, 'active')))
        .orderBy(asc(paymentChannels.name), asc(paymentChannels.id)),
      // Every channel-source record of the card (ended ones too): what a DELETE removes with it.
      db
        .select({ status: paymentChannelSources.status, n: sql<number>`count(*)` })
        .from(paymentChannelSources)
        .where(and(eq(paymentChannelSources.userId, uid), eq(paymentChannelSources.cardId, id)))
        .groupBy(paymentChannelSources.status),
    ]);
    const count = (status: string) => Number(sources.find((r) => r.status === status)?.n ?? 0);
    const detail: CardDetail = { ...dto, links: links.map(toLinkDto), channels, channelSourceCounts: { active: count('active'), ended: count('ended') } };
    return c.json(detail);
  })

  .patch('/:id', async (c) => {
    const parsed = cardPatchValues(await body(c, z.unknown()), c.var.deps.now());
    if (!parsed.ok) fail(400, 'validation failed', parsed.code, parsed.issues);
    const { values } = parsed;
    const id = c.req.param('id');
    const { db } = c.var.deps;
    const [current] = await db.select().from(cards).where(ownCard(c, id));
    if (!current) notFound('card');
    rejectSensitive({ name: values.name, notes: values.notes });

    // Moving the card to another issuer (fixing a wrong pick) needs an active institution of the
    // caller's; re-checked inside the UPDATE so an archive in between can't slip through.
    const moveTo = values.issuerInstitutionId !== undefined && values.issuerInstitutionId !== current.issuerInstitutionId ? values.issuerInstitutionId : null;
    if (moveTo) await requireActiveInstitution(c, moveTo);
    const conds = [ownCard(c, id)!];
    if (moveTo) conds.push(sql`EXISTS (SELECT 1 FROM institutions i WHERE i.id = ${moveTo} AND i.user_id = ${c.var.user.id} AND i.status = 'active')`);
    // The write phase on its own (a one-statement batch, like the create): whatever happened since
    // the pre-check, the EXISTS above is evaluated by the UPDATE itself.
    const [updated] = await db.batch([
      db
        .update(cards)
        .set(values)
        .where(and(...conds))
        .returning({ id: cards.id }),
    ]);
    if (!updated.length) {
      // Deleted in between (404), or the new issuer archived / deleted in between (409 / 404).
      const [still] = await db.select({ id: cards.id }).from(cards).where(ownCard(c, id));
      if (!still) notFound('card');
      if (moveTo) await requireActiveInstitution(c, moveTo);
      throw new Error('card update wrote nothing');
    }
    return c.json(await loadDto(c, id));
  })

  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    const { db } = c.var.deps;
    const now = c.var.deps.now();
    let deleted: { id: string }[];
    try {
      // One batch: the audit record (read from the card row, so only if it still exists), then the
      // delete, which cascades to its links (ended ones too) and channel sources in the same
      // statement; accounts, currencies and channels stay. A refused delete rolls the audit back.
      [, deleted] = await db.batch([
        cardAuditStatement(db, 'card.delete', { id, userId: c.var.user.id }, { id: newId(now), ip: c.var.ip, now }),
        db.delete(cards).where(ownCard(c, id)).returning({ id: cards.id }),
      ]);
    } catch (err) {
      // From M3: a transaction referencing the card (NO ACTION) refuses the delete.
      if (isForeignKeyViolation(err)) inUse();
      throw err;
    }
    // Missing, another user's, or deleted by a concurrent request: 404 either way (and no audit).
    if (!deleted.length) notFound('card');
    return c.json({ ok: true });
  });
