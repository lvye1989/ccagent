'use client';
import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { formatMicroYuan, parseYuanToMicro } from '@/core/money-display';

const names: Record<string, string> = { users: '管理用户', keys: '管理 Key', wallets: '调整账户余额', orders: '核验订单与退款', refunds: '核对未知退款结果' };
export function AdminActions({ section, rows, permissions }: { section: string; rows: Record<string, unknown>[]; permissions: string[] }) {
  const router = useRouter(), [action, setAction] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const last = useRef<{ body: string; id: string } | null>(null);
  const options = section === 'users' ? [['disable', 'users.write', '禁用账户并撤销会话'], ['enable', 'users.write', '恢复账户'], ['grant', 'roles.write', '授予管理员角色'], ['remove', 'roles.write', '移除管理员角色'],
    ['credit', 'wallets.write', '增加余额'], ['debit', 'wallets.write', '扣减余额'], ['set-balance', 'wallets.write', '设置目标余额']]
    : section === 'keys' ? [['revoke', 'keys.write', '撤销 Key'], ['limit', 'keys.write', '调整累计额度']]
    : section === 'wallets' ? [['credit', 'wallets.write', '增加余额'], ['debit', 'wallets.write', '扣减余额'], ['set-balance', 'wallets.write', '设置目标余额']]
    : section === 'orders' ? [['reconcile', 'orders.read', '主动查单并核验入账'], ['refund', 'refunds.write', '发起原订单全额退款']]
    : section === 'refunds' ? [['success', 'refunds.write', '凭渠道退款凭据确认成功'], ['rejected', 'refunds.write', '凭渠道核验结果确认失败']] : [];
  const allowed = options.filter(([, permission]) => permissions.includes(permission));
  const selectedAction = allowed.some(([value]) => value === action) ? action : '';
  if (!allowed.length || !rows.length) return null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(''); setError('');
    if (!selectedAction) { setError('请选择执行操作。'); setBusy(false); return; }
    const form = new FormData(event.currentTarget), id = String(form.get('id') || ''), reason = String(form.get('reason') || '').trim(), amount = String(form.get('amount') || '').trim();
    let micro: string | null = null;
    if (['credit', 'debit', 'set-balance', 'limit'].includes(selectedAction)) {
      try { if (amount || selectedAction !== 'limit') micro = parseYuanToMicro(amount, { maxMicro: 9_000_000_000_000_000n }); }
      catch (error) { setError(error instanceof Error ? error.message : '请输入有效的人民币金额。'); setBusy(false); return; }
    }
    let url = '', method = 'POST', payload: Record<string, unknown> = {};
    if (['users', 'wallets'].includes(section) && ['credit', 'debit', 'set-balance'].includes(selectedAction)) {
      if (micro === null || (micro === '0' && selectedAction !== 'set-balance')) { setError('增加或扣减金额必须大于零。'); setBusy(false); return; }
      url = '/api/admin/wallets/adjust'; payload = { userId: id,
        ...(selectedAction === 'set-balance' ? { targetBalance: micro } : { delta: selectedAction === 'debit' ? `-${micro}` : micro }), reason };
      const body = JSON.stringify(payload);
      if (!last.current || last.current.body !== body) last.current = { body, id: crypto.randomUUID() };
      payload.idempotencyKey = last.current.id;
    } else if (section === 'users') {
      url = `/api/admin/users/${encodeURIComponent(id)}`; method = 'PUT';
      const row = rows.find(row => String(row.id) === id), roles = Array.isArray(row?.roles) ? row.roles.filter((item): item is string => typeof item === 'string') : ['user'];
      payload = ['disable', 'enable'].includes(selectedAction) ? { action: 'status', banned: selectedAction === 'disable', reason }
        : { action: 'roles', roles: selectedAction === 'grant' ? [...new Set([...roles, 'admin'])] : roles.filter(role => role !== 'admin') };
    } else if (section === 'keys') {
      url = `/api/admin/keys/${encodeURIComponent(id)}`; method = 'PUT'; payload = selectedAction === 'revoke' ? { action: 'revoke' } : { action: 'limit', limit: micro };
    } else if (section === 'orders') {
      url = selectedAction === 'refund' ? '/api/admin/refunds' : '/api/admin/orders/reconcile';
      payload = selectedAction === 'refund' ? { orderId: id, reason } : { orderId: id };
    } else {
      url = '/api/admin/refunds'; method = 'PUT'; payload = { refundId: id, outcome: selectedAction, evidence: reason };
    }
    try {
      const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json() as { message?: string; status?: string; refund?: { status: string }; changed?: boolean; replayed?: boolean; balance?: string };
      if (!response.ok) throw new Error(result.message || '操作未完成，请重试。');
      const status = result.refund?.status || result.status;
      const description: Record<string, string> = { credited: '充值已入账', pending: '结果待核验，请保留冻结额度并核对渠道记录', success: '退款成功', rejected: '退款已明确失败，冻结额度已释放', submitting: '退款正在提交，请稍后核对', refunded: '订单已退款', refunding: '退款处理中' };
      setMessage(result.replayed ? '已确认原操作结果，余额未重复调整。' : result.changed === false ? '原余额已是目标余额，未产生资金变动。'
        : result.balance !== undefined ? `余额已调整，该笔操作后总余额为 ¥${formatMicroYuan(result.balance)}。` : status ? description[status] || `操作完成，当前状态：${status}` : '操作已保存。');
      last.current = null; router.refresh();
    } catch (error) { setError(error instanceof Error ? error.message : '网络连接失败，请稍后核对结果。'); }
    finally { setBusy(false); }
  }
  const needsReason = section === 'wallets' || section === 'refunds' || ['disable', 'enable', 'refund', 'credit', 'debit', 'set-balance'].includes(selectedAction);
  return <section className="panel"><h2>{names[section]}</h2><form className="form-stack" onSubmit={submit}><div className="form-row"><label className="field">操作对象<select name="id" defaultValue="" required disabled={busy}><option value="" disabled>请选择操作对象</option>{rows.map(row => <option value={String(row.id || row.user_id)} key={String(row.id || row.user_id)}>{String(row.email || row.name || row.order_id || row.id)}{row.prefix ? ` · ${row.prefix}…` : ''}{row.status ? ` · ${row.status}` : ''}</option>)}</select></label><label className="field">执行操作<select value={selectedAction} required onChange={event => { setAction(event.target.value); setMessage(''); setError(''); }} disabled={busy}><option value="" disabled>请选择执行操作</option>{allowed.map(([value, , label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    {['credit', 'debit', 'set-balance', 'limit'].includes(selectedAction) && <label className="field">{selectedAction === 'limit' ? '累计额度（元；留空表示不单独限制）' : selectedAction === 'set-balance' ? '目标总余额（元）' : '调整金额（元）'}<input name="amount" inputMode="decimal" maxLength={24} required={selectedAction !== 'limit'} disabled={busy} /><small>{selectedAction === 'set-balance' ? '可设为 0。总余额包含冻结部分，目标不能低于当前冻结金额。' : '人民币元，最多 6 位小数。'}{['credit', 'debit'].includes(selectedAction) && ' 冻结金额不能扣减。'}</small></label>}
    {needsReason && <label className="field">{section === 'refunds' ? '渠道核验凭据与结果说明' : '操作原因'}<textarea name="reason" required minLength={section === 'refunds' ? 10 : 5} maxLength={section === 'refunds' ? 300 : 200} disabled={busy} /><small>{section === 'refunds' ? '填写退款核验凭据编号与结论，避免包含密钥和付款人隐私。支付成功状态不能证明退款成功。' : '此操作会记录操作人、时间和处理结果。'}</small></label>}
    {selectedAction === 'refund' && <div className="notice neutral">将冻结所选原订单的全额充值金额。网络超时或结果不明时保留冻结，需核对退款渠道凭据后处理。</div>}
    {message && <div className="notice" role="status">{message}</div>}{error && <div className="notice error" role="alert">{error}</div>}<div><button className="button" disabled={busy || !selectedAction}>{busy ? '正在处理…' : allowed.find(([value]) => value === selectedAction)?.[2] || '执行所选操作'}</button></div></form></section>;
}
