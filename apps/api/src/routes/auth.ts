import { and, desc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  loginSchema,
  passkeyRenameSchema,
  passwordChangeSchema,
  profileSchema,
  totpConfirmSchema,
  type AuditDto,
  type MeDto,
  type PasskeyDto,
  type SessionDto,
} from '@z-ui/shared';
import { requireAuth, requireStepUp } from '../auth/middleware.ts';
import { dummyHash, hashIterations, hashPassword, verifyPassword } from '../auth/password.ts';
import { clearFailures, IP_MAX, ipKey, lockedUntil, recordFailure, USER_MAX, userKey } from '../auth/ratelimit.ts';
import { createSession, destroySession, loadSession, markStepUp, revokeUserSessions, stepUpUntil } from '../auth/session.ts';
import { generateTotpSecret, totpUri } from '../auth/totp.ts';
import {
  checkTotp,
  consumeRecoveryCode,
  regenerateRecoveryCodes,
  remainingRecoveryCodes,
  toUserDto,
  totpContext,
} from '../auth/users.ts';
import { authenticationOptions, registrationOptions, verifyAuthentication, verifyRegistration } from '../auth/webauthn.ts';
import { auditLog, passkeys, sessions, users } from '../db/schema.ts';
import type { AppBindings, SessionRow, UserRow } from '../env.ts';
import { audit } from '../lib/audit.ts';
import { encryptField } from '../lib/crypto.ts';
import { body, fail, notFound } from '../lib/http.ts';

type C = Context<AppBindings>;

const webauthnResponse = z.object({
  challengeId: z.string().min(1).max(64),
  response: z.looseObject({ id: z.string().min(1).max(1024) }),
});

export async function meDto(c: C, user: UserRow, session: SessionRow): Promise<MeDto> {
  return {
    user: await toUserDto(c.var.deps, user),
    session: { id: session.id.slice(0, 12), method: session.method, createdAt: session.createdAt, stepUpUntil: stepUpUntil(session) },
  };
}

async function guardLocked(c: C, keys: string[]) {
  const until = await lockedUntil(c.var.deps.db, keys, c.var.deps.now());
  if (until) {
    await audit(c, 'login.locked', { keys }, null);
    fail(429, 'too many failed attempts, try again later', 'LOCKED', { until });
  }
}

export const authRoutes = new Hono<AppBindings>()
  // ------------------------------------------------------------ public
  .get('/me', async (c) => {
    const s = await loadSession(c);
    if (!s || s.session.method === 'setup') fail(401, 'not signed in', 'UNAUTHENTICATED');
    return c.json(await meDto(c, s.user, s.session));
  })

  .post('/login', async (c) => {
    const input = await body(c, loginSchema);
    const { db, env, now } = c.var.deps;
    const keys = [userKey(input.username), ipKey(c.var.ip)];
    await guardLocked(c, keys);
    if (c.var.deps.limiter && !(await c.var.deps.limiter(`login:${c.var.ip}`))) fail(429, 'too many attempts', 'RATE_LIMITED');

    const [user] = await db.select().from(users).where(eq(users.username, input.username));
    const usable = user && user.status === 'active' && user.passwordHash && user.totpEnabled;
    const pwOk = await verifyPassword(input.password, usable ? user.passwordHash! : dummyHash(env.PASSWORD_ITERATIONS), env.SESSION_PEPPER);

    let method: 'password_totp' | 'recovery' | null = null;
    if (usable && pwOk) {
      if (input.totp && (await checkTotp(c.var.deps, user, input.totp))) method = 'password_totp';
      else if (input.recoveryCode && (await consumeRecoveryCode(c.var.deps, user.id, input.recoveryCode))) method = 'recovery';
    }
    if (!method || !user) {
      const t = now();
      await recordFailure(db, keys[0]!, USER_MAX, t);
      await recordFailure(db, keys[1]!, IP_MAX, t);
      await audit(c, 'login.failure', { username: input.username, via: 'password' }, user?.id ?? null);
      fail(401, 'incorrect username, password or code', 'BAD_CREDENTIALS');
    }
    await clearFailures(db, keys[0]!);
    // Re-hash at the configured cost (e.g. after moving from a 100k local hash to Workers).
    if (hashIterations(user.passwordHash!) !== env.PASSWORD_ITERATIONS) {
      await db
        .update(users)
        .set({ passwordHash: await hashPassword(input.password, env.SESSION_PEPPER, env.PASSWORD_ITERATIONS), updatedAt: now() })
        .where(eq(users.id, user.id));
    }
    const session = await createSession(c, user, method, { stepUp: true });
    await audit(c, method === 'recovery' ? 'recovery.used' : 'login.success', { via: method }, user.id);
    return c.json(await meDto(c, user, session));
  })

  .post('/passkey/options', async (c) => {
    await guardLocked(c, [ipKey(c.var.ip)]);
    if (c.var.deps.limiter && !(await c.var.deps.limiter(`passkey:${c.var.ip}`))) fail(429, 'too many attempts', 'RATE_LIMITED');
    return c.json(await authenticationOptions(c.var.deps, 'login'));
  })

  .post('/passkey/verify', async (c) => {
    const input = await body(c, webauthnResponse);
    const { db, now } = c.var.deps;
    await guardLocked(c, [ipKey(c.var.ip)]);
    let pk;
    try {
      pk = await verifyAuthentication(c.var.deps, 'login', input.challengeId, input.response as never);
    } catch (e) {
      await recordFailure(db, ipKey(c.var.ip), IP_MAX, now());
      await audit(c, 'login.failure', { via: 'passkey' }, null);
      throw e;
    }
    const [user] = await db.select().from(users).where(eq(users.id, pk.userId));
    if (!user || user.status !== 'active') fail(401, 'account disabled', 'DISABLED');
    const session = await createSession(c, user, 'passkey', { stepUp: true });
    await audit(c, 'login.success', { via: 'passkey', passkey: pk.name }, user.id);
    return c.json(await meDto(c, user, session));
  })

  .post('/logout', async (c) => {
    const s = await loadSession(c);
    if (s) {
      await destroySession(c, s.session.id);
      await audit(c, 'logout', null, s.user.id);
    }
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------ signed in
  .use('*', requireAuth)

  /** Display name and profile picture. */
  .patch('/profile', async (c) => {
    const input = await body(c, profileSchema);
    const { db, now } = c.var.deps;
    const patch: Partial<typeof users.$inferInsert> = { updatedAt: now() };
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.avatar !== undefined) patch.avatar = input.avatar;
    const [user] = await db.update(users).set(patch).where(eq(users.id, c.var.user.id)).returning();
    return c.json(await meDto(c, user!, c.var.session));
  })

  .post('/step-up/options', async (c) => c.json(await authenticationOptions(c.var.deps, 'step_up', c.var.user)))

  .post('/step-up/passkey', async (c) => {
    const input = await body(c, webauthnResponse);
    await verifyAuthentication(c.var.deps, 'step_up', input.challengeId, input.response as never, c.var.user);
    await markStepUp(c, c.var.session);
    await audit(c, 'step_up', { via: 'passkey' });
    return c.json(await meDto(c, c.var.user, c.var.session));
  })

  .post('/step-up/totp', async (c) => {
    const { code } = await body(c, totpConfirmSchema);
    const keys = [userKey(c.var.user.username)];
    await guardLocked(c, keys);
    if (!(await checkTotp(c.var.deps, c.var.user, code))) {
      await recordFailure(c.var.deps.db, keys[0]!, USER_MAX, c.var.deps.now());
      fail(401, 'incorrect code', 'BAD_CREDENTIALS');
    }
    await markStepUp(c, c.var.session);
    await audit(c, 'step_up', { via: 'totp' });
    return c.json(await meDto(c, c.var.user, c.var.session));
  })

  .get('/sessions', async (c) => {
    const rows = await c.var.deps.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, c.var.user.id))
      .orderBy(desc(sessions.lastSeenAt));
    return c.json(
      rows
        .filter((s) => s.method !== 'setup')
        .map(
          (s): SessionDto => ({
            id: s.id.slice(0, 12),
            method: s.method,
            ip: s.ip,
            userAgent: s.userAgent,
            createdAt: s.createdAt,
            lastSeenAt: s.lastSeenAt,
            current: s.id === c.var.session.id,
          }),
        ),
    );
  })

  .delete('/sessions/:id', async (c) => {
    const prefix = c.req.param('id');
    const rows = await c.var.deps.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, c.var.user.id));
    const target = rows.find((s) => s.id.slice(0, 12) === prefix);
    if (!target) notFound('session');
    await c.var.deps.db.delete(sessions).where(and(eq(sessions.id, target.id), eq(sessions.userId, c.var.user.id)));
    await audit(c, 'session.revoke', { session: prefix });
    return c.json({ ok: true });
  })

  .get('/passkeys', async (c) => {
    const rows = await c.var.deps.db.select().from(passkeys).where(eq(passkeys.userId, c.var.user.id));
    return c.json(
      rows.map(
        (p): PasskeyDto => ({
          id: p.id,
          name: p.name,
          deviceType: p.deviceType,
          backedUp: p.backedUp,
          createdAt: p.createdAt,
          lastUsedAt: p.lastUsedAt,
        }),
      ),
    );
  })

  .post('/passkeys/options', requireStepUp, async (c) => c.json(await registrationOptions(c.var.deps, c.var.user)))

  .post('/passkeys/verify', requireStepUp, async (c) => {
    const input = await body(c, webauthnResponse.extend({ name: z.string().trim().min(1).max(64).default('Passkey') }));
    const pk = await verifyRegistration(c.var.deps, c.var.user, input.challengeId, input.response as never, input.name);
    await audit(c, 'passkey.add', { name: pk.name });
    return c.json({ id: pk.id, name: pk.name });
  })

  .patch('/passkeys/:id', async (c) => {
    const { name } = await body(c, passkeyRenameSchema);
    const r = await c.var.deps.db
      .update(passkeys)
      .set({ name })
      .where(and(eq(passkeys.id, c.req.param('id')), eq(passkeys.userId, c.var.user.id)))
      .returning({ id: passkeys.id });
    if (!r.length) notFound('passkey');
    return c.json({ ok: true });
  })

  .delete('/passkeys/:id', requireStepUp, async (c) => {
    const r = await c.var.deps.db
      .delete(passkeys)
      .where(and(eq(passkeys.id, c.req.param('id')), eq(passkeys.userId, c.var.user.id)))
      .returning({ name: passkeys.name });
    if (!r.length) notFound('passkey');
    await audit(c, 'passkey.remove', { name: r[0]!.name });
    return c.json({ ok: true });
  })

  .post('/password', requireStepUp, async (c) => {
    const input = await body(c, passwordChangeSchema);
    const { db, env, now } = c.var.deps;
    const user = c.var.user;
    if (!user.passwordHash || !(await verifyPassword(input.currentPassword, user.passwordHash, env.SESSION_PEPPER))) {
      fail(400, 'current password is incorrect', 'BAD_CREDENTIALS');
    }
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(input.newPassword, env.SESSION_PEPPER, env.PASSWORD_ITERATIONS), updatedAt: now() })
      .where(eq(users.id, user.id));
    await revokeUserSessions(c, user.id, c.var.session.id);
    await audit(c, 'password.change');
    return c.json({ ok: true });
  })

  .post('/totp/rebind', requireStepUp, async (c) => {
    const { db, env } = c.var.deps;
    const user = c.var.user;
    const secret = generateTotpSecret();
    await db
      .update(users)
      .set({ totpPendingEnc: await encryptField(env.APP_ENC_KEY, secret, totpContext(user.id)) })
      .where(eq(users.id, user.id));
    return c.json({ secret, uri: totpUri(secret, user.username, env.RP_NAME) });
  })

  .post('/totp/rebind/confirm', requireStepUp, async (c) => {
    const { code } = await body(c, totpConfirmSchema);
    const user = c.var.user;
    const [fresh] = await c.var.deps.db.select().from(users).where(eq(users.id, user.id));
    if (!fresh?.totpPendingEnc) fail(400, 'no pending authenticator', 'NO_PENDING');
    if (!(await checkTotp(c.var.deps, fresh, code, 'pending'))) fail(400, 'incorrect code', 'BAD_CREDENTIALS');
    await c.var.deps.db
      .update(users)
      .set({ totpSecretEnc: fresh.totpPendingEnc, totpPendingEnc: null, totpEnabled: true, updatedAt: c.var.deps.now() })
      .where(eq(users.id, user.id));
    await audit(c, 'totp.rebind');
    return c.json({ ok: true });
  })

  .get('/recovery-codes', async (c) => c.json({ remaining: await remainingRecoveryCodes(c.var.deps, c.var.user.id) }))

  .post('/recovery-codes', requireStepUp, async (c) => {
    const codes = await regenerateRecoveryCodes(c.var.deps, c.var.user.id);
    await audit(c, 'recovery.regenerate');
    return c.json({ codes });
  })

  .get('/audit', async (c) => {
    const rows = await c.var.deps.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.userId, c.var.user.id))
      .orderBy(desc(auditLog.createdAt))
      .limit(100);
    return c.json(
      rows.map(
        (r): AuditDto => ({
          id: r.id,
          action: r.action,
          detail: r.detail,
          ip: r.ip,
          createdAt: r.createdAt,
          username: c.var.user.username,
        }),
      ),
    );
  });
