import { hmacSha256, randomBytes, timingSafeEqual } from '../lib/crypto.ts';
import { base64UrlToBytes, bytesToBase64Url } from '../lib/encoding.ts';

/**
 * PBKDF2-SHA256 with a per-user salt and a server-side pepper (HMAC pre-hash). The iteration
 * count is stored in each hash. 100k (~7 ms) is the most Cloudflare's WebCrypto accepts; new
 * hashes use PASSWORD_ITERATIONS (default 50k, within the free plan's 10 ms CPU). Passkeys are
 * the primary login; the password is only ever accepted together with a TOTP code.
 */
const ITERATIONS = 100_000;
const SCHEME = 'pbkdf2-sha256';

async function derive(password: string, pepper: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const pre = await hmacSha256(pepper, password.normalize('NFKC'));
  const key = await crypto.subtle.importKey('raw', pre, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, pepper: string, iterations = ITERATIONS): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, pepper, salt, iterations);
  return `${SCHEME}$${iterations}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string, pepper: string): Promise<boolean> {
  const [scheme, iter, saltB64, hashB64] = stored.split('$');
  if (scheme !== SCHEME || !iter || !saltB64 || !hashB64 || Number(iter) > ITERATIONS) return false;
  const hash = await derive(password, pepper, base64UrlToBytes(saltB64), Number(iter));
  return timingSafeEqual(hash, base64UrlToBytes(hashB64));
}

/** PBKDF2 iteration count stored in a hash (0 if unreadable). */
export const hashIterations = (stored: string) => Number(stored.split('$')[1]) || 0;

/** A hash that never verifies, used to keep timing similar for unknown usernames. */
export const dummyHash = (iterations = ITERATIONS) => `${SCHEME}$${iterations}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
