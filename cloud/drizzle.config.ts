import './scripts/load-env';
import { defineConfig } from 'drizzle-kit';
import { databaseSchema, databaseUrl } from './src/core/env';

export default defineConfig({ dialect: 'postgresql', schema: './src/core/db/schema.ts', out: './migrations',
  schemaFilter: [databaseSchema()], dbCredentials: { url: databaseUrl(true) } });
