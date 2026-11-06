import { and, eq, ilike, sql } from 'drizzle-orm';
import { Shell, PageHeader } from '@/components/shell';
import { DataTable } from '@/components/data-table';
import { Pager } from '@/components/pager';
import { webAccount } from '@/core/web-account';
import { database } from '@/core/db';
import { reservations } from '@/core/db/schema';
import { pagination } from '@/core/http';

export const dynamic = 'force-dynamic';
export default async function Usage({ searchParams }: { searchParams: Promise<{ page?: string; pageSize?: string; q?: string }> }) {
  const current = await webAccount(), query = await searchParams;
  const paging = pagination(new URL(`http://local/?${new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))}`));
  const q = (query.q || '').slice(0, 120), where = and(eq(reservations.userId, current.user.id), q ? ilike(reservations.taskId, `%${q}%`) : undefined);
  const rows = await database().db.select({ id: reservations.id, task_id: reservations.taskId, route_id: reservations.routeId, status: reservations.status,
    charged: reservations.charged, authorized: reservations.authorized, usage: reservations.usage, created_at: reservations.createdAt }).from(reservations).where(where)
    .orderBy(sql`${reservations.createdAt} desc`, reservations.id).limit(paging.pageSize).offset(paging.offset);
  const [total] = await database().db.select({ count: sql<number>`count(*)::integer` }).from(reservations).where(where);
  return <Shell user={current.user} title="使用明细" path="/account/usage" canAdmin={current.permissions.includes('admin.read')}><PageHeader title="使用明细" description="逐笔查看调用、任务归属与结算费用。金额以整数微元展示，1 元 = 1,000,000 微元。" /><section className="panel"><form className="filters"><input name="q" maxLength={120} placeholder="按任务编号搜索" defaultValue={q} aria-label="任务编号" /><button className="button secondary">查询</button></form><DataTable rows={rows} empty="服务使用后的调用记录会显示在这里。" /><Pager path="/account/usage" {...paging} total={total.count} q={q} /></section></Shell>;
}
