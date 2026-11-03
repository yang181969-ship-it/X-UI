import type { CardLinkDto } from '@xui/ledger-shared';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { accountCardLinks, accounts, cards, institutions, paymentChannels } from '../db/schema.ts';

/** Column selections for the summaries embedded in M2 DTOs, and the card-link DTO (shared by the account and card routes). */

export const institutionSummary = {
  id: institutions.id,
  name: institutions.name,
  institutionType: institutions.institutionType,
  color: institutions.color,
  status: institutions.status,
};
export const cardSummary = { id: cards.id, name: cards.name, network: cards.network, last4: cards.last4, cardType: cards.cardType, status: cards.status };
export const accountSummary = { id: accounts.id, name: accounts.name, accountCountry: accounts.accountCountry, status: accounts.status };
export const channelSummary = { id: paymentChannels.id, name: paymentChannels.name, channelType: paymentChannels.channelType, status: paymentChannels.status };

type LinkRow = typeof accountCardLinks.$inferSelect;

export const toLinkDto = ({ link: l, card, account }: { link: LinkRow; card: CardLinkDto['card']; account: CardLinkDto['account'] }): CardLinkDto => ({
  id: l.id,
  cardId: l.cardId,
  accountId: l.accountId,
  currency: l.currency,
  role: l.role,
  isDefault: l.isDefault,
  priority: l.priority,
  status: l.status,
  startedOn: l.startedOn,
  endedOn: l.endedOn,
  notes: l.notes,
  card,
  account,
  createdAt: l.createdAt,
  updatedAt: l.updatedAt,
});

/** Links joined with their card and account summaries (same user on every side, as the composite keys require); callers add where / orderBy and map rows with toLinkDto. */
export const selectLinkDtos = (db: DB) =>
  db
    .select({ link: accountCardLinks, card: cardSummary, account: accountSummary })
    .from(accountCardLinks)
    .innerJoin(cards, and(eq(cards.id, accountCardLinks.cardId), eq(cards.userId, accountCardLinks.userId)))
    .innerJoin(accounts, and(eq(accounts.id, accountCardLinks.accountId), eq(accounts.userId, accountCardLinks.userId)));
