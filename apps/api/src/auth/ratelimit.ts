import { eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { loginAttempts } from '../db/schema.ts';

/**
 * Failed-login throttling stored in the database (works the same on D1).
 * Per username: 5 failures in 15 minutes → locked for 15 minutes.
 * Per IP: 30 failures (family members share a home IP, so this is looser).
 */
export const WINDOW_MS = 15 * 60_000;
export const LOCK_MS = 15 * 60_000;
export const USER_MAX = 5;
export const IP_MAX = 30;

export const userKey = (username: string) => `user:${username.toLowerCase()}`;
export const ipKey = (ip: string | null) => `ip:${ip ?? 'unknown'}`;

/** Returns the epoch ms until which any of the keys is locked, or null. */
export async function lockedUntil(db: DB, keys: string[], now: number): Promise<number | null> {
  const rows = await db.select().from(loginAttempts).where(inArray(loginAttempts.key, keys));
  let until: number | null = null;
  for (const r of rows) {
    if (r.lockedUntil && r.lockedUntil > now) until = Math.max(until ?? 0, r.lockedUntil);
  }
  return until;
}

export async function recordFailure(db: DB, key: string, max: number, now: number): Promise<void> {
  const [row] = await db.select().from(loginAttempts).where(eq(loginAttempts.key, key));
  if (!row || now - row.windowStart > WINDOW_MS) {
    await db
      .insert(loginAttempts)
      .values({ key, failures: 1, windowStart: now, lockedUntil: null })
      .onConflictDoUpdate({ target: loginAttempts.key, set: { failures: 1, windowStart: now, lockedUntil: null } });
    return;
  }
  const failures = row.failures + 1;
  await db
    .update(loginAttempts)
    .set({ failures, lockedUntil: failures >= max ? now + LOCK_MS : row.lockedUntil })
    .where(eq(loginAttempts.key, key));
}

export async function clearFailures(db: DB, key: string): Promise<void> {
  await db.delete(loginAttempts).where(eq(loginAttempts.key, key));
}
