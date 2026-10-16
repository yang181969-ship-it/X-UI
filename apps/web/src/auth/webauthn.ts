import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { MeDto } from '@z-ui/shared';
import { post } from '../api/client.ts';

export const passkeysSupported = () => browserSupportsWebAuthn();

type Options<T> = { challengeId: string; options: T };

export async function passkeyLogin(): Promise<MeDto> {
  const { challengeId, options } = await post<Options<Parameters<typeof startAuthentication>[0]['optionsJSON']>>('/auth/passkey/options');
  const response = await startAuthentication({ optionsJSON: options });
  return post<MeDto>('/auth/passkey/verify', { challengeId, response });
}

export async function passkeyStepUp(): Promise<MeDto> {
  const { challengeId, options } = await post<Options<Parameters<typeof startAuthentication>[0]['optionsJSON']>>('/auth/step-up/options');
  const response = await startAuthentication({ optionsJSON: options });
  return post<MeDto>('/auth/step-up/passkey', { challengeId, response });
}

export async function passkeyRegister(name: string): Promise<{ id: string; name: string }> {
  const { challengeId, options } = await post<Options<Parameters<typeof startRegistration>[0]['optionsJSON']>>('/auth/passkeys/options');
  const response = await startRegistration({ optionsJSON: options });
  return post('/auth/passkeys/verify', { challengeId, response, name });
}

/** A readable default name for a new passkey, e.g. "Mac · Safari". */
export function guessDeviceName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Mac/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${br}`;
}

/** The user dismissed the browser's passkey prompt (not a real error). */
export function isPasskeyCancel(e: unknown): boolean {
  const name = (e as { name?: string })?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}
