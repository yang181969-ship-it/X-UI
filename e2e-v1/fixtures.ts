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
export const OTHER_TOTP_SECRET = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU';

/** Seeded with raw rows for OWNER (institutions journey). */
export const SEED = {
  referencedInstitution: '示例参考银行',
  referencingAccount: '示例储蓄账户',
  otherUsersInstitution: 'Other User Test Bank',
};

/**
 * The accounts journey signs in as its own user, so its data never changes what the institutions
 * journey counts. Cards, card links and payment channels have no API or UI yet: seeded as rows.
 */
export const ACCOUNTS_USER = { username: 'accounts', password: 'e2e v1 accounts password', displayName: '账户测试用户' };
export const ACCOUNTS_TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
export const ACCOUNTS_SEED = {
  bank: '示例环球银行',
  /** bank account, SG, SGD (default) / USD / EUR; EUR is the scope of a card link. */
  linkedAccount: '示例环球储蓄',
  card: '示例借记卡',
  emi: '示例支付服务',
  /** e-money account used as the balance account of a payment channel. */
  balanceAccount: '示例钱包账户',
  channel: '示例支付渠道',
};

/** The settings journey's own user (no rows: it starts without a user_preferences row). */
export const SETTINGS_USER = { username: 'settings', password: 'e2e v1 settings password', displayName: '设置测试用户' };
export const SETTINGS_TOTP_SECRET = 'MFRGGZDFMZTWQ2LKMFRGGZDFMZTWQ2LK';

export function totp(secret: string, at = Date.now()): string {
  return new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate({ timestamp: at });
}
