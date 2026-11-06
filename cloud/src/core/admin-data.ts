import { sql, type SQL } from 'drizzle-orm';
import { database } from './db';
import * as tables from './db/schema';
import { HttpError, pagination } from './http';

export type AdminSection = 'users' | 'roles' | 'permissions' | 'keys' | 'wallets' | 'orders' | 'refunds' | 'usage' | 'tasks' | 'ledger' | 'audit' | 'routes' | 'prices';
type View = { table: SQL; columns: SQL; filter: SQL; order: SQL; permission: string; title: string };
const views: Record<AdminSection, View> = {
  users: { table: sql`${tables.user}`, columns: sql`id,name,email,email_verified,banned,(select coalesce(jsonb_agg(ur.role_id),'[]'::jsonb) from ${tables.userRoles} ur where ur.user_id="user".id) as roles,created_at`, filter: sql`email`, order: sql`created_at desc,id`, permission: 'admin.read', title: '用户管理' },
  roles: { table: sql`${tables.roles}`, columns: sql`id,name,created_at`, filter: sql`name`, order: sql`id`, permission: 'admin.read', title: '角色管理' },
  permissions: { table: sql`${tables.permissions}`, columns: sql`id,name`, filter: sql`name`, order: sql`id`, permission: 'admin.read', title: '权限目录' },
  keys: { table: sql`${tables.apiKeys} k join ${tables.user} u on u.id=k.user_id`, columns: sql`k.id,k.user_id,u.email,k.name,k.prefix,k.enabled,k."limit",k.spent,k.frozen,k.created_at,k.revoked_at`, filter: sql`k.name`, order: sql`k.created_at desc,k.id`, permission: 'keys.write', title: 'API Key 管理' },
  wallets: { table: sql`${tables.wallets} w join ${tables.user} u on u.id=w.user_id`, columns: sql`w.user_id,u.email,w.balance,w.frozen,w.updated_at`, filter: sql`u.email`, order: sql`w.updated_at desc,w.user_id`, permission: 'data.read', title: '账户余额' },
  orders: { table: sql`${tables.orders}`, columns: sql`id,user_id,amount_fen,status,trade_no,channel,created_at,credited_at`, filter: sql`id`, order: sql`created_at desc,id`, permission: 'orders.read', title: '充值订单' },
  refunds: { table: sql`${tables.refunds}`, columns: sql`id,order_id,user_id,amount,status,initiated_by,reason,created_at,updated_at`, filter: sql`order_id`, order: sql`created_at desc,id`, permission: 'refunds.write', title: '退款与对账' },
  usage: { table: sql`${tables.reservations}`, columns: sql`id,user_id,key_id,route_id,task_id,status,authorized,charged,usage,created_at`, filter: sql`task_id`, order: sql`created_at desc,id`, permission: 'usage.read', title: '调用明细' },
  tasks: { table: sql`(select user_id,task_id,count(*) as calls,sum(charged) as charged,max(created_at) as latest_at from ${tables.reservations} group by user_id,task_id) task_totals`,
    columns: sql`user_id,task_id,calls,charged,latest_at`, filter: sql`task_id`, order: sql`latest_at desc,user_id,task_id`, permission: 'usage.read', title: '任务费用' },
  ledger: { table: sql`${tables.ledger}`, columns: sql`id,user_id,reference,kind,balance_delta,frozen_delta,balance_after,frozen_after,created_at`, filter: sql`reference`, order: sql`created_at desc,id`, permission: 'data.read', title: '资金流水' },
  audit: { table: sql`${tables.audit}`, columns: sql`id,actor_id,action,object_id,result,metadata,created_at`, filter: sql`action`, order: sql`created_at desc,id`, permission: 'data.read', title: '操作审计' },
  routes: { table: sql`${tables.routes}`, columns: sql`id,name,service,protocol,provider,base_url,upstream_model,credential_env,enabled,timeout_ms,retries,updated_at`, filter: sql`name`, order: sql`updated_at desc,id`, permission: 'admin.read', title: '服务网关' },
  prices: { table: sql`${tables.prices}`, columns: sql`id,route_id,version,currency,components,fx,markup,source_url,effective_at`, filter: sql`route_id`, order: sql`effective_at desc,id`, permission: 'admin.read', title: '成本与汇率版本' },
};
export function adminView(section: string): View {
  if (!Object.hasOwn(views, section)) throw new HttpError(404, 'NOT_FOUND', '页面不存在。');
  return views[section as AdminSection];
}
export async function adminRows(section: string, url: URL, exportCsv = false) {
  const view = adminView(section), paging = pagination(url), q = (url.searchParams.get('q') || '').trim();
  if (q.length > 120) throw new HttpError(400, 'QUERY_TOO_LONG', '查询内容过长。');
  const where = q ? sql`where ${view.filter}::text ilike ${`%${q}%`}` : sql``;
  const rows = await database().db.execute<Record<string, unknown>>(sql`select ${view.columns} from ${view.table} ${where} order by ${view.order} limit ${exportCsv ? 10000 : paging.pageSize} offset ${exportCsv ? 0 : paging.offset}`);
  const [total] = await database().db.execute<{ count: string }>(sql`select count(*)::text as count from ${view.table} ${where}`);
  return { title: view.title, rows: Array.from(rows), total: Number(total.count), page: paging.page, pageSize: paging.pageSize, q };
}
export async function databaseOverview() {
  const db = database().db;
  const [health] = await db.execute<{ role: string; schema: string }>(sql`select current_user as role, ${tables.namespace.schemaName}::text as schema`);
  const [versions] = await db.execute<{ count: number }>(sql`select count(*)::integer as count from ${sql.identifier(tables.namespace.schemaName)}.__drizzle_migrations`);
  const [counts] = await db.execute<Record<string, string>>(sql`select
    (select count(*) from ${tables.user})::text as users,
    (select count(*) from ${tables.apiKeys} where enabled)::text as active_keys,
    (select count(*) from ${tables.orders} where status = 'pending')::text as pending_orders,
    (select count(*) from ${tables.refunds} where status in ('held','pending'))::text as pending_refunds,
    (select count(*) from ${tables.reservations} where status in ('held','pending'))::text as pending_calls,
    (select coalesce(sum(balance),0) from ${tables.wallets})::text as balance,
    (select coalesce(sum(frozen),0) from ${tables.wallets})::text as frozen`);
  return { connected: true, schema: health.schema, runtimeRole: health.role, migrationVersions: versions.count, counts, checkedAt: new Date().toISOString() };
}
export function csvResponse(rows: Record<string, unknown>[], section: string): Response {
  const columns = rows.length ? Object.keys(rows[0]) : ['无记录'];
  const cell = (value: unknown) => {
    let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const body = '\uFEFF' + [columns.map(cell).join(','), ...rows.map(row => columns.map(column => cell(row[column])).join(','))].join('\r\n');
  return new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="ccagent-${section}.csv"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
