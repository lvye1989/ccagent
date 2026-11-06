import Link from 'next/link';

export default function NotFound() { return <main className="site-error"><div className="eyebrow">CCAGENT / 404</div><h1>无法访问此页面</h1><p>页面不存在，或当前账户没有访问权限。</p><Link className="button" href="/account">返回账户中心</Link></main>; }
