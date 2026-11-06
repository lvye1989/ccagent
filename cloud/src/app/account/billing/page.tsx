import { eq, sql } from 'drizzle-orm';
import { Shell, PageHeader } from '@/components/shell';
import { DataTable } from '@/components/data-table';
import { Pager } from '@/components/pager';
import { RechargeForm } from '@/components/recharge-form';
import { cny, webAccount } from '@/core/web-account';
import { walletFor, walletLedger } from '@/core/wallet';
import { database } from '@/core/db';
import { orders } from '@/core/db/schema';
import { pagination } from '@/core/http';
import { configurationValues } from '@/core/configuration';

export const dynamic = 'force-dynamic';
export default async function Billing({ searchParams }: { searchParams: Promise<{ page?: string; pageSize?: string }> }) {
  const current = await webAccount(), query = await searchParams;
  const paging = pagination(new URL(`http://local/?${new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))}`));
  const [wallet, entries] = await Promise.all([walletFor(current.user.id), walletLedger(current.user.id, paging.offset, paging.pageSize)]);
  const config = await configurationValues();
  const recentOrders = await database().db.select({ id: orders.id, amount_fen: orders.amountFen, status: orders.status, created_at: orders.createdAt, credited_at: orders.creditedAt })
    .from(orders).where(eq(orders.userId, current.user.id)).orderBy(sql`${orders.createdAt} desc`).limit(20);
  const [{ count }] = await database().db.execute<{ count: number }>(sql`select count(*)::integer as count from ${sql.identifier(process.env.DB_SCHEMA || 'ccagent')}.ledger where user_id = ${current.user.id}`);
  return <Shell user={current.user} title="余额与充值" path="/account/billing" canAdmin={current.permissions.includes('admin.read')}><PageHeader title="余额与充值" description="管理人民币预付余额，核对充值订单与资金流水。" /><div className="stats"><div className="stat accent"><div className="stat-label">可用余额</div><div className="stat-value">{cny(wallet.available)}</div></div><div className="stat"><div className="stat-label">账户余额</div><div className="stat-value">{cny(wallet.balance)}</div></div><div className="stat"><div className="stat-label">冻结额度</div><div className="stat-value">{cny(wallet.frozen)}</div></div></div>
    <section className="panel"><h2>充值余额</h2><RechargeForm enabled={config.payment_enabled && !!process.env.ZPAY_PID && !!process.env.ZPAY_KEY} minFen={config.recharge_min_fen} maxFen={config.recharge_max_fen} /></section>
    <section className="panel"><h2>最近充值订单</h2><DataTable rows={recentOrders} empty="充值订单将显示在这里。" /></section>
    <section className="panel"><h2>资金流水</h2><DataTable rows={entries.map(entry => ({ id: entry.id, kind: entry.kind, balance_delta: entry.balanceDelta, frozen_delta: entry.frozenDelta, balance_after: entry.balanceAfter, frozen_after: entry.frozenAfter, created_at: entry.createdAt }))} /><Pager path="/account/billing" {...paging} total={count} /></section></Shell>;
}
