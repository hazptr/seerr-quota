import { defineConfig } from 'drizzle-kit';

// Points drizzle-kit at the schema module and the same DB_PATH the app opens
// at runtime (see src/lib/db/index.ts).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DB_PATH ?? '/db/seerr-quota.db',
  },
});
