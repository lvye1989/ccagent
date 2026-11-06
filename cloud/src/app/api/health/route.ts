import { json } from '@/core/http';

export const dynamic = 'force-dynamic';
export function GET() { return json({ service: 'CCAGENT', status: 'ok' }); }
