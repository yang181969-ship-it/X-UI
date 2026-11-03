import { DEFAULT_HOME_REGION, profileSettingsUpdateSchema, type ProfileSettingsDto } from '@xui/ledger-shared';
import { and, eq, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { auditLog, userPreferences, users } from '../db/schema.ts';
import type { AppBindings } from '../env.ts';
import { body } from '../lib/http.ts';
import { newId } from '../lib/id.ts';

/**
 * Personal settings of the signed-in user (API_SPEC §3.1), kept in user_preferences — never in the
 * global settings table. There is no user id in the path: every query is keyed by the session's
 * user, so nobody can read or change another user's row. A user without a row has the defaults
 * (home region CN, isDefault: true); reading never creates the row.
 *
 * home_region only matters for transactions saved later: M3 copies it into each transaction as a
 * snapshot, so changing it never reinterprets history.
 */

type C = Context<AppBindings>;

async function profile(c: C): Promise<ProfileSettingsDto> {
  const [row] = await c.var.deps.db
    .select({ homeRegion: userPreferences.homeRegion })
    .from(userPreferences)
    .where(eq(userPreferences.userId, c.var.user.id));
  return row ? { homeRegion: row.homeRegion, isDefault: false } : { homeRegion: DEFAULT_HOME_REGION, isDefault: true };
}

/**
 * PATCH as one db.batch() — a single transaction on libsql and on D1 (which has no interactive
 * transactions) — of two conditional INSERT … SELECT statements. Both select FROM the user's own
 * users row LEFT JOIN its user_preferences row, so they read the current value inside the
 * transaction, never a value read earlier by the route:
 *
 * 1. the audit record, only if the effective value (the row's, or CN without a row) differs from
 *    the requested one; detail = { from: that value, to, created: no row yet };
 * 2. the row: INSERT (first save) or ON CONFLICT DO UPDATE (later saves), under the same condition.
 *
 * Writers are serialized (SQLite and D1 alike), so concurrent saves apply one after the other and
 * each audit record names exactly the value its own batch replaced; a save that changes nothing
 * (same value, or CN without a row) writes nothing at all — no row, no updated_at, no audit. If
 * either statement fails, the batch rolls back both. (Query builder only: drizzle's D1 batch can't
 * bind raw db.run(sql``) statements.)
 */
function saveHomeRegionBatch(c: C, homeRegion: string) {
  const { db } = c.var.deps;
  const userId = c.var.user.id;
  const now = c.var.deps.now();
  const current = sql<string>`coalesce(${userPreferences.homeRegion}, ${DEFAULT_HOME_REGION})`;
  const changing = and(eq(users.id, userId), sql`${current} <> ${homeRegion}`);
  const source = <T extends Record<string, unknown>>(fields: T) =>
    db.select(fields as never).from(users).leftJoin(userPreferences, eq(userPreferences.userId, users.id)).where(changing);

  const created = sql`json(CASE WHEN ${userPreferences.userId} IS NULL THEN 'true' ELSE 'false' END)`;
  const auditRow = {
    id: sql`${newId(now)}`.as('id'),
    userId: sql`${userId}`.as('user_id'),
    action: sql`${'preferences.home_region'}`.as('action'),
    detail: sql`json_object('from', ${current}, 'to', ${homeRegion}, 'created', ${created})`.as('detail'),
    ip: sql`${c.var.ip}`.as('ip'),
    createdAt: sql`${now}`.as('created_at'),
  } satisfies Record<keyof typeof auditLog.$inferSelect, unknown>;
  const prefRow = {
    userId: sql`${userId}`.as('user_id'),
    homeRegion: sql`${homeRegion}`.as('home_region'),
    createdAt: sql`${now}`.as('created_at'),
    updatedAt: sql`${now}`.as('updated_at'),
  } satisfies Record<keyof typeof userPreferences.$inferSelect, unknown>;

  return [
    db.insert(auditLog).select(source(auditRow)),
    db
      .insert(userPreferences)
      .select(source(prefRow))
      .onConflictDoUpdate({ target: userPreferences.userId, set: { homeRegion: sql`excluded.home_region`, updatedAt: sql`excluded.updated_at` } }),
  ] as const;
}

export const settingsRoutes = new Hono<AppBindings>()
  .get('/profile', async (c) => c.json(await profile(c)))

  .patch('/profile', async (c) => {
    const { homeRegion } = await body(c, profileSettingsUpdateSchema);
    await c.var.deps.db.batch(saveHomeRegionBatch(c, homeRegion));
    // The stored settings after this save (a concurrent save committed later may already show).
    return c.json(await profile(c));
  });
