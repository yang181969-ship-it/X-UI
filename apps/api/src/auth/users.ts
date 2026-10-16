import { and, count, eq, isNull } from 'drizzle-orm';
import type { Role, UserDto } from '@z-ui/shared';
import { categories, passkeys, recoveryCodes, users } from '../db/schema.ts';
import type { Deps, UserRow } from '../env.ts';
import { decryptField, encryptField, randomBytes, sha256Hex } from '../lib/crypto.ts';
import { bytesToBase64Url } from '../lib/encoding.ts';
import { chunkRows } from '../lib/chunks.ts';
import { newId } from '../lib/id.ts';
import { hashPassword } from './password.ts';
import { verifyTotp } from './totp.ts';

export const totpContext = (userId: string) => `user:${userId}:totp`;

export async function createUser(
  deps: Deps,
  input: { username: string; displayName: string; password: string; role: Role; status: UserRow['status']; totpSecret: string },
): Promise<UserRow> {
  const t = deps.now();
  const id = newId();
  const row: UserRow = {
    id,
    username: input.username.toLowerCase(),
    displayName: input.displayName,
    role: input.role,
    status: input.status,
    passwordHash: await hashPassword(input.password, deps.env.SESSION_PEPPER, deps.env.PASSWORD_ITERATIONS),
    totpSecretEnc: await encryptField(deps.env.APP_ENC_KEY, input.totpSecret, totpContext(id)),
    totpPendingEnc: null,
    totpEnabled: false,
    totpLastStep: null,
    webauthnUserId: bytesToBase64Url(randomBytes(32)),
    avatar: null,
    createdAt: t,
    updatedAt: t,
  };
  await deps.db.insert(users).values(row);
  await seedCategories(deps, id);
  return row;
}

/** Each user starts with their own copy of the default categories from the config file. */
export async function seedCategories(deps: Deps, userId: string) {
  const cfg = deps.config.get();
  const rows = (['expense', 'income'] as const).flatMap((kind) =>
    cfg.defaultCategories[kind].map((c, i) => ({
      id: newId(),
      userId,
      kind,
      name: c.name,
      parentId: null,
      icon: c.icon ?? null,
      color: c.color ?? null,
      sort: i,
      archived: false,
    })),
  );
  for (const part of chunkRows(rows)) await deps.db.insert(categories).values(part);
}

/**
 * Check a TOTP code against the user's active (or pending) secret, rejecting replays.
 * On success the time step is recorded.
 */
export async function checkTotp(deps: Deps, user: UserRow, code: string, which: 'active' | 'pending' = 'active') {
  const enc = which === 'active' ? user.totpSecretEnc : user.totpPendingEnc;
  if (!enc) return false;
  const secret = await decryptField(deps.env.APP_ENC_KEY, enc, totpContext(user.id));
  const step = verifyTotp(secret, code, deps.now());
  if (step === null || (user.totpLastStep !== null && step <= user.totpLastStep)) return false;
  await deps.db.update(users).set({ totpLastStep: step }).where(eq(users.id, user.id));
  user.totpLastStep = step;
  return true;
}

export async function decryptTotpSecret(deps: Deps, user: UserRow, which: 'active' | 'pending' = 'active') {
  const enc = which === 'active' ? user.totpSecretEnc : user.totpPendingEnc;
  return enc ? decryptField(deps.env.APP_ENC_KEY, enc, totpContext(user.id)) : null;
}

// ---------------------------------------------------------------- recovery codes

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function normalizeRecovery(code: string) {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Replace all recovery codes with 10 fresh ones; returns them in clear (shown once). */
export async function regenerateRecoveryCodes(deps: Deps, userId: string): Promise<string[]> {
  const codes: string[] = [];
  for (let i = 0; i < 10; i++) {
    const bytes = randomBytes(10);
    let s = '';
    for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
    codes.push(`${s.slice(0, 5)}-${s.slice(5)}`);
  }
  const t = deps.now();
  await deps.db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  await deps.db.insert(recoveryCodes).values(
    await Promise.all(
      codes.map(async (code) => ({
        id: newId(),
        userId,
        codeHash: await sha256Hex(`${userId}:${normalizeRecovery(code)}`),
        usedAt: null,
        createdAt: t,
      })),
    ),
  );
  return codes;
}

export async function consumeRecoveryCode(deps: Deps, userId: string, code: string): Promise<boolean> {
  const hash = await sha256Hex(`${userId}:${normalizeRecovery(code)}`);
  const [row] = await deps.db
    .select()
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), eq(recoveryCodes.codeHash, hash), isNull(recoveryCodes.usedAt)));
  if (!row) return false;
  await deps.db.update(recoveryCodes).set({ usedAt: deps.now() }).where(eq(recoveryCodes.id, row.id));
  return true;
}

export async function remainingRecoveryCodes(deps: Deps, userId: string): Promise<number> {
  const [r] = await deps.db
    .select({ n: count() })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
  return r?.n ?? 0;
}

export async function toUserDto(deps: Deps, user: UserRow): Promise<UserDto> {
  const [r] = await deps.db.select({ n: count() }).from(passkeys).where(eq(passkeys.userId, user.id));
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    totpEnabled: user.totpEnabled,
    passkeyCount: r?.n ?? 0,
    avatar: user.avatar ?? null,
    createdAt: user.createdAt,
  };
}
