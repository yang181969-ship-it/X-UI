import type { DB } from './db/client.ts';
import { base64UrlToBytes } from './lib/encoding.ts';
import type * as schema from './db/schema.ts';

/**
 * Runtime settings. Property names match the legacy app so the reviewed auth modules work
 * unchanged, but every value comes from an XUI_V1_* variable (never from the legacy .env keys).
 */
export interface AppEnv {
  /** 32-byte key (base64/base64url) for encrypting TOTP secrets (and card data from M2). Back it up! */
  APP_ENC_KEY: string;
  /** Server-side secret mixed into password hashes. */
  SESSION_PEPPER: string;
  /** WebAuthn relying-party id: "localhost" locally, the v1 domain in production. */
  RP_ID: string;
  RP_NAME: string;
  /** Allowed browser origins, e.g. ["http://localhost:5174", "http://localhost:8788"]. */
  ORIGINS: string[];
  /** Send cookies with Secure + __Host- prefix. Must be true behind HTTPS. */
  COOKIE_SECURE: boolean;
  /** Trust X-Forwarded-For / CF-Connecting-IP for the client IP. */
  TRUST_PROXY: boolean;
  /** One-time first-run setup link secret (/setup/<token>); unset disables the setup flow. */
  SETUP_TOKEN?: string;
  /** PBKDF2 cost for new password hashes. */
  PASSWORD_ITERATIONS: number;
}

export type UserRow = typeof schema.users.$inferSelect;
export type SessionRow = typeof schema.sessions.$inferSelect;

export interface Deps {
  db: DB;
  env: AppEnv;
  now: () => number;
  /** Cheap edge rate limiter (Cloudflare rate limiting binding); false = over the limit. */
  limiter?: (key: string) => Promise<boolean>;
}

export type AppBindings = {
  Variables: {
    deps: Deps;
    user: UserRow;
    session: SessionRow;
    ip: string | null;
  };
};

export const ENV_PREFIX = 'XUI_V1_';
export const DEFAULT_ORIGINS = 'http://localhost:5174,http://localhost:8788';

export function readEnv(source: Record<string, string | undefined>): AppEnv {
  const get = (k: string) => source[ENV_PREFIX + k] || undefined;
  const required = (k: string) => {
    const v = get(k);
    if (!v) throw new Error(`Missing required environment variable ${ENV_PREFIX}${k} — set it in .env.v1 at the repository root (template: .env.v1.example)`);
    return v;
  };
  const env: AppEnv = {
    APP_ENC_KEY: required('APP_ENC_KEY'),
    SESSION_PEPPER: required('SESSION_PEPPER'),
    RP_ID: get('RP_ID') ?? 'localhost',
    RP_NAME: get('RP_NAME') ?? 'X-UI',
    ORIGINS: (get('ORIGINS') ?? DEFAULT_ORIGINS)
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean),
    COOKIE_SECURE: (get('COOKIE_SECURE') ?? 'false') === 'true',
    TRUST_PROXY: (get('TRUST_PROXY') ?? 'false') === 'true',
    SETUP_TOKEN: get('SETUP_TOKEN'),
    PASSWORD_ITERATIONS: Math.min(100_000, Math.max(10_000, Number(get('PASSWORD_ITERATIONS')) || 50_000)),
  };
  let keyBytes = 0;
  try {
    keyBytes = base64UrlToBytes(env.APP_ENC_KEY.replace(/=+$/, '')).length;
  } catch {
    /* reported below */
  }
  if (keyBytes !== 32) throw new Error(`${ENV_PREFIX}APP_ENC_KEY must be 32 bytes, base64 or base64url encoded`);
  // Locally the WebAuthn RP id is "localhost", so the app must be opened as http://localhost:<port>.
  // An IP-address origin (127.0.0.1) is refused here rather than added to the allow-list.
  if (env.RP_ID === 'localhost') {
    const bad = env.ORIGINS.filter((o) => {
      try {
        return new URL(o).hostname !== 'localhost';
      } catch {
        return true;
      }
    });
    if (bad.length) throw new Error(`${ENV_PREFIX}ORIGINS must use http://localhost (not an IP address) while ${ENV_PREFIX}RP_ID=localhost: ${bad.join(', ')}`);
  }
  return env;
}
