import {
  accountCreateSchema,
  accountCurrenciesReplaceSchema,
  accountListQuerySchema,
  BALANCE_ACCOUNT_TYPES,
  normalizeNameKey,
  type AccountCurrencyDto,
  type AccountDetail,
  type AccountDto,
  type AccountInUseDetails,
  type AccountListItem,
  type CardSummary,
  type ChannelSummary,
  type CurrencyInUseDetails,
  type InstitutionSummary,
} from '@xui/ledger-shared';
import { and, asc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { accountCardLinks, accountCurrencies, accounts, cards, institutions, paymentChannels, paymentChannelSources } from '../db/schema.ts';
import type { AppBindings } from '../env.ts';
import { audit } from '../lib/audit.ts';
import { isForeignKeyViolation, isTriggerAbort, likeContains, rejectSensitive } from '../lib/guards.ts';
import { body, fail, notFound, query } from '../lib/http.ts';
import { newId } from '../lib/id.ts';
import { accountSummary, cardSummary, channelSummary, institutionSummary, toLinkDto } from './summaries.ts';
import { accountCreateBatch, accountPatchValues, currencyReplacePlan, currencyRows, type AccountRow as NewAccountRow } from '../services/accounts.ts';

/**
 * Accounts that hold money (API_SPEC §3.3). Every query is scoped to the signed-in user; another
 * user's account — or an institution of another user named in a create — is a 404.
 * - An account belongs to exactly one institution, chosen at creation and never changed (PATCH
 *   refuses institutionId; the accounts_institution_immutable trigger backs it up). New accounts
 *   need an active institution (409 INSTITUTION_ARCHIVED); existing accounts of an archived
 *   institution stay readable and editable.
 * - account_country is entered by the user and never inferred from the institution.
 * - Currencies: 1–30, no repeats, exactly one default and it is active. Created and replaced in
 *   one db.batch() (D1 has no interactive transactions). A currency still referenced by a card
 *   link can't be removed (409 CURRENCY_IN_USE) — it is closed instead, keeping the link.
 * - No balance of any kind is stored or returned.
 * - Closing or freezing an account changes nothing else: links and defaults stay, the account is
 *   just no longer offered as a funding source (spending-source recommendation, M3 transactions).
 */

type C = Context<AppBindings>;
type AccountRow = typeof accounts.$inferSelect;

const toDto = (r: AccountRow, institution: InstitutionSummary, currencies: AccountCurrencyDto[]): AccountDto => ({
  id: r.id,
  institutionId: r.institutionId,
  institution,
  name: r.name,
  accountType: r.accountType,
  depositKind: r.depositKind,
  accountCountry: r.accountCountry,
  numberHint: r.numberHint,
  status: r.status,
  openedOn: r.openedOn,
  closedOn: r.closedOn,
  notes: r.notes,
  sort: r.sort,
  currencies,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** Accounts joined with their institution (same user on both sides, as the composite key requires). */
const selectAccounts = (c: C) =>
  c.var.deps.db
    .select({ row: accounts, institution: institutionSummary })
    .from(accounts)
    .innerJoin(institutions, and(eq(institutions.id, accounts.institutionId), eq(institutions.userId, accounts.userId)));

const ownAccount = (c: C, id: string) => and(eq(accounts.id, id), eq(accounts.userId, c.var.user.id));

/** Currencies of the caller's accounts (or of one account), grouped by account, in list order. */
async function currenciesByAccount(c: C, accountId?: string): Promise<Map<string, AccountCurrencyDto[]>> {
  const conds = [eq(accountCurrencies.userId, c.var.user.id)];
  if (accountId) conds.push(eq(accountCurrencies.accountId, accountId));
  const rows = await c.var.deps.db
    .select()
    .from(accountCurrencies)
    .where(and(...conds))
    .orderBy(asc(accountCurrencies.accountId), asc(accountCurrencies.sort), asc(accountCurrencies.currency));
  const out = new Map<string, AccountCurrencyDto[]>();
  for (const r of rows) {
    const list = out.get(r.accountId) ?? [];
    list.push({ currency: r.currency, isDefault: r.isDefault, status: r.status, sort: r.sort });
    out.set(r.accountId, list);
  }
  return out;
}

/** The account DTO of one of the caller's accounts (404 otherwise); also used by POST /cards for a new stored-value account. */
export async function accountDto(c: C, id: string): Promise<AccountDto> {
  const [r] = await selectAccounts(c).where(ownAccount(c, id));
  if (!r) notFound('account');
  return toDto(r.row, r.institution, (await currenciesByAccount(c, id)).get(id) ?? []);
}

/** Channels using the account as their balance account (they block deleting it). */
const balanceChannels = (c: C, accountId: string): Promise<ChannelSummary[]> =>
  c.var.deps.db
    .select(channelSummary)
    .from(paymentChannels)
    .where(and(eq(paymentChannels.userId, c.var.user.id), eq(paymentChannels.balanceAccountId, accountId)))
    .orderBy(asc(paymentChannels.sort), asc(paymentChannels.nameKey), asc(paymentChannels.id));

/** Which of `currencies` are still referenced by a card link of the account (any link status). */
async function currenciesInUse(c: C, accountId: string, currencies: string[]): Promise<string[]> {
  if (!currencies.length) return [];
  const rows = await c.var.deps.db
    .selectDistinct({ currency: accountCardLinks.currency })
    .from(accountCardLinks)
    .where(and(eq(accountCardLinks.userId, c.var.user.id), eq(accountCardLinks.accountId, accountId), inArray(accountCardLinks.currency, currencies)));
  return rows.map((r) => r.currency!).sort();
}

const currencyInUse = (currencies: string[]): never =>
  fail(409, 'a currency still used by a card link cannot be removed — close it instead', 'CURRENCY_IN_USE', { currencies } satisfies CurrencyInUseDetails);

const accountInUse = (channels: ChannelSummary[]): never =>
  fail(409, 'the account is the balance account of a payment channel', 'IN_USE', {
    references: { balanceOfChannels: channels.length },
    channels,
  } satisfies AccountInUseDetails);

const balanceKind = (channels: ChannelSummary[]): never =>
  fail(400, 'a payment channel balance account must stay e_money or stored_value', 'BALANCE_ACCOUNT_KIND', { channels });

/** New accounts are only opened at active institutions: restore the institution first. */
const institutionArchived = (institutionId: string): never =>
  fail(409, 'the institution is archived — restore it before opening a new account', 'INSTITUTION_ARCHIVED', { institutionId });

const invalid = (path: string, message: string): never => fail(400, 'validation failed', 'VALIDATION', [{ code: 'custom', path: [path], message }]);

export const accountRoutes = new Hono<AppBindings>()
  .get('/', async (c) => {
    const q = query(c, accountListQuerySchema);
    const uid = c.var.user.id;
    const conds: SQL[] = [eq(accounts.userId, uid)];
    if (q.status === undefined) conds.push(ne(accounts.status, 'closed'));
    else if (q.status !== 'all') conds.push(eq(accounts.status, q.status));
    if (q.institutionId) conds.push(eq(accounts.institutionId, q.institutionId));
    if (q.type) conds.push(eq(accounts.accountType, q.type));
    if (q.country) conds.push(eq(accounts.accountCountry, q.country));
    // Correlated subqueries are written out by hand: drizzle would render the outer columns unqualified.
    if (q.currency) {
      conds.push(sql`EXISTS (SELECT 1 FROM account_currencies ac WHERE ac.user_id = "accounts"."user_id" AND ac.account_id = "accounts"."id" AND ac.currency = ${q.currency})`);
    }
    if (q.cardId) {
      conds.push(
        sql`EXISTS (SELECT 1 FROM account_card_links l WHERE l.user_id = "accounts"."user_id" AND l.account_id = "accounts"."id" AND l.card_id = ${q.cardId} AND l.status <> 'ended')`,
      );
    }
    const needle = q.q === undefined ? '' : normalizeNameKey(q.q);
    if (needle) {
      const like = likeContains(needle);
      conds.push(
        or(
          sql`${accounts.nameKey} LIKE ${like} ESCAPE '\\'`,
          sql`${institutions.nameKey} LIKE ${like} ESCAPE '\\'`,
          sql`lower(${accounts.numberHint}) LIKE ${like} ESCAPE '\\'`,
        )!,
      );
    }
    const { db } = c.var.deps;
    const [rows, currencies, linked] = await Promise.all([
      selectAccounts(c)
        .where(and(...conds))
        .orderBy(asc(accounts.sort), asc(accounts.nameKey), asc(accounts.name), asc(accounts.id)),
      currenciesByAccount(c),
      // Cards with an unfinished link, per account.
      db
        .select({ accountId: accountCardLinks.accountId, card: cardSummary })
        .from(accountCardLinks)
        .innerJoin(cards, and(eq(cards.id, accountCardLinks.cardId), eq(cards.userId, accountCardLinks.userId)))
        .where(and(eq(accountCardLinks.userId, uid), ne(accountCardLinks.status, 'ended')))
        .orderBy(asc(cards.sort), asc(cards.name), asc(cards.id)),
    ]);
    const cardsByAccount = new Map<string, CardSummary[]>();
    for (const l of linked) {
      const list = cardsByAccount.get(l.accountId) ?? [];
      if (!list.some((card) => card.id === l.card.id)) list.push(l.card);
      cardsByAccount.set(l.accountId, list);
    }
    const items: AccountListItem[] = rows.map((r) => {
      const linkedCards = cardsByAccount.get(r.row.id) ?? [];
      return { ...toDto(r.row, r.institution, currencies.get(r.row.id) ?? []), linkedCardCount: linkedCards.length, linkedCards: linkedCards.slice(0, 3) };
    });
    return c.json(items);
  })

  .post('/', async (c) => {
    const input = await body(c, accountCreateSchema);
    rejectSensitive({ name: input.name, notes: input.notes, numberHint: input.numberHint });
    const { db } = c.var.deps;
    const uid = c.var.user.id;
    const institutionState = async () => {
      const [inst] = await db
        .select({ id: institutions.id, status: institutions.status })
        .from(institutions)
        .where(and(eq(institutions.id, input.institutionId), eq(institutions.userId, uid)));
      return inst;
    };
    // Another user's institution is a 404 like a missing one; an archived one of the caller's own is a 409.
    const inst = await institutionState();
    if (!inst) notFound('institution');
    if (inst.status !== 'active') institutionArchived(inst.id);

    const now = c.var.deps.now();
    const id = newId(now);
    const row: NewAccountRow = {
      id,
      userId: uid,
      institutionId: inst.id,
      name: input.name,
      nameKey: normalizeNameKey(input.name),
      accountType: input.accountType,
      depositKind: input.depositKind ?? null,
      accountCountry: input.accountCountry,
      numberHint: input.numberHint ?? null,
      status: input.status ?? 'active',
      openedOn: input.openedOn ?? null,
      closedOn: input.closedOn ?? null,
      notes: input.notes ?? null,
      sort: input.sort ?? 0,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await db.batch(accountCreateBatch(db, row, currencyRows(id, uid, input.currencies, now)));
    } catch (err) {
      // The institution was archived or deleted between the check and the batch: the batch wrote
      // no account, its currencies failed their foreign key and everything rolled back.
      if (isForeignKeyViolation(err)) {
        const now = await institutionState();
        if (!now) notFound('institution');
        if (now.status !== 'active') institutionArchived(now.id);
      }
      throw err;
    }
    return c.json(await accountDto(c, id), 201);
  })

  .get('/:id', async (c) => {
    const id = c.req.param('id');
    const dto = await accountDto(c, id);
    const { db } = c.var.deps;
    const uid = c.var.user.id;
    const [links, balanceOf, sourceOf] = await Promise.all([
      db
        .select({ link: accountCardLinks, card: cardSummary, account: accountSummary })
        .from(accountCardLinks)
        .innerJoin(cards, and(eq(cards.id, accountCardLinks.cardId), eq(cards.userId, accountCardLinks.userId)))
        .innerJoin(accounts, and(eq(accounts.id, accountCardLinks.accountId), eq(accounts.userId, accountCardLinks.userId)))
        .where(and(eq(accountCardLinks.userId, uid), eq(accountCardLinks.accountId, id)))
        .orderBy(asc(accountCardLinks.createdAt), asc(accountCardLinks.id)),
      balanceChannels(c, id),
      db
        .selectDistinct(channelSummary)
        .from(paymentChannelSources)
        .innerJoin(paymentChannels, and(eq(paymentChannels.id, paymentChannelSources.channelId), eq(paymentChannels.userId, paymentChannelSources.userId)))
        .where(and(eq(paymentChannelSources.userId, uid), eq(paymentChannelSources.accountId, id), eq(paymentChannelSources.status, 'active')))
        .orderBy(asc(paymentChannels.name), asc(paymentChannels.id)),
    ]);
    const detail: AccountDetail = {
      ...dto,
      links: links.map(toLinkDto),
      balanceOfChannels: balanceOf,
      sourceOfChannels: sourceOf,
    };
    return c.json(detail);
  })

  .patch('/:id', async (c) => {
    // The service turns the body into the update; institutionId (or any unknown field) is a 400.
    const patch = accountPatchValues(await body(c, z.unknown()), c.var.deps.now());
    if (!patch.ok) fail(400, 'validation failed', patch.code, patch.issues);
    const { values } = patch;
    const id = c.req.param('id');
    const { db } = c.var.deps;
    const [current] = await db.select().from(accounts).where(ownAccount(c, id));
    if (!current) notFound('account');
    rejectSensitive({ name: values.name, notes: values.notes, numberHint: values.numberHint });

    // Cross-field rules against the stored row (the schema can only compare fields of the body).
    const type = values.accountType ?? current.accountType;
    const depositKind = values.depositKind !== undefined ? values.depositKind : current.depositKind;
    if (depositKind != null && type !== 'bank') invalid('depositKind', 'depositKind is only for bank accounts');
    const openedOn = values.openedOn !== undefined ? values.openedOn : current.openedOn;
    const closedOn = values.closedOn !== undefined ? values.closedOn : current.closedOn;
    if (openedOn && closedOn && closedOn < openedOn) invalid('closedOn', 'closedOn is before openedOn');
    if (values.accountType && !(BALANCE_ACCOUNT_TYPES as readonly string[]).includes(values.accountType)) {
      const channels = await balanceChannels(c, id);
      if (channels.length) balanceKind(channels);
    }

    try {
      await db.update(accounts).set(values).where(ownAccount(c, id));
    } catch (err) {
      // A channel took the account as its balance account in between: the trigger refuses the type.
      if (isTriggerAbort(err, 'BALANCE_ACCOUNT_KIND')) balanceKind(await balanceChannels(c, id));
      throw err;
    }
    return c.json(await accountDto(c, id));
  })

  .put('/:id/currencies', async (c) => {
    const input = await body(c, accountCurrenciesReplaceSchema);
    const id = c.req.param('id');
    const { db } = c.var.deps;
    const [current] = await db.select({ id: accounts.id, userId: accounts.userId }).from(accounts).where(ownAccount(c, id));
    if (!current) notFound('account');
    const existing = await db
      .select({ currency: accountCurrencies.currency })
      .from(accountCurrencies)
      .where(and(eq(accountCurrencies.accountId, id), eq(accountCurrencies.userId, current.userId)));
    const plan = currencyReplacePlan(
      db,
      current,
      existing.map((r) => r.currency),
      input.currencies,
      c.var.deps.now(),
    );
    const used = await currenciesInUse(c, id, plan.removed);
    if (used.length) currencyInUse(used);
    try {
      await db.batch(plan.batch);
    } catch (err) {
      // Referenced between the check and the batch: the NO ACTION key refused the DELETE, nothing changed.
      if (isForeignKeyViolation(err)) {
        const now = await currenciesInUse(c, id, plan.removed);
        currencyInUse(now.length ? now : plan.removed);
      }
      throw err;
    }
    return c.json(await accountDto(c, id));
  })

  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    const { db } = c.var.deps;
    const [current] = await db.select({ id: accounts.id }).from(accounts).where(ownAccount(c, id));
    if (!current) notFound('account');
    const channels = await balanceChannels(c, id);
    if (channels.length) accountInUse(channels);
    try {
      // Cascades to its currencies, card links and channel sources in the same statement.
      await db.delete(accounts).where(ownAccount(c, id));
    } catch (err) {
      // Made a balance account in between (or, from M3, referenced by an entry): NO ACTION refuses.
      if (isForeignKeyViolation(err)) accountInUse(await balanceChannels(c, id));
      throw err;
    }
    await audit(c, 'account.delete', { id });
    return c.json({ ok: true });
  });
