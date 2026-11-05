import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  IDEMPOTENCY_KEY_HEADER,
  type TransactionDto,
  type TransactionListDto,
  type TransactionListQuery,
  type TransactionNotesDto,
  type TransactionRevisionDto,
  type TransactionSummaryDto,
  type TransactionSummaryQuery,
  type TransactionWriteResult,
} from '@xui/ledger-shared';
import { apiRequest, get, patch, qs } from './client.ts';

/**
 * M3 transactions (API_SPEC §5). Query key prefix: invalidating it refreshes every list, detail and
 * revision. M3-B4-B covers the reads and the notes PATCH; the financial writes (create, correct,
 * void) come with their forms and go through lib/pendingWrite.ts (Idempotency-Key).
 *
 * Read-only views show what the server returns: the saved facts and snapshots of a version, and,
 * separately, the current summaries of its accounts, card and channel. Nothing here classifies,
 * sums or converts.
 *
 * The summary (M3-B5-B) lives under the same prefix, so every create, correction (settlement
 * included) and void — they all invalidate [TRANSACTIONS] — refreshes it; the notes PATCH only
 * refreshes lists, since notes never change a statistic.
 */
export const TRANSACTIONS = 'transactions';

const path = (id: string) => `/transactions/${encodeURIComponent(id)}`;

/** Keyset pages in the server's fixed order; the filters are the query key, the cursor is the page param. */
export const useTransactionList = (filters: TransactionListQuery) =>
  useInfiniteQuery({
    queryKey: [TRANSACTIONS, 'list', filters],
    queryFn: ({ pageParam }) => get<TransactionListDto>(`/transactions${qs({ ...filters, cursor: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });

/**
 * GET /transactions/summary (API_SPEC §5.10). The query is the key: each period is its own cache
 * entry, so a slow answer for an earlier period can never show under a later one; the previous
 * period's numbers stay visible (marked stale) while the next one loads.
 */
export const useTransactionSummary = (q: TransactionSummaryQuery) =>
  useQuery({
    queryKey: [TRANSACTIONS, 'summary', q],
    queryFn: () => get<TransactionSummaryDto>(`/transactions/summary${qs(q)}`),
    placeholderData: keepPreviousData,
  });

export const useTransaction = (id: string | undefined) =>
  useQuery({
    queryKey: [TRANSACTIONS, 'detail', id],
    queryFn: () => get<TransactionDto>(path(id!)),
    enabled: !!id,
  });

/** A published version never changes (DATA_MODEL §10): fetched once. The account summaries inside are current, refreshed with the detail. */
export const useTransactionRevision = (id: string | undefined, revision: string | undefined) =>
  useQuery({
    queryKey: [TRANSACTIONS, 'revision', id, revision],
    queryFn: () => get<TransactionRevisionDto>(`${path(id!)}/revisions/${encodeURIComponent(revision!)}`),
    enabled: !!id && !!revision,
    staleTime: Infinity,
  });

/** PATCH /transactions/:id/notes — no Idempotency-Key (API_SPEC §5.9): the same request twice gives the same result. */
export const updateTransactionNotes = (id: string, notes: string | null) => patch<TransactionNotesDto>(`${path(id)}/notes`, { notes });

/**
 * Notes: the answer (even for an unchanged value, which the server still writes) goes into the
 * detail cache; lists are refetched because `q` matches notes.
 */
export function useUpdateNotes(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (notes: string | null) => updateTransactionNotes(id, notes),
    onSuccess: async (res) => {
      qc.setQueryData<TransactionDto>([TRANSACTIONS, 'detail', id], (old) => (old && old.id === res.id ? { ...old, notes: res.notes, updatedAt: res.updatedAt } : old));
      await qc.invalidateQueries({ queryKey: [TRANSACTIONS, 'list'] });
    },
  });
}

/** A financial write that gets no answer within this time has an unknown outcome (retried with the same key). */
export const WRITE_TIMEOUT_MS = 30_000;

/**
 * POST /transactions (API_SPEC §5.4) with its Idempotency-Key. Only lib/usePendingWrite calls it:
 * the key and the parsed body come from the pending write, unchanged on every retry.
 */
export const createTransaction = (key: string, body: unknown) =>
  apiRequest<TransactionWriteResult>('POST', '/transactions', body, { headers: { [IDEMPOTENCY_KEY_HEADER]: key }, timeoutMs: WRITE_TIMEOUT_MS });

/** POST /transactions/:id/revisions (settlement, fact_correction, snapshot_correction; API_SPEC §5.7) — through lib/usePendingWrite only. */
export const correctTransaction = (id: string) => (key: string, body: unknown) =>
  apiRequest<TransactionWriteResult>('POST', `${path(id)}/revisions`, body, { headers: { [IDEMPOTENCY_KEY_HEADER]: key }, timeoutMs: WRITE_TIMEOUT_MS });

/** POST /transactions/:id/void (API_SPEC §5.8) — through lib/usePendingWrite only. */
export const voidTransaction = (id: string) => (key: string, body: unknown) =>
  apiRequest<TransactionWriteResult>('POST', `${path(id)}/void`, body, { headers: { [IDEMPOTENCY_KEY_HEADER]: key }, timeoutMs: WRITE_TIMEOUT_MS });

export const transactionHref = (id: string) => `/transactions/${encodeURIComponent(id)}`;
export const correctionHref = (id: string) => `${transactionHref(id)}/correct`;
export const NEW_TRANSACTION_PATH = '/transactions/new';
export const revisionHref = (id: string, revision: number) => `${transactionHref(id)}/revisions/${revision}`;

export type TransactionPages = InfiniteData<TransactionListDto, string | undefined>;
