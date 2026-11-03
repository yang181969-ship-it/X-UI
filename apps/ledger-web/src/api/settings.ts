import { useQuery } from '@tanstack/react-query';
import type { ProfileSettingsDto, ProfileSettingsUpdate } from '@xui/ledger-shared';
import { get, patch } from './client.ts';

/** Query key prefix of the signed-in user's own settings (cleared with the rest of the cache on sign-out). */
export const SETTINGS = 'settings';

export const useProfileSettings = () => useQuery({ queryKey: [SETTINGS, 'profile'], queryFn: () => get<ProfileSettingsDto>('/settings/profile') });

export const updateProfileSettings = (body: ProfileSettingsUpdate) => patch<ProfileSettingsDto>('/settings/profile', body);
