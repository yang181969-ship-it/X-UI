import { Secret, TOTP } from 'otpauth';

/**
 * X-UI v1 browser tests (npm run test:e2e:v1). Shared between the throwaway server (seed) and the
 * tests. Test-only values; every name below is fictional — no real financial data.
 * Port 8798, so the legacy e2e server (8788) and a local v1 dev server (8788 / 5174) never clash.
 */
export const E2E_V1_PORT = 8798;
export const BASE_URL = `http://localhost:${E2E_V1_PORT}`;
export const OWNER = { username: 'owner', password: 'e2e v1 owner password', displayName: '测试用户' };
export const OWNER_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
export const OTHER = { username: 'other', password: 'e2e v1 other password', displayName: '另一位用户' };

/** Seeded with raw rows: the account API arrives in a later step. */
export const SEED = {
  referencedInstitution: '示例参考银行',
  referencingAccount: '示例储蓄账户',
  otherUsersInstitution: 'Other User Test Bank',
};

export function totp(secret: string, at = Date.now()): string {
  return new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate({ timestamp: at });
}
