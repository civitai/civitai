import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { denied } from '$lib/server/access';
import { readProbe } from '$lib/server/scan-probe/service';

// Page access is enforced in hooks.server.ts (this path is under /images/scan-probe); the grant is
// checked here because a page grant alone must not read scan results.
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.grants['image.scanProbe.run']) error(403, denied('image.scanProbe.run'));
  if (!/^[1-9][0-9]{0,18}$/.test(params.runId)) error(400, 'Malformed run id.');
  const result = await readProbe(params.runId, locals.user.id);
  if (!result) error(404, 'No such run.');
  return json(result, { headers: { 'cache-control': 'no-store' } });
};
