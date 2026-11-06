import { redirect } from 'next/navigation';
import { webAccount } from '@/core/web-account';

export const dynamic = 'force-dynamic';
export default async function Home() { await webAccount(); redirect('/account'); }
