import { Secret, TOTP } from 'otpauth';

const PERIOD = 30;

function make(secretBase32: string, label = 'user', issuer = 'Z-UI') {
  return new TOTP({
    issuer,
    label,
    algorithm: 'SHA1', // what Google Authenticator supports
    digits: 6,
    period: PERIOD,
    secret: Secret.fromBase32(secretBase32),
  });
}

export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function totpUri(secretBase32: string, label: string, issuer: string): string {
  return make(secretBase32, label, issuer).toString();
}

/**
 * Verify a code allowing ±1 step of clock drift. Returns the matched time step, or null.
 * Callers must reject steps ≤ the last accepted one to stop replays.
 */
export function verifyTotp(secretBase32: string, code: string, now = Date.now()): number | null {
  const delta = make(secretBase32).validate({ token: code, timestamp: now, window: 1 });
  if (delta === null) return null;
  return Math.floor(now / 1000 / PERIOD) + delta;
}

/** Current code; used by tests and the create-admin script. */
export function currentTotp(secretBase32: string, now = Date.now()): string {
  return make(secretBase32).generate({ timestamp: now });
}
