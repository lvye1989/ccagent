import { availableModels } from '@/core/gateway';
import { errorResponse, json } from '@/core/http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { return json(await availableModels(request)); } catch (error) { return errorResponse(error); }
}
