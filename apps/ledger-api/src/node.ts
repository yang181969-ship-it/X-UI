import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { count, eq } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createApp } from './app.ts';
import { openV1Db } from './db/client.ts';
import { dbPathFromUrl } from './db/identity.ts';
import { users } from './db/schema.ts';
import { ENV_PREFIX, readEnv } from './env.ts';
import { randomToken } from './lib/crypto.ts';

/** Local (Node) entry point of X-UI v1: its own SQLite file, its own .env.v1, port 8788. */

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const ENV_FILE = '.env.v1';
export const DEFAULT_PORT = 8788;
export const WEB_DEV_URL = 'http://localhost:5174';

export const defaultDbPath = (root = REPO_ROOT) => resolve(root, 'data/x-ui-v1.db');

/** Databases v1 must never open: the legacy default file, plus DATABASE_URL if the shell exports one. */
export function legacyDbPaths(root = REPO_ROOT, source: Record<string, string | undefined> = process.env): string[] {
  const paths = [resolve(root, 'data/z-ui.db')];
  const legacyUrl = source.DATABASE_URL;
  const legacyPath = legacyUrl ? dbPathFromUrl(legacyUrl) : null;
  if (legacyPath) paths.push(legacyPath);
  return paths;
}

/**
 * Load .env.v1 from the repo root — never the legacy .env. Only XUI_V1_* keys are taken from it,
 * and variables already set in the process win. On a fresh install (no .env.v1, no v1 database)
 * the file is created from .env.v1.example with new random secrets; if the v1 database already
 * exists a missing .env.v1 is an error, because new keys could not decrypt what it stores.
 */
export function loadV1Env(root = REPO_ROOT, target: Record<string, string | undefined> = process.env) {
  const file = resolve(root, ENV_FILE);
  if (!existsSync(file) && !target[`${ENV_PREFIX}APP_ENC_KEY`]) {
    const url = target[`${ENV_PREFIX}DATABASE_URL`];
    const dbFile = url ? dbPathFromUrl(url) : defaultDbPath(root);
    if (dbFile && existsSync(dbFile)) {
      throw new Error(
        `${file} is missing but the X-UI v1 database ${dbFile} already exists.\n` +
          `Restore ${ENV_FILE} (${ENV_PREFIX}APP_ENC_KEY, ${ENV_PREFIX}SESSION_PEPPER) from your backup — new keys would make stored secrets and passwords unusable.`,
      );
    }
    const template = readFileSync(resolve(root, '.env.v1.example'), 'utf8')
      .replace(/^XUI_V1_APP_ENC_KEY=.*$/m, `XUI_V1_APP_ENC_KEY=${randomToken(32)}`)
      .replace(/^XUI_V1_SESSION_PEPPER=.*$/m, `XUI_V1_SESSION_PEPPER=${randomToken(32)}`)
      .replace(/^XUI_V1_SETUP_TOKEN=.*$/m, `XUI_V1_SETUP_TOKEN=${randomToken(24)}`);
    // 'wx': never overwrite an existing file, even if it appeared in the meantime.
    writeFileSync(file, template, { mode: 0o600, flag: 'wx' });
    console.warn(`[env] created ${file} with new random secrets — back up ${ENV_PREFIX}APP_ENC_KEY somewhere safe.`);
  }
  if (!existsSync(file)) return;
  const parsed = parseEnv(readFileSync(file, 'utf8'));
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (!k.startsWith(ENV_PREFIX)) ignored.push(k);
    else if (target[k] === undefined) target[k] = v;
  }
  if (ignored.length) console.warn(`[env] ${ENV_FILE}: ignoring keys without the ${ENV_PREFIX} prefix: ${ignored.join(', ')}`);
}

export function defaultDbUrl(root = REPO_ROOT) {
  const file = defaultDbPath(root);
  mkdirSync(dirname(file), { recursive: true });
  return `file:${file}`;
}

function clientIp(trustProxy: boolean) {
  return (c: Context): string | null => {
    if (trustProxy) {
      const fwd = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (fwd) return fwd;
    }
    try {
      return getConnInfo(c).remote.address ?? null;
    } catch {
      return null;
    }
  };
}

/** Serve apps/ledger-web/dist with SPA fallback to index.html. */
function spa(distDir: string): MiddlewareHandler {
  const isFile = (p: string) => {
    try {
      return statSync(join(distDir, p)).isFile();
    } catch {
      return false;
    }
  };
  return serveStatic({
    root: relative(process.cwd(), distDir) || '.',
    // Unknown paths are client-side routes: answer with index.html.
    rewriteRequestPath: (p) => (isFile(p) ? p : '/index.html'),
  });
}

export async function main() {
  loadV1Env();
  const env = readEnv(process.env);
  const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
  const url = process.env[`${ENV_PREFIX}DATABASE_URL`] ?? defaultDbUrl();
  const { db, identity, applied } = await openV1Db(url, { legacyPaths: legacyDbPaths() });
  console.info(`[db] ${dbPathFromUrl(url)} — ${identity === 'empty' ? 'new X-UI v1 database initialized, ' : ''}${applied} migration(s) applied`);

  const [active] = await db.select({ n: count() }).from(users).where(eq(users.status, 'active'));
  if (!active?.n) {
    console.info(
      env.SETUP_TOKEN
        ? `[setup] no account yet — open ${production ? `http://localhost:${process.env[`${ENV_PREFIX}PORT`] ?? DEFAULT_PORT}` : WEB_DEV_URL}/setup/<${ENV_PREFIX}SETUP_TOKEN from ${ENV_FILE}>`
        : `[setup] no account yet — set ${ENV_PREFIX}SETUP_TOKEN in ${ENV_FILE} to enable the first-run setup link`,
    );
  }

  const distDir = resolve(REPO_ROOT, 'apps/ledger-web/dist');
  const staticHandler = production && existsSync(distDir) ? spa(distDir) : undefined;
  if (production && !staticHandler) console.warn('[api] apps/ledger-web/dist not found — run `npm run build:v1` first');

  const app = createApp({ db, env, now: Date.now }, { clientIp: clientIp(env.TRUST_PROXY), staticHandler });
  const port = Number(process.env[`${ENV_PREFIX}PORT`] ?? DEFAULT_PORT);
  // Listen on loopback only by default; expose deliberately (XUI_V1_HOST=0.0.0.0) behind HTTPS.
  const hostname = process.env[`${ENV_PREFIX}HOST`] ?? '127.0.0.1';
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.info(`[api] X-UI v1 listening on ${hostname}:${info.port}${staticHandler ? ` (serving ledger-web/dist — open http://localhost:${info.port})` : ''}`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
