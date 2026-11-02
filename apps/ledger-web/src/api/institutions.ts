import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { InstitutionCreate, InstitutionDetail, InstitutionDto, InstitutionListItem, InstitutionListQuery, InstitutionUpdate } from '@xui/ledger-shared';
import { del, get, patch, post, qs } from './client.ts';

/** Query key prefix: invalidating it refreshes every institution list and detail. */
export const INSTITUTIONS = 'institutions';

export const useInstitutions = (filters: InstitutionListQuery) =>
  useQuery({
    queryKey: [INSTITUTIONS, 'list', filters],
    queryFn: () => get<InstitutionListItem[]>(`/institutions${qs(filters)}`),
    placeholderData: keepPreviousData,
  });

export const useInstitution = (id: string | null) =>
  useQuery({
    queryKey: [INSTITUTIONS, 'detail', id],
    queryFn: () => get<InstitutionDetail>(`/institutions/${encodeURIComponent(id!)}`),
    enabled: !!id,
  });

export const createInstitution = (body: InstitutionCreate) => post<InstitutionDto>('/institutions', body);
export const updateInstitution = (id: string, body: InstitutionUpdate) => patch<InstitutionDto>(`/institutions/${encodeURIComponent(id)}`, body);
export const deleteInstitution = (id: string) => del<{ ok: true }>(`/institutions/${encodeURIComponent(id)}`);

/** details of a 409 IN_USE answer. */
export interface InUseDetails {
  references: { accounts: number; cards: number; channels: number };
}
