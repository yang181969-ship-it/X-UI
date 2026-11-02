import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App } from 'antd';
import { useTranslation } from 'react-i18next';
import type { AuditDto, MeDto, PasskeyDto, SessionDto } from '@z-ui/shared';
import { ApiError, get } from './client.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: true,
      retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
    },
  },
});

export const useMe = () =>
  useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await get<MeDto>('/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });

export const usePasskeys = () => useQuery({ queryKey: ['passkeys'], queryFn: () => get<PasskeyDto[]>('/auth/passkeys') });
export const useSessions = () => useQuery({ queryKey: ['sessions'], queryFn: () => get<SessionDto[]>('/auth/sessions') });
export const useAudit = () => useQuery({ queryKey: ['audit'], queryFn: () => get<AuditDto[]>('/auth/audit') });
export const useRecoveryCount = () =>
  useQuery({ queryKey: ['recovery'], queryFn: () => get<{ remaining: number }>('/auth/recovery-codes') });

export interface SystemInfoDto {
  product: string;
  edition: string;
  database: { identity: string | null; createdAt: number | null };
}
export const useSystemInfo = () => useQuery({ queryKey: ['system'], queryFn: () => get<SystemInfoDto>('/system/info'), staleTime: 300_000 });

/** Mutation with toast feedback; refreshes the given queries. */
export function useAction<TVars, TRes = unknown>(fn: (v: TVars) => Promise<TRes>, opts: { success?: string | false; invalidate?: string[] } = {}) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await Promise.all((opts.invalidate ?? []).map((k) => qc.invalidateQueries({ queryKey: [k] })));
      if (opts.success !== false) void message.success(opts.success ?? t('common.saved'));
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'STEP_UP_REQUIRED') return; // user cancelled the dialog
      void message.error(errorText(e, t));
    },
  });
}

export function errorText(e: unknown, t: (k: string) => string): string {
  if (e instanceof ApiError) {
    if (e.code === 'NETWORK') return t('errors.network');
    // Known error codes have a translated message; others show the server's text.
    const key = `errors.codes.${e.code}`;
    const translated = e.code ? t(key) : key;
    if (translated !== key) return translated;
    if (e.code === 'VALIDATION' && Array.isArray(e.details)) {
      const first = e.details[0] as { path?: (string | number)[]; message?: string } | undefined;
      if (first) return `${first.path?.join('.') ?? ''} ${first.message ?? ''}`.trim();
    }
    return e.message;
  }
  return (e as Error)?.message ?? t('errors.generic');
}
