import { eq } from 'drizzle-orm';
import { appConfigSchema, serializeConfig, unifiedDiff, type AppConfig } from '@z-ui/shared';
import type { DB } from '../db/client.ts';
import { settings } from '../db/schema.ts';

/**
 * The shared configuration (currencies, countries, categories, custom fields…). Stored once, in
 * the database, and edited from the Settings page; config/app.config.json only provides the
 * defaults for a fresh installation. Works the same on Node (libsql) and Cloudflare (D1).
 */
export interface ConfigStore {
  get(): AppConfig;
  preview(next: AppConfig): { changed: boolean; diff: string };
  save(next: AppConfig): Promise<{ changed: boolean; diff: string }>;
}

function diffOf(prev: AppConfig, next: AppConfig) {
  const a = serializeConfig(prev);
  const b = serializeConfig(next);
  return { changed: a !== b, diff: a === b ? '' : unifiedDiff(a, b) };
}

const KEY = 'app-config';

export class DbConfigStore implements ConfigStore {
  private cfg: AppConfig;
  private loadedAt = 0;

  constructor(
    private readonly db: DB,
    private readonly defaults: AppConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.cfg = defaults;
  }

  /** Read the stored config (seeding it from the defaults on first run). */
  async load() {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, KEY));
    if (!row) {
      await this.db.insert(settings).values({ key: KEY, value: this.defaults, updatedAt: this.now() }).onConflictDoNothing();
      this.cfg = this.defaults;
    } else {
      const parsed = appConfigSchema.safeParse(row.value);
      if (parsed.success) this.cfg = parsed.data;
      else console.error('[config] stored config is invalid, using defaults', parsed.error.issues[0]);
    }
    this.loadedAt = this.now();
  }

  /** Workers keep one copy per isolate; re-read at most once a minute so edits propagate. */
  async refreshIfStale(maxAgeMs = 60_000) {
    if (this.now() - this.loadedAt > maxAgeMs) await this.load();
  }

  get() {
    return this.cfg;
  }

  preview(next: AppConfig) {
    return diffOf(this.cfg, next);
  }

  async save(next: AppConfig) {
    const result = diffOf(this.cfg, next);
    if (!result.changed) return result;
    const t = this.now();
    await this.db
      .insert(settings)
      .values({ key: KEY, value: next, updatedAt: t })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: t } });
    this.cfg = next;
    this.loadedAt = t;
    return result;
  }
}

/** In-memory store for tests. */
export class MemoryConfigStore implements ConfigStore {
  constructor(private cfg: AppConfig) {}
  get() {
    return this.cfg;
  }
  preview(next: AppConfig) {
    return diffOf(this.cfg, next);
  }
  async save(next: AppConfig) {
    const r = diffOf(this.cfg, next);
    this.cfg = next;
    return r;
  }
}
