import { useQuery } from '@tanstack/react-query';
import type { CardLinkCreate, CardLinkDto, CardLinkEnd, CardLinkUpdate, SpendingSourceResult } from '@xui/ledger-shared';
import { del, get, patch, post } from './client.ts';
import { CARDS } from './cards.ts';

/**
 * Card ↔ account links (API_SPEC §3.5). Links are embedded in card and account DTOs (details and
 * list summaries) and drive the spending-source recommendation, so every link write refreshes
 * accounts, cards and institutions (useRefreshAccounts).
 */

const path = (id: string) => `/card-links/${encodeURIComponent(id)}`;

export const createLink = (body: CardLinkCreate) => post<CardLinkDto>('/card-links', body);
export const updateLink = (id: string, body: CardLinkUpdate) => patch<CardLinkDto>(path(id), body);
export const setDefaultLink = (id: string) => post<CardLinkDto>(`${path(id)}/default`);
export const endLink = (id: string, body: CardLinkEnd) => post<CardLinkDto>(`${path(id)}/end`, body);
export const deleteLink = (id: string) => del<{ ok: true }>(path(id));

/**
 * The recommended spending source for a purchase in `currency` (read-only). Under the cards key,
 * so any account, card, currency or link write (useRefreshAccounts) refetches it.
 */
export const useSpendingSource = (cardId: string | undefined, currency: string | undefined) =>
  useQuery({
    queryKey: [CARDS, 'spending-source', cardId, currency],
    queryFn: () => get<SpendingSourceResult>(`/cards/${encodeURIComponent(cardId!)}/spending-source?currency=${encodeURIComponent(currency!)}`),
    enabled: !!cardId && !!currency,
    staleTime: 0,
  });
