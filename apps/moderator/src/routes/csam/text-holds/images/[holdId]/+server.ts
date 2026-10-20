import { error, json, type RequestHandler } from '@sveltejs/kit';
import { denied } from '$lib/server/access';
import { getHoldImagesById } from '$lib/server/csam-holds.service';
import { int4Id } from '$lib/server/query';

// Read per open hold, not in the page load: the shell switches holds without navigating.
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.grants['csam.report.file']) error(403, denied('csam.report.file'));
  const holdId = int4Id.safeParse(params.holdId);
  if (!holdId.success) error(400, 'Bad hold id.');
  return json({ images: await getHoldImagesById(holdId.data) });
};
