import * as React from 'react';

const labels: Record<string, string> = {
  id: '编号', name: '名称', email: '邮箱', email_verified: '邮箱已验证', banned: '已禁用', roles: '角色', created_at: '创建时间',
  user_id: '用户编号', actor_id: '操作人', prefix: 'Key 前缀', enabled: '已启用', limit: '累计额度（微元）', spent: '已使用（微元）', frozen: '冻结（微元）',
  balance: '余额（微元）', updated_at: '更新时间', revoked_at: '撤销时间', amount_fen: '充值金额（分）', amount: '金额（微元）',
  status: '状态', trade_no: '支付交易号', channel: '渠道', credited_at: '入账时间', order_id: '订单编号', initiated_by: '发起人', reason: '原因',
  key_id: 'Key 编号', route_id: '服务编号', task_id: '任务编号', authorized: '授权（微元）', charged: '费用（微元）', usage: '计量用量', calls: '调用次数', latest_at: '最近调用',
  reference: '业务引用', kind: '类型', balance_delta: '余额变动（微元）', frozen_delta: '冻结变动（微元）', balance_after: '变动后余额（微元）', frozen_after: '变动后冻结（微元）',
  action: '操作', object_id: '对象', result: '结果', metadata: '记录信息', reconcile_at: '核对期限', executed_route_id: '实际执行路由', fallback_used: '使用备用', service: '服务类型', protocol: '接口协议', provider: '供应商', base_url: '接口地址',
  upstream_model: '上游模型', credential_env: '凭据配置项', timeout_ms: '超时（毫秒）', retries: '重试次数', version: '版本', currency: '成本币种', components: '成本单价', fx: '结算汇率', markup: '收费倍率', source_url: '公开价格来源', effective_at: '生效时间',
};
const dateColumns = new Set(['created_at', 'updated_at', 'revoked_at', 'credited_at', 'latest_at', 'effective_at', 'reconcile_at']);
const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function content(key: string, value: unknown) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? dateFormat.format(value) : String(value);
  if (typeof value === 'string' && dateColumns.has(key) && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(value)) {
    const parsed = new Date(value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
    if (Number.isFinite(parsed.getTime())) return dateFormat.format(parsed);
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
export function DataTable({ rows, empty = '当前没有记录。' }: { rows: Record<string, unknown>[]; empty?: string }) {
  if (!rows.length) return <div className="empty"><strong>暂无记录</strong>{empty}</div>;
  const columns = Object.keys(rows[0]);
  return <div className="table-wrap"><table><thead><tr>{columns.map(key => <th key={key}>{labels[key] || key}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.id || `${row.user_id}-${row.task_id}-${index}`)}>{columns.map(key => <td key={key} title={content(key, row[key])}>{content(key, row[key])}</td>)}</tr>)}</tbody></table></div>;
}
