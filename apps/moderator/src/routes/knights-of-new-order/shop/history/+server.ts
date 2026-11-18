import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAccess } from '$lib/server/access';
import { listShopChanges } from '$lib/server/knights/shop-catalog.service';

const id = (value: string | null) => (value && /^\d{1,9}$/.test(value) ? Number(value) : null);

export const GET: RequestHandler = async ({ url, locals }) => {
  requireAccess(locals.user, url.pathname);
  const itemId = id(url.searchParams.get('item'));
  if (itemId === null) return json({ error: 'Pick an item.' }, { status: 400 });
  return json(
    await listShopChanges({ itemId, before: id(url.searchParams.get('before')) ?? undefined })
  );
};
