import { createImagesGateway } from '@/core/images-gateway';
export const runtime = 'nodejs';
export const maxDuration = 300;
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { return createImagesGateway().get(request, (await context.params).id); }
