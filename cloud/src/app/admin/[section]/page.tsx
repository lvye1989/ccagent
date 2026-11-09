import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Shell, PageHeader } from '@/components/shell';
import { DataTable } from '@/components/data-table';
import { Pager } from '@/components/pager';
import { SettingsPanel } from '@/components/settings-panel';
import { AdminActions } from '@/components/admin-actions';
import { AdminKeysPanel } from '@/components/admin-keys-panel';
import { AdminRoutesPanel } from '@/components/admin-routes-panel';
import { GatewayPanel } from '@/components/gateway-panel';
import { GatewayDefaultsPanel } from '@/components/gateway-defaults-panel';
import { GatewayConfigPanel } from '@/components/gateway-config-panel';
import { adminServiceDefaults } from '@/core/service-defaults';
import { AdminFilters, AdminSummary } from '@/components/admin-filters';
import { webAccount } from '@/core/web-account';
import { adminRows, adminView, databaseOverview } from '@/core/admin-data';
import { configuration, credentialStatuses } from '@/core/configuration';
import { adminFilterInputs } from '@/core/admin-filters';
import { HttpError } from '@/core/http';
import { BackendDataPanel } from '@/components/backend-data-panel';

export const dynamic = 'force-dynamic';
const groups: Record<string, [string, string][]> = {
  users: [['users', '用户'], ['roles', '角色'], ['permissions', '权限']], roles: [['users', '用户'], ['roles', '角色'], ['permissions', '权限']], permissions: [['users', '用户'], ['roles', '角色'], ['permissions', '权限']],
  orders: [['orders', '充值订单'], ['wallets', '账户余额'], ['ledger', '资金流水']], wallets: [['orders', '充值订单'], ['wallets', '账户余额'], ['ledger', '资金流水']], ledger: [['orders', '充值订单'], ['wallets', '账户余额'], ['ledger', '资金流水']],
  usage: [['usage', '逐笔调用'], ['tasks', '任务汇总']], tasks: [['usage', '逐笔调用'], ['tasks', '任务汇总']], routes: [['routes', '服务路由'], ['prices', '成本版本']], prices: [['routes', '服务路由'], ['prices', '成本版本']],
  data: [['data', '连接与统计'], ['ledger', '资金流水'], ['audit', '操作审计']], audit: [['data', '连接与统计'], ['ledger', '资金流水'], ['audit', '操作审计']],
};
export default async function AdminSection({ params, searchParams }: { params: Promise<{ section: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { section } = await params;
  const permission = section === 'routes' ? undefined : section === 'settings' ? 'settings.write' : section === 'data' ? 'data.read' : adminView(section).permission;
  const current = await webAccount(permission);
  if (section === 'routes' && !current.permissions.some(value => value === 'admin.read' || value === 'routes.write')) notFound();
  const title = section === 'settings' ? '系统设置' : section === 'data' ? '后端数据' : adminView(section).title;
  const active = ['wallets', 'ledger'].includes(section) ? 'orders' : ['roles', 'permissions'].includes(section) ? 'users' : section === 'tasks' ? 'usage' : section === 'prices' ? 'routes' : section === 'audit' ? 'data' : section;
  let content: React.ReactNode, taskQuery = '';
  if (section === 'settings') content = <SettingsPanel settings={await configuration()} credentials={credentialStatuses()} canManageGateway={current.permissions.includes('routes.write')} canReadBackend={current.permissions.includes('data.read')} />;
  else if (section === 'data') {
    content = <BackendDataPanel overview={await databaseOverview(current.permissions)} permissions={current.permissions} />;
  } else {
    const query = await searchParams;
    const url = new URL('http://local/');
    for (const [key, entry] of Object.entries(query)) for (const value of Array.isArray(entry) ? entry : typeof entry === 'string' ? [entry] : []) url.searchParams.append(key, value);
    let result: Awaited<ReturnType<typeof adminRows>> | undefined, filterError = '';
    try { result = await adminRows(section, url); }
    catch (error) { if (!(error instanceof HttpError) || error.status !== 400) throw error; filterError = error.message; }
    const exportQuery = new URLSearchParams({ format: 'csv' });
    for (const [key, value] of Object.entries(result?.filters || {})) if (value) exportQuery.set(key, value);
    if (result && ['usage', 'tasks'].includes(section)) {
      const navigation = new URLSearchParams(exportQuery); navigation.delete('format'); navigation.set('pageSize', String(result.pageSize)); taskQuery = navigation.toString();
    }
    const safeRows = result ? JSON.parse(JSON.stringify(result.rows)) as Record<string, unknown>[] : [];
    content = <><section className="panel">{filterError && <div className="notice error" role="alert">{filterError}</div>}<AdminFilters section={section} values={result?.filters || adminFilterInputs(section, url)} pageSize={result?.pageSize} exportHref={result && current.permissions.includes('data.export') ? `/api/admin/data/${section}?${exportQuery}` : undefined} />{result && <><AdminSummary values={result.summary} />{section === 'routes' ? <AdminRoutesPanel key={`${section}-${result.page}-${exportQuery}`} rows={safeRows} permissions={current.permissions} /> : <DataTable rows={result.rows} />}<Pager path={`/admin/${section}`} page={result.page} pageSize={result.pageSize} total={result.total} filters={result.filters} />{result.total > 10000 && <p className="small-text muted">每次导出最多 10,000 条，请继续缩小筛选范围；汇总金额包含全部匹配记录。</p>}</>}</section>{result && <>{section === 'keys' ? <AdminKeysPanel key={`${section}-${result.page}-${exportQuery}`} rows={safeRows} /> : section !== 'routes' && <AdminActions key={`${section}-${result.page}-${exportQuery}`} section={section} rows={safeRows} permissions={current.permissions} />}{section === 'prices' && current.permissions.includes('routes.write') && <GatewayPanel mode="prices" rows={safeRows} />}</>}</>;
  }
  if (section === 'routes' && current.permissions.includes('routes.write')) content = <><GatewayDefaultsPanel initial={await adminServiceDefaults()} />{content}<GatewayConfigPanel /></>;
  return <Shell user={current.user} title={title} path={`/admin/${active}`} admin><PageHeader title={title} description={section === 'settings' ? '管理通用、认证、支付与计费配置，查看服务凭据配置状态。' : '查询平台业务数据，按权限执行管理操作。'} />{groups[section] && <nav className="tabs">{groups[section].map(([key, label]) => <Link className={section === key ? 'active' : ''} key={key} href={`/admin/${key}${taskQuery && ['usage', 'tasks'].includes(key) ? `?${taskQuery}` : ''}`}>{label}</Link>)}</nav>}{content}</Shell>;
}
