import { sql, type SQL } from 'drizzle-orm';
import { database } from './db';
import * as tables from './db/schema';
import { HttpError, pagination } from './http';
import { parseAdminFilters, type AdminFilterValues, type AdminSection } from './admin-filters';
import { inspectDatabaseStructure, type AppliedMigration } from './db/migration-state';

export type { AdminSection } from './admin-filters';
type View = { table: SQL; columns: SQL; filter: SQL; order: SQL; permission: string; title: string };
const views: Record<AdminSection, View> = {
  users: { table: sql`${tables.user}`, columns: sql`id,name,email,email_verified,banned,(select coalesce(jsonb_agg(ur.role_id),'[]'::jsonb) from ${tables.userRoles} ur where ur.user_id="user".id) as roles,created_at`, filter: sql`email`, order: sql`created_at desc,id`, permission: 'admin.read', title: '用户管理' },
  roles: { table: sql`${tables.roles}`, columns: sql`id,name,created_at`, filter: sql`name`, order: sql`id`, permission: 'admin.read', title: '角色管理' },
  permissions: { table: sql`${tables.permissions}`, columns: sql`id,name`, filter: sql`name`, order: sql`id`, permission: 'admin.read', title: '权限目录' },
  keys: { table: sql`${tables.apiKeys} k join ${tables.user} u on u.id=k.user_id`, columns: sql`k.id,k.user_id,u.email,k.name,k.prefix,k.enabled,k."limit",k.spent,k.frozen,k.created_at,k.revoked_at`, filter: sql`k.name`, order: sql`k.created_at desc,k.id`, permission: 'keys.write', title: 'API Key 管理' },
  wallets: { table: sql`${tables.wallets} w join ${tables.user} u on u.id=w.user_id`, columns: sql`w.user_id,u.email,w.balance,w.frozen,w.updated_at`, filter: sql`u.email`, order: sql`w.updated_at desc,w.user_id`, permission: 'data.read', title: '账户余额' },
  orders: { table: sql`${tables.orders}`, columns: sql`id,user_id,amount_fen,status,trade_no,channel,created_at,credited_at`, filter: sql`id`, order: sql`created_at desc,id`, permission: 'orders.read', title: '充值订单' },
  refunds: { table: sql`${tables.refunds}`, columns: sql`id,order_id,user_id,amount,status,initiated_by,reason,created_at,updated_at`, filter: sql`order_id`, order: sql`created_at desc,id`, permission: 'refunds.write', title: '退款与对账' },
  usage: { table: sql`${tables.reservations}`, columns: sql`id,user_id,key_id,route_id,coalesce(usage->>'executedRouteId',case when usage->>'attempts' ~ '^[1-9][0-9]*$' then route_id else null end) as executed_route_id,
    case when usage->>'fallbackUsed'='true' then true else false end as fallback_used,task_id,status,authorized,charged,usage,created_at,reconcile_at`, filter: sql`task_id`, order: sql`created_at desc,id`, permission: 'usage.read', title: '调用明细' },
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
  const view = adminView(section), filters = parseAdminFilters(section, url), paging = pagination(url);
  const conditions = filteredConditions(section as AdminSection, view, filters);
  const where = conditions.length ? sql`where ${sql.join(conditions, sql` and `)}` : sql``;
  // Filter individual calls before grouping. A task's total must describe the selected period/services.
  const relation = section === 'tasks'
    ? sql`(select user_id,task_id,count(*) as calls,sum(charged) as charged,max(created_at) as latest_at from ${tables.reservations} ${where} group by user_id,task_id) task_totals`
    : view.table;
  const outerWhere = section === 'tasks' ? sql`` : where;
  const sums: Partial<Record<AdminSection, SQL>> = {
    wallets: sql`coalesce(sum(w.balance),0)::text as balance,coalesce(sum(w.frozen),0)::text as frozen`,
    orders: sql`coalesce(sum(amount_fen),0)::text as amount_fen`, refunds: sql`coalesce(sum(amount),0)::text as amount`,
    usage: sql`coalesce(sum(charged),0)::text as charged,coalesce(sum(authorized),0)::text as authorized`,
    tasks: sql`coalesce(sum(calls),0)::text as calls,coalesce(sum(charged),0)::text as charged`,
    ledger: sql`coalesce(sum(balance_delta),0)::text as balance_delta,coalesce(sum(frozen_delta),0)::text as frozen_delta`,
  };
  const sum = sums[section as AdminSection];
  return database().db.transaction(async tx => {
    const rows = await tx.execute<Record<string, unknown>>(sql`select ${view.columns} from ${relation} ${outerWhere} order by ${view.order} limit ${exportCsv ? 10000 : paging.pageSize} offset ${exportCsv ? 0 : paging.offset}`);
    const [total] = await tx.execute<Record<string, string>>(sql`select count(*)::text as count ${sum ? sql`,${sum}` : sql``} from ${relation} ${outerWhere}`);
    const { count, ...summary } = total;
    return { title: view.title, rows: Array.from(rows), total: Number(count), page: paging.page, pageSize: paging.pageSize, q: filters.q || '', filters, summary };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

function contains(value: string) { return `%${value.replace(/[!%_]/g, '!$&')}%`; }
function filteredConditions(section: AdminSection, view: View, values: AdminFilterValues): SQL[] {
  const userColumns: Partial<Record<AdminSection, SQL>> = { users: sql`${tables.user.id}`, keys: sql`k.user_id`, wallets: sql`w.user_id`, orders: sql`${tables.orders.userId}`,
    refunds: sql`${tables.refunds.userId}`, usage: sql`${tables.reservations.userId}`, tasks: sql`${tables.reservations.userId}`, ledger: sql`${tables.ledger.userId}`, audit: sql`${tables.audit.actorId}` };
  const times: Partial<Record<AdminSection, SQL>> = { users: sql`${tables.user.createdAt}`, roles: sql`${tables.roles.createdAt}`, keys: sql`k.created_at`, wallets: sql`w.updated_at`,
    orders: sql`${tables.orders.createdAt}`, refunds: sql`${tables.refunds.createdAt}`, usage: sql`${tables.reservations.createdAt}`, tasks: sql`${tables.reservations.createdAt}`,
    ledger: sql`${tables.ledger.createdAt}`, audit: sql`${tables.audit.createdAt}`, routes: sql`${tables.routes.updatedAt}`, prices: sql`${tables.prices.effectiveAt}` };
  const route = ['usage', 'tasks'].includes(section) ? sql`${tables.reservations.routeId}` : section === 'prices' ? sql`${tables.prices.routeId}` : undefined;
  const result: SQL[] = [];
  if (values.q) result.push(sql`${view.filter}::text ilike ${contains(values.q)} escape '!'`);
  const owner = userColumns[section];
  if (values.user && owner) result.push(sql`(${owner}=${values.user} or exists(select 1 from ${tables.user} filter_user where filter_user.id=${owner} and filter_user.email ilike ${contains(values.user)} escape '!'))`);
  const time = times[section];
  if (values.from && time) result.push(sql`${time} >= (${values.from}::date::timestamp at time zone 'Asia/Shanghai')`);
  if (values.to && time) result.push(sql`${time} < ((${values.to}::date + 1)::timestamp at time zone 'Asia/Shanghai')`);
  if (values.route && route) result.push(sql`${route}=${values.route}`);
  if (values.task) result.push(sql`${tables.reservations.taskId}=${values.task}`);
  if (values.overdue) result.push(sql`${tables.reservations.status} in ('held','pending') and ${tables.reservations.reconcileAt} <= now()`);
  if (values.service) {
    if (section === 'routes') result.push(sql`${tables.routes.service}=${values.service}`);
    else if (route) result.push(sql`exists(select 1 from ${tables.routes} filter_route where filter_route.id=${route} and filter_route.service=${values.service})`);
  }
  if (values.status) {
    if (section === 'users') result.push(sql`${tables.user.banned}=${values.status === 'disabled'}`);
    else if (section === 'keys') result.push(values.status === 'active' ? sql`k.enabled and k.revoked_at is null` : sql`(not k.enabled or k.revoked_at is not null)`);
    else if (section === 'routes') result.push(sql`${tables.routes.enabled}=${values.status === 'enabled'}`);
    else if (section === 'orders') result.push(sql`${tables.orders.status}=${values.status}`);
    else if (section === 'refunds') result.push(sql`${tables.refunds.status}=${values.status}`);
    else result.push(sql`${tables.reservations.status}=${values.status}`);
  }
  return result;
}
export async function databaseOverview(permissions: readonly string[] = []) {
  return database().db.transaction(async db => {
    const [health] = await db.execute<{ role: string; schema: string }>(sql`select current_user as role, ${tables.namespace.schemaName}::text as schema`);
    const tableRows = await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema=${tables.namespace.schemaName} and table_type='BASE TABLE'`);
    const names = Array.from(tableRows, value => value.table_name);
    const applied = names.includes('__drizzle_migrations') ? Array.from(await db.execute<AppliedMigration>(sql`select hash,created_at::text as "createdAt" from ${sql.identifier(tables.namespace.schemaName)}.__drizzle_migrations order by created_at`)) : [];
    const structure = inspectDatabaseStructure(applied, names, tables.namespace.schemaName);
    const base = { connected: true, schema: health.schema, runtimeRole: health.role, migrationVersions: applied.length, structure, checkedAt: new Date().toISOString() };
    const pending: Partial<Record<'orders' | 'refunds' | 'usage', Record<string, unknown>[]>> = {};
    if (!structure.tables.current) return { ...base, counts: null, pending, lastMaintenance: null, lastMaintenanceChecked: false };
    const [counts] = await db.execute<Record<string, string>>(sql`select
    (select count(*) from ${tables.user})::text as users,
    (select count(*) from ${tables.apiKeys})::text as keys,
    (select count(*) from ${tables.apiKeys} where enabled and revoked_at is null)::text as active_keys,
    (select count(*) from ${tables.orders})::text as orders,
    (select count(*) from ${tables.refunds})::text as refunds,
    (select count(*) from ${tables.reservations})::text as calls,
    (select count(*) from (select user_id,task_id from ${tables.reservations} group by user_id,task_id) task_groups)::text as tasks,
    (select count(*) from ${tables.ledger})::text as ledger,
    (select count(*) from ${tables.audit})::text as audit,
    (select count(*) from ${tables.routes})::text as routes,
    (select count(*) from ${tables.routes} where enabled)::text as enabled_routes,
    (select count(*) from ${tables.prices})::text as prices,
    (select count(*) from ${tables.blobs} where status not in ('deleted','purged'))::text as files,
    (select count(*) from ${tables.orders} where status = 'pending')::text as pending_orders,
    (select count(*) from ${tables.refunds} where status in ('held','submitting','pending'))::text as pending_refunds,
    (select count(*) from ${tables.reservations} where status in ('held','pending'))::text as pending_calls,
    (select count(*) from ${tables.reservations} where status in ('held','pending') and reconcile_at <= now())::text as overdue_calls,
    (select coalesce(sum(balance),0) from ${tables.wallets})::text as balance,
    (select coalesce(sum(frozen),0) from ${tables.wallets})::text as frozen`);
    // Callers supply permissions read from the authenticated server session, never URL/body values.
    if (permissions.includes('orders.read')) pending.orders = Array.from(await db.execute<Record<string, unknown>>(sql`select id,user_id,amount_fen,status,created_at from ${tables.orders} where status='pending' order by created_at,id limit 5`));
    if (permissions.includes('refunds.write')) pending.refunds = Array.from(await db.execute<Record<string, unknown>>(sql`select id,order_id,user_id,amount,status,created_at from ${tables.refunds} where status in ('held','submitting','pending') order by created_at,id limit 5`));
    if (permissions.includes('usage.read')) pending.usage = Array.from(await db.execute<Record<string, unknown>>(sql`select id,user_id,task_id,status,authorized,charged,reconcile_at from ${tables.reservations} where status in ('held','pending') and reconcile_at<=now() order by reconcile_at,id limit 5`));
    const [maintenance] = await db.execute<{ created_at: Date; result: string }>(sql`select created_at,result from ${tables.audit} where action='system.maintenance' order by created_at desc,id desc limit 1`);
    return { ...base, counts, pending,
      lastMaintenance: maintenance ? { at: maintenance.created_at, result: ['success', 'partial'].includes(maintenance.result) ? maintenance.result : 'unknown' } : null,
      lastMaintenanceChecked: true };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
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
