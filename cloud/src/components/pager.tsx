import Link from 'next/link';

export function Pager({ path, page, pageSize, total, q = '' }: { path: string; page: number; pageSize: number; total: number; q?: string }) {
  const query = (value: number) => `${path}?${new URLSearchParams({ page: String(value), pageSize: String(pageSize), ...(q ? { q } : {}) })}`;
  return <div className="pagination"><span>共 {total.toLocaleString('zh-CN')} 条 · 第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页</span><div className="pagination-actions">{page > 1 && <Link className="button secondary small" href={query(page - 1)}>上一页</Link>}{page * pageSize < total && <Link className="button secondary small" href={query(page + 1)}>下一页</Link>}</div></div>;
}
