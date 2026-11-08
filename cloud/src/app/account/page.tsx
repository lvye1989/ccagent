import Link from 'next/link';
import { Shell, PageHeader } from '@/components/shell';
import { cny, webAccount } from '@/core/web-account';
import { walletFor, walletLedger } from '@/core/wallet';

export const dynamic = 'force-dynamic';
export default async function Account() {
  const current = await webAccount();
  const [wallet, entries] = await Promise.all([walletFor(current.user.id), walletLedger(current.user.id, 0, 5)]);
  return <Shell user={current.user} title="账户概览" path="/account" canAdmin={current.permissions.includes('admin.read')}><PageHeader title="账户概览" description={`你好，${current.user.name || 'CCAGENT 用户'}。在这里管理服务与每一笔用量。`}><Link href="/account/keys" className="button secondary">管理 API Key</Link><Link href="/account/billing" className="button">余额与充值 →</Link></PageHeader>
    <div className="stats"><div className="stat accent"><div className="stat-label">可用余额</div><div className="stat-value">{cny(wallet.available)}</div><div className="stat-footnote">人民币预付余额</div></div><div className="stat"><div className="stat-label">账户总余额</div><div className="stat-value">{cny(wallet.balance)}</div><div className="stat-footnote">包含进行中调用的授权额度</div></div><div className="stat"><div className="stat-label">暂时冻结</div><div className="stat-value">{cny(wallet.frozen)}</div><div className="stat-footnote">调用结算后释放未使用的部分</div></div></div>
    <section className="panel"><div className="panel-header"><h2>最近资金变动</h2><Link className="text-button small-text" href="/account/billing">查看全部 →</Link></div>{entries.length ? <div className="table-wrap"><table><thead><tr><th>时间</th><th>类型</th><th>余额变动</th><th>变动后余额</th></tr></thead><tbody>{entries.map(entry => <tr key={entry.id}><td>{entry.createdAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</td><td>{({ recharge: '充值入账', authorization: '调用授权', settlement: '调用结算', release: '授权释放', adjustment: '余额调整', refund_hold: '退款冻结', refund: '退款扣减', refund_release: '退款释放' } as Record<string, string>)[entry.kind] || entry.kind}</td><td>{cny(entry.balanceDelta)}</td><td>{cny(entry.balanceAfter)}</td></tr>)}</tbody></table></div> : <div className="empty"><strong>还没有资金记录</strong>充值与服务使用产生的变动会显示在这里。</div>}</section>
  </Shell>;
}
