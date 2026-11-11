import { Shell, PageHeader } from '@/components/shell';
import { ReleasesPanel } from '@/components/releases-panel';
import { webAccount } from '@/core/web-account';
import { readRelease } from '@/core/releases';
export const dynamic = 'force-dynamic';
export default async function ReleasesPage() {
  const current = await webAccount('settings.write');
  return <Shell user={current.user} title="版本更新" path="/admin/releases" admin><PageHeader title="版本更新" description="编写版本说明，向客户端发送更新通知和下载链接。" /><ReleasesPanel initial={await readRelease()} /></Shell>;
}
