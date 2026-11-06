import { ResetForm } from '@/components/reset-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: '重置密码' };
export default async function Reset({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const query = await searchParams;
  return <main className="auth-content" style={{ minHeight: '100vh' }}><ResetForm token={query.token || ''} invalid={!!query.error} /></main>;
}
