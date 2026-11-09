import { after } from 'next/server';
import { createRouteTests } from '@/core/route-tests';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export async function GET(request: Request) { return createRouteTests().get(request); }
export async function POST(request: Request) { return createRouteTests({ keepAlive: work => after(() => work) }).post(request); }
