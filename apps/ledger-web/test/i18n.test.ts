import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ENTRY_SHAPE_RULES, TRANSACTION_ERROR_CODES, TRANSACTION_HINT_CODES } from '@xui/ledger-shared';
import { describe, expect, it } from 'vitest';
import en from '../src/i18n/en.ts';
import zh from '../src/i18n/zh-CN.ts';

/**
 * Every translation key the transaction UI uses exists in both languages (the Dict type already
 * forces en to have zh's shape): literal t('…') keys found in the sources, plus the families built
 * at run time (error codes, issue codes, Entry-shape rules, hints, diff fields).
 */

const SRC = join(import.meta.dirname, '../src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : /\.tsx?$/.test(n) ? [join(dir, n)] : []));
const lookup = (dict: unknown, key: string) => key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), dict);

describe('translations', () => {
  it('every literal key used in the web app exists in zh-CN and en', () => {
    const keys = new Set<string>();
    for (const f of files(SRC)) for (const m of readFileSync(f, 'utf8').matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(m[1]!);
    expect(keys.size).toBeGreaterThan(200);
    const missing = [...keys].filter((k) => typeof lookup(zh, k) !== 'string' || typeof lookup(en, k) !== 'string');
    expect(missing).toEqual([]);
  });

  it('run-time key families of the transaction UI exist in both languages', () => {
    const families = [
      ...TRANSACTION_ERROR_CODES.map((c) => `errors.codes.${c}`),
      ...['required', 'regionRequired', 'empty', 'currency', 'format', 'scale', 'zero', 'range', 'tooLate', 'postedBefore', 'sameAccount', 'notRegistered', 'closedCurrencyCurrent', 'ackRequired', 'sensitive', 'shape', 'confirmedDomestic', 'noChange', 'noneSelected', 'noSnapshotChange', 'invalid'].map((c) => `transactions.form.issues.${c}`),
      ...ENTRY_SHAPE_RULES.map((r) => `transactions.form.shapeRules.${r}`),
      ...TRANSACTION_HINT_CODES.map((h) => `transactions.hints.${h}`),
      ...['recordMode', 'occurredOn', 'occurredTime', 'postedOn', 'eventAmount', 'merchant', 'merchantCountry', 'card', 'channel', 'transferMethod', 'counterpartyName', 'counterpartyCountry', 'counterpartyInstitution', 'counterpartyHint', 'homeRegion', 'foreignStatus', 'entry_out', 'entry_in'].map((f) => `transactions.lifecycle.fields.${f}`),
      ...['settle', 'fact', 'snapshot', 'void'].map((k) => `transactions.lifecycle.kinds.${k}`),
      ...['original', 'settlement', 'fact_correction', 'snapshot_correction'].map((k) => `transactions.revisionKinds.${k}`),
    ];
    const missing = families.filter((k) => typeof lookup(zh, k) !== 'string' || typeof lookup(en, k) !== 'string');
    expect(missing).toEqual([]);
  });

  it('placeholders match between the two languages', () => {
    const vars = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    const walk = (a: unknown, b: unknown, path: string, out: string[]) => {
      if (typeof a === 'string' && typeof b === 'string') {
        if (vars(a).join() !== vars(b).join()) out.push(path);
        return;
      }
      if (a && typeof a === 'object') for (const k of Object.keys(a)) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out);
    };
    const out: string[] = [];
    walk(zh.transactions, en.transactions, 'transactions', out);
    walk(zh.errors, en.errors, 'errors', out);
    expect(out).toEqual([]);
  });
});
