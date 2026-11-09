import { createImagesGateway } from '@/core/images-gateway';
export const runtime = 'nodejs';
export const maxDuration = 300;
export async function POST(request: Request) { return createImagesGateway().start(request); }
