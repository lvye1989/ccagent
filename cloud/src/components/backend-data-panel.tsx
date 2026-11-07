import Link from 'next/link';
import type { databaseOverview } from '@/core/admin-data';
import { cny } from '@/core/web-account';
import { DataTable } from './data-table';

type Overview = Awaited<ReturnType<typeof databaseOverview>>;
const metrics = [
  ['users', '用户', '/admin/users', 'admin.read'], ['keys', '个人 Key', '/admin/keys', 'keys.write'], ['orders', '充值订单', '/admin/orders', 'orders.read'],
  ['refunds', '退款申请', '/admin/refunds', 'refunds.write'], ['calls', '服务调用', '/admin/usage', 'usage.read'], ['tasks', '用户任务', '/admin/tasks', 'usage.read'],
  ['ledger', '资金流水', '/admin/ledger', 'data.read'], ['audit', '操作审计', '/admin/audit', 'data.read'], ['routes', '服务路由', '/admin/routes', 'admin.read'],
  ['prices', '成本版本', '/admin/prices', 'admin.read'], ['files', '临时文件记录', '', ''],
] as const;
function date(value: Date | string) { return (value instanceof Date ? value : new Date(value)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); }
export function BackendDataPanel({ overview, permissions }: { overview: Overview; permissions: readonly string[] }) {
  const { structure, counts } = overview;
  const migration = structure.migrations.state === 'current' ? '已同步' : structure.migrations.state === 'pending' ? '待升级' : '需核对';
  return <>{!structure.ready && <div className="notice error" role="alert">数据结构需要核对：迁移{migration}，必需表 {structure.tables.actual} / {structure.tables.expected}。
    {!!structure.tables.missing.length && <>缺少：{structure.tables.missing.join('、')}。</>}{!!structure.tables.unexpected && <>另有 {structure.tables.unexpected} 张未纳入版本的数据表。</>}
    请通过服务端迁移与权限检查处理。</div>}
    <div className="grid-two"><section className="panel"><h2>数据库健康状态</h2><div className="status-list">
      <div className="status-line"><span>连接状态</span><span className="tag success">正常</span></div>
      <div className="status-line"><span>Schema</span><span className="mono">{overview.schema}</span></div>
      <div className="status-line"><span>运行账户</span><span className="mono">{overview.runtimeRole}</span></div>
      <div className="status-line"><span>迁移版本</span><span>{overview.migrationVersions} / {structure.migrations.expected} · {migration}</span></div>
      <div className="status-line"><span>必需数据表</span><span>{structure.tables.actual} / {structure.tables.expected}</span></div>
      <div className="status-line"><span>检测时间</span><span>{date(overview.checkedAt)}</span></div>
    </div></section><section className="panel"><h2>维护与资金状态</h2><div className="status-list">
      <div className="status-line"><span>账户余额合计</span><span>{counts ? cny(counts.balance) : '暂不可读取'}</span></div>
      <div className="status-line"><span>冻结金额合计</span><span>{counts ? cny(counts.frozen) : '暂不可读取'}</span></div>
      <div className="status-line"><span>最近维护记录</span><span>{!overview.lastMaintenanceChecked ? '暂不可读取' : overview.lastMaintenance ? date(overview.lastMaintenance.at) : '尚无执行记录'}</span></div>
      {overview.lastMaintenance && <div className="status-line"><span>最近执行结果</span><span>{overview.lastMaintenance.result === 'success' ? '返回成功' : overview.lastMaintenance.result === 'partial' ? '部分任务失败' : '需核对'}</span></div>}
    </div><p className="small-text admin-filter-note">待处理业务请结合下方记录核对。维护记录通过独立系统身份写入。</p><div className="inline-actions"><Link className="button secondary small" href="/admin/audit?q=system.maintenance">维护审计</Link><Link className="button secondary small" href="/admin/ledger">资金流水</Link></div></section></div>
    <section className="panel"><h2>业务数据数量</h2><div className="backend-counts">{metrics.map(([key, label, href, permission]) => {
      const body = <><span className="muted">{label}</span><strong>{counts?.[key] === undefined ? '暂不可读取' : BigInt(counts[key]).toLocaleString('zh-CN')}</strong></>;
      return href && permissions.includes(permission) ? <Link className="backend-count" href={href} key={key}>{body}</Link> : <div className="backend-count" key={key}>{body}</div>;
    })}</div><p className="small-text admin-filter-note">任务按用户与任务编号分组；已删除的临时文件不计入当前记录。启用中的 Key：{counts?.active_keys ?? '暂不可读取'}，开放路由：{counts?.enabled_routes ?? '暂不可读取'}。</p></section>
    {overview.pending.orders && <section className="panel"><div className="panel-header"><h2>待完成充值订单 · {counts?.pending_orders}</h2><Link className="text-button" href="/admin/orders?status=pending">查看全部 →</Link></div><DataTable rows={overview.pending.orders} empty="没有待完成订单。" /><p className="small-text admin-filter-note">按创建时间展示最早的 5 条，入账以服务端查单结果为准。</p></section>}
    {overview.pending.refunds && <section className="panel"><div className="panel-header"><h2>待处理退款 · {counts?.pending_refunds}</h2><div className="inline-actions"><Link className="text-button" href="/admin/refunds?status=held">已冻结</Link><Link className="text-button" href="/admin/refunds?status=submitting">提交中</Link><Link className="text-button" href="/admin/refunds?status=pending">待核对 →</Link></div></div><DataTable rows={overview.pending.refunds} empty="没有待处理退款。" /><p className="small-text admin-filter-note">展示最早的 5 条。结果不明的退款需核对渠道凭据后处理。</p></section>}
    {overview.pending.usage && <section className="panel"><div className="panel-header"><h2>到期待处理调用 · {counts?.overdue_calls}</h2><Link className="text-button" href="/admin/usage?overdue=true">查看全部 →</Link></div><DataTable rows={overview.pending.usage} empty="没有到期待处理调用。" /><p className="small-text admin-filter-note">按核对期限展示最早的 5 条；进行中及待对账调用共 {counts?.pending_calls} 条。未核实用量的冻结由维护任务按既定规则处理。</p></section>}
    <div className="notice neutral">连接凭据通过服务器安全配置维护；资金流水与操作审计保留原始记录。此页只读取状态。</div>
  </>;
}
