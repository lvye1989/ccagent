import { z } from 'zod';

if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

export function databaseUrl(migration = false): string {
  const value = migration
    ? process.env.DATABASE_MIGRATION_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL
    : process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!value) throw new Error('DATABASE_NOT_CONFIGURED');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('INVALID_DATABASE_PROTOCOL');
  return value;
}

export function authEnvironment() {
  const secret = z.string().min(32).parse(process.env.AUTH_SECRET);
  const origin = new URL(process.env.AUTH_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://127.0.0.1:4310'));
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('INVALID_AUTH_ORIGIN');
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname) && !process.env.VERCEL)) {
    throw new Error('AUTH_HTTPS_REQUIRED');
  }
  return { secret, origin: origin.origin };
}

export function databaseSchema(): string {
  const name = process.env.DB_SCHEMA || 'ccagent';
  // Tests use a separately created schema, never another application's schema.
  if (!/^ccagent(?:_test_[a-f0-9]{16})?$/.test(name)) throw new Error('INVALID_DATABASE_SCHEMA');
  return name;
}

export function databaseMaxConnections(): number {
  return z.coerce.number().int().min(1).max(10).parse(process.env.DB_MAX_CONNECTIONS || '1');
}
