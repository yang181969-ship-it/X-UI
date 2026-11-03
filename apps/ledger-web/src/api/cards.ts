import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { CardCreate, CardCreateResult, CardDetail, CardDto, CardListItem, CardListQuery, CardUpdate } from '@xui/ledger-shared';
import { del, get, patch, post, qs } from './client.ts';

/**
 * Query key prefix: invalidating it refreshes every card list and detail. Card DTOs embed their
 * issuer and linked accounts, and account / institution DTOs embed cards, so writes to any of the
 * three refresh all of them (useRefreshAccounts).
 */
export const CARDS = 'cards';

export const useCards = (filters: CardListQuery, enabled = true) =>
  useQuery({
    queryKey: [CARDS, 'list', filters],
    queryFn: () => get<CardListItem[]>(`/cards${qs(filters)}`),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useCard = (id: string | undefined) =>
  useQuery({
    queryKey: [CARDS, 'detail', id],
    queryFn: () => get<CardDetail>(`/cards/${encodeURIComponent(id!)}`),
    enabled: !!id,
  });

export const createCard = (body: CardCreate) => post<CardCreateResult>('/cards', body);
export const updateCard = (id: string, body: CardUpdate) => patch<CardDto>(`/cards/${encodeURIComponent(id)}`, body);
export const deleteCard = (id: string) => del<{ ok: true }>(`/cards/${encodeURIComponent(id)}`);
