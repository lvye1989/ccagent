'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { CredentialStatuses } from '@/core/configuration';
import { formatFenYuan, parseYuanToMicro } from '@/core/money-display';

type Entry = { key: string; value: unknown; version: number; source: string; readonly: boolean };
const descriptions: Record<string, [string, string]> = {
  support_email: ['客服邮箱', '在用户需要协助时提供的联系邮箱。'], payment_enabled: ['开放余额充值', '启用前请确认支付商户、回调和对账均已验证。'],
  recharge_min_fen: ['单笔最低充值（元）', '以人民币元填写，最多保留 2 位小数。'], recharge_max_fen: ['单笔最高充值（元）', '与最低充值额共同限制可提交金额。'],
  settlement_usd_cny: ['美元结算汇率', '人民币 / 美元。留空时不开放需要美元换算的服务。'],
};
const groups = [['general', '通用'], ['authentication', '认证'], ['payment', '支付'], ['email', '邮箱'], ['storage', '存储'], ['ai', 'AI 服务'], ['backend', '后端数据'], ['billing', '余额与计费']];
const rechargeFields = new Set(['recharge_min_fen', 'recharge_max_fen']);
function rechargeFen(value: string) {
  const micro = BigInt(parseYuanToMicro(value, { maxMicro: 10_000_000_000n }));
  if (micro < 10000n || micro % 10000n !== 0n) throw new Error('充值金额须为 0.01 至 10000 元，最多保留 2 位小数。');
  return Number(micro / 10000n);
}
function Status({ value, valid = true }: { value: boolean; valid?: boolean }) { return <span className={`tag ${value && valid ? 'success' : ''}`}>{!valid ? '配置无效' : value ? '已配置' : '未配置'}</span>; }
export function SettingsPanel({ settings, credentials, canManageGateway = false, canReadBackend = false }: { settings: Entry[]; credentials: CredentialStatuses; canManageGateway?: boolean; canReadBackend?: boolean }) {
  const router = useRouter(), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(''); setError('');
    const form = new FormData(event.currentTarget);
    try {
      const changes = settings.filter(item => !item.readonly).map(item => ({ key: item.key, version: item.version,
        value: rechargeFields.has(item.key) ? rechargeFen(String(form.get(item.key) || '')) : typeof item.value === 'boolean' ? form.get(item.key) === 'true' : typeof item.value === 'number' ? Number(form.get(item.key)) : String(form.get(item.key) || '').trim() })).filter(change => change.value !== settings.find(item => item.key === change.key)?.value);
      if (!changes.length) { setMessage('当前设置未发生变化。'); return; }
      const response = await fetch('/api/admin/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes }) });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message || '保存失败。');
      setMessage('设置已保存，将从下一次请求开始生效。'); router.refresh();
    } catch (error) { setError(error instanceof Error ? error.message : '网络连接失败。'); }
    finally { setBusy(false); }
  }
  function fields(keys: string[]) {
    return settings.filter(item => keys.includes(item.key)).map(item => <label className="setting-row" key={`${item.key}-${item.version}`}><div className="setting-label"><strong>{descriptions[item.key]?.[0] || item.key}</strong><p>{descriptions[item.key]?.[1]}</p><span className="tag">{item.source === 'environment' ? '环境变量 · 只读' : item.source === 'database' ? `数据库 · v${item.version}` : '默认值'}</span></div>{typeof item.value === 'boolean' ? <select name={item.key} defaultValue={String(item.value)} disabled={item.readonly || busy}><option value="false">关闭</option><option value="true">开启</option></select> : <input name={item.key} type={typeof item.value === 'number' ? 'number' : item.key === 'support_email' ? 'email' : 'text'} defaultValue={rechargeFields.has(item.key) ? formatFenYuan(Number(item.value)) : String(item.value)} disabled={item.readonly || busy} maxLength={320} min={typeof item.value === 'number' ? rechargeFields.has(item.key) ? '0.01' : 1 : undefined} step={rechargeFields.has(item.key) ? '0.01' : undefined} max={rechargeFields.has(item.key) ? '10000' : undefined} required={typeof item.value === 'number'} />}</label>);
  }
  return <><nav className="tabs" aria-label="设置分组">{groups.map(([id, name]) => <a key={id} href={`#settings-${id}`}>{name}</a>)}</nav><form onSubmit={save}>
    <div className="grid-two">
      <section className="panel settings-group" id="settings-general"><h2>通用</h2>{fields(['support_email'])}</section>
      <section className="panel settings-group" id="settings-authentication"><h2>认证</h2><div className="status-list"><div className="status-line"><span>邮箱密码登录</span><span className="tag success">必选</span></div><div className="status-line"><span>注册邮箱验证</span><span className="tag success">必选</span></div><div className="status-line"><span>认证密钥</span><Status value={credentials.auth} /></div></div><p className="small-text admin-filter-note">账户、会话与权限由服务端验证。认证策略通过受控发布维护。</p></section>
      <section className="panel settings-group" id="settings-payment"><h2>支付</h2>{fields(['payment_enabled', 'recharge_min_fen', 'recharge_max_fen'])}<hr className="divider" /><div className="status-list">
        <div className="status-line"><span>七支付接口</span><span className="mono config-value">{credentials.payment.baseUrl || '配置无效'}</span></div>
        <div className="status-line"><span>接口来源</span><span className="tag">{credentials.payment.baseUrlSource === 'environment' ? '环境变量' : '默认值'} · 只读</span></div>
        <div className="status-line"><span>商户编号</span><Status value={credentials.payment.merchantConfigured} /></div><div className="status-line"><span>商户密钥</span><Status value={credentials.payment.keyConfigured} /></div>
        <div className="status-line"><span>支付方式</span><span>支付宝</span></div><div className="status-line"><span>可选渠道编号</span><Status value={credentials.payment.channelIdConfigured} valid={credentials.payment.channelIdValid} /></div>
        <div className="status-line"><span>异步通知地址</span><span className="mono config-value">{credentials.payment.notifyUrl || '需要有效 HTTPS 服务地址'}</span></div><div className="status-line"><span>浏览器返回地址</span><span className="mono config-value">{credentials.payment.returnUrl || '需要有效 HTTPS 服务地址'}</span></div>
      </div><p className="small-text admin-filter-note">回调地址由当前认证服务地址生成。商户、网关及渠道配置通过服务端安全渠道维护。</p></section>
      <section className="panel settings-group" id="settings-email"><h2>邮箱</h2><div className="status-list"><div className="status-line"><span>Resend 发信凭据</span><Status value={credentials.email} /></div><div className="status-line"><span>发信域名</span><span className="mono config-value">{credentials.emailDomain || '发信地址需要核对'}</span></div><div className="status-line"><span>邮件用途</span><span className="config-value">注册验证、密码找回</span></div></div><p className="small-text admin-filter-note">邮件接收与重置流程按真实收信结果验收，域名及发信地址通过服务器配置维护。</p></section>
      <section className="panel settings-group" id="settings-storage"><h2>存储</h2><div className="status-list"><div className="status-line"><span>文件服务凭据</span><Status value={credentials.storage.configured} /></div><div className="status-line"><span>访问方式</span><span>私有临时文件</span></div></div><p className="small-text admin-filter-note">上传、读取和清理校验账户归属。完整工作区与对话继续由本地应用管理。</p></section>
      <section className="panel settings-group" id="settings-ai"><h2>AI 服务</h2><div className="status-line"><span>服务端凭据配置项</span><span>{credentials.providers.configuredCount} 项</span></div><p className="small-text admin-filter-note">主模型、读图、Jev、搜索和语音分别管理协议与价格。服务开放条件在路由中核对。</p>{canManageGateway && <div className="inline-actions"><Link className="button secondary small" href="/admin/routes">服务网关</Link><Link className="button secondary small" href="/admin/prices">成本版本</Link></div>}</section>
      <section className="panel settings-group" id="settings-backend"><h2>后端数据</h2><div className="status-list"><div className="status-line"><span>数据库凭据</span><Status value={credentials.database} /></div><div className="status-line"><span>数据库</span><span>Supabase PostgreSQL</span></div><div className="status-line"><span>Schema</span><span className="mono config-value">{credentials.backend.schema}</span></div><div className="status-line"><span>单实例连接上限</span><span>{credentials.backend.maxConnections}</span></div></div>{canReadBackend && <div className="inline-actions admin-filter-note"><Link className="button secondary small" href="/admin/data">健康状态与业务待办</Link></div>}</section>
      <section className="panel settings-group" id="settings-billing"><h2>余额与计费</h2>{fields(['settlement_usd_cny'])}<div className="status-line"><span>收费倍率</span><span>{credentials.markup} × 供应商成本</span></div><p className="small-text admin-filter-note">账户余额与费用统一以人民币元展示，最多保留 6 位小数。服务价格、倍率及汇率随调用保存版本，历史费用保留原值。</p></section>
    </div><section className="panel">{message && <div className="notice" role="status">{message}</div>}{error && <div className="notice error" role="alert">{error}</div>}<button className="button" disabled={busy}>{busy ? '正在保存…' : '保存设置'}</button><p className="small-text admin-filter-note">此表单保存通用、支付与计费的可编辑字段。凭据仅显示配置状态，实际连通及业务状态按对应验收结果核对。</p></section>
  </form></>;
}
