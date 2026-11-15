import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAccess } from '$lib/server/access';
import { getPaginatedCosmetics } from '$lib/server/cosmetics.service';
import { inReviewCosmetics } from '$lib/server/knights/shop-catalog.service';

export const GET: RequestHandler = async ({ url, locals }) => {
  requireAccess(locals.user, url.pathname);
  const q = url.searchParams.get('q')?.trim() ?? '';
  if (!q) return json([]);
  const { items } = await getPaginatedCosmetics({ name: q, limit: 10 });
  const inReview = await inReviewCosmetics(items.map(({ id }) => id));
  return json(
    items.map(({ id, name, type, data }) => ({ id, name, type, data, inReview: inReview.has(id) }))
  );
};
