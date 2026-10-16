import { Secret, TOTP } from 'otpauth';

/** Shared between the e2e server (seed) and the tests. Test-only values. */
export const E2E_PORT = 8788;
export const BASE_URL = `http://localhost:${E2E_PORT}`;
export const ADMIN = { username: 'admin', password: 'e2e admin password', displayName: '管理员' };
export const ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

export function totp(secret: string, at = Date.now()): string {
  return new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate({ timestamp: at });
}
