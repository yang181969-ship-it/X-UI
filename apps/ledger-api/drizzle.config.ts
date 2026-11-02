import { defineConfig } from 'drizzle-kit';

// X-UI v1 only. Used for `drizzle-kit generate`; migrations are applied by the app
// (src/db/client.ts) after the database identity check — there are deliberately no
// dbCredentials, so `drizzle-kit migrate/push` cannot bypass that check.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  migrations: { table: '__xui_v1_migrations' },
});
