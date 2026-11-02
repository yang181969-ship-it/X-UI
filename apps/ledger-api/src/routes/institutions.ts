import {
  institutionCreateSchema,
  institutionListQuerySchema,
  institutionUpdateSchema,
  normalizeNameKey,
  scanSensitive,
  type AccountSummary,
  type CardSummary,
  type ChannelSummary,
  type InstitutionDetail,
  type InstitutionDto,
  type InstitutionListItem,
} from '@xui/ledger-shared';
import { and, asc, eq, ne, sql, type SQL } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { accounts, cards, institutions, paymentChannels } from '../db/schema.ts';
import type { AppBindings } from '../env.ts';
import { audit } from '../lib/audit.ts';
import { body, errorChain, fail, notFound, query } from '../lib/http.ts';
import { newId } from '../lib/id.ts';

/**
 * Financial institutions (API_SPEC §3.2). Every query is scoped to the signed-in user; another
 * user's institution is a 404. Duplicates are the same name_key + country (NULL country counts as
 * one value, like the unique index institutions_user_name_country_uq); the same name in another
 * country is a different legal entity and allowed. Referenced institutions can't be deleted (409
 * IN_USE) — they are archived instead.
 */

type C = Context<AppBindings>;
type InstitutionRow = typeof institutions.$inferSelect;

const toDto = (r: InstitutionRow): InstitutionDto => ({
  id: r.id,
  name: r.name,
  country: r.country,
  institutionType: r.institutionType,
  website: r.website,
  color: r.color,
  notes: r.notes,
  status: r.status,
  sort: r.sort,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

// Reference counts (every status counts: a closed account still references its institution).
// Written out by hand: drizzle renders a column of the outer table unqualified inside sql``, which
// would bind to the subquery's own table.
const refCount = (table: string, column: string) =>
  sql<number>`(SELECT count(*) FROM ${sql.raw(table)} r WHERE r.user_id = "institutions"."user_id" AND r.${sql.raw(column)} = "institutions"."id")`;
const accountCount = refCount('accounts', 'institution_id');
const cardCount = refCount('cards', 'issuer_institution_id');
const channelCount = refCount('payment_channels', 'provider_institution_id');
const withCounts = { row: institutions, accountCount, cardCount, channelCount };

type CountedRow = { row: InstitutionRow; accountCount: number; cardCount: number; channelCount: number };
const toListItem = (r: CountedRow): InstitutionListItem => ({
  ...toDto(r.row),
  accountCount: Number(r.accountCount),
  cardCount: Number(r.cardCount),
  channelCount: Number(r.channelCount),
});

const ownRow = (c: C, id: string) => and(eq(institutions.id, id), eq(institutions.userId, c.var.user.id));

async function loadCounted(c: C, id: string): Promise<CountedRow> {
  const [r] = await c.var.deps.db.select(withCounts).from(institutions).where(ownRow(c, id));
  if (!r) notFound('institution');
  return r;
}

/** LIKE pattern for a literal substring (escape with '\'). */
const likeContains = (s: string) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** 400 SENSITIVE_DATA naming the fields (never the matched text). No bypass exists. */
function rejectSensitive(fields: Record<string, string | null | undefined>) {
  const hits = scanSensitive(fields);
  if (hits.length) fail(400, 'free text looks like a card number or a security code', 'SENSITIVE_DATA', { fields: hits });
}

/** Id of the caller's institution with this name key and country (null = no country), other than `exceptId`. */
async function findDuplicate(c: C, nameKey: string, country: string | null, exceptId?: string): Promise<string | null> {
  const conds: SQL[] = [
    eq(institutions.userId, c.var.user.id),
    eq(institutions.nameKey, nameKey),
    sql`ifnull(${institutions.country}, '') = ${country ?? ''}`,
  ];
  if (exceptId) conds.push(ne(institutions.id, exceptId));
  const [dup] = await c.var.deps.db.select({ id: institutions.id }).from(institutions).where(and(...conds));
  return dup?.id ?? null;
}

const duplicate = (existingId: string): never =>
  fail(409, 'an institution with this name already exists in this country', 'DUPLICATE', { existingId });

const isUniqueViolation = (err: unknown) => /UNIQUE constraint failed/i.test(errorChain(err));
const isForeignKeyViolation = (err: unknown) => /FOREIGN KEY constraint failed/i.test(errorChain(err));

export const institutionRoutes = new Hono<AppBindings>()
  .get('/', async (c) => {
    const q = query(c, institutionListQuerySchema);
    const conds: SQL[] = [eq(institutions.userId, c.var.user.id)];
    if (q.status === undefined) conds.push(eq(institutions.status, 'active'));
    else if (q.status !== 'all') conds.push(eq(institutions.status, q.status));
    if (q.type) conds.push(eq(institutions.institutionType, q.type));
    if (q.country) conds.push(eq(institutions.country, q.country));
    const needle = q.q === undefined ? '' : normalizeNameKey(q.q);
    if (needle) conds.push(sql`${institutions.nameKey} LIKE ${likeContains(needle)} ESCAPE '\\'`);
    const rows = await c.var.deps.db
      .select(withCounts)
      .from(institutions)
      .where(and(...conds))
      .orderBy(asc(institutions.sort), asc(institutions.nameKey), asc(institutions.name), asc(institutions.id));
    return c.json(rows.map(toListItem));
  })

  .post('/', async (c) => {
    const input = await body(c, institutionCreateSchema);
    rejectSensitive({ name: input.name, notes: input.notes, website: input.website });
    const nameKey = normalizeNameKey(input.name);
    const country = input.country ?? null;
    const existing = await findDuplicate(c, nameKey, country);
    if (existing) duplicate(existing);

    const now = c.var.deps.now();
    const row: typeof institutions.$inferInsert = {
      id: newId(now),
      userId: c.var.user.id,
      name: input.name,
      nameKey,
      country,
      institutionType: input.institutionType,
      website: input.website ?? null,
      color: input.color ?? null,
      notes: input.notes ?? null,
      status: input.status ?? 'active',
      sort: input.sort ?? 0,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await c.var.deps.db.insert(institutions).values(row);
    } catch (err) {
      // Lost a race with a concurrent create: the unique index is the last line of defence.
      if (isUniqueViolation(err)) {
        const id = await findDuplicate(c, nameKey, country);
        if (id) duplicate(id);
      }
      throw err;
    }
    const [created] = await c.var.deps.db.select().from(institutions).where(ownRow(c, row.id!));
    return c.json(toDto(created!), 201);
  })

  .get('/:id', async (c) => {
    const r = await loadCounted(c, c.req.param('id'));
    const { db } = c.var.deps;
    const uid = c.var.user.id;
    const [accountRows, cardRows, channelRows] = await Promise.all([
      db
        .select({ id: accounts.id, name: accounts.name, accountCountry: accounts.accountCountry, status: accounts.status })
        .from(accounts)
        .where(and(eq(accounts.userId, uid), eq(accounts.institutionId, r.row.id)))
        .orderBy(asc(accounts.sort), asc(accounts.nameKey), asc(accounts.id)),
      db
        .select({ id: cards.id, name: cards.name, network: cards.network, last4: cards.last4, cardType: cards.cardType, status: cards.status })
        .from(cards)
        .where(and(eq(cards.userId, uid), eq(cards.issuerInstitutionId, r.row.id)))
        .orderBy(asc(cards.sort), asc(cards.name), asc(cards.id)),
      db
        .select({ id: paymentChannels.id, name: paymentChannels.name, channelType: paymentChannels.channelType, status: paymentChannels.status })
        .from(paymentChannels)
        .where(and(eq(paymentChannels.userId, uid), eq(paymentChannels.providerInstitutionId, r.row.id)))
        .orderBy(asc(paymentChannels.sort), asc(paymentChannels.nameKey), asc(paymentChannels.id)),
    ]);
    const detail: InstitutionDetail = {
      ...toListItem(r),
      accounts: accountRows satisfies AccountSummary[],
      cards: cardRows satisfies CardSummary[],
      channels: channelRows satisfies ChannelSummary[],
    };
    return c.json(detail);
  })

  .patch('/:id', async (c) => {
    const input = await body(c, institutionUpdateSchema);
    if (Object.keys(input).length === 0) fail(400, 'nothing to update', 'VALIDATION', [{ code: 'custom', path: [], message: 'nothing to update' }]);
    const id = c.req.param('id');
    const [current] = await c.var.deps.db.select().from(institutions).where(ownRow(c, id));
    if (!current) notFound('institution');
    rejectSensitive({ name: input.name, notes: input.notes, website: input.website });

    const values: Partial<typeof institutions.$inferInsert> = { updatedAt: c.var.deps.now() };
    if (input.name !== undefined) {
      values.name = input.name;
      values.nameKey = normalizeNameKey(input.name);
    }
    if (input.country !== undefined) values.country = input.country;
    if (input.institutionType !== undefined) values.institutionType = input.institutionType;
    if (input.website !== undefined) values.website = input.website;
    if (input.color !== undefined) values.color = input.color;
    if (input.notes !== undefined) values.notes = input.notes;
    if (input.status !== undefined) values.status = input.status;
    if (input.sort !== undefined) values.sort = input.sort;

    // Renaming or moving to another country is checked like a create.
    const nameKey = values.nameKey ?? current.nameKey;
    const country = values.country !== undefined ? values.country : current.country;
    if (input.name !== undefined || input.country !== undefined) {
      const existing = await findDuplicate(c, nameKey, country, id);
      if (existing) duplicate(existing);
    }
    try {
      await c.var.deps.db.update(institutions).set(values).where(ownRow(c, id));
    } catch (err) {
      if (isUniqueViolation(err)) {
        const dup = await findDuplicate(c, nameKey, country, id);
        if (dup) duplicate(dup);
      }
      throw err;
    }
    const [updated] = await c.var.deps.db.select().from(institutions).where(ownRow(c, id));
    return c.json(toDto(updated!));
  })

  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    const inUse = (r: CountedRow): never =>
      fail(409, 'the institution is still referenced — archive it instead', 'IN_USE', {
        references: { accounts: Number(r.accountCount), cards: Number(r.cardCount), channels: Number(r.channelCount) },
      });
    const r = await loadCounted(c, id);
    if (Number(r.accountCount) + Number(r.cardCount) + Number(r.channelCount) > 0) inUse(r);
    try {
      await c.var.deps.db.delete(institutions).where(ownRow(c, id));
    } catch (err) {
      // A reference created between the check and the delete: the NO ACTION foreign keys refuse it.
      if (isForeignKeyViolation(err)) inUse(await loadCounted(c, id));
      throw err;
    }
    await audit(c, 'institution.delete', { id });
    return c.json({ ok: true });
  });
