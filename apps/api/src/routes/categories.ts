import { and, asc, count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { categoryPatchSchema, categorySchema, tagPatchSchema, tagSchema, type CategoryDto, type TagDto } from '@z-ui/shared';
import { categories, tags, transactions, transactionTags } from '../db/schema.ts';
import type { AppBindings } from '../env.ts';
import { body, fail, notFound } from '../lib/http.ts';
import { chunkRows } from '../lib/chunks.ts';
import { newId } from '../lib/id.ts';
import { defined, ownCategory } from '../lib/ledger.ts';

type CatRow = typeof categories.$inferSelect;
const catDto = ({ userId: _u, ...rest }: CatRow): CategoryDto => rest;

export const categoryRoutes = new Hono<AppBindings>()
  .get('/', async (c) => {
    const rows = await c.var.deps.db
      .select()
      .from(categories)
      .where(eq(categories.userId, c.var.user.id))
      .orderBy(asc(categories.kind), asc(categories.sort));
    return c.json(rows.map(catDto));
  })

  /** Add the config's default categories this user doesn't have yet (matched by kind + name). */
  .post('/import-defaults', async (c) => {
    const { db, config } = c.var.deps;
    const userId = c.var.user.id;
    const have = await db.select({ kind: categories.kind, name: categories.name }).from(categories).where(eq(categories.userId, userId));
    const key = (k: string, n: string) => `${k}:${n}`;
    const existing = new Set(have.map((h) => key(h.kind, h.name)));
    const defaults = config.get().defaultCategories;
    const rows = (['expense', 'income'] as const).flatMap((kind) =>
      defaults[kind]
        .map((d, i) => ({ d, i }))
        .filter(({ d }) => !existing.has(key(kind, d.name)))
        .map(({ d, i }) => ({ id: newId(), userId, kind, name: d.name, parentId: null, icon: d.icon ?? null, color: d.color ?? null, sort: i, archived: false })),
    );
    for (const part of chunkRows(rows)) await db.insert(categories).values(part);
    return c.json({ added: rows.length });
  })

  .post('/', async (c) => {
    const input = await body(c, categorySchema);
    const { db } = c.var.deps;
    if (input.parentId) await ownCategory(db, c.var.user.id, input.parentId);
    const row: CatRow = {
      id: newId(),
      userId: c.var.user.id,
      kind: input.kind,
      name: input.name,
      parentId: input.parentId ?? null,
      icon: input.icon ?? null,
      color: input.color ?? null,
      sort: input.sort ?? 999,
      archived: input.archived ?? false,
    };
    await db.insert(categories).values(row);
    return c.json(catDto(row), 201);
  })

  .patch('/:id', async (c) => {
    const input = await body(c, categoryPatchSchema);
    const { db } = c.var.deps;
    const cur = await ownCategory(db, c.var.user.id, c.req.param('id'));
    if (input.parentId) {
      if (input.parentId === cur.id) fail(400, 'a category cannot be its own parent', 'BAD_PARENT');
      await ownCategory(db, c.var.user.id, input.parentId);
    }
    const [row] = await db
      .update(categories)
      .set(defined(input))
      .where(and(eq(categories.id, cur.id), eq(categories.userId, c.var.user.id)))
      .returning();
    return c.json(catDto(row!));
  })

  /** Unused categories are deleted; used ones are archived so history keeps its labels. */
  .delete('/:id', async (c) => {
    const { db } = c.var.deps;
    const cur = await ownCategory(db, c.var.user.id, c.req.param('id'));
    const [n] = await db.select({ n: count() }).from(transactions).where(eq(transactions.categoryId, cur.id));
    if (n && n.n > 0) {
      await db.update(categories).set({ archived: true }).where(eq(categories.id, cur.id));
      return c.json({ ok: true, archived: true });
    }
    await db.delete(categories).where(and(eq(categories.id, cur.id), eq(categories.userId, c.var.user.id)));
    return c.json({ ok: true, archived: false });
  });

export const tagRoutes = new Hono<AppBindings>()
  .get('/', async (c) => {
    const rows = await c.var.deps.db
      .select({ t: tags, n: count(transactionTags.transactionId) })
      .from(tags)
      .leftJoin(transactionTags, eq(transactionTags.tagId, tags.id))
      .where(eq(tags.userId, c.var.user.id))
      .groupBy(tags.id)
      .orderBy(asc(tags.name));
    return c.json(rows.map((r): TagDto => ({ id: r.t.id, name: r.t.name, color: r.t.color, count: r.n })));
  })

  .post('/', async (c) => {
    const input = await body(c, tagSchema);
    const { db } = c.var.deps;
    const [dup] = await db.select().from(tags).where(and(eq(tags.userId, c.var.user.id), eq(tags.name, input.name)));
    if (dup) fail(409, 'tag already exists', 'DUPLICATE');
    const row = { id: newId(), userId: c.var.user.id, name: input.name, color: input.color ?? null };
    await db.insert(tags).values(row);
    return c.json({ id: row.id, name: row.name, color: row.color, count: 0 } satisfies TagDto, 201);
  })

  .patch('/:id', async (c) => {
    const input = await body(c, tagPatchSchema);
    const r = await c.var.deps.db
      .update(tags)
      .set(defined(input))
      .where(and(eq(tags.id, c.req.param('id')), eq(tags.userId, c.var.user.id)))
      .returning();
    if (!r.length) notFound('tag');
    return c.json({ ok: true });
  })

  .delete('/:id', async (c) => {
    const r = await c.var.deps.db
      .delete(tags)
      .where(and(eq(tags.id, c.req.param('id')), eq(tags.userId, c.var.user.id)))
      .returning({ id: tags.id });
    if (!r.length) notFound('tag');
    return c.json({ ok: true });
  });
