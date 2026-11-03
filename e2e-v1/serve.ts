/**
 * Starts the X-UI v1 production build (apps/ledger-web/dist served by apps/ledger-api) against a
 * throwaway database in data/e2e-v1/, so browser runs never touch data/x-ui-v1.db or the legacy
 * app. Seeds seven users and a few fictional rows (the accounts, settings, cards, card-links and channels journeys have their own users).
 */
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createUser } from '../apps/ledger-api/src/auth/users.ts';
import { openV1Db } from '../apps/ledger-api/src/db/client.ts';
import { accountCardLinks, accountCurrencies, accounts, cards, institutions, paymentChannels, paymentChannelSources, users } from '../apps/ledger-api/src/db/schema.ts';
import { readEnv } from '../apps/ledger-api/src/env.ts';
import { newId } from '../apps/ledger-api/src/lib/id.ts';
import { legacyDbPaths, main, REPO_ROOT } from '../apps/ledger-api/src/node.ts';
import {
  ACCOUNTS_SEED,
  ACCOUNTS_TOTP_SECRET,
  ACCOUNTS_USER,
  BASE_URL,
  CARDS_SEED,
  CARDS_TOTP_SECRET,
  CARDS_USER,
  CHANNELS_SEED,
  CHANNELS_TOTP_SECRET,
  CHANNELS_USER,
  E2E_V1_PORT,
  LINKS_SEED,
  LINKS_TOTP_SECRET,
  LINKS_USER,
  OTHER,
  OTHER_TOTP_SECRET,
  OWNER,
  OWNER_TOTP_SECRET,
  SEED,
  SETTINGS_TOTP_SECRET,
  SETTINGS_USER,
} from './fixtures.ts';

const dir = resolve(REPO_ROOT, 'data/e2e-v1');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

Object.assign(process.env, {
  NODE_ENV: 'production',
  XUI_V1_PORT: String(E2E_V1_PORT),
  XUI_V1_HOST: '127.0.0.1',
  XUI_V1_DATABASE_URL: `file:${resolve(dir, 'x-ui-v1.db')}`,
  XUI_V1_ORIGINS: BASE_URL,
  XUI_V1_RP_ID: 'localhost',
  XUI_V1_APP_ENC_KEY: 'r8Kx2m1c3v4b5n6m7a8s9d0f1g2h3j4k5l6z7x8c9v0=',
  XUI_V1_SESSION_PEPPER: 'e2e-v1-pepper',
  XUI_V1_COOKIE_SECURE: 'false',
  XUI_V1_PASSWORD_ITERATIONS: '10000',
});

const { db, client } = await openV1Db(process.env.XUI_V1_DATABASE_URL!, { legacyPaths: legacyDbPaths() });
const deps = { db, env: readEnv(process.env), now: Date.now };
const activate = async (input: typeof OWNER, totpSecret: string) => {
  const u = await createUser(deps, { ...input, role: 'admin', status: 'pending', totpSecret });
  await db.update(users).set({ status: 'active', totpEnabled: true }).where(eq(users.id, u.id));
  return u;
};
const owner = await activate(OWNER, OWNER_TOTP_SECRET);
const other = await activate(OTHER, OTHER_TOTP_SECRET);

const now = Date.now();
const refBank = newId(now);
const otherBank = newId(now);
await db.insert(institutions).values([
  { id: refBank, userId: owner.id, name: SEED.referencedInstitution, nameKey: SEED.referencedInstitution, country: 'SG', institutionType: 'bank', createdAt: now, updatedAt: now },
  { id: otherBank, userId: other.id, name: SEED.otherUsersInstitution, nameKey: SEED.otherUsersInstitution.toLowerCase(), country: 'HK', institutionType: 'bank', createdAt: now, updatedAt: now },
]);
// Another user's card: the cards journey must never see it (fixed id, so it can try to open it).
await db.insert(cards).values({ id: CARDS_SEED.otherUsersCardId, userId: other.id, issuerInstitutionId: otherBank, name: CARDS_SEED.otherUsersCard, network: 'visa', cardType: 'debit', last4: '9999', issuingCountry: 'HK', createdAt: now, updatedAt: now });
const account = newId(now);
await db.insert(accounts).values({
  id: account,
  userId: owner.id,
  institutionId: refBank,
  name: SEED.referencingAccount,
  nameKey: SEED.referencingAccount,
  accountType: 'bank',
  accountCountry: 'SG',
  createdAt: now,
  updatedAt: now,
});
await db.insert(accountCurrencies).values({ accountId: account, userId: owner.id, currency: 'SGD', isDefault: true, createdAt: now });

// The accounts journey's own user and rows (fictional).
const acc = await activate(ACCOUNTS_USER, ACCOUNTS_TOTP_SECRET);
const [bank, emi, linked, wallet, card] = [newId(now), newId(now), newId(now), newId(now), newId(now)];
await db.insert(institutions).values([
  { id: bank, userId: acc.id, name: ACCOUNTS_SEED.bank, nameKey: ACCOUNTS_SEED.bank, country: 'SG', institutionType: 'bank', createdAt: now, updatedAt: now },
  { id: emi, userId: acc.id, name: ACCOUNTS_SEED.emi, nameKey: ACCOUNTS_SEED.emi, country: 'LU', institutionType: 'emi', createdAt: now, updatedAt: now },
]);
await db.insert(accounts).values([
  { id: linked, userId: acc.id, institutionId: bank, name: ACCOUNTS_SEED.linkedAccount, nameKey: ACCOUNTS_SEED.linkedAccount, accountType: 'bank', depositKind: 'savings', accountCountry: 'SG', numberHint: '0042', createdAt: now, updatedAt: now },
  { id: wallet, userId: acc.id, institutionId: emi, name: ACCOUNTS_SEED.balanceAccount, nameKey: ACCOUNTS_SEED.balanceAccount, accountType: 'e_money', accountCountry: 'LU', createdAt: now, updatedAt: now },
]);
await db.insert(accountCurrencies).values([
  { accountId: linked, userId: acc.id, currency: 'SGD', isDefault: true, sort: 0, createdAt: now },
  { accountId: linked, userId: acc.id, currency: 'USD', sort: 1, createdAt: now },
  { accountId: linked, userId: acc.id, currency: 'EUR', sort: 2, createdAt: now },
  { accountId: wallet, userId: acc.id, currency: 'EUR', isDefault: true, createdAt: now },
]);
await db.insert(cards).values({ id: card, userId: acc.id, issuerInstitutionId: bank, name: ACCOUNTS_SEED.card, network: 'visa', cardType: 'debit', last4: '4242', issuingCountry: 'SG', createdAt: now, updatedAt: now });
await db.insert(accountCardLinks).values({ id: newId(now), userId: acc.id, cardId: card, accountId: linked, currency: 'EUR', role: 'spending_source', isDefault: true, createdAt: now, updatedAt: now });
await db.insert(paymentChannels).values({ id: newId(now), userId: acc.id, name: ACCOUNTS_SEED.channel, nameKey: ACCOUNTS_SEED.channel, channelType: 'payment_service', balanceAccountId: wallet, createdAt: now, updatedAt: now });

// The settings journey's own user: no user_preferences row, so it starts on the default (CN).
await activate(SETTINGS_USER, SETTINGS_TOTP_SECRET);

// The cards journey's own user and rows (fictional). Expiries are relative to today (local time,
// as the browser sees it): this month = expiring soon, last month = expired.
const cardsUser = await activate(CARDS_USER, CARDS_TOTP_SECRET);
const ym = (monthsAhead: number) => {
  const d = new Date();
  const m = new Date(d.getFullYear(), d.getMonth() + monthsAhead, 1);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
};
const [cBank, cEmi, cArchived, cAccount] = [newId(now), newId(now), newId(now), newId(now)];
await db.insert(institutions).values([
  { id: cBank, userId: cardsUser.id, name: CARDS_SEED.bank, nameKey: CARDS_SEED.bank, country: 'SG', institutionType: 'bank', color: '#2f54eb', createdAt: now, updatedAt: now },
  { id: cEmi, userId: cardsUser.id, name: CARDS_SEED.emi, nameKey: CARDS_SEED.emi, country: 'HK', institutionType: 'emi', color: '#13c2c2', createdAt: now, updatedAt: now },
  { id: cArchived, userId: cardsUser.id, name: CARDS_SEED.archivedBank, nameKey: CARDS_SEED.archivedBank, country: 'GB', institutionType: 'bank', status: 'archived', createdAt: now, updatedAt: now },
]);
await db.insert(accounts).values({ id: cAccount, userId: cardsUser.id, institutionId: cBank, name: CARDS_SEED.account, nameKey: CARDS_SEED.account, accountType: 'bank', accountCountry: 'SG', createdAt: now, updatedAt: now });
await db.insert(accountCurrencies).values([
  { accountId: cAccount, userId: cardsUser.id, currency: 'SGD', isDefault: true, sort: 0, createdAt: now },
  { accountId: cAccount, userId: cardsUser.id, currency: 'USD', sort: 1, createdAt: now },
]);
const cardRow = (name: string, issuer: string, extra: Partial<typeof cards.$inferInsert>) => ({
  id: newId(now),
  userId: cardsUser.id,
  issuerInstitutionId: issuer,
  name,
  network: 'visa' as const,
  cardType: 'debit' as const,
  last4: '1357',
  issuingCountry: 'SG',
  createdAt: now,
  updatedAt: now,
  ...extra,
});
const linkedCard = cardRow(CARDS_SEED.linkedCard, cBank, { last4: CARDS_SEED.linkedLast4, expiresOn: ym(0), sort: 1 });
await db.insert(cards).values([
  linkedCard,
  cardRow(CARDS_SEED.expiredCard, cBank, { network: 'mastercard', last4: '1122', expiresOn: ym(-1), sort: 2 }),
  cardRow(CARDS_SEED.longCard, cBank, { network: 'unionpay', form: 'virtual', last4: '3344', expiresOn: ym(36), sort: 3 }),
  cardRow(CARDS_SEED.noExpiryCard, cEmi, { cardType: 'prepaid', network: 'mastercard', last4: '5566', issuingCountry: 'HK', sort: 4 }),
  cardRow(CARDS_SEED.archivedIssuerCard, cArchived, { last4: '7788', issuingCountry: 'GB', expiresOn: ym(36), sort: 5 }),
]);
await db.insert(accountCardLinks).values([
  { id: newId(now), userId: cardsUser.id, cardId: linkedCard.id, accountId: cAccount, role: 'spending_source', isDefault: true, createdAt: now, updatedAt: now },
  { id: newId(now), userId: cardsUser.id, cardId: linkedCard.id, accountId: cAccount, currency: 'USD', role: 'top_up_source', status: 'ended', endedOn: '2025-01-31', createdAt: now, updatedAt: now },
]);
// A device wallet with the linked card as an active and an ended source (what a delete would remove with it).
const cWallet = newId(now);
await db.insert(paymentChannels).values({ id: cWallet, userId: cardsUser.id, name: CARDS_SEED.wallet, nameKey: CARDS_SEED.wallet, channelType: 'device_wallet', createdAt: now, updatedAt: now });
await db.insert(paymentChannelSources).values([
  { id: newId(now), userId: cardsUser.id, channelId: cWallet, cardId: linkedCard.id, status: 'active', createdAt: now, updatedAt: now },
  { id: newId(now), userId: cardsUser.id, channelId: cWallet, cardId: linkedCard.id, status: 'ended', createdAt: now, updatedAt: now },
]);
// The card-links journey's own user and rows (fictional); the links themselves are made in the UI.
const linksUser = await activate(LINKS_USER, LINKS_TOTP_SECRET);
const [lEmi, lMulti, lUsd] = [newId(now), newId(now), newId(now)];
await db.insert(institutions).values({ id: lEmi, userId: linksUser.id, name: LINKS_SEED.emi, nameKey: LINKS_SEED.emi, country: 'BE', institutionType: 'emi', color: '#9fe870', createdAt: now, updatedAt: now });
await db.insert(accounts).values([
  { id: lMulti, userId: linksUser.id, institutionId: lEmi, name: LINKS_SEED.multi, nameKey: LINKS_SEED.multi, accountType: 'e_money', accountCountry: 'BE', sort: 1, createdAt: now, updatedAt: now },
  { id: lUsd, userId: linksUser.id, institutionId: lEmi, name: LINKS_SEED.usd, nameKey: LINKS_SEED.usd, accountType: 'bank', accountCountry: 'SG', sort: 2, createdAt: now, updatedAt: now },
]);
await db.insert(accountCurrencies).values([
  { accountId: lMulti, userId: linksUser.id, currency: 'HKD', isDefault: true, sort: 0, createdAt: now },
  { accountId: lMulti, userId: linksUser.id, currency: 'EUR', sort: 1, createdAt: now },
  { accountId: lUsd, userId: linksUser.id, currency: 'USD', isDefault: true, sort: 0, createdAt: now },
]);
await db.insert(cards).values([
  { id: newId(now), userId: linksUser.id, issuerInstitutionId: lEmi, name: LINKS_SEED.card, network: 'visa', cardType: 'debit', last4: LINKS_SEED.cardLast4, issuingCountry: 'BE', sort: 1, createdAt: now, updatedAt: now },
  { id: newId(now), userId: linksUser.id, issuerInstitutionId: lEmi, name: LINKS_SEED.virtualCard, network: 'visa', cardType: 'debit', form: 'virtual', last4: LINKS_SEED.virtualLast4, issuingCountry: 'BE', sort: 2, createdAt: now, updatedAt: now },
]);
// Another user's account (must never be offered in the link dialog).
await db.insert(accounts).values({ id: 'e2e-other-user-account', userId: other.id, institutionId: otherBank, name: LINKS_SEED.otherUsersAccount, nameKey: LINKS_SEED.otherUsersAccount.toLowerCase(), accountType: 'bank', accountCountry: 'HK', createdAt: now, updatedAt: now });
await db.insert(accountCurrencies).values({ accountId: 'e2e-other-user-account', userId: other.id, currency: 'USD', isDefault: true, createdAt: now });

// The payment-channels journey's own user and rows (fictional); its new channels and sources are made in the UI.
const chUser = await activate(CHANNELS_USER, CHANNELS_TOTP_SECRET);
const [chProvider, chArchived, chBank, chFunds, chTaken, chSavings] = [newId(now), newId(now), newId(now), newId(now), newId(now), newId(now)];
await db.insert(institutions).values([
  { id: chProvider, userId: chUser.id, name: CHANNELS_SEED.provider, nameKey: CHANNELS_SEED.provider, country: 'LU', institutionType: 'emi', color: '#1677ff', createdAt: now, updatedAt: now },
  { id: chArchived, userId: chUser.id, name: CHANNELS_SEED.archivedProvider, nameKey: CHANNELS_SEED.archivedProvider, country: 'GB', institutionType: 'emi', status: 'archived', createdAt: now, updatedAt: now },
  { id: chBank, userId: chUser.id, name: CHANNELS_SEED.bank, nameKey: CHANNELS_SEED.bank, country: 'SG', institutionType: 'bank', createdAt: now, updatedAt: now },
]);
await db.insert(accounts).values([
  { id: chFunds, userId: chUser.id, institutionId: chProvider, name: CHANNELS_SEED.funds, nameKey: CHANNELS_SEED.funds, accountType: 'e_money', accountCountry: 'LU', sort: 1, createdAt: now, updatedAt: now },
  { id: chTaken, userId: chUser.id, institutionId: chProvider, name: CHANNELS_SEED.takenFunds, nameKey: CHANNELS_SEED.takenFunds, accountType: 'e_money', accountCountry: 'LU', sort: 2, createdAt: now, updatedAt: now },
  { id: chSavings, userId: chUser.id, institutionId: chBank, name: CHANNELS_SEED.bankAccount, nameKey: CHANNELS_SEED.bankAccount, accountType: 'bank', accountCountry: 'SG', sort: 3, createdAt: now, updatedAt: now },
]);
await db.insert(accountCurrencies).values([
  { accountId: chFunds, userId: chUser.id, currency: 'EUR', isDefault: true, createdAt: now },
  { accountId: chTaken, userId: chUser.id, currency: 'EUR', isDefault: true, createdAt: now },
  { accountId: chSavings, userId: chUser.id, currency: 'SGD', isDefault: true, createdAt: now },
]);
await db.insert(cards).values([
  { id: newId(now), userId: chUser.id, issuerInstitutionId: chBank, name: CHANNELS_SEED.card, network: 'visa', cardType: 'debit', last4: CHANNELS_SEED.cardLast4, issuingCountry: 'SG', sort: 1, createdAt: now, updatedAt: now },
  { id: newId(now), userId: chUser.id, issuerInstitutionId: chBank, name: CHANNELS_SEED.virtualCard, network: 'mastercard', cardType: 'debit', form: 'virtual', last4: CHANNELS_SEED.virtualLast4, issuingCountry: 'SG', sort: 2, createdAt: now, updatedAt: now },
]);
await db.insert(paymentChannels).values({ id: newId(now), userId: chUser.id, name: CHANNELS_SEED.oldChannel, nameKey: CHANNELS_SEED.oldChannel, channelType: 'payment_service', balanceAccountId: chTaken, sort: 9, createdAt: now, updatedAt: now });
// Another user's channel (fixed id): the journey tries to open it.
await db.insert(paymentChannels).values({ id: CHANNELS_SEED.otherUsersChannelId, userId: other.id, name: CHANNELS_SEED.otherUsersChannel, nameKey: CHANNELS_SEED.otherUsersChannel.toLowerCase(), channelType: 'device_wallet', createdAt: now, updatedAt: now });
client.close();

await main();
