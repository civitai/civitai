import type { RequestHandler } from './$types';
import { modelFlagDetailResponse } from '$lib/server/minor-flag-queue';

export const GET: RequestHandler = ({ params, url }) =>
  modelFlagDetailResponse(params.modelId, url);
