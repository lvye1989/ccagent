import { after } from 'next/server';
import { paymentService } from '@/core/payments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    const service = paymentService();
    const event = await service.receiveNotification(new URL(request.url).searchParams);
    after(async () => { try { await service.reconcileOrder(event.orderId, event.tradeNo); } catch { console.error('PAYMENT_RECONCILIATION_PENDING'); } });
    return new Response('success', { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  } catch { return new Response('fail', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } }); }
}
