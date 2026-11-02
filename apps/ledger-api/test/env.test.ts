import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { readEnv } from '../src/env.ts';
import { ENV_FILE, loadV1Env, REPO_ROOT } from '../src/node.ts';
import { withDbDir } from './helpers.ts';

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'; // 32 bytes, base64url
const LEGACY = {
  APP_ENC_KEY: 'bGVnYWN5LWtleS1sZWdhY3kta2V5LWxlZ2FjeS1rZXk=',
  SESSION_PEPPER: 'legacy-pepper',
  RP_ID: 'z-ui.example.com',
  RP_NAME: 'Z-UI',
  ORIGINS: 'http://localhost:5173,http://localhost:8787',
  SETUP_TOKEN: 'legacy-setup-token-0123456789',
};

describe('readEnv (XUI_V1_* only)', () => {
  it('never falls back to the legacy variable names', () => {
    expect(() => readEnv(LEGACY)).toThrowError(/XUI_V1_APP_ENC_KEY/);
    const env = readEnv({ ...LEGACY, XUI_V1_APP_ENC_KEY: KEY, XUI_V1_SESSION_PEPPER: 'v1-pepper' });
    expect(env.APP_ENC_KEY).toBe(KEY);
    expect(env.SESSION_PEPPER).toBe('v1-pepper');
    expect(env.RP_ID).toBe('localhost');
    expect(env.RP_NAME).toBe('X-UI');
    expect(env.ORIGINS).toEqual(['http://localhost:5174', 'http://localhost:8788']);
    expect(env.SETUP_TOKEN).toBeUndefined();
  });

  it('refuses IP-address origins while the RP id is localhost, and malformed keys', () => {
    const base = { XUI_V1_APP_ENC_KEY: KEY, XUI_V1_SESSION_PEPPER: 'p' };
    expect(() => readEnv({ ...base, XUI_V1_ORIGINS: 'http://127.0.0.1:5174' })).toThrowError(/localhost/);
    expect(() => readEnv({ ...base, XUI_V1_ORIGINS: 'http://localhost:5174,http://[::1]:8788' })).toThrowError(/localhost/);
    expect(() => readEnv({ ...base, XUI_V1_APP_ENC_KEY: 'too-short' })).toThrowError(/32 bytes/);
    expect(readEnv({ ...base, XUI_V1_RP_ID: 'x-ui.example.com', XUI_V1_ORIGINS: 'https://x-ui.example.com' }).ORIGINS).toEqual(['https://x-ui.example.com']);
  });
});

/** A throwaway "repository root" with the real .env.v1.example and a legacy .env next to it. */
function fakeRoot(dir: string) {
  copyFileSync(join(REPO_ROOT, '.env.v1.example'), join(dir, '.env.v1.example'));
  const legacyEnv = Object.entries(LEGACY)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(join(dir, '.env'), legacyEnv);
  return legacyEnv;
}

describe('loadV1Env (.env.v1 only)', () => {
  it('creates .env.v1 with fresh secrets on a fresh install and never reads the legacy .env', () =>
    withDbDir('xui-env-', async (dir) => {
      const legacyEnv = fakeRoot(dir);
      const target: Record<string, string | undefined> = {};
      loadV1Env(dir, target);

      const created = parseEnv(readFileSync(join(dir, ENV_FILE), 'utf8'));
      for (const k of ['XUI_V1_APP_ENC_KEY', 'XUI_V1_SESSION_PEPPER', 'XUI_V1_SETUP_TOKEN']) {
        expect(created[k], k).toMatch(/^[A-Za-z0-9_-]{32,}$/);
        expect(target[k]).toBe(created[k]);
      }
      expect(Object.values(created)).not.toContain(LEGACY.APP_ENC_KEY);
      expect(Object.keys(target).every((k) => k.startsWith('XUI_V1_'))).toBe(true);
      expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(legacyEnv);
      expect(() => readEnv(target)).not.toThrow();

      // A second start reuses the file as it is.
      const first = readFileSync(join(dir, ENV_FILE), 'utf8');
      loadV1Env(dir, {});
      expect(readFileSync(join(dir, ENV_FILE), 'utf8')).toBe(first);
    }));

  it('refuses to invent new keys when the v1 database already exists', () =>
    withDbDir('xui-env-', async (dir) => {
      fakeRoot(dir);
      mkdirSync(join(dir, 'data'));
      writeFileSync(join(dir, 'data', 'x-ui-v1.db'), '');
      expect(() => loadV1Env(dir, {})).toThrowError(/Restore \.env\.v1/);
      expect(existsSync(join(dir, ENV_FILE))).toBe(false);
    }));

  it('takes only XUI_V1_* keys from .env.v1, and the process environment wins', () =>
    withDbDir('xui-env-', async (dir) => {
      writeFileSync(join(dir, ENV_FILE), `XUI_V1_APP_ENC_KEY=${KEY}\nXUI_V1_SESSION_PEPPER=from-file\nAPP_ENC_KEY=stray\nDATABASE_URL=file:z-ui.db\n`);
      const target: Record<string, string | undefined> = { XUI_V1_SESSION_PEPPER: 'from-process' };
      loadV1Env(dir, target);
      expect(target).toEqual({ XUI_V1_APP_ENC_KEY: KEY, XUI_V1_SESSION_PEPPER: 'from-process' });
    }));
});
