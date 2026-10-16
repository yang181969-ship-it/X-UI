import type { MiddlewareHandler } from 'hono';
import type { AppBindings } from '../env.ts';
import { fail } from '../lib/http.ts';
import { loadSession, STEP_UP_MS } from './session.ts';

type MW = MiddlewareHandler<AppBindings>;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-zui-csrf';

/**
 * CSRF defence for cookie-authenticated requests (on top of SameSite=Strict):
 * every state-changing request must come from an allowed Origin and carry a custom header,
 * which cross-site pages cannot set without a CORS preflight (which we never allow).
 */
export const csrfGuard: MW = async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method)) {
    const origin = c.req.header('origin')?.replace(/\/$/, '');
    if (!origin || !c.var.deps.env.ORIGINS.includes(origin)) fail(403, 'origin not allowed', 'BAD_ORIGIN');
    if (c.req.header(CSRF_HEADER) !== '1') fail(403, 'missing CSRF header', 'CSRF');
  }
  await next();
};

/** Requires a full (non-setup) session. */
export const requireAuth: MW = async (c, next) => {
  const s = await loadSession(c);
  if (!s || s.session.method === 'setup') fail(401, 'not signed in', 'UNAUTHENTICATED');
  c.set('user', s.user);
  c.set('session', s.session);
  await next();
};

/** Accepts the short-lived setup session issued while accepting an invite. */
export const requireSetupSession: MW = async (c, next) => {
  const s = await loadSession(c);
  if (!s || s.session.method !== 'setup') fail(401, 'setup session required', 'UNAUTHENTICATED');
  c.set('user', s.user);
  c.set('session', s.session);
  await next();
};

export const requireAdmin: MW = async (c, next) => {
  if (c.var.user.role !== 'admin') fail(403, 'admin only', 'FORBIDDEN');
  await next();
};

/** Sensitive actions need a passkey/TOTP verification within the last 5 minutes. */
export const requireStepUp: MW = async (c, next) => {
  const at = c.var.session.stepUpAt;
  if (!at || c.var.deps.now() - at > STEP_UP_MS) fail(403, 'please verify again', 'STEP_UP_REQUIRED');
  await next();
};
