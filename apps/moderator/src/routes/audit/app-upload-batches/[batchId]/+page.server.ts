import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { int4Id } from '$lib/server/query';
import { getUploadBatch } from '$lib/server/app-upload-batches.service';

export const load: PageServerLoad = async ({ params }) => {
  const parsed = int4Id.safeParse(params.batchId);
  if (!parsed.success) error(400, 'Bad batch id.');
  const detail = await getUploadBatch(parsed.data);
  if (detail.kind === 'missing') error(404, 'No such batch.');
  return { detail };
};
