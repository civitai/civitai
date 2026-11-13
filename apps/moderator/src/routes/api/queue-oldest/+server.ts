import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getQueueOldest } from '$lib/server/sidebar-counts.service';
import { bounded } from '$lib/server/bounded';

// The dashboard's "Oldest" column. A failure is a 503 rather than `{}`, which would read as every
// queue having nothing old in it.
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) return json(null, { status: 401 });
  const oldest = await bounded(getQueueOldest);
  if (!oldest) return json(null, { status: 503 });
  return json(oldest);
};
