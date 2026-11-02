import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { xuiV1Meta } from '../db/schema.ts';
import { IDENTITY_KEY } from '../db/identity.ts';
import type { AppBindings } from '../env.ts';

export const PRODUCT = 'x-ui';
export const EDITION = 'v1';

/** Signed-in only: which product and database this server runs on (shown under Settings). */
export const systemRoutes = new Hono<AppBindings>().get('/info', async (c) => {
  const [identity] = await c.var.deps.db.select().from(xuiV1Meta).where(eq(xuiV1Meta.key, IDENTITY_KEY));
  return c.json({
    product: PRODUCT,
    edition: EDITION,
    database: { identity: identity?.value ?? null, createdAt: identity?.createdAt ?? null },
  });
});
