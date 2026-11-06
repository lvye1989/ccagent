import { Shell, PageHeader } from '@/components/shell';
import { KeysPanel } from '@/components/keys-panel';
import { webAccount } from '@/core/web-account';
import { listKeys } from '@/core/keys';

export const dynamic = 'force-dynamic';
export default async function Keys() {
  const current = await webAccount(), keys = await listKeys(current.user.id);
  const safe = keys.map(key => ({ ...key, limit: key.limit?.toString() ?? null, spent: key.spent.toString(), frozen: key.frozen.toString(), createdAt: key.createdAt.toISOString(), revokedAt: key.revokedAt?.toISOString() ?? null }));
  return <Shell user={current.user} title="个人 API Key" path="/account/keys" canAdmin={current.permissions.includes('admin.read')}><PageHeader title="个人 API Key" description="为每台设备创建 Key，分别管理服务额度与访问权限。" /><KeysPanel keys={safe} /></Shell>;
}
