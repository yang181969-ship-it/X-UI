import type { AppConfig } from './config-schema.ts';
import { CUSTOM_FIELD_ENTITIES } from './enums.ts';

/** Minimal line diff (LCS) rendered in unified style with `context` lines around changes. */
export function unifiedDiff(a: string, b: string, context = 3): string {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  // LCS table; config files are small (hundreds of lines) so O(n·m) is fine.
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: { t: ' ' | '-' | '+'; s: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      ops.push({ t: ' ', s: x[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) ops.push({ t: '-', s: x[i++]! });
    else ops.push({ t: '+', s: y[j++]! });
  }
  while (i < n) ops.push({ t: '-', s: x[i++]! });
  while (j < m) ops.push({ t: '+', s: y[j++]! });

  const keep: boolean[] = Array.from({ length: ops.length }, () => false);
  ops.forEach((op, k) => {
    if (op.t === ' ') return;
    for (let d = Math.max(0, k - context); d <= Math.min(ops.length - 1, k + context); d++) keep[d] = true;
  });
  const out: string[] = [];
  let skipped = false;
  ops.forEach((op, k) => {
    if (keep[k]) {
      if (skipped) out.push('@@');
      skipped = false;
      out.push(`${op.t}${op.s}`);
    } else skipped = true;
  });
  return out.join('\n');
}

/** Human summary for the Git commit message, e.g. "add account field 账户状态". */
export function summarizeConfigChange(prev: AppConfig, next: AppConfig): string {
  const parts: string[] = [];
  for (const entity of CUSTOM_FIELD_ENTITIES) {
    const before = new Map(prev.customFields[entity].map((f) => [f.key, f]));
    const after = new Map(next.customFields[entity].map((f) => [f.key, f]));
    for (const [k, f] of after) {
      if (!before.has(k)) parts.push(`add ${entity} field ${f.label}`);
      else if (JSON.stringify(before.get(k)) !== JSON.stringify(f)) parts.push(`update ${entity} field ${f.label}`);
    }
    for (const [k, f] of before) if (!after.has(k)) parts.push(`remove ${entity} field ${f.label}`);
  }
  for (const section of ['app', 'currencies', 'countries', 'defaultCategories', 'reminders'] as const) {
    if (JSON.stringify(prev[section]) !== JSON.stringify(next[section])) parts.push(`update ${section}`);
  }
  if (parts.length === 0) return 'no changes';
  return parts.length > 3 ? `${parts.slice(0, 3).join(', ')} (+${parts.length - 3} more)` : parts.join(', ');
}
