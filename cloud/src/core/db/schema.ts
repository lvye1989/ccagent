import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { databaseSchema } from '../env';

export const namespace = pgSchema(databaseSchema());
const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const money = (name: string) => bigint(name, { mode: 'bigint' });
const created = () => time('created_at').notNull().defaultNow();

export const user = namespace.table('user', {
  id: text('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false), image: text('image'),
  role: text('role').notNull().default('user'), banned: boolean('banned').notNull().default(false),
  banReason: text('ban_reason'), banExpires: time('ban_expires'),
  createdAt: created(), updatedAt: time('updated_at').notNull().defaultNow(),
});
export const session = namespace.table('session', {
  id: text('id').primaryKey(), token: text('token').notNull().unique(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: time('expires_at').notNull(), ipAddress: text('ip_address'), userAgent: text('user_agent'),
  createdAt: created(), updatedAt: time('updated_at').notNull().defaultNow(), impersonatedBy: text('impersonated_by'),
}, t => [index('session_user_idx').on(t.userId)]);
export const account = namespace.table('account', {
  id: text('id').primaryKey(), accountId: text('account_id').notNull(), providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'), refreshToken: text('refresh_token'), idToken: text('id_token'),
  accessTokenExpiresAt: time('access_token_expires_at'), refreshTokenExpiresAt: time('refresh_token_expires_at'),
  scope: text('scope'), password: text('password'), createdAt: created(), updatedAt: time('updated_at').notNull().defaultNow(),
}, t => [index('account_user_idx').on(t.userId), uniqueIndex('account_provider_idx').on(t.providerId, t.accountId)]);
export const verification = namespace.table('verification', {
  id: text('id').primaryKey(), identifier: text('identifier').notNull(), value: text('value').notNull(),
  expiresAt: time('expires_at').notNull(), createdAt: created(), updatedAt: time('updated_at').notNull().defaultNow(),
}, t => [index('verification_identifier_idx').on(t.identifier)]);
export const rateLimit = namespace.table('rate_limit', {
  id: text('id').primaryKey(), key: text('key').notNull().unique(), count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});

export const roles = namespace.table('roles', { id: text('id').primaryKey(), name: text('name').notNull(), createdAt: created() });
export const permissions = namespace.table('permissions', { id: text('id').primaryKey(), name: text('name').notNull() });
export const rolePermissions = namespace.table('role_permissions', {
  roleId: text('role_id').notNull().references(() => roles.id), permissionId: text('permission_id').notNull().references(() => permissions.id),
}, t => [primaryKey({ columns: [t.roleId, t.permissionId] })]);
export const userRoles = namespace.table('user_roles', {
  userId: text('user_id').notNull().references(() => user.id), roleId: text('role_id').notNull().references(() => roles.id),
}, t => [primaryKey({ columns: [t.userId, t.roleId] })]);

export const wallets = namespace.table('wallets', {
  userId: text('user_id').primaryKey().references(() => user.id),
  balance: money('balance').notNull().default(sql`0`), frozen: money('frozen').notNull().default(sql`0`), updatedAt: time('updated_at').notNull().defaultNow(),
}, t => [check('wallet_funds_valid', sql`${t.balance} >= 0 AND ${t.frozen} >= 0 AND ${t.frozen} <= ${t.balance}`)]);
export const ledger = namespace.table('ledger', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => user.id),
  reference: text('reference').notNull().unique(), kind: text('kind').notNull(),
  balanceDelta: money('balance_delta').notNull(), frozenDelta: money('frozen_delta').notNull(),
  balanceAfter: money('balance_after').notNull(), frozenAfter: money('frozen_after').notNull(),
  metadata: jsonb('metadata').notNull().default({}), createdAt: created(),
}, t => [index('ledger_user_time_idx').on(t.userId, t.createdAt)]);
export const apiKeys = namespace.table('api_keys', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => user.id),
  name: text('name').notNull(), prefix: text('prefix').notNull(), hash: text('hash').notNull().unique(),
  enabled: boolean('enabled').notNull().default(true), limit: money('limit'), spent: money('spent').notNull().default(sql`0`),
  frozen: money('frozen').notNull().default(sql`0`), createdAt: created(), revokedAt: time('revoked_at'),
}, t => [index('api_key_user_idx').on(t.userId), check('key_funds_valid', sql`${t.spent} >= 0 AND ${t.frozen} >= 0 AND (${t.limit} IS NULL OR ${t.limit} >= ${t.spent} + ${t.frozen})`)]);
export const routes = namespace.table('routes', {
  id: text('id').primaryKey(), name: text('name').notNull(), service: text('service').notNull(), protocol: text('protocol').notNull(),
  provider: text('provider').notNull(), baseUrl: text('base_url').notNull(), upstreamModel: text('upstream_model').notNull(),
  credentialEnv: text('credential_env').notNull(), enabled: boolean('enabled').notNull().default(false),
  timeoutMs: integer('timeout_ms').notNull().default(120000), retries: integer('retries').notNull().default(0),
  options: jsonb('options').notNull().default({}), createdAt: created(), updatedAt: time('updated_at').notNull().defaultNow(),
});
export const prices = namespace.table('prices', {
  id: text('id').primaryKey(), routeId: text('route_id').notNull().references(() => routes.id), version: integer('version').notNull(),
  currency: text('currency').notNull(), components: jsonb('components').notNull(), fx: text('fx'),
  markup: text('markup').notNull().default('1.3'), sourceUrl: text('source_url').notNull(), effectiveAt: time('effective_at').notNull(),
  createdAt: created(),
}, t => [uniqueIndex('price_route_version_idx').on(t.routeId, t.version)]);
export const reservations = namespace.table('reservations', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => user.id),
  keyId: text('key_id').notNull().references(() => apiKeys.id), routeId: text('route_id').notNull().references(() => routes.id),
  taskId: text('task_id').notNull(), idempotencyKey: text('idempotency_key').notNull(), requestHash: text('request_hash').notNull(),
  status: text('status').notNull().default('held'), authorized: money('authorized').notNull(), charged: money('charged').notNull().default(sql`0`),
  priceSnapshot: jsonb('price_snapshot').notNull(), usage: jsonb('usage'), resultBlobId: text('result_blob_id'),
  createdAt: created(), updatedAt: time('updated_at').notNull().defaultNow(), reconcileAt: time('reconcile_at').notNull(),
}, t => [uniqueIndex('reservation_idempotency_idx').on(t.userId, t.idempotencyKey), index('reservation_user_time_idx').on(t.userId, t.createdAt),
  check('reservation_funds_valid', sql`${t.authorized} > 0 AND ${t.charged} >= 0 AND ${t.charged} <= ${t.authorized}`),
  check('reservation_status_valid', sql`${t.status} IN ('held','pending','settled','released')`)]);
export const orders = namespace.table('orders', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => user.id),
  amountFen: bigint('amount_fen', { mode: 'bigint' }).notNull(), status: text('status').notNull().default('pending'),
  tradeNo: text('trade_no').unique(), channel: text('channel').notNull().default('alipay'), merchantId: text('merchant_id').notNull(),
  createdAt: created(), creditedAt: time('credited_at'), checkedAt: time('checked_at'),
}, t => [index('order_user_time_idx').on(t.userId, t.createdAt), check('order_funds_valid', sql`${t.amountFen} > 0`)]);
export const paymentEvents = namespace.table('payment_events', {
  id: text('id').primaryKey(), orderId: text('order_id').notNull().references(() => orders.id), tradeNo: text('trade_no').notNull(),
  deduplicationHash: text('deduplication_hash').notNull().unique(), status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0), receivedAt: created(), processedAt: time('processed_at'),
});
export const refunds = namespace.table('refunds', {
  id: text('id').primaryKey(), orderId: text('order_id').notNull().unique().references(() => orders.id),
  userId: text('user_id').notNull().references(() => user.id), amount: money('amount').notNull(),
  status: text('status').notNull().default('held'), initiatedBy: text('initiated_by').notNull().references(() => user.id),
  reason: text('reason').notNull(), createdAt: created(), updatedAt: time('updated_at').notNull().defaultNow(),
});
export const settings = namespace.table('settings', {
  key: text('key').primaryKey(), value: jsonb('value').notNull(), updatedBy: text('updated_by').references(() => user.id),
  version: integer('version').notNull().default(1), updatedAt: time('updated_at').notNull().defaultNow(),
});
export const audit = namespace.table('audit', {
  id: text('id').primaryKey(), actorId: text('actor_id').references(() => user.id), action: text('action').notNull(),
  objectId: text('object_id').notNull(), result: text('result').notNull(), metadata: jsonb('metadata').notNull().default({}), createdAt: created(),
}, t => [index('audit_time_idx').on(t.createdAt)]);
export const blobs = namespace.table('blobs', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => user.id), pathname: text('pathname').notNull().unique(),
  purpose: text('purpose').notNull(), contentType: text('content_type').notNull(), size: bigint('size', { mode: 'number' }).notNull(),
  status: text('status').notNull().default('pending'), createdAt: created(), expiresAt: time('expires_at').notNull(),
});
