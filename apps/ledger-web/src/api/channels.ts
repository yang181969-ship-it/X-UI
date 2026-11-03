import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  ChannelSourceCreate,
  ChannelSourceDto,
  ChannelSourceUpdate,
  PaymentChannelCreate,
  PaymentChannelDetail,
  PaymentChannelDto,
  PaymentChannelListItem,
  PaymentChannelListQuery,
  PaymentChannelUpdate,
} from '@xui/ledger-shared';
import { del, get, patch, post, qs } from './client.ts';

/**
 * Payment channels and their funding sources (API_SPEC §3.6). Query key prefix: invalidating it
 * refreshes every channel list and detail. Channel DTOs embed their provider, balance account and
 * source cards / accounts, and account, card and institution DTOs embed channel summaries, so a
 * write to any of them refreshes all (useRefreshAccounts).
 */
export const CHANNELS = 'channels';

export const useChannels = (filters: PaymentChannelListQuery, enabled = true) =>
  useQuery({
    queryKey: [CHANNELS, 'list', filters],
    queryFn: () => get<PaymentChannelListItem[]>(`/payment-channels${qs(filters)}`),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useChannel = (id: string | undefined) =>
  useQuery({
    queryKey: [CHANNELS, 'detail', id],
    queryFn: () => get<PaymentChannelDetail>(`/payment-channels/${encodeURIComponent(id!)}`),
    enabled: !!id,
  });

const channelPath = (id: string) => `/payment-channels/${encodeURIComponent(id)}`;
const sourcePath = (id: string) => `/payment-channel-sources/${encodeURIComponent(id)}`;

export const createChannel = (body: PaymentChannelCreate) => post<PaymentChannelDto>('/payment-channels', body);
export const updateChannel = (id: string, body: PaymentChannelUpdate) => patch<PaymentChannelDto>(channelPath(id), body);
export const deleteChannel = (id: string) => del<{ ok: true }>(channelPath(id));

export const createSource = (channelId: string, body: ChannelSourceCreate) => post<ChannelSourceDto>(`${channelPath(channelId)}/sources`, body);
export const updateSource = (id: string, body: ChannelSourceUpdate) => patch<ChannelSourceDto>(sourcePath(id), body);
export const endSource = (id: string) => post<ChannelSourceDto>(`${sourcePath(id)}/end`);
export const deleteSource = (id: string) => del<{ ok: true }>(sourcePath(id));

/** The channel detail page (PRODUCT_SPEC §4.5). */
export const channelHref = (id: string) => `/accounts/channels/${encodeURIComponent(id)}`;
