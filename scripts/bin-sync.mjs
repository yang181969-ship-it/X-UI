#!/usr/bin/env node
/**
 * Manual sync of the public BIN (IIN) list into static lookup files.
 *
 *   npm run bin:sync                     # download the default open list
 *   npm run bin:sync -- --from ./x.csv   # or a local CSV / another URL with the same columns
 *
 * Output: apps/web/public/bin/<first 3 digits>.json  { "424242": [scheme, type, level, issuer,
 * country alpha-2, country name, phone, url, last confirmed (YYYY-MM-DD)], … } plus meta.json.
 * They ship as static assets: on Cloudflare they are served for free without running the Worker
 * or touching D1, and the browser looks BINs up directly. Only 6-digit BINs are kept (longer ones
 * are cut to 6).
 *
 * Default source: github.com/Techbuddie-Solutions/binlist-data — a monthly merge of
 * iannuttall/binlist-data (2020) and venelinkochev/bin-list-data (2025) that prefers the newer
 * record; CC BY 4.0 (attribution in meta.json). Open BIN data is not official and has no 8-digit
 * BINs, so cards can be corrected by hand in the app.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'apps/web/public/bin');
const DEFAULT_URL = 'https://raw.githubusercontent.com/Techbuddie-Solutions/binlist-data/main/bins.csv';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

/** RFC 4180-ish CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0]);
}

const clean = (s) => (s ?? '').trim().replace(/\s+/g, ' ');

/** CSV rows → { bin6: record } keeping the most complete record per 6-digit BIN. */
export function buildIndex(rows) {
  const [header, ...data] = rows;
  const col = (name) => header.indexOf(name);
  const c = {
    bin: col('bin'),
    brand: col('brand'),
    type: col('type'),
    category: col('category'),
    issuer: col('issuer'),
    alpha2: col('alpha_2'),
    country: col('country'),
    // iannuttall: bank_phone / bank_url; the merged list: issuer_phone / issuer_url.
    phone: col('bank_phone') >= 0 ? col('bank_phone') : col('issuer_phone'),
    url: col('bank_url') >= 0 ? col('bank_url') : col('issuer_url'),
    seen: col('seen'),
  };
  if (c.bin < 0) throw new Error('CSV needs a "bin" column');
  const index = new Map();
  for (const r of data) {
    const digits = clean(r[c.bin]).replace(/\D/g, '');
    if (digits.length < 6) continue;
    const bin = digits.slice(0, 6);
    const rec = [r[c.brand], r[c.type], r[c.category], r[c.issuer], r[c.alpha2], r[c.country], r[c.phone], r[c.url], c.seen >= 0 ? r[c.seen] : ''].map(clean);
    while (rec.length && !rec[rec.length - 1]) rec.pop();
    // Most complete record wins; then an exact 6-digit row; then the most recently confirmed.
    const score = rec.slice(0, 8).filter(Boolean).length + (digits.length === 6 ? 0.5 : 0) + (rec[8] ? Number(rec[8].slice(0, 4)) / 1e5 : 0);
    const prev = index.get(bin);
    if (!prev || score > prev.score) index.set(bin, { rec, score });
  }
  return index;
}

async function main() {
  const from = arg('--from') ?? DEFAULT_URL;
  console.log(`[bin] reading ${from}`);
  const text = /^https?:/.test(from) ? await (await fetch(from)).text() : readFileSync(from, 'utf8');
  const index = buildIndex(parseCsv(text));
  const dates = [...index.values()].map((x) => x.rec[8]).filter(Boolean).sort();

  const shards = new Map();
  for (const [bin, { rec }] of index) {
    const key = bin.slice(0, 3);
    if (!shards.has(key)) shards.set(key, {});
    shards.get(key)[bin] = rec;
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  let bytes = 0;
  for (const [key, obj] of [...shards].sort()) {
    const json = JSON.stringify(obj);
    bytes += json.length;
    writeFileSync(resolve(OUT, `${key}.json`), json);
  }
  writeFileSync(
    resolve(OUT, 'meta.json'),
    JSON.stringify(
      {
        count: index.size,
        files: shards.size,
        generatedAt: new Date().toISOString(),
        /** Most recent "last confirmed" date among the records. */
        newest: dates.at(-1) ?? null,
        source: from,
        license: 'CC BY 4.0',
        attribution:
          from === DEFAULT_URL
            ? 'BIN data: binlist-data by Techbuddie Solutions (github.com/Techbuddie-Solutions/binlist-data), merging Ian Nuttall’s and Venelin Kochev’s lists, CC BY 4.0. Not an official IIN register.'
            : `BIN data: ${from}`,
        fields: ['scheme', 'type', 'level', 'issuer', 'country', 'countryName', 'phone', 'url', 'seen'],
      },
      null,
      2,
    ),
  );
  console.log(`[bin] ${index.size} BINs → ${shards.size} files, ${(bytes / 1e6).toFixed(1)} MB in ${OUT}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
