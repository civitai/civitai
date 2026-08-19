import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { announcementsEnabled, createCoverUpload } from '$lib/server/announcements';

// The mint is the cross-origin problem, not the PUT: /api/v1/image-upload is an authed main-site
// endpoint, so proxying it server-to-server here keeps the browser same-origin. The browser then PUTs
// straight at the uploads bucket, whose CORS allows any origin.
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!(await announcementsEnabled(locals.user))) error(404, 'Not found');

  const result = await createCoverUpload(request.headers.get('cookie') ?? '');
  if (!result.ok) error(result.status, result.error);

  return json(result.data);
};
