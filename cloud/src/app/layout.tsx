import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: { default: 'CCAGENT · 账户中心', template: '%s · CCAGENT' }, description: '管理 CCAGENT 账户、余额、个人 API Key 和使用明细。', robots: { index: false, follow: false } };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
