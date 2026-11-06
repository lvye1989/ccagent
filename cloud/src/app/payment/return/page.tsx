import Link from 'next/link';
import { and, eq } from 'drizzle-orm';
import { webAccount, cny } from '@/core/web-account';
import { database } from '@/core/db';
import { orders } from '@/core/db/schema';

export const dynamic = 'force-dynamic';
export default async function PaymentReturn({ searchParams }: { searchParams: Promise<{ out_trade_no?: string }> }) {
  const current = await webAccount(), query = await searchParams;
  // Browser return only reads the local order. It never verifies payment or credits the wallet.
  const [order] = query.out_trade_no ? await database().db.select().from(orders).where(and(eq(orders.id, query.out_trade_no), eq(orders.userId, current.user.id))) : [];
  return <main className="auth-content" style={{ minHeight: '100vh' }}><section className="auth-card"><div className="eyebrow">CCAGENT / PAYMENT</div><h1>{order?.status === 'credited' ? '充值已入账' : '支付结果核验中'}</h1><p>{order?.status === 'credited' ? `${cny(order.amountFen * 10000n)} 已存入你的账户余额。` : '完成付款后，平台会核验交易并更新余额。你可以返回账户中心查看订单。'}</p><Link className="button full" href="/account/billing">查看余额与订单 →</Link></section></main>;
}
