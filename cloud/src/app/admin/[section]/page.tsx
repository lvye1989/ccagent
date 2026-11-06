import Link from 'next/link';
import { Shell, PageHeader } from '@/components/shell';
import { DataTable } from '@/components/data-table';
import { Pager } from '@/components/pager';
import { SettingsPanel } from '@/components/settings-panel';
import { AdminActions } from '@/components/admin-actions';
import { GatewayPanel } from '@/components/gateway-panel';
import { webAccount } from '@/core/web-account';
import { adminRows, adminView, databaseOverview } from '@/core/admin-data';
import { configuration, credentialStatuses } from '@/core/configuration';

export const dynamic = 'force-dynamic';
const groups: Record<string, [string, string][]> = {
  users: [['users', '用户'], ['roles', '角色'], ['permissions', '权限']], roles: [['users', '用户'], ['roles', '角色'], ['permissions', '权限']], permissions: [['users', '用户'], ['roles', '角色'], ['permissions', '权限']],
  orders: [['orders', '充值订单'], ['wallets', '账户余额'], ['ledger', '资金流水']], wallets: [['orders', '充值订单'], ['wallets', '账户余额'], ['ledger', '资金流水']], ledger: [['orders', '充值订单'], ['wallets', '账户余额'], ['ledger', '资金流水']],
  usage: [['usage', '逐笔调用'], ['tasks', '任务汇总']], tasks: [['usage', '逐笔调用'], ['tasks', '任务汇总']], routes: [['routes', '服务路由'], ['prices', '成本版本']], prices: [['routes', '服务路由'], ['prices', '成本版本']],
  data: [['data', '连接与统计'], ['ledger', '资金流水'], ['audit', '操作审计']], audit: [['data', '连接与统计'], ['ledger', '资金流水'], ['audit', '操作审计']],
};
export default async function AdminSection({ params, searchParams }: { params: Promise<{ section: string }>; searchParams: Promise<{ page?: string; pageSize?: string; q?: string }> }) {
  const { section } = await params;
  const permission = section === 'settings' ? 'settings.write' : section === 'data' ? 'data.read' : adminView(section).permission;
  const current = await webAccount(permission);
  const title = section === 'settings' ? '系统设置' : section === 'data' ? '后端数据' : adminView(section).title;
  const active = ['wallets', 'ledger'].includes(section) ? 'orders' : ['roles', 'permissions'].includes(section) ? 'users' : section === 'tasks' ? 'usage' : section === 'prices' ? 'routes' : section === 'audit' ? 'data' : section;
  let content: React.ReactNode;
  if (section === 'settings') content = <SettingsPanel settings={await configuration()} credentials={credentialStatuses()} />;
  else if (section === 'data') {
    const overview = await databaseOverview();
    content = <div className="grid-two"><section className="panel"><h2>数据库健康状态</h2><div className="status-list"><div className="status-line"><span>连接状态</span><span className="tag success">正常</span></div><div className="status-line"><span>Schema</span><span className="mono">{overview.schema}</span></div><div className="status-line"><span>运行账户</span><span className="mono">{overview.runtimeRole}</span></div><div className="status-line"><span>迁移版本</span><span>{overview.migrationVersions}</span></div><div className="status-line"><span>检测时间</span><span>{new Date(overview.checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</span></div></div></section><section className="panel"><h2>数据管控</h2><p>用户、Key、订单、流水和调用明细可在对应菜单按条件查询与导出。管理操作记录在审计中。</p><div className="inline-actions"><Link className="button secondary" href="/admin/audit">操作审计</Link><Link className="button secondary" href="/admin/ledger">资金流水</Link></div><div className="notice neutral">数据库连接凭据通过服务器安全配置维护；资金流水与操作审计保留原始记录。</div></section></div>;
  } else {
    const query = await searchParams;
    const url = new URL(`http://local/?${new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))}`);
    const result = await adminRows(section, url);
    const exportQuery = new URLSearchParams({ format: 'csv', ...(result.q ? { q: result.q } : {}) });
    const safeRows = JSON.parse(JSON.stringify(result.rows)) as Record<string, unknown>[];
    content = <><section className="panel"><div className="panel-header"><form className="filters" style={{ marginBottom: 0 }}><input name="q" maxLength={120} defaultValue={result.q} placeholder={['users', 'wallets'].includes(section) ? '按邮箱搜索' : '输入名称或业务编号'} aria-label="查询条件" /><button className="button secondary">查询</button></form>{current.permissions.includes('data.export') && <a className="button secondary small" href={`/api/admin/data/${section}?${exportQuery}`}>导出 CSV</a>}</div><DataTable rows={result.rows} /><Pager path={`/admin/${section}`} page={result.page} pageSize={result.pageSize} total={result.total} q={result.q} />{result.total > 10000 && <p className="small-text muted">每次导出最多 10,000 条，请先筛选需要的数据。</p>}</section><AdminActions section={section} rows={safeRows} permissions={current.permissions} />{(section === 'routes' || section === 'prices') && current.permissions.includes('routes.write') && <GatewayPanel mode={section} rows={safeRows} />}</>;
  }
  return <Shell user={current.user} title={title} path={`/admin/${active}`} admin><PageHeader title={title} description={section === 'settings' ? '管理通用、认证、支付与计费配置，查看服务凭据配置状态。' : '查询平台业务数据，按权限执行管理操作。'} />{groups[section] && <nav className="tabs">{groups[section].map(([key, label]) => <Link className={section === key ? 'active' : ''} key={key} href={`/admin/${key}`}>{label}</Link>)}</nav>}{content}</Shell>;
}
