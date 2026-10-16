import type { AppConfig, CustomField } from './config-schema.ts';
import { isIsoDate } from './date.ts';
import type { CustomFieldEntity } from './enums.ts';

export type ExtraValues = Record<string, unknown>;

export function fieldsFor(cfg: Pick<AppConfig, 'customFields'>, entity: CustomFieldEntity): CustomField[] {
  return [...cfg.customFields[entity]].sort((a, b) => a.order - b.order);
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** Returns an error message for one value, or null when valid. */
export function validateFieldValue(field: CustomField, value: unknown): string | null {
  if (isEmpty(value)) return field.required ? `${field.label} is required` : null;
  const options = new Set((field.options ?? []).map((o) => o.value));
  switch (field.type) {
    case 'text':
      return typeof value === 'string' && value.length <= 1000 ? null : `${field.label} must be text`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${field.label} must be a number`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${field.label} must be true/false`;
    case 'date':
      return typeof value === 'string' && isIsoDate(value) ? null : `${field.label} must be a date`;
    case 'select':
      return typeof value === 'string' && options.has(value) ? null : `${field.label}: unknown option`;
    case 'multiselect':
      return Array.isArray(value) && value.every((v) => typeof v === 'string' && options.has(v))
        ? null
        : `${field.label}: unknown option`;
    case 'money': {
      const m = value as { amount?: unknown; currency?: unknown };
      return typeof m === 'object' &&
        Number.isSafeInteger(m.amount) &&
        typeof m.currency === 'string' &&
        /^[A-Z]{3}$/.test(m.currency)
        ? null
        : `${field.label} must be an amount with currency`;
    }
  }
}

/**
 * Validate incoming extra values against the configured fields and merge them over the stored
 * ones. Keys of fields that were removed from the config are kept untouched, so re-adding a
 * field later brings its values back.
 */
export function mergeExtra(
  fields: CustomField[],
  stored: ExtraValues,
  incoming: ExtraValues | undefined,
): { ok: true; value: ExtraValues } | { ok: false; errors: string[] } {
  const result: ExtraValues = { ...stored };
  const errors: string[] = [];
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(incoming ?? {})) {
    const field = byKey.get(key);
    if (!field) continue; // unknown keys from the client are ignored
    const err = validateFieldValue(field, value);
    if (err) errors.push(err);
    else if (isEmpty(value)) delete result[key];
    else result[key] = value;
  }
  for (const field of fields) {
    if (field.required && isEmpty(result[field.key])) {
      const err = validateFieldValue(field, undefined);
      if (err && !errors.includes(err)) errors.push(err);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: result };
}
