import { requireSession } from '@/core/auth';
import { initializeUpload, uploadInput } from '@/core/files';
import { errorResponse, json, readJson, requireSameOrigin } from '@/core/http';

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const { user } = await requireSession(request.headers);
    return json(await initializeUpload(user.id, uploadInput.parse(await readJson(request))), 201);
  } catch (error) { return errorResponse(error); }
}
