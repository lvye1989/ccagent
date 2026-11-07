import Link from 'next/link';

export function Pager({ path, page, pageSize, total, q = '', filters = {} }: { path: string; page: number; pageSize: number; total: number; q?: string; filters?: Partial<Record<string, string>> }) {
  const query = (value: number) => {
    const params = new URLSearchParams();
    for (const [key, entry] of Object.entries(filters)) if (entry) params.set(key, entry);
    if (q) params.set('q', q);
    params.set('page', String(value)); params.set('pageSize', String(pageSize));
    return `${path}?${params}`;
  };
  return <div className="pagination"><span>共 {total.toLocaleString('zh-CN')} 条 · 第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页</span><div className="pagination-actions">{page > 1 && <Link className="button secondary small" href={query(page - 1)}>上一页</Link>}{page * pageSize < total && <Link className="button secondary small" href={query(page + 1)}>下一页</Link>}</div></div>;
}
