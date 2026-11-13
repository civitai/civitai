import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { listCreatorScoreGrants } from '$lib/server/creator-score-grant.service';

// The reasons are moderator audit notes, so the list needs the grant permission as well as the page.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');
  if (!locals.grants['user.creatorScore.grant']) error(403, 'Not permitted.');
  return json(await listCreatorScoreGrants(userId));
};
