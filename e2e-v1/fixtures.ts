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
 * journey counts. Its cards, card links and payment channel are seeded as rows (a fixed starting state).
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
 * (this month = expiring soon, last month = expired). Its card links are seeded as rows (a fixed starting state).
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

/**
 * The card-links journey's own user (M2-B4): a multi-currency account (HKD default, EUR), a USD
 * account, a debit card and a virtual card — no links: the journey creates them through the UI.
 */
export const LINKS_USER = { username: 'links', password: 'e2e v1 links password', displayName: '关联测试用户' };
export const LINKS_TOTP_SECRET = 'NBSWY3DPNBSWY3DPNBSWY3DPNBSWY3DP';
export const LINKS_SEED = {
  emi: '示例多币种机构',
  /** e_money, BE, HKD (default) / EUR. */
  multi: '示例多币种账户',
  /** bank, SG, USD only. */
  usd: '示例美元账户',
  card: '示例多币种借记卡',
  cardLast4: '8642',
  virtualCard: '示例虚拟卡',
  virtualLast4: '9753',
  /** Another user's account, with a fixed id: never offered or reachable. */
  otherUsersAccount: 'Other User Hidden Account',
};

/**
 * The payment-channels journey's own user (M2-B5): a provider, an archived institution, a bank, a
 * free e-money account (the new service's funds account), an e-money account already backing a
 * seeded channel, a bank account and two cards. The journey creates its channels and sources
 * through the UI. All names and last-four digits are fictional.
 */
export const CHANNELS_USER = { username: 'channels', password: 'e2e v1 channels password', displayName: '渠道测试用户' };
export const CHANNELS_TOTP_SECRET = 'ONSWG4TFOQYTEMZUONSWG4TFOQYTEMZU';
export const CHANNELS_SEED = {
  provider: '示例支付服务商',
  archivedProvider: '示例停业机构',
  bank: '示例渠道银行',
  /** e_money, free: the funds account of the payment service the journey creates. */
  funds: '示例服务资金账户',
  /** e_money, already the funds account of `oldChannel`. */
  takenFunds: '示例占用资金账户',
  oldChannel: '示例旧渠道',
  /** bank account: an account source of the payment service; never offered for the wallet. */
  bankAccount: '示例渠道储蓄',
  card: '示例渠道借记卡',
  cardLast4: '3141',
  virtualCard: '示例渠道虚拟卡',
  virtualLast4: '2718',
  /** Typed in the UI. */
  service: '示例支付服务',
  wallet: '示例设备钱包',
  /** Another user's channel, with a fixed id: never listed or reachable. */
  otherUsersChannel: 'Other User Hidden Channel',
  otherUsersChannelId: 'e2e-other-user-channel',
};

/**
 * The transactions journey's own user (M3-B4-B): the home region stays the default CN (no settings
 * row). Accounts, a card and a channel are seeded as rows; the transactions themselves are created
 * through the real API (POST /api/transactions with an Idempotency-Key) by the journey — the create
 * form arrives in B4-C. All names, numbers and amounts are fictional.
 */
export const TXN_USER = { username: 'transactions', password: 'e2e v1 transactions password', displayName: '流水测试用户' };
export const TXN_TOTP_SECRET = 'KRUGS4ZANFZSAYJAORSXG5BAONSWG4TF';
export const TXN_SEED = {
  bank: '示例流水银行',
  emi: '示例流水支付机构',
  /** bank, HK: HKD (default) / EUR. */
  hkAccount: '示例港币账户',
  /** e_money, US: USD. */
  usdAccount: '示例美元钱包',
  /** bank, CN (= the home region): CNY. */
  cnAccount: '示例境内账户',
  card: '示例流水借记卡',
  cardLast4: '5566',
  /** device wallet without sources. */
  channel: '示例流水钱包',
};

/**
 * The create-form journey's own user (M3-B4-C): home region stays the default CN. One card has an
 * active all-currency spending-source link to the HK account (USD → exact match, JPY → conversion);
 * the other card has no link (no match). All names, numbers and amounts are fictional.
 */
export const CREATE_USER = { username: 'creator', password: 'e2e v1 creator password', displayName: '录入测试用户' };
export const CREATE_TOTP_SECRET = 'MNZGKYLUNFXW4ZDBORQXGZLDOJSXIMZT';
export const CREATE_SEED = {
  bank: '示例录入银行',
  emi: '示例录入支付机构',
  /** bank, HK: HKD (default) / USD active, EUR closed. */
  hk: '示例录入港币账户',
  /** e_money, US: USD. */
  us: '示例录入美元钱包',
  /** bank, CN (= the home region): CNY. */
  cn: '示例录入境内账户',
  /** Linked to `hk` (spending source, all currencies, default). */
  linkedCard: '示例推荐借记卡',
  linkedLast4: '7788',
  /** No links. */
  plainCard: '示例无关联借记卡',
  plainLast4: '9900',
};

/**
 * The lifecycle journeys' users (M3-B4-D): one for settlement / corrections / void / conflicts, one
 * for lost responses, recovery and the phone layout. Same fictional accounts each: an HK bank account
 * (HKD default, USD, EUR closed), a US wallet (USD) and a home-region (CN) account (CNY). Their
 * transactions are created through the API by the journeys.
 */
export const LIFE_USER = { username: 'lifecycle', password: 'e2e v1 lifecycle password', displayName: '生命周期测试用户' };
export const LIFE_TOTP_SECRET = 'NRUWMZLDPFRWYZJAORSXG5DFOJXGK4TB';
export const RECOVER_USER = { username: 'recovery', password: 'e2e v1 recovery password', displayName: '恢复测试用户' };
export const RECOVER_TOTP_SECRET = 'OJSWG33WMVZHSIDUMVZXI2LOM5SXEYLC';
export const LEDGER_SEED = {
  bank: '示例生命周期银行',
  emi: '示例生命周期支付机构',
  hk: '示例更正港币账户',
  us: '示例更正美元钱包',
  cn: '示例更正境内账户',
};

export function totp(secret: string, at = Date.now()): string {
  return new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate({ timestamp: at });
}
