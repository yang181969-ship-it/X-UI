import {
  channelSourceCreateSchema,
  channelSourceUpdateSchema,
  ledgerErrorCode,
  normalizeNameKey,
  paymentChannelCreateSchema,
  paymentChannelListQuerySchema,
  paymentChannelUpdateSchema,
  type ChannelSourceDto,
  type ChannelTypeChangeDetails,
  type DuplicateDetails,
  type InstitutionSummary,
  type LinkStateDetails,
  type TransactionReferencesDetails,
  type PaymentChannelDetail,
  type PaymentChannelDto,
  type PaymentChannelListItem,
  type AccountSummary,
} from '@xui/ledger-shared';
import { and, asc, eq, isNotNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { accounts, cards, institutions, paymentChannels, paymentChannelSources } from '../db/schema.ts';
import type { AppBindings } from '../env.ts';
import { dbErrorText } from '../lib/dbErrors.ts';
import { body, fail, notFound, optionalBody, query } from '../lib/http.ts';
import { isForeignKeyViolation, isTriggerAbort, isUniqueViolation, likeContains, nothingToUpdate, rejectSensitive } from '../lib/guards.ts';
import { newId } from '../lib/id.ts';
import { transactionsUsingChannel } from '../services/transactionReferences.ts';
import {
  activeProvider,
  channelDeleteBatch,
  channelInsert,
  noAccountSources,
  sourceCreateBatch,
  sourceDefaultStatements,
  sourceDeleteStatement,
  sourceEndStatement,
  sourceUpdateStatement,
  type ChannelRow,
  type SourceRow,
} from '../services/channels.ts';
import { accountSummary, cardSummary, institutionSummary } from './summaries.ts';

/**
 * Payment channels and their funding sources (API_SPEC §3.6). A channel is where a payment is
 * started — device_wallet (Apple Pay, Google Pay, …), payment_service (PayPal, …) or other; there
 * is no bank_transfer type (SWIFT, FPS, SEPA are transfer methods of M3 transactions). A channel
 * holds no money and has no balance: the money is in accounts. Every query is scoped to the
 * signed-in user; another user's channel, source, card, account or institution is a 404 like a
 * missing one, and the composite foreign keys refuse cross-user rows at the database regardless.
 * - Balance account (payment_service only): an e_money / stored_value account of the user's, used
 *   by at most one channel (409 DUPLICATE otherwise). The unique index is not user-scoped, so
 *   ownership is settled before a duplicate is reported — a 409 never reveals another user's account.
 * - Provider (optional): an institution of the user's; a new or changed provider must be active
 *   (409 INSTITUTION_ARCHIVED, as for new accounts and cards). Keeping an archived one is fine.
 * - Sources: exactly one of a card or an account; device wallets take cards only (400
 *   CHANNEL_SOURCE_KIND), and a channel with account sources can't become one. One active record
 *   per source (409 DUPLICATE); at most one default per channel. Lifecycle: active → ended (POST
 *   /end, final; the record stays as history, the default flag is cleared; the source may be added
 *   again as a new record). Ended sources can still have their notes edited; making one the default
 *   is 409 LINK_STATE. DELETE is only for correcting mistakes.
 * - Archiving a channel changes none of its sources; archived channels are hidden from the default
 *   list and otherwise managed as usual. Freezing / closing a card or account changes no source.
 * - Each rule is checked by the write that depends on it (services/channels.ts); when a write is
 *   refused or changes nothing, the route re-reads to give the reason.
 * - Audit: channel.delete only ({ id }), in the delete's batch (API_SPEC §3.7).
 */

type C = Context<AppBindings>;
type ChannelSelect = typeof paymentChannels.$inferSelect;
type SourceSelect = typeof paymentChannelSources.$inferSelect;

const toDto = (r: ChannelSelect, provider: InstitutionSummary | null, balanceAccount: AccountSummary | null): PaymentChannelDto => ({
  id: r.id,
  name: r.name,
  channelType: r.channelType,
  providerInstitutionId: r.providerInstitutionId,
  provider,
  balanceAccountId: r.balanceAccountId,
  balanceAccount,
  region: r.region,
  status: r.status,
  notes: r.notes,
  sort: r.sort,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const toSourceDto = ({ source: s, card, account }: { source: SourceSelect; card: ChannelSourceDto['card']; account: ChannelSourceDto['account'] }): ChannelSourceDto => ({
  id: s.id,
  channelId: s.channelId,
  cardId: s.cardId,
  accountId: s.accountId,
  card,
  account,
  isDefault: s.isDefault,
  status: s.status,
  notes: s.notes,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

/** Active sources per channel (correlated subquery written by hand: drizzle would render the outer columns unqualified). */
const sourceCount = sql<number>`(SELECT count(*) FROM payment_channel_sources s WHERE s.user_id = "payment_channels"."user_id" AND s.channel_id = "payment_channels"."id" AND s.status = 'active')`;

/** Channels with their provider and balance account (both optional; same user on every side, as the composite keys require). */
const selectChannels = (c: C) =>
  c.var.deps.db
    .select({ row: paymentChannels, provider: institutionSummary, balanceAccount: accountSummary, sourceCount })
    .from(paymentChannels)
    .leftJoin(institutions, and(eq(institutions.id, paymentChannels.providerInstitutionId), eq(institutions.userId, paymentChannels.userId)))
    .leftJoin(accounts, and(eq(accounts.id, paymentChannels.balanceAccountId), eq(accounts.userId, paymentChannels.userId)));

/** Sources with their card or account summary (same user, as the composite keys require). */
const selectSources = (c: C) =>
  c.var.deps.db
    .select({ source: paymentChannelSources, card: cardSummary, account: accountSummary })
    .from(paymentChannelSources)
    .leftJoin(cards, and(eq(cards.id, paymentChannelSources.cardId), eq(cards.userId, paymentChannelSources.userId)))
    .leftJoin(accounts, and(eq(accounts.id, paymentChannelSources.accountId), eq(accounts.userId, paymentChannelSources.userId)));

const ownChannel = (c: C, id: string) => and(eq(paymentChannels.id, id), eq(paymentChannels.userId, c.var.user.id));
const ownSource = (c: C, id: string) => and(eq(paymentChannelSources.id, id), eq(paymentChannelSources.userId, c.var.user.id));

async function channelDto(c: C, id: string): Promise<PaymentChannelDto> {
  const [r] = await selectChannels(c).where(ownChannel(c, id));
  if (!r) notFound('payment channel');
  return toDto(r.row, r.provider, r.balanceAccount);
}

async function sourceDto(c: C, id: string): Promise<ChannelSourceDto> {
  const [r] = await selectSources(c).where(ownSource(c, id));
  if (!r) notFound('channel source');
  return toSourceDto(r);
}

async function sourceRow(c: C, id: string) {
  const [row] = await c.var.deps.db.select().from(paymentChannelSources).where(ownSource(c, id));
  return row;
}

const exists = async (c: C, table: typeof institutions | typeof accounts | typeof cards | typeof paymentChannels, id: string) =>
  (await c.var.deps.db.select({ id: table.id }).from(table).where(and(eq(table.id, id), eq(table.userId, c.var.user.id)))).length > 0;

/** Parse a body with the channel-aware error code (a balance account on a non-payment_service channel → BALANCE_ACCOUNT_KIND). */
async function channelBody<S extends z.ZodType>(c: C, schema: S): Promise<z.infer<S>> {
  const r = schema.safeParse(await body(c, z.unknown()));
  if (!r.success) fail(400, 'validation failed', ledgerErrorCode(r.error), r.error.issues);
  return r.data;
}

const duplicate = (message: string, existingId: string): never => fail(409, message, 'DUPLICATE', { existingId } satisfies DuplicateDetails);
const balanceKind = (): never => fail(400, 'a balance account is only for payment_service channels and must be an e_money or stored_value account', 'BALANCE_ACCOUNT_KIND');
const sourceKind = (): never => fail(400, 'a device wallet can only be funded by cards', 'CHANNEL_SOURCE_KIND');
const institutionArchived = (institutionId: string): never =>
  fail(409, 'the institution is archived — restore it before making it a channel provider', 'INSTITUTION_ARCHIVED', { institutionId });
const sourceEnded = (): never => fail(409, 'the source has ended — add it again as a new source instead', 'LINK_STATE', { status: 'ended' } satisfies LinkStateDetails);
const inUse = (transactions: number): never =>
  fail(409, 'the payment channel is referenced by transactions — archive it instead', 'IN_USE', { references: { transactions } } satisfies TransactionReferencesDetails);

// SQLite (libsql and D1 alike) names the columns of a plain unique index in its message; the drivers wrap it.
const isNameDuplicate = (err: unknown) => isUniqueViolation(err) && /payment_channels\.name_key/.test(dbErrorText(err));
const isBalanceDuplicate = (err: unknown) => isUniqueViolation(err) && /payment_channels\.balance_account_id/.test(dbErrorText(err));
const isSourceDuplicate = (err: unknown) => isUniqueViolation(err) && /payment_channel_sources\.(card_id|account_id)/.test(dbErrorText(err));
const isBalanceCheck = (err: unknown) => /payment_channels_balance_ck/.test(dbErrorText(err));

/** 404 when a provider or balance account named by the request is missing or another user's. */
async function requireOwnRefs(c: C, refs: { provider: string | null; balanceAccount: string | null }) {
  if (refs.provider && !(await exists(c, institutions, refs.provider))) notFound('institution');
  if (refs.balanceAccount && !(await exists(c, accounts, refs.balanceAccount))) notFound('account');
}

/** 409 when the provider (already known to be the caller's) is archived. */
async function requireActiveProvider(c: C, id: string) {
  const [inst] = await c.var.deps.db.select({ status: institutions.status }).from(institutions).where(and(eq(institutions.id, id), eq(institutions.userId, c.var.user.id)));
  if (!inst) notFound('institution');
  if (inst.status !== 'active') institutionArchived(id);
}

/** The caller's other channel with this name key, or using this balance account. */
async function channelWith(c: C, cond: SQL, except: string | null) {
  const [row] = await c.var.deps.db
    .select({ id: paymentChannels.id })
    .from(paymentChannels)
    .where(and(eq(paymentChannels.userId, c.var.user.id), cond, except ? ne(paymentChannels.id, except) : undefined));
  return row?.id;
}

/**
 * A channel INSERT / UPDATE failed: give the reason. Ownership comes first — the balance-account
 * unique index spans all users, so another user's account used by their own channel would fail it
 * before its foreign key does; it must look exactly like a missing account (404), never a 409.
 */
async function explainChannelWrite(c: C, err: unknown, refs: { provider: string | null; balanceAccount: string | null }, nameKey: string | undefined, self: string | null) {
  if (!(isUniqueViolation(err) || isForeignKeyViolation(err) || isTriggerAbort(err, 'BALANCE_ACCOUNT_KIND') || isBalanceCheck(err))) return;
  await requireOwnRefs(c, refs);
  if (isNameDuplicate(err) && nameKey !== undefined) {
    const id = await channelWith(c, eq(paymentChannels.nameKey, nameKey), self);
    if (id) duplicate('a payment channel with this name already exists', id);
  }
  if (isBalanceDuplicate(err) && refs.balanceAccount) {
    const id = await channelWith(c, eq(paymentChannels.balanceAccountId, refs.balanceAccount), self);
    if (id) duplicate('the account is already the balance account of another payment channel', id);
  }
  // The account's type (trigger), or the channel type changed while a balance account was set (CHECK).
  if (isTriggerAbort(err, 'BALANCE_ACCOUNT_KIND') || isBalanceCheck(err)) balanceKind();
}

/** The channel's account sources by status: what keeps it from becoming a device wallet. */
const accountSourceCounts = async (c: C, channelId: string) => {
  const rows = await c.var.deps.db
    .select({ status: paymentChannelSources.status, n: sql<number>`count(*)` })
    .from(paymentChannelSources)
    .where(and(eq(paymentChannelSources.userId, c.var.user.id), eq(paymentChannelSources.channelId, channelId), isNotNull(paymentChannelSources.accountId)))
    .groupBy(paymentChannelSources.status);
  const count = (status: string) => Number(rows.find((r) => r.status === status)?.n ?? 0);
  return { active: count('active'), ended: count('ended') };
};

/**
 * 400 CHANNEL_SOURCE_KIND for a would-be device wallet with account sources. Ended ones block it too:
 * they are the channel's history (which account funded it, and when), so the type of the channel that
 * history belongs to is not rewritten — and deleting history is never the advice. The way forward is a
 * new device-wallet channel, archiving this one.
 */
const deviceWalletRefused = ({ active, ended }: { active: number; ended: number }): never =>
  fail(
    400,
    active > 0
      ? 'the channel has active account sources and a device wallet is funded by cards only — create a new device-wallet channel and archive this one'
      : 'the channel has ended account sources (history, kept as recorded) — create a new device-wallet channel and archive this one instead of changing the type',
    'CHANNEL_SOURCE_KIND',
    { accountSources: active + ended, activeAccountSources: active, endedAccountSources: ended } satisfies ChannelTypeChangeDetails,
  );

export const channelRoutes = new Hono<AppBindings>()
  .get('/', async (c) => {
    const q = query(c, paymentChannelListQuerySchema);
    const conds: SQL[] = [eq(paymentChannels.userId, c.var.user.id)];
    if (q.status === undefined) conds.push(eq(paymentChannels.status, 'active'));
    else if (q.status !== 'all') conds.push(eq(paymentChannels.status, q.status));
    if (q.type) conds.push(eq(paymentChannels.channelType, q.type));
    const needle = q.q === undefined ? '' : normalizeNameKey(q.q);
    if (needle) {
      const like = likeContains(needle);
      conds.push(or(sql`${paymentChannels.nameKey} LIKE ${like} ESCAPE '\\'`, sql`${institutions.nameKey} LIKE ${like} ESCAPE '\\'`)!);
    }
    const rows = await selectChannels(c)
      .where(and(...conds))
      .orderBy(asc(paymentChannels.sort), asc(paymentChannels.nameKey), asc(paymentChannels.name), asc(paymentChannels.id));
    const items: PaymentChannelListItem[] = rows.map((r) => ({ ...toDto(r.row, r.provider, r.balanceAccount), sourceCount: Number(r.sourceCount) }));
    return c.json(items);
  })

  .post('/', async (c) => {
    const input = await channelBody(c, paymentChannelCreateSchema);
    rejectSensitive({ name: input.name, notes: input.notes });
    const now = c.var.deps.now();
    const row: ChannelRow = {
      id: newId(now),
      userId: c.var.user.id,
      name: input.name,
      nameKey: normalizeNameKey(input.name),
      channelType: input.channelType,
      providerInstitutionId: input.providerInstitutionId ?? null,
      balanceAccountId: input.balanceAccountId ?? null,
      region: input.region ?? null,
      status: input.status ?? 'active',
      notes: input.notes ?? null,
      sort: input.sort ?? 0,
      createdAt: now,
      updatedAt: now,
    };
    const refs = { provider: row.providerInstitutionId, balanceAccount: row.balanceAccountId };
    const { db } = c.var.deps;
    try {
      await db.batch([channelInsert(db, row)]);
    } catch (err) {
      await explainChannelWrite(c, err, refs, row.nameKey, null);
      throw err;
    }
    const [written] = await selectChannels(c).where(ownChannel(c, row.id));
    if (!written) {
      // The INSERT … SELECT found no active provider of the caller's: another user's or missing (404), or archived (409).
      await requireOwnRefs(c, refs);
      if (row.providerInstitutionId) await requireActiveProvider(c, row.providerInstitutionId);
      throw new Error('payment channel create wrote nothing');
    }
    return c.json(toDto(written.row, written.provider, written.balanceAccount), 201);
  })

  .get('/:id', async (c) => {
    const id = c.req.param('id');
    const dto = await channelDto(c, id);
    const sources = await selectSources(c)
      .where(and(eq(paymentChannelSources.userId, c.var.user.id), eq(paymentChannelSources.channelId, id)))
      .orderBy(asc(paymentChannelSources.createdAt), asc(paymentChannelSources.id));
    // Only sources whose card or account is the caller's own are described. The composite foreign
    // keys make anything else impossible; should such a row exist anyway, it is left out (never another user's id).
    const detail: PaymentChannelDetail = { ...dto, sources: sources.filter((r) => (r.source.cardId ? r.card : r.account)).map(toSourceDto) };
    return c.json(detail);
  })

  .patch('/:id', async (c) => {
    const input = await channelBody(c, paymentChannelUpdateSchema);
    if (Object.keys(input).length === 0) nothingToUpdate();
    rejectSensitive({ name: input.name, notes: input.notes });
    const id = c.req.param('id');
    const uid = c.var.user.id;
    const { db } = c.var.deps;
    // Read for the merged rules below; each is re-checked by the UPDATE itself.
    const [current] = await db.select().from(paymentChannels).where(ownChannel(c, id));
    if (!current) notFound('payment channel');

    const values: Partial<ChannelRow> = { updatedAt: c.var.deps.now() };
    if (input.name !== undefined) {
      values.name = input.name;
      values.nameKey = normalizeNameKey(input.name);
    }
    if (input.channelType !== undefined) values.channelType = input.channelType;
    if (input.providerInstitutionId !== undefined) values.providerInstitutionId = input.providerInstitutionId;
    if (input.balanceAccountId !== undefined) values.balanceAccountId = input.balanceAccountId;
    if (input.region !== undefined) values.region = input.region;
    if (input.status !== undefined) values.status = input.status;
    if (input.notes !== undefined) values.notes = input.notes;
    if (input.sort !== undefined) values.sort = input.sort;

    // A balance account only on a payment_service (body merged with the stored row; the CHECK backs it up).
    const type = values.channelType ?? current.channelType;
    const balance = values.balanceAccountId !== undefined ? values.balanceAccountId : current.balanceAccountId;
    if (balance !== null && type !== 'payment_service') balanceKind();
    // Only what changes is checked: keeping an archived provider or the same balance account is fine.
    const refs = {
      provider: values.providerInstitutionId != null && values.providerInstitutionId !== current.providerInstitutionId ? values.providerInstitutionId : null,
      balanceAccount: values.balanceAccountId != null && values.balanceAccountId !== current.balanceAccountId ? values.balanceAccountId : null,
    };
    const conds = [ownChannel(c, id)!];
    if (refs.provider) conds.push(activeProvider(refs.provider, uid));
    if (values.channelType === 'device_wallet') conds.push(noAccountSources);

    let updated: { id: string }[];
    try {
      // A one-statement batch: the write phase on its own, conditions evaluated by the UPDATE.
      [updated] = await db.batch([
        db
          .update(paymentChannels)
          .set(values)
          .where(and(...conds))
          .returning({ id: paymentChannels.id }),
      ]);
    } catch (err) {
      await explainChannelWrite(c, err, refs, values.nameKey, id);
      throw err;
    }
    if (!updated.length) {
      // Deleted in between (404), the new provider not the caller's (404) or archived (409), or account sources on a would-be device wallet (400).
      if (!(await exists(c, paymentChannels, id))) notFound('payment channel');
      await requireOwnRefs(c, refs);
      if (refs.provider) await requireActiveProvider(c, refs.provider);
      if (values.channelType === 'device_wallet') {
        const counts = await accountSourceCounts(c, id);
        if (counts.active + counts.ended > 0) deviceWalletRefused(counts);
      }
      throw new Error('payment channel update wrote nothing');
    }
    return c.json(await channelDto(c, id));
  })

  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    const { db } = c.var.deps;
    const now = c.var.deps.now();
    let deleted: { id: string }[];
    try {
      [, deleted] = await db.batch(channelDeleteBatch(db, { id, userId: c.var.user.id }, { id: newId(now), ip: c.var.ip, now }));
    } catch (err) {
      // From M3: a transaction referencing the channel (any version, voided ones too; NO ACTION)
      // refuses the delete, and the audit rolls back with it. Count them; a refusal nothing
      // explains is not reported as IN_USE (generic 500).
      if (isForeignKeyViolation(err)) {
        const transactions = await transactionsUsingChannel(db, c.var.user.id, id);
        if (transactions > 0) inUse(transactions);
      }
      throw err;
    }
    // Missing, another user's, or deleted by a concurrent request: 404 either way (and no audit).
    if (!deleted.length) notFound('payment channel');
    return c.json({ ok: true });
  })

  .post('/:id/sources', async (c) => {
    const input = await body(c, channelSourceCreateSchema);
    rejectSensitive({ notes: input.notes });
    const channelId = c.req.param('id');
    const now = c.var.deps.now();
    const row: SourceRow = {
      id: newId(now),
      userId: c.var.user.id,
      channelId,
      cardId: input.cardId ?? null,
      accountId: input.accountId ?? null,
      isDefault: false,
      status: 'active',
      notes: input.notes ?? null,
      createdAt: now,
      updatedAt: now,
    };
    const { db } = c.var.deps;
    // Another user's channel, card or account (or a missing one) is a 404, never revealing it exists.
    const requireOwn = async () => {
      if (!(await exists(c, paymentChannels, channelId))) notFound('payment channel');
      if (row.cardId && !(await exists(c, cards, row.cardId))) notFound('card');
      if (row.accountId && !(await exists(c, accounts, row.accountId))) notFound('account');
    };
    try {
      await db.batch(sourceCreateBatch(db, row, input.isDefault === true));
    } catch (err) {
      // Ownership is settled before a duplicate is reported (the source indexes are not user-scoped).
      if (isForeignKeyViolation(err) || isSourceDuplicate(err)) await requireOwn();
      if (isSourceDuplicate(err)) {
        const [twin] = await db
          .select({ id: paymentChannelSources.id })
          .from(paymentChannelSources)
          .where(
            and(
              eq(paymentChannelSources.userId, row.userId),
              eq(paymentChannelSources.channelId, channelId),
              row.cardId ? eq(paymentChannelSources.cardId, row.cardId) : eq(paymentChannelSources.accountId, row.accountId!),
              eq(paymentChannelSources.status, 'active'),
            ),
          );
        duplicate('the channel already has this source', twin?.id ?? row.id);
      }
      throw err;
    }
    const [written] = await selectSources(c).where(ownSource(c, row.id));
    if (!written) {
      // The INSERT … SELECT found no such channel of the caller's — or it is a device wallet and this is an account.
      await requireOwn();
      if (row.accountId) {
        const [channel] = await db.select({ channelType: paymentChannels.channelType }).from(paymentChannels).where(ownChannel(c, channelId));
        if (channel?.channelType === 'device_wallet') sourceKind();
      }
      throw new Error('channel source create wrote nothing');
    }
    return c.json(toSourceDto(written), 201);
  });

export const channelSourceRoutes = new Hono<AppBindings>()
  .patch('/:id', async (c) => {
    const patch = await body(c, channelSourceUpdateSchema);
    if (Object.keys(patch).length === 0) nothingToUpdate();
    rejectSensitive({ notes: patch.notes });
    const id = c.req.param('id');
    // Read for the channel (fixed); the rules are checked by the statements themselves.
    const current = await sourceRow(c, id);
    if (!current) notFound('channel source');
    const { db } = c.var.deps;
    const now = c.var.deps.now();
    const values: Partial<SourceRow> = { updatedAt: now };
    if (patch.notes !== undefined) values.notes = patch.notes;
    let changed: { id: string }[];
    if (patch.isDefault === true) {
      // Clear the channel's other default, then set this one — both only while it is active.
      [, changed] = await db.batch(sourceDefaultStatements(db, current, now, values));
    } else {
      if (patch.isDefault === false) values.isDefault = false;
      [changed] = await db.batch([sourceUpdateStatement(db, current, values)]);
    }
    if (!changed.length) {
      const still = await sourceRow(c, id);
      if (!still) notFound('channel source');
      if (still.status === 'ended') sourceEnded();
      throw new Error('channel source update changed nothing although the source is active');
    }
    return c.json(await sourceDto(c, id));
  })

  .post('/:id/end', async (c) => {
    await optionalBody(c, z.strictObject({}));
    const id = c.req.param('id');
    const { db } = c.var.deps;
    // Only while active: ending twice (or concurrently) changes nothing the second time.
    const [ended] = await db.batch([sourceEndStatement(db, { id, userId: c.var.user.id }, c.var.deps.now())]);
    if (!ended.length) {
      if (!(await sourceRow(c, id))) notFound('channel source');
      sourceEnded();
    }
    return c.json(await sourceDto(c, id));
  })

  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    const { db } = c.var.deps;
    const [deleted] = await db.batch([sourceDeleteStatement(db, { id, userId: c.var.user.id })]);
    // Missing, another user's or already deleted → 404.
    if (!deleted.length) notFound('channel source');
    return c.json({ ok: true });
  });
