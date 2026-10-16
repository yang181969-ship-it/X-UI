import { and, eq, ne } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { SessionMethod } from '@z-ui/shared';
import { sessions, users } from '../db/schema.ts';
import type { AppBindings, SessionRow, UserRow } from '../env.ts';
import { randomToken, sha256Hex } from '../lib/crypto.ts';

export const SESSION_IDLE_MS = 7 * 24 * 3600_000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 3600_000;
export const SETUP_SESSION_MS = 30 * 60_000;
export const STEP_UP_MS = 5 * 60_000;
/** Don't write last_seen on every request. */
const TOUCH_INTERVAL_MS = 60_000;

type C = Context<AppBindings>;

export function sessionCookieName(c: C): string {
  return c.var.deps.env.COOKIE_SECURE ? '__Host-zui_session' : 'zui_session';
}

function writeCookie(c: C, token: string, maxAgeMs: number) {
  setCookie(c, sessionCookieName(c), token, {
    httpOnly: true,
    secure: c.var.deps.env.COOKIE_SECURE,
    sameSite: 'Strict',
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  });
}

export async function createSession(c: C, user: UserRow, method: SessionMethod, opts: { stepUp?: boolean } = {}) {
  const { db, now } = c.var.deps;
  const t = now();
  const token = randomToken();
  const ttl = method === 'setup' ? SETUP_SESSION_MS : SESSION_IDLE_MS;
  const abs = method === 'setup' ? SETUP_SESSION_MS : SESSION_ABSOLUTE_MS;
  const row = {
    id: await sha256Hex(token),
    userId: user.id,
    method,
    ip: c.var.ip,
    userAgent: c.req.header('user-agent')?.slice(0, 300) ?? null,
    createdAt: t,
    lastSeenAt: t,
    expiresAt: t + ttl,
    absoluteExpiresAt: t + abs,
    // A fresh strong login counts as a recent verification.
    stepUpAt: opts.stepUp ? t : null,
  } satisfies SessionRow;
  await db.insert(sessions).values(row);
  writeCookie(c, token, ttl);
  return row;
}

/** Look up the session from the cookie. Expired sessions and disabled users yield null. */
export async function loadSession(c: C): Promise<{ user: UserRow; session: SessionRow } | null> {
  const token = getCookie(c, sessionCookieName(c));
  if (!token || token.length > 100) return null;
  const { db, now } = c.var.deps;
  const id = await sha256Hex(token);
  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .limit(1);
  const hit = rows[0];
  if (!hit) return null;
  const t = now();
  const { session, user } = hit;
  const expired = t >= session.expiresAt || t >= session.absoluteExpiresAt;
  const userOk = user.status === 'active' || (user.status === 'pending' && session.method === 'setup');
  if (expired || !userOk) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  if (session.method !== 'setup' && t - session.lastSeenAt > TOUCH_INTERVAL_MS) {
    const expiresAt = Math.min(t + SESSION_IDLE_MS, session.absoluteExpiresAt);
    await db.update(sessions).set({ lastSeenAt: t, expiresAt }).where(eq(sessions.id, id));
    session.lastSeenAt = t;
    session.expiresAt = expiresAt;
    writeCookie(c, token, expiresAt - t);
  }
  return { user, session };
}

export async function destroySession(c: C, sessionId: string) {
  await c.var.deps.db.delete(sessions).where(eq(sessions.id, sessionId));
  deleteCookie(c, sessionCookieName(c), { path: '/', secure: c.var.deps.env.COOKIE_SECURE });
}

export async function markStepUp(c: C, session: SessionRow) {
  const t = c.var.deps.now();
  await c.var.deps.db.update(sessions).set({ stepUpAt: t }).where(eq(sessions.id, session.id));
  session.stepUpAt = t;
}

export function stepUpUntil(session: SessionRow): number | null {
  return session.stepUpAt ? session.stepUpAt + STEP_UP_MS : null;
}

export async function revokeUserSessions(c: C, userId: string, exceptId?: string) {
  await c.var.deps.db
    .delete(sessions)
    .where(exceptId ? and(eq(sessions.userId, userId), ne(sessions.id, exceptId)) : eq(sessions.userId, userId));
}
