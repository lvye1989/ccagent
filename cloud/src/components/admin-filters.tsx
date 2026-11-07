import Link from 'next/link';
import { adminFilterDefinition, serviceChoices, type AdminFilterValues } from '@/core/admin-filters';
import { cny } from '@/core/web-account';

export function AdminFilters({ section, values, pageSize = 20, exportHref }: { section: string; values: AdminFilterValues; pageSize?: number; exportHref?: string }) {
  const definition = adminFilterDefinition(section), has = (key: keyof AdminFilterValues) => definition.fields.includes(key);
  const dateName = section === 'wallets' || section === 'routes' ? '更新时间' : section === 'prices' ? '生效时间' : '创建时间';
  const sizes = [...new Set([10, 20, 50, 100, pageSize])].sort((a, b) => a - b);
  return <form method="get" className="admin-filters"><div className="admin-filter-fields">
    <label className="field">关键词<input name="q" type="search" maxLength={120} defaultValue={values.q || ''} placeholder={definition.placeholder} /></label>
    {has('user') && <label className="field">{section === 'audit' ? '操作人邮箱或编号' : '用户邮箱或编号'}<input name="user" maxLength={320} defaultValue={values.user || ''} placeholder="邮箱片段或完整用户编号" /></label>}
    {has('from') && <label className="field">开始日期<input name="from" type="date" defaultValue={values.from || ''} max={values.to || '9999-12-31'} /></label>}
    {has('to') && <label className="field">结束日期<input name="to" type="date" defaultValue={values.to || ''} min={values.from || '0001-01-01'} max="9999-12-31" /></label>}
    {has('status') && <label className="field">状态<select name="status" defaultValue={values.status || ''}><option value="">全部状态</option>{definition.statuses?.map(([value, name]) => <option value={value} key={value}>{name}</option>)}</select></label>}
    {has('service') && <label className="field">服务类型<select name="service" defaultValue={values.service || ''}><option value="">全部服务</option>{serviceChoices.map(([value, name]) => <option value={value} key={value}>{name}</option>)}</select></label>}
    {has('route') && <label className="field">服务编号<input name="route" maxLength={80} defaultValue={values.route || ''} placeholder="完整服务编号" /></label>}
    {has('task') && <label className="field">任务编号<input name="task" maxLength={200} defaultValue={values.task || ''} placeholder="完整任务编号" /></label>}
    {has('overdue') && <label className="field">处理时限<select name="overdue" defaultValue={values.overdue || ''}><option value="">全部调用</option><option value="true">到期待处理</option></select></label>}
    <label className="field">每页条数<select name="pageSize" defaultValue={pageSize}>{sizes.map(size => <option value={size} key={size}>{size} 条</option>)}</select></label>
  </div>{has('from') && <p className="small-text admin-filter-note">{section === 'tasks' ? '先筛选调用，再汇总任务费用。' : `${dateName}按筛选日期查询。`}日期按北京时间，包含结束日期当天；金额合计覆盖全部筛选结果。</p>}
    <div className="admin-filter-actions"><button className="button secondary">查询</button><Link className="text-button" href={`/admin/${section}`}>清除筛选</Link>{exportHref && <a className="button secondary small admin-filter-export" href={exportHref}>导出当前筛选 CSV</a>}</div>
  </form>;
}

const summaryNames: Record<string, string> = { balance: '账户余额', frozen: '冻结金额', amount_fen: '订单金额', amount: '申请退款金额', charged: '调用费用', authorized: '授权额度', calls: '调用次数', balance_delta: '余额变动', frozen_delta: '冻结变动' };
export function AdminSummary({ values }: { values: Record<string, string> }) {
  if (!Object.keys(values).length) return null;
  return <section className="admin-filter-summary" aria-label="筛选结果汇总">{Object.entries(values).map(([key, value]) => <span key={key}><span className="muted">{summaryNames[key] || key}合计</span><strong>{key === 'calls' ? BigInt(value).toLocaleString('zh-CN') : cny(key === 'amount_fen' ? BigInt(value) * 10000n : value)}</strong></span>)}</section>;
}
