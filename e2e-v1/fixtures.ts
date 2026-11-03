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

/**
 * The cards journey's own user. Card expiries are seeded relative to the day the server starts
 * (this month = expiring soon, last month = expired). Card links have no API yet: seeded as rows.
 * All names and last-four digits are fictional.
 */
export const CARDS_USER = { username: 'cards', password: 'e2e v1 cards password', displayName: '银行卡测试用户' };
export const CARDS_TOTP_SECRET = 'MZXW6YTBOJRGC4TVMZXW6YTBOJRGC4TV';
export const CARDS_SEED = {
  bank: '示例环球银行',
  emi: '示例预付机构',
  archivedBank: '示例归档银行',
  account: '示例储蓄账户',
  /** Debit, this month's expiry (expiring soon), linked to the account (one active, one ended link). */
  linkedCard: '示例旅行借记卡',
  linkedLast4: '2468',
  /** Expired last month, still active. */
  expiredCard: '示例过期借记卡',
  /** Expires in three years. */
  longCard: '示例长期借记卡',
  /** No expiry. */
  noExpiryCard: '示例无期限卡',
  /** Device wallet listing the linked card as one active and one ended source. */
  wallet: '示例手机钱包',
  /** Issued by the archived institution. */
  archivedIssuerCard: '示例归档机构卡',
  /** Another user's card, with a fixed id so the journey can try to open it. */
  otherUsersCard: 'Other User Secret Card',
  otherUsersCardId: 'e2e-other-user-card',
};

export function totp(secret: string, at = Date.now()): string {
  return new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate({ timestamp: at });
}
