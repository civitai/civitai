import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAccess } from '$lib/server/access';
import { searchCosmetics } from '$lib/server/knights/shop-catalog.service';

// Typeahead for the shop's cosmetic picker, so an item always points at a cosmetic that exists.
export const GET: RequestHandler = async ({ url, locals }) => {
  requireAccess(locals.user, url.pathname);
  const q = url.searchParams.get('q')?.trim() ?? '';
  return json(q ? await searchCosmetics(q) : []);
};
