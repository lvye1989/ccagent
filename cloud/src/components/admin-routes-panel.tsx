'use client';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { GatewayPanel } from './gateway-panel';
import styles from './admin-routes-panel.module.css';
import { imageConfigurationOnly } from './kie-image-configuration';

type Selection = { kind: 'details' | 'edit' | 'delete' | 'create'; id: string; revision: number };
type Detail = { id: string; name: string; service: string; protocol: string; provider: string; baseUrl: string; upstreamModel: string;
  enabled: boolean; timeoutMs: number; retries: number; updatedAt: string; routeFingerprint: string;
  credentialConfigured: boolean; ready: boolean; priceVersion: number | null; priceCurrency: string | null;
  options: { contextWindow: number; maxOutputTokens: number; maxImages: number; fallbackRouteId: string | null; fallbackEnabled: boolean } };
const serviceNames: Record<string, string> = { chat: '主模型', vision: '视觉读图', decision: '结构化决策', search: '联网搜索', voice: '语音合成', image: '图像生成' };
const serviceName = (service: string, protocol: string) => imageConfigurationOnly(service, protocol) ? '图像生成（配置中）' : serviceNames[service] || service;
class ManagementError extends Error {}
const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function date(value: unknown) { const parsed = typeof value === 'string' ? new Date(value) : null; return parsed && Number.isFinite(parsed.getTime()) ? dateFormat.format(parsed) : '—'; }
function safeError(status: number, code: unknown) {
  if (status === 401 || status === 403) return '当前账户没有此操作权限，请重新登录或联系管理员。';
  if (status === 404 || status === 410 || code === 'ROUTE_DELETED') return '路由不存在或已删除，请刷新列表。';
  if (status === 409 || code === 'ROUTE_CONFIGURATION_CHANGED') return '路由已被其他管理员更新，或仍被其他服务引用。请刷新后核对再操作。';
  return '操作未完成，请稍后重新载入核对。';
}
function publicDetail(body: Record<string, unknown>, id: string): Detail {
  const row = body.route as Detail | undefined;
  if (!row || row.id !== id || typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt)) || !row.options) throw new ManagementError('路由详情暂时无法读取，请刷新后重试。');
  const credential = body.credentialStatus as { configured?: unknown } | undefined;
  const price = body.latestPrice as { version?: unknown; currency?: unknown } | undefined;
  // A strict public projection: response additions, credentials and encrypted values are never rendered.
  return { id: row.id, name: row.name, service: row.service, protocol: row.protocol, provider: row.provider, baseUrl: row.baseUrl, upstreamModel: row.upstreamModel,
    enabled: row.enabled === true, timeoutMs: row.timeoutMs, retries: row.retries, updatedAt: row.updatedAt,
    routeFingerprint: typeof body.routeFingerprint === 'string' && /^[a-f0-9]{64}$/.test(body.routeFingerprint) ? body.routeFingerprint : '',
    credentialConfigured: credential?.configured === true || body.credentialConfigured === true, ready: body.ready === true,
    priceVersion: typeof price?.version === 'number' ? price.version : null, priceCurrency: typeof price?.currency === 'string' ? price.currency : null,
    options: { contextWindow: row.options.contextWindow, maxOutputTokens: row.options.maxOutputTokens, maxImages: row.options.maxImages,
      fallbackRouteId: row.options.fallbackRouteId || null, fallbackEnabled: row.options.fallbackEnabled === true } };
}

export function AdminRoutesPanel({ rows, permissions }: { rows: Record<string, unknown>[]; permissions: string[] }) {
  const router = useRouter(), headingId = useId();
  const canRead = permissions.some(value => ['admin.read', 'routes.write'].includes(value)), canWrite = permissions.includes('routes.write');
  const [selection, setSelection] = useState<Selection | null>(null), [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false), [deleting, setDeleting] = useState(false), [editorBusy, setEditorBusy] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const inspector = useRef<HTMLElement | null>(null), launcher = useRef<HTMLElement | null>(null), heading = useRef<HTMLHeadingElement | null>(null);
  const revision = useRef(0), mutation = useRef(false), mutationGeneration = useRef(0), mutationRequest = useRef<AbortController | null>(null);
  const busy = deleting || editorBusy;
  useEffect(() => () => { mutationGeneration.current++; mutationRequest.current?.abort(); }, []);
  useEffect(() => {
    if (!selection) return;
    inspector.current?.focus({ preventScroll: true }); inspector.current?.scrollIntoView?.({ block: 'nearest' });
    if (selection.kind !== 'details' && selection.kind !== 'delete') return;
    let active = true; const controller = new AbortController();
    setLoading(true); setDetail(null); setError('');
    void (async () => {
      try {
        const response = await fetch('/api/admin/routes?' + new URLSearchParams({ id: selection.id }), { cache: 'no-store', signal: controller.signal });
        const body = await response.json() as Record<string, unknown>;
        if (!response.ok) throw new ManagementError(safeError(response.status, body.code));
        const value = publicDetail(body, selection.id); if (active) setDetail(value);
      } catch (error) { if (active && !controller.signal.aborted) setError(error instanceof ManagementError ? error.message : '路由读取未完成，请重试。'); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; controller.abort(); };
  }, [selection]);
  function choose(kind: Selection['kind'], id: string, button: HTMLElement) {
    if (mutation.current || busy || !canRead || (kind !== 'details' && !canWrite)) return;
    launcher.current = button; setDetail(null); setError(''); setMessage(''); setConfirmed(false); setLoading(false);
    setSelection({ kind, id, revision: ++revision.current });
  }
  function close() {
    if (mutation.current || busy) return;
    setSelection(null); setDetail(null); setConfirmed(false); setError(''); setLoading(false);
    if (launcher.current?.isConnected) launcher.current.focus(); else heading.current?.focus();
  }
  async function remove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.current || !canWrite || !confirmed || selection?.kind !== 'delete' || detail?.id !== selection.id) return;
    const selected = detail, generation = ++mutationGeneration.current, controller = new AbortController();
    mutation.current = true; mutationRequest.current = controller; setDeleting(true); setError('');
    try {
      const response = await fetch('/api/admin/routes', { method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: selected.id, expectedUpdatedAt: selected.updatedAt, ...(selected.routeFingerprint ? { expectedRouteFingerprint: selected.routeFingerprint } : {}) }), signal: controller.signal });
      const body = await response.json() as Record<string, unknown>;
      if (controller.signal.aborted || generation !== mutationGeneration.current) return;
      if (!response.ok || body.deleted !== true) throw new ManagementError(safeError(response.status, body.code));
      setRemoved(previous => new Set([...previous, selected.id])); setSelection(null); setDetail(null); setConfirmed(false);
      setMessage('路由已删除。历史调用、价格和审计记录已保留。'); router.refresh(); heading.current?.focus();
    } catch (error) { if (!controller.signal.aborted && generation === mutationGeneration.current) setError(error instanceof ManagementError ? error.message : '删除结果尚未确认，请刷新列表后核对。'); }
    finally { if (generation === mutationGeneration.current) { mutation.current = false; mutationRequest.current = null; setDeleting(false); } }
  }
  if (!canRead) return null;
  const visible = rows.filter(row => !removed.has(String(row.id)));
  const information = detail ? [
    ['路由编号', detail.id], ['显示名称', detail.name], ['服务类型', serviceName(detail.service, detail.protocol)], ['供应商协议', detail.protocol],
    ['供应商', detail.provider], ['上游模型', detail.upstreamModel], ['上游地址', detail.baseUrl], ['API Key', detail.credentialConfigured ? '已配置' : '未配置'],
    ['开放状态', detail.enabled ? '已开放' : '暂停开放'], ['服务就绪', detail.ready ? '已就绪' : '尚未就绪'],
    ['最新成本版本', detail.priceVersion === null ? '尚未配置' : `v${detail.priceVersion} · ${detail.priceCurrency || ''}`],
    ...(detail.protocol === 'kie-images' ? [['提示词上限', '20,000 字符'], ['计费单位', '1K / 2K / 4K 输出图片（张）']] : [['上下文上限', `${detail.options.contextWindow} Token`], ['输出上限', `${detail.options.maxOutputTokens} Token`]]), ['每次最多图片数', String(detail.options.maxImages)],
    ['超时', `${detail.timeoutMs} 毫秒`], ['内部重试次数', String(detail.retries)],
    ['备用路由', detail.options.fallbackEnabled ? detail.options.fallbackRouteId || '未指定' : '关闭备用'], ['更新时间（北京时间）', date(detail.updatedAt)],
  ] : [];
  return <section aria-labelledby={headingId} className={styles.management}>
    <div className="panel-header"><div><h2 id={headingId} ref={heading} tabIndex={-1}>服务路由</h2><p className="small-text muted">操作列固定在左侧，横向滚动时仍可管理当前路由。</p></div>{canWrite && <button className="button" disabled={busy} onClick={event => choose('create', '', event.currentTarget)}>新增服务网关</button>}</div>
    {message && <div className="notice" role="status">{message}</div>}
    {visible.length ? <div className={`table-wrap ${styles.tableWrap}`} tabIndex={0} role="region" aria-label="服务路由列表，可横向滚动"><table className={styles.table}>
      <thead><tr><th scope="col" className={styles.actions}>操作</th>{['服务名称', '路由编号', '服务类型', '供应商', '协议', '上游模型', '上游地址', '开放状态', 'API Key', '更新时间（北京时间）'].map(name => <th scope="col" key={name}>{name}</th>)}</tr></thead>
      <tbody>{visible.map(row => { const id = String(row.id), name = String(row.name || id); return <tr key={id}>
        <td className={styles.actions}><div className={styles.buttons}>
          <button className="button secondary small" disabled={busy} aria-label={`查看 ${name} 详情`} onClick={event => choose('details', id, event.currentTarget)}>详情</button>
          {canWrite && <><button className="button secondary small" disabled={busy} aria-label={`编辑 ${name}`} onClick={event => choose('edit', id, event.currentTarget)}>编辑</button><button className="button danger small" disabled={busy} aria-label={`删除 ${name}`} onClick={event => choose('delete', id, event.currentTarget)}>删除</button></>}
        </div></td><td title={name}>{name}</td><td className="mono" title={id}>{id}</td><td>{serviceName(String(row.service || '—'), String(row.protocol || ''))}</td>
        <td>{String(row.provider || '—')}</td><td>{String(row.protocol || '—')}</td><td title={String(row.upstream_model || '')}>{String(row.upstream_model || '—')}</td><td title={String(row.base_url || '')}>{String(row.base_url || '—')}</td>
        <td><span className={`tag${row.enabled === true ? ' success' : ''}`}>{row.enabled === true ? '已开放' : '暂停开放'}</span></td><td>{row.credential_configured === true ? '已配置' : row.credential_configured === false ? '未配置' : '详情查看'}</td><td>{date(row.updated_at)}</td>
      </tr>; })}</tbody>
    </table></div> : <div className="empty"><strong>暂无服务路由</strong>{canWrite ? '可新增服务网关，或调整上方筛选条件。' : '请调整上方筛选条件。'}</div>}
    {selection && <section ref={inspector} tabIndex={-1} className={styles.inspector} aria-label={selection.kind === 'details' ? '服务网关详情' : selection.kind === 'delete' ? '删除服务网关' : selection.kind === 'create' ? '新增服务网关' : '编辑服务网关'}>
      <div className="panel-header"><h3>{selection.kind === 'details' ? '服务网关详情' : selection.kind === 'delete' ? '删除服务网关' : selection.kind === 'create' ? '新增服务网关' : '编辑服务网关'}{selection.id && ` · ${selection.id}`}</h3><button className="button secondary small" disabled={busy} onClick={close}>关闭</button></div>
      {loading && <p role="status">正在读取路由…</p>}
      {detail && <dl className={styles.details}>{information.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>}
      {selection.kind === 'delete' && detail && <form className="form-stack" onSubmit={remove}><p className="notice neutral">删除后停止提供此服务，不能使用同一编号重新创建；历史调用、成本版本和审计记录保留。</p><label className="route-test-consent"><input type="checkbox" checked={confirmed} disabled={deleting} onChange={event => setConfirmed(event.target.checked)} /><span>确认删除 {detail.name}（{detail.id}）</span></label><div><button className="button danger" disabled={!confirmed || deleting}>{deleting ? '正在删除…' : '确认删除路由'}</button></div></form>}
      {(selection.kind === 'edit' || selection.kind === 'create') && <GatewayPanel key={`${selection.kind}-${selection.id}-${selection.revision}`} mode="routes" rows={rows} initialRouteId={selection.kind === 'edit' ? selection.id : undefined} hideLookup onBusyChange={setEditorBusy} />}
      {error && <div className="notice error" role="alert">{error}</div>}
    </section>}
  </section>;
}
