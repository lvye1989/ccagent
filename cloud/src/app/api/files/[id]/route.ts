import { requireSession } from '@/core/auth';
import { completeUpload, deleteOwnedFile, readOwnedFile } from '@/core/files';
import { errorResponse, json, requireSameOrigin } from '@/core/http';

export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireSession(request.headers), { id } = await context.params;
    const file = await readOwnedFile(user.id, id);
    return new Response(file.stream, { headers: { 'content-type': file.record.contentType, 'content-length': String(file.record.size), 'cache-control': 'private, no-store',
      'content-disposition': 'attachment', 'x-content-type-options': 'nosniff' } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const { user } = await requireSession(request.headers), { id } = await context.params;
    return json(await completeUpload(user.id, id));
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const { user } = await requireSession(request.headers), { id } = await context.params;
    await deleteOwnedFile(user.id, id);
    return json({ deleted: true });
  } catch (error) { return errorResponse(error); }
}
