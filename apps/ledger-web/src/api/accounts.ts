import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountCreate, AccountCurrencyInput, AccountDetail, AccountDto, AccountListItem, AccountListQuery, AccountUpdate } from '@xui/ledger-shared';
import { del, get, patch, post, put, qs } from './client.ts';
import { CARDS } from './cards.ts';
import { INSTITUTIONS } from './institutions.ts';

/** Query key prefix: invalidating it refreshes every account list and detail. */
export const ACCOUNTS = 'accounts';

export const useAccounts = (filters: AccountListQuery, enabled = true) =>
  useQuery({
    queryKey: [ACCOUNTS, 'list', filters],
    queryFn: () => get<AccountListItem[]>(`/accounts${qs(filters)}`),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useAccount = (id: string | undefined) =>
  useQuery({
    queryKey: [ACCOUNTS, 'detail', id],
    queryFn: () => get<AccountDetail>(`/accounts/${encodeURIComponent(id!)}`),
    enabled: !!id,
  });

export const createAccount = (body: AccountCreate) => post<AccountDto>('/accounts', body);
export const updateAccount = (id: string, body: AccountUpdate) => patch<AccountDto>(`/accounts/${encodeURIComponent(id)}`, body);
export const replaceCurrencies = (id: string, currencies: AccountCurrencyInput[]) => put<AccountDto>(`/accounts/${encodeURIComponent(id)}/currencies`, { currencies });
export const deleteAccount = (id: string) => del<{ ok: true }>(`/accounts/${encodeURIComponent(id)}`);

/**
 * Refresh accounts, cards and institutions after a write to any of them: each embeds summaries of
 * the others (an account's linked cards, a card's issuer and linked accounts, an institution's
 * account and card counts).
 */
export function useRefreshAccounts() {
  const qc = useQueryClient();
  return () => Promise.all([ACCOUNTS, CARDS, INSTITUTIONS].map((key) => qc.invalidateQueries({ queryKey: [key] })));
}
