import { after } from 'next/server';
import { createGateway } from '@/core/gateway';
export const runtime = 'nodejs';
export const maxDuration = 300;
export async function POST(request: Request) { return createGateway({ keepAlive: work => after(() => work) }).execute(request, 'chat'); }
