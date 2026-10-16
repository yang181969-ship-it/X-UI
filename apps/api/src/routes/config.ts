import { Hono } from 'hono';
import { z } from 'zod';
import { appConfigSchema, configSaveSchema, summarizeConfigChange, type AppConfig } from '@z-ui/shared';
import { requireAdmin, requireStepUp } from '../auth/middleware.ts';
import type { AppBindings } from '../env.ts';
import { audit } from '../lib/audit.ts';
import { body, fail } from '../lib/http.ts';

function parseConfig(raw: unknown): AppConfig {
  const r = appConfigSchema.safeParse(raw);
  if (!r.success) fail(400, 'invalid config', 'VALIDATION', r.error.issues);
  return r.data;
}

/** The shared configuration, stored in the database and edited from the Settings page. */
export const configRoutes = new Hono<AppBindings>()
  .get('/', (c) => c.json(c.var.deps.config.get()))

  .post('/preview', requireAdmin, async (c) => {
    const { config } = await body(c, z.object({ config: z.unknown() }));
    const next = parseConfig(config);
    const store = c.var.deps.config;
    return c.json({ ...store.preview(next), summary: summarizeConfigChange(store.get(), next) });
  })

  .put('/', requireAdmin, requireStepUp, async (c) => {
    const input = await body(c, configSaveSchema);
    const next = parseConfig(input.config);
    const store = c.var.deps.config;
    const summary = summarizeConfigChange(store.get(), next);
    const result = await store.save(next);
    if (result.changed) await audit(c, 'config.save', { summary });
    return c.json(result);
  });
