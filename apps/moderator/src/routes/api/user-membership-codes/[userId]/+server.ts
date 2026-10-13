import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { listSupportMembershipCodes } from '$lib/server/membership-code.service';

// The codes themselves are credentials, so the list needs the minting grant as well as the page.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');
  if (!locals.grants['user.membership.code']) error(403, 'Not permitted.');
  return json(await listSupportMembershipCodes(userId));
};
