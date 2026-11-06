import { Brand } from '@/components/brand';
import { AuthForm } from '@/components/auth-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: '登录' };
export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; verified?: string }> }) {
  const query = await searchParams;
  return <div className="auth-shell"><section className="auth-story"><Brand /><div className="auth-story-main"><div className="eyebrow">CCAGENT / WORKSPACE</div><h1>让想法，<br />成为完成的工作。</h1><div className="story-rule" /><p>从一次对话到一项任务，在熟悉的工作区里连接模型、工具与文件。</p></div><div className="story-note">你的账户 · 你的工作区 · 清晰的每一笔用量</div></section><section className="auth-content"><AuthForm initialError={query.error === 'disabled' ? '账户已被禁用，请联系管理员。' : ''} verified={query.verified === '1'} /></section></div>;
}
