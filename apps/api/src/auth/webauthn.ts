import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { and, eq, lt } from 'drizzle-orm';
import { authChallenges, passkeys } from '../db/schema.ts';
import type { Deps, UserRow } from '../env.ts';
import { base64UrlToBytes, bytesToBase64Url } from '../lib/encoding.ts';
import { fail } from '../lib/http.ts';
import { newId } from '../lib/id.ts';

const CHALLENGE_TTL_MS = 5 * 60_000;
type Purpose = 'register' | 'login' | 'step_up';
export type PasskeyRow = typeof passkeys.$inferSelect;

async function storeChallenge(deps: Deps, purpose: Purpose, challenge: string, userId: string | null) {
  const t = deps.now();
  await deps.db.delete(authChallenges).where(lt(authChallenges.expiresAt, t));
  const id = newId();
  await deps.db.insert(authChallenges).values({ id, userId, purpose, challenge, expiresAt: t + CHALLENGE_TTL_MS });
  return id;
}

/** Fetch and delete (single use) a stored challenge. */
async function takeChallenge(deps: Deps, id: string, purpose: Purpose, userId: string | null) {
  const [row] = await deps.db.select().from(authChallenges).where(eq(authChallenges.id, id));
  if (row) await deps.db.delete(authChallenges).where(eq(authChallenges.id, id));
  if (!row || row.purpose !== purpose || row.expiresAt < deps.now() || (userId !== null && row.userId !== userId)) {
    fail(400, 'challenge expired, please try again', 'CHALLENGE');
  }
  return row.challenge;
}

function toCredential(pk: PasskeyRow) {
  return {
    id: pk.id,
    publicKey: base64UrlToBytes(pk.publicKey),
    counter: pk.counter,
    transports: pk.transports ?? undefined,
  };
}

// ---------------------------------------------------------------- registration

export async function registrationOptions(deps: Deps, user: UserRow) {
  const existing = await deps.db.select().from(passkeys).where(eq(passkeys.userId, user.id));
  const options = await generateRegistrationOptions({
    rpName: deps.env.RP_NAME,
    rpID: deps.env.RP_ID,
    userName: user.username,
    userDisplayName: user.displayName,
    userID: base64UrlToBytes(user.webauthnUserId),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports ?? undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  const challengeId = await storeChallenge(deps, 'register', options.challenge, user.id);
  return { challengeId, options };
}

export async function verifyRegistration(
  deps: Deps,
  user: UserRow,
  challengeId: string,
  response: RegistrationResponseJSON,
  name: string,
): Promise<PasskeyRow> {
  const expectedChallenge = await takeChallenge(deps, challengeId, 'register', user.id);
  let result;
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: deps.env.ORIGINS,
      expectedRPID: deps.env.RP_ID,
      requireUserVerification: true,
    });
  } catch (e) {
    fail(400, `passkey registration failed: ${(e as Error).message}`, 'WEBAUTHN');
  }
  if (!result.verified) fail(400, 'passkey registration failed', 'WEBAUTHN');
  const info = result.registrationInfo;
  const row: PasskeyRow = {
    id: info.credential.id,
    userId: user.id,
    publicKey: bytesToBase64Url(info.credential.publicKey),
    counter: info.credential.counter,
    transports: info.credential.transports ?? null,
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    name,
    createdAt: deps.now(),
    lastUsedAt: null,
  };
  await deps.db.insert(passkeys).values(row);
  return row;
}

// ---------------------------------------------------------------- authentication

/** Usernameless login (discoverable credentials) or a step-up for a known user. */
export async function authenticationOptions(deps: Deps, purpose: 'login' | 'step_up', user?: UserRow) {
  const allow = user ? await deps.db.select().from(passkeys).where(eq(passkeys.userId, user.id)) : [];
  if (purpose === 'step_up' && allow.length === 0) fail(400, 'no passkey registered', 'NO_PASSKEY');
  const options = await generateAuthenticationOptions({
    rpID: deps.env.RP_ID,
    userVerification: 'required',
    allowCredentials: allow.map((p) => ({ id: p.id, transports: p.transports ?? undefined })),
  });
  const challengeId = await storeChallenge(deps, purpose, options.challenge, user?.id ?? null);
  return { challengeId, options };
}

/** Verifies an assertion; returns the matching passkey (whose userId identifies the user). */
export async function verifyAuthentication(
  deps: Deps,
  purpose: 'login' | 'step_up',
  challengeId: string,
  response: AuthenticationResponseJSON,
  user?: UserRow,
): Promise<PasskeyRow> {
  const expectedChallenge = await takeChallenge(deps, challengeId, purpose, user?.id ?? null);
  const where = user
    ? and(eq(passkeys.id, response.id), eq(passkeys.userId, user.id))
    : eq(passkeys.id, response.id);
  const [pk] = await deps.db.select().from(passkeys).where(where);
  if (!pk) fail(401, 'unknown passkey', 'WEBAUTHN');
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: deps.env.ORIGINS,
      expectedRPID: deps.env.RP_ID,
      credential: toCredential(pk),
      requireUserVerification: true,
    });
  } catch (e) {
    fail(401, `passkey verification failed: ${(e as Error).message}`, 'WEBAUTHN');
  }
  if (!result.verified) fail(401, 'passkey verification failed', 'WEBAUTHN');
  const t = deps.now();
  await deps.db
    .update(passkeys)
    .set({ counter: result.authenticationInfo.newCounter, lastUsedAt: t })
    .where(eq(passkeys.id, pk.id));
  return { ...pk, counter: result.authenticationInfo.newCounter, lastUsedAt: t };
}
