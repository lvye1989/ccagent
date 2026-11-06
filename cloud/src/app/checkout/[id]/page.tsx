import Link from 'next/link';
import { and, eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { Brand } from '@/components/brand';
import { cny, webAccount } from '@/core/web-account';
import { database } from '@/core/db';
import { orders } from '@/core/db/schema';
import { paymentService } from '@/core/payments';

export const dynamic = 'force-dynamic';
export default async function Checkout({ params }: { params: Promise<{ id: string }> }) {
  const current = await webAccount(), { id } = await params;
  const [order] = await database().db.select().from(orders).where(and(eq(orders.id, id), eq(orders.userId, current.user.id)));
  if (!order) notFound();
  const payable = order.status === 'pending', checkout = payable ? paymentService().checkout(order) : null;
  return <main className="auth-content" style={{ minHeight: '100vh' }}><section className="auth-card"><Brand /><hr className="divider" /><div className="eyebrow">SECURE CHECKOUT</div><h1>{payable ? '确认充值' : '订单状态'}</h1><p>CCAGENT API 服务余额充值</p><div className="stat accent"><div className="stat-label">{payable ? '应付金额' : '订单金额'}</div><div className="stat-value">{cny(order.amountFen * 10000n)}</div><div className="stat-footnote">人民币 · 支付宝</div></div><div className="notice neutral"><div>充值账户：{current.user.email}</div><div className="mono">订单编号：{order.id}</div></div>
    {checkout ? <form action={checkout.action} method="POST">{Object.entries(checkout.fields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}<button type="submit" className="button full">前往支付宝收银台 →</button><p className="small-text" style={{ marginTop: 16 }}>完成支付后返回账户中心查看余额。入账状态以平台核验结果为准。</p></form> : <div className="notice">{order.status === 'credited' ? '充值已入账。' : order.status === 'refunded' ? '该订单已退款。' : '该订单正在处理退款，请查看账户记录。'}</div>}<Link className="text-button small-text" href="/account/billing">← 返回余额与充值</Link></section></main>;
}
