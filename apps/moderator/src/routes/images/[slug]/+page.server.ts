import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { FLAG_KEPT_THROUGH_BLOCK, IMAGE_VIEW_SLUGS, type ImageViewSlug } from '$lib/image-review';
import { imageQueueActions, loadCsamQueueByUser, loadImageQueue } from '$lib/server/image-queue';

// The review queues. The page and its actions are shared with `/reports/image` (`$lib/server/image-queue.ts`,
// `$lib/components/image-queue/`), which is where the reported-image queue lives now.
export const load: PageServerLoad = async ({ params, url }) => {
  // `reported` moved to `/reports/image` (2026-10-15); `$lib/moved-pages.ts` redirects it before this
  // runs. Refused here all the same, so the route can never serve it again by accident.
  if (params.slug === 'reported') error(404, 'Unknown image view');
  if (!(IMAGE_VIEW_SLUGS as readonly string[]).includes(params.slug))
    error(404, 'Unknown image view');
  if (params.slug === FLAG_KEPT_THROUGH_BLOCK && url.searchParams.get('by') === 'user')
    return loadCsamQueueByUser(url);
  return loadImageQueue(params.slug as ImageViewSlug, url);
};

export const actions = imageQueueActions;
