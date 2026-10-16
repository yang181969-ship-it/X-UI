/** Thin fetch wrapper for the same-origin API (cookies + CSRF header). */

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

export async function api<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        'x-zui-csrf': '1',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError((e as Error).message || 'network error', 0, 'NETWORK');
  }
  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;

  const err = (await res.json().catch(() => ({}))) as { error?: string; code?: string; details?: unknown };
  if (err.code === 'STEP_UP_REQUIRED' && stepUpHandler && !retried) {
    if (await stepUpHandler()) return api<T>(method, path, body, true);
  }
  if (res.status === 401 && err.code === 'UNAUTHENTICATED' && path !== '/auth/me') unauthenticatedHandler?.();
  throw new ApiError(err.error ?? res.statusText, res.status, err.code, err.details);
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
