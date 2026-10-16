import { z } from 'zod';
import { CUSTOM_FIELD_TYPES, type CustomFieldEntity } from './enums.ts';

/**
 * Schema of config/app.config.json — the single source of configuration shared by
 * the API and the web app. Edited from the Settings page and committed to Git.
 */

export const customFieldOptionSchema = z.object({
  value: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(64),
  color: z.string().max(32).optional(),
});

export const customFieldSchema = z
  .object({
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,31}$/, 'key must be lowercase letters, digits or _ and start with a letter'),
    label: z.string().trim().min(1).max(32),
    type: z.enum(CUSTOM_FIELD_TYPES),
    options: z.array(customFieldOptionSchema).max(100).optional(),
    /** Fields sharing a tab name are shown together as an extra tab in the detail drawer. */
    tab: z.string().trim().max(32).optional(),
    description: z.string().max(200).optional(),
    showInTable: z.boolean().default(false),
    required: z.boolean().default(false),
    order: z.number().int().default(0),
  })
  .superRefine((f, ctx) => {
    const needsOptions = f.type === 'select' || f.type === 'multiselect';
    if (needsOptions && (!f.options || f.options.length === 0)) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'select fields need at least one option' });
    }
    if (f.options) {
      const seen = new Set<string>();
      for (const [i, o] of f.options.entries()) {
        if (seen.has(o.value)) {
          ctx.addIssue({ code: 'custom', path: ['options', i, 'value'], message: `duplicate option "${o.value}"` });
        }
        seen.add(o.value);
      }
    }
  });

const uniqueKeys = (fields: { key: string }[], ctx: z.RefinementCtx) => {
  const seen = new Set<string>();
  for (const [i, f] of fields.entries()) {
    if (seen.has(f.key)) ctx.addIssue({ code: 'custom', path: [i, 'key'], message: `duplicate key "${f.key}"` });
    seen.add(f.key);
  }
};

const fieldList = z.array(customFieldSchema).max(50).superRefine(uniqueKeys).default([]);

export const customFieldsSchema = z.object({
  institution: fieldList,
  account: fieldList,
  card: fieldList,
  transaction: fieldList,
} satisfies Record<CustomFieldEntity, unknown>);

export const currencySchema = z.object({
  code: z.string().regex(/^[A-Z]{3}$/),
  name: z.string().trim().min(1).max(40),
  symbol: z.string().trim().min(1).max(8),
  decimals: z.number().int().min(0).max(4),
});

export const countrySchema = z.object({
  code: z.string().regex(/^[A-Z]{2}$/),
  name: z.string().trim().min(1).max(40),
  flag: z.string().max(8).optional(),
});

export const categorySeedSchema = z.object({
  name: z.string().trim().min(1).max(32),
  icon: z.string().max(32).optional(),
  color: z.string().max(32).optional(),
});

export const appConfigSchema = z
  .object({
    version: z.literal(1),
    app: z.object({
      name: z.string().trim().min(1).max(32),
      defaultLocale: z.enum(['zh-CN', 'en']).default('zh-CN'),
      defaultCurrency: z.string().regex(/^[A-Z]{3}$/),
      /** Pre-selected country for new institutions ("ZZ" = global / no specific country). */
      defaultCountry: z.string().regex(/^[A-Z]{2}$/).default('US'),
    }),
    currencies: z.array(currencySchema).min(1),
    countries: z.array(countrySchema).min(1),
    defaultCategories: z.object({
      expense: z.array(categorySeedSchema),
      income: z.array(categorySeedSchema),
    }),
    reminders: z.object({
      /** Default "remind N days before due" for new bills. */
      defaultDaysBefore: z.number().int().min(0).max(60).default(3),
      /** How far ahead the reminder list looks. */
      lookaheadDays: z.number().int().min(1).max(120).default(14),
      /** Warn this many days before a card expires. */
      cardExpiryDays: z.number().int().min(0).max(365).default(60),
    }),
    customFields: customFieldsSchema,
  })
  .superRefine((cfg, ctx) => {
    const codes = new Set<string>();
    for (const [i, c] of cfg.currencies.entries()) {
      if (codes.has(c.code)) ctx.addIssue({ code: 'custom', path: ['currencies', i, 'code'], message: `duplicate currency ${c.code}` });
      codes.add(c.code);
    }
    if (!codes.has(cfg.app.defaultCurrency)) {
      ctx.addIssue({ code: 'custom', path: ['app', 'defaultCurrency'], message: 'defaultCurrency must be listed in currencies' });
    }
    const countries = new Set<string>();
    for (const [i, c] of cfg.countries.entries()) {
      if (countries.has(c.code)) ctx.addIssue({ code: 'custom', path: ['countries', i, 'code'], message: `duplicate country ${c.code}` });
      countries.add(c.code);
    }
    if (!countries.has(cfg.app.defaultCountry)) {
      ctx.addIssue({ code: 'custom', path: ['app', 'defaultCountry'], message: 'defaultCountry must be listed in countries' });
    }
  });

export type AppConfig = z.infer<typeof appConfigSchema>;
export type AppConfigInput = z.input<typeof appConfigSchema>;
export type CustomField = z.infer<typeof customFieldSchema>;
export type CustomFields = z.infer<typeof customFieldsSchema>;
export type Currency = z.infer<typeof currencySchema>;
export type Country = z.infer<typeof countrySchema>;

/** Stable JSON for writing the config file so Git diffs stay minimal. */
export function serializeConfig(cfg: AppConfig): string {
  return JSON.stringify(cfg, null, 2) + '\n';
}

export function currencyDecimals(cfg: Pick<AppConfig, 'currencies'>, code: string): number {
  return cfg.currencies.find((c) => c.code === code)?.decimals ?? 2;
}
