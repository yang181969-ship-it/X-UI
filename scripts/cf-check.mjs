#!/usr/bin/env node
/** Pre-deploy sanity checks for `npm run cf:deploy`. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const wrangler = readFileSync(resolve(ROOT, 'wrangler.jsonc'), 'utf8');
if (wrangler.includes('00000000-0000-0000-0000-000000000000')) problems.push('wrangler.jsonc: set d1_databases[0].database_id (npx wrangler d1 create z-ui)');
if (wrangler.includes('z.example.com')) problems.push('wrangler.jsonc: replace z.example.com with your domain (routes, RP_ID, ORIGINS)');

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log('✓ wrangler.jsonc looks ready');
