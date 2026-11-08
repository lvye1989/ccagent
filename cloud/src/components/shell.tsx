import Link from 'next/link';
import { Brand } from './brand';
import { Logout } from './logout';

export const accountNavigation = [['/account', '账户概览', '◈'], ['/account/keys', '个人 API Key', '⚿'], ['/account/billing', '余额与充值', '¥'], ['/account/usage', '使用明细', '↗']] as const;
export const adminNavigation = [['/admin', '运营概览', '◈'], ['/admin/users', '用户与权限', '◎'], ['/admin/keys', 'API Key 管理', '⚿'], ['/admin/orders', '余额与订单', '¥'], ['/admin/refunds', '退款与对账', '↶'], ['/admin/usage', '用量与任务费用', '↗'], ['/admin/data', '后端数据', '▤'], ['/admin/routes', '服务网关', '⇄'], ['/admin/settings', '系统设置', '⚙']] as const;
export function Shell({ children, title, path, user, admin = false, canAdmin = false }: {
  children: React.ReactNode; title: string; path: string; user: { name: string; email: string }; admin?: boolean; canAdmin?: boolean;
}) {
  const navigation = admin ? adminNavigation : accountNavigation;
  return <div className="dashboard"><aside className="sidebar"><Brand /><nav className="nav-group" aria-label={admin ? '管理导航' : '账户导航'}><span>{admin ? 'MANAGEMENT' : 'WORKSPACE'}</span>
    {navigation.map(([href, label, symbol]) => <Link key={href} href={href} className={`nav-item ${path === href ? 'active' : ''}`} aria-current={path === href ? 'page' : undefined}><span className="nav-symbol" aria-hidden="true">{symbol}</span>{label}</Link>)}
  </nav>{(admin || canAdmin) && <nav className="nav-group"><span>SWITCH VIEW</span><Link className="nav-item" href={admin ? '/account' : '/admin'}>{admin ? '← 返回用户中心' : '管理后台 →'}</Link></nav>}
    <div className="sidebar-bottom"><div className="user-label"><strong>{user.name || 'CCAGENT 用户'}</strong><span>{user.email}</span></div><Logout /></div></aside>
    <div className="main-column"><header className="topbar"><div className="breadcrumb">{admin ? '管理后台' : '账户中心'}<b>/ {title}</b></div><div className="inline-actions"><span className="tag success">{admin ? '管理员' : '已登录'}</span><span className="mobile-brand"><Logout /></span></div></header><main className="main-content">{children}</main></div></div>;
}
export function PageHeader({ title, description, children }: { title: string; description?: string; children?: React.ReactNode }) {
  return <div className="page-header"><div><div className="section-label">CCAGENT / {title}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{children && <div className="inline-actions">{children}</div>}</div>;
}
