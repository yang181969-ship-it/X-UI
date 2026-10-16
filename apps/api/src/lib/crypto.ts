import { base64UrlToBytes, bytesToBase64Url, bytesToHex, utf8 } from './encoding.ts';

/** WebCrypto helpers. Works on Node ≥ 20 and Cloudflare Workers. */

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** 256-bit URL-safe random token. */
export function randomToken(bytes = 32): string {
  return bytesToBase64Url(randomBytes(bytes));
}

export async function sha256Hex(input: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(input))));
}

export async function hmacSha256(key: string, message: string): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey('raw', utf8.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, utf8.encode(message)));
}

/** Constant-time comparison of equal-length byte arrays. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ---------------------------------------------------------------- AES-256-GCM field encryption

type AesKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
const keyCache = new Map<string, Promise<AesKey>>();

function importAesKey(keyB64: string): Promise<AesKey> {
  let p = keyCache.get(keyB64);
  if (!p) {
    const raw = base64UrlToBytes(keyB64.replace(/=+$/, ''));
    if (raw.length !== 32) throw new Error('APP_ENC_KEY must be 32 bytes (base64/base64url)');
    p = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keyCache.set(keyB64, p);
  }
  return p;
}

/**
 * Encrypt a short secret (card number, TOTP seed). Output: "v1.<iv>.<ciphertext>" (base64url).
 * `context` is bound as additional authenticated data so a value can't be moved to another
 * column/row without failing to decrypt.
 */
export async function encryptField(keyB64: string, plaintext: string, context: string): Promise<string> {
  const key = await importAesKey(keyB64);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8.encode(context) },
    key,
    utf8.encode(plaintext),
  );
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ct))}`;
}

export async function decryptField(keyB64: string, payload: string, context: string): Promise<string> {
  const [v, ivB64, ctB64] = payload.split('.');
  if (v !== 'v1' || !ivB64 || !ctB64) throw new Error('unknown ciphertext format');
  const key = await importAesKey(keyB64);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlToBytes(ivB64), additionalData: utf8.encode(context) },
    key,
    base64UrlToBytes(ctB64),
  );
  return new TextDecoder().decode(pt);
}
