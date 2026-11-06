'use client';

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="site-error"><div className="eyebrow">CCAGENT</div><h1>暂时无法加载</h1><p>服务连接出现问题。请稍后重试，你的账户数据会保留。</p><button className="button" onClick={reset}>重试</button></main>;
}
