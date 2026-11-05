/** Thin fetch wrapper for the same-origin X-UI v1 API (cookies + CSRF header). */
import { IDEMPOTENCY_REPLAYED_HEADER } from '@xui/ledger-shared';

/** Must match apps/ledger-api CSRF_HEADER (the legacy app uses x-zui-csrf). */
export const CSRF_HEADER = 'x-xui-csrf';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type StepUpHandler = () => Promise<boolean>;
let stepUpHandler: StepUpHandler | null = null;
let unauthenticatedHandler: (() => void) | null = null;

/** Installed by <StepUpProvider>: shows the verify dialog and resolves true when verified. */
export function setStepUpHandler(fn: StepUpHandler | null) {
  stepUpHandler = fn;
}

export function setUnauthenticatedHandler(fn: (() => void) | null) {
  unauthenticatedHandler = fn;
}

export interface RequestOptions {
  /** Extra request headers (e.g. Idempotency-Key). The CSRF and content-type headers are always set. */
  headers?: Record<string, string>;
  /** Give up after this many ms (ApiError status 0, code TIMEOUT: the outcome is unknown). */
  timeoutMs?: number;
}

/** A successful answer with its status and the response headers the app reads. */
export interface ApiResponse<T> {
  data: T;
  status: number;
  /** The server answered `Idempotency-Replayed: true` (a replay of the first successful financial write). */
  replayed: boolean;
}

/**
 * One request. Every caller goes through here: CSRF, step-up retry (with the same headers and body),
 * the 401 handler and ApiError are the same for api() and apiRequest().
 */
export async function apiRequest<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}, retried = false): Promise<ApiResponse<T>> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...options.headers,
        [CSRF_HEADER]: '1',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(options.timeoutMs !== undefined && { signal: AbortSignal.timeout(options.timeoutMs) }),
    });
  } catch (e) {
    if ((e as Error)?.name === 'TimeoutError') throw new ApiError('request timed out', 0, 'TIMEOUT');
    throw new ApiError((e as Error).message || 'network error', 0, 'NETWORK');
  }
  if (res.ok) {
    const data = (res.status === 204 ? undefined : await res.json()) as T;
    return { data, status: res.status, replayed: res.headers.get(IDEMPOTENCY_REPLAYED_HEADER) === 'true' };
  }

  const err = (await res.json().catch(() => ({}))) as { error?: string; code?: string; details?: unknown };
  if (err.code === 'STEP_UP_REQUIRED' && stepUpHandler && !retried) {
    if (await stepUpHandler()) return apiRequest<T>(method, path, body, options, true);
  }
  if (res.status === 401 && err.code === 'UNAUTHENTICATED' && path !== '/auth/me') unauthenticatedHandler?.();
  throw new ApiError(err.error ?? res.statusText, res.status, err.code, err.details);
}

/** The response body only (every M1 / M2 caller). */
export async function api<T>(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  return (await apiRequest<T>(method, path, body, options)).data;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body: unknown = {}) => api<T>('POST', path, body);
export const put = <T>(path: string, body: unknown) => api<T>('PUT', path, body);
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const del = <T>(path: string) => api<T>('DELETE', path);

export function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
