/**
 * Starts the X-UI v1 production build (apps/ledger-web/dist served by apps/ledger-api) against a
 * throwaway database in data/e2e-v1/, so browser runs never touch data/x-ui-v1.db or the legacy
 * app. Seeds four users and a few fictional rows (the accounts and settings journeys have their own users).
 */
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createUser } from '../apps/ledger-api/src/auth/users.ts';
import { openV1Db } from '../apps/ledger-api/src/db/client.ts';
import { accountCardLinks, accountCurrencies, accounts, cards, institutions, paymentChannels, users } from '../apps/ledger-api/src/db/schema.ts';
import { readEnv } from '../apps/ledger-api/src/env.ts';
import { newId } from '../apps/ledger-api/src/lib/id.ts';
import { legacyDbPaths, main, REPO_ROOT } from '../apps/ledger-api/src/node.ts';
import {
  ACCOUNTS_SEED,
  ACCOUNTS_TOTP_SECRET,
  ACCOUNTS_USER,
  BASE_URL,
  E2E_V1_PORT,
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
await db.insert(institutions).values([
  { id: refBank, userId: owner.id, name: SEED.referencedInstitution, nameKey: SEED.referencedInstitution, country: 'SG', institutionType: 'bank', createdAt: now, updatedAt: now },
  { id: newId(now), userId: other.id, name: SEED.otherUsersInstitution, nameKey: SEED.otherUsersInstitution.toLowerCase(), country: 'HK', institutionType: 'bank', createdAt: now, updatedAt: now },
]);
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
client.close();

await main();
