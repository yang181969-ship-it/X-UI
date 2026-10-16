import { and, count, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { inviteBeginSchema, totpConfirmSchema } from '@z-ui/shared';
import { requireSetupSession } from '../auth/middleware.ts';
import { IP_MAX, ipKey, lockedUntil, recordFailure } from '../auth/ratelimit.ts';
import { createSession, destroySession } from '../auth/session.ts';
import { generateTotpSecret, totpUri } from '../auth/totp.ts';
import { checkTotp, createUser, regenerateRecoveryCodes } from '../auth/users.ts';
import { users } from '../db/schema.ts';
import type { AppBindings } from '../env.ts';
import { audit } from '../lib/audit.ts';
import { timingSafeEqual } from '../lib/crypto.ts';
import { utf8 } from '../lib/encoding.ts';
import { body, fail } from '../lib/http.ts';
import { meDto } from './auth.ts';

type C = Context<AppBindings>;

/**
 * First-run setup for a single-user installation (e.g. a fresh Cloudflare deployment):
 * whoever holds the SETUP_TOKEN secret can create the one account — but only while no active
 * account exists. Afterwards these routes answer "invalid" and the secret can be deleted.
 *   1. begin   — username/password; a pending account + 30 min setup session; TOTP secret returned.
 *   2. confirm — prove the authenticator works; the account becomes active, gets recovery codes
 *                and a normal session (the UI then offers to register a passkey).
 */
async function setupAllowed(c: C, token: string): Promise<boolean> {
  const expected = c.var.deps.env.SETUP_TOKEN;
  if (!expected || !timingSafeEqual(utf8.encode(token), utf8.encode(expected))) return false;
  const [r] = await c.var.deps.db.select({ n: count() }).from(users).where(eq(users.status, 'active'));
  return (r?.n ?? 0) === 0;
}

async function guard(c: C, token: string) {
  const { db, now } = c.var.deps;
  if (await lockedUntil(db, [ipKey(c.var.ip)], now())) fail(429, 'too many attempts', 'LOCKED');
  if (c.var.deps.limiter && !(await c.var.deps.limiter(`setup:${c.var.ip}`))) fail(429, 'too many attempts', 'RATE_LIMITED');
  if (!(await setupAllowed(c, token))) {
    await recordFailure(db, ipKey(c.var.ip), IP_MAX, now());
    fail(410, 'setup link is invalid or already used', 'SETUP_INVALID');
  }
}

const TOKEN = '/:token{[A-Za-z0-9_-]{16,128}}';

export const setupRoutes = new Hono<AppBindings>()
  .get(TOKEN, async (c) => {
    const ok = await setupAllowed(c, c.req.param('token'));
    if (!ok) await recordFailure(c.var.deps.db, ipKey(c.var.ip), IP_MAX, c.var.deps.now());
    return c.json({ valid: ok });
  })

  .post(`${TOKEN}/begin`, async (c) => {
    const input = await body(c, inviteBeginSchema);
    await guard(c, c.req.param('token'));
    const { db, env } = c.var.deps;
    // Restarting the flow replaces any unfinished account.
    await db.delete(users).where(eq(users.status, 'pending'));
    const secret = generateTotpSecret();
    const user = await createUser(c.var.deps, { ...input, role: 'admin', status: 'pending', totpSecret: secret });
    await createSession(c, user, 'setup');
    return c.json({ secret, uri: totpUri(secret, user.username, env.RP_NAME) });
  })

  .post(`${TOKEN}/confirm`, requireSetupSession, async (c) => {
    const { code } = await body(c, totpConfirmSchema);
    await guard(c, c.req.param('token'));
    const { db, now } = c.var.deps;
    const user = c.var.user;
    if (!(await checkTotp(c.var.deps, user, code))) fail(400, 'incorrect code — check the time on your phone', 'BAD_CREDENTIALS');
    await db.update(users).set({ status: 'active', totpEnabled: true, updatedAt: now() }).where(and(eq(users.id, user.id), eq(users.status, 'pending')));
    user.status = 'active';
    user.totpEnabled = true;
    const recoveryCodes = await regenerateRecoveryCodes(c.var.deps, user.id);
    await destroySession(c, c.var.session.id);
    const session = await createSession(c, user, 'password_totp', { stepUp: true });
    await audit(c, 'invite.accept', { via: 'setup' }, user.id);
    return c.json({ recoveryCodes, me: await meDto(c, user, session) });
  });
