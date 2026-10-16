import { and, asc, count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { institutionPatchSchema, institutionSchema, type InstitutionDto } from '@z-ui/shared';
import { accounts, institutions } from '../db/schema.ts';
import type { AppBindings } from '../env.ts';
import { body, fail } from '../lib/http.ts';
import { newId } from '../lib/id.ts';
import { applyExtra, defined, ownInstitution } from '../lib/ledger.ts';

type Row = typeof institutions.$inferSelect;

function dto(r: Row, accountCount: number): InstitutionDto {
  const { userId: _u, ...rest } = r;
  return { ...rest, accountCount };
}

export const institutionRoutes = new Hono<AppBindings>()
  .get('/', async (c) => {
    const { db } = c.var.deps;
    const rows = await db
      .select({ inst: institutions, n: count(accounts.id) })
      .from(institutions)
      .leftJoin(accounts, eq(accounts.institutionId, institutions.id))
      .where(eq(institutions.userId, c.var.user.id))
      .groupBy(institutions.id)
      .orderBy(asc(institutions.sort), asc(institutions.createdAt));
    return c.json(rows.map((r) => dto(r.inst, r.n)));
  })

  .post('/', async (c) => {
    const input = await body(c, institutionSchema);
    const t = c.var.deps.now();
    const row: Row = {
      id: newId(),
      userId: c.var.user.id,
      name: input.name,
      country: input.country,
      type: input.type,
      color: input.color ?? null,
      website: input.website ?? null,
      note: input.note ?? null,
      extra: applyExtra(c.var.deps, 'institution', {}, input.extra),
      sort: input.sort ?? 0,
      archived: input.archived ?? false,
      createdAt: t,
      updatedAt: t,
    };
    await c.var.deps.db.insert(institutions).values(row);
    return c.json(dto(row, 0), 201);
  })

  .patch('/:id', async (c) => {
    const input = await body(c, institutionPatchSchema);
    const { db, now } = c.var.deps;
    const cur = await ownInstitution(db, c.var.user.id, c.req.param('id'));
    const { extra, ...fields } = input;
    const [row] = await db
      .update(institutions)
      .set({
        ...defined(fields),
        ...(extra !== undefined && { extra: applyExtra(c.var.deps, 'institution', cur.extra, extra) }),
        updatedAt: now(),
      })
      .where(and(eq(institutions.id, cur.id), eq(institutions.userId, c.var.user.id)))
      .returning();
    const [n] = await db.select({ n: count() }).from(accounts).where(eq(accounts.institutionId, cur.id));
    return c.json(dto(row!, n?.n ?? 0));
  })

  .delete('/:id', async (c) => {
    const { db } = c.var.deps;
    const cur = await ownInstitution(db, c.var.user.id, c.req.param('id'));
    const [n] = await db.select({ n: count() }).from(accounts).where(eq(accounts.institutionId, cur.id));
    if (n && n.n > 0) fail(409, 'institution still has accounts — archive it instead', 'HAS_CHILDREN');
    await db.delete(institutions).where(and(eq(institutions.id, cur.id), eq(institutions.userId, c.var.user.id)));
    return c.json({ ok: true });
  });
