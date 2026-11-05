import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { utcDay } from '@civitai/shared/knights-shop';
import { requireAccess } from '$lib/server/access';
import { parseForm } from '$lib/server/query';
import {
  createShopItem,
  listShopChanges,
  listShopItems,
  previewShop,
  setShopItemActive,
  updateShopItem,
  type Outcome,
} from '$lib/server/knights/shop-catalog.service';
import {
  editShopItemSchema,
  itemIdSchema,
  newShopItemSchema,
} from '$lib/server/knights/shop-catalog.schema';

const TABS = ['items', 'preview', 'audit'] as const;
type Tab = (typeof TABS)[number];

const isDay = (value: string | null): value is string =>
  value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

export const load: PageServerLoad = async ({ url, locals }) => {
  requireAccess(locals.user, url.pathname);
  const requested = url.searchParams.get('tab');
  const tab: Tab = TABS.find((t) => t === requested) ?? 'items';
  const requestedDay = url.searchParams.get('day');
  const day = isDay(requestedDay) ? requestedDay : utcDay(new Date());
  const itemId = url.searchParams.get('item') || undefined;
  const items = await listShopItems();
  return {
    tab,
    items,
    day,
    preview: tab === 'preview' ? await previewShop(day) : null,
    itemId: itemId ?? '',
    changes: tab === 'audit' ? await listShopChanges({ itemId }) : [],
  };
};

async function run<S extends z.ZodType>(
  event: { request: Request; locals: App.Locals; url: URL },
  schema: S,
  label: string,
  act: (input: z.infer<S>, userId: number) => Promise<Outcome<object>>
) {
  requireAccess(event.locals.user, event.url.pathname);
  const userId = event.locals.user?.id;
  if (!userId) return fail(401, { error: 'Sign in again to change the shop.' });
  const input = parseForm(schema, await event.request.formData());
  if (typeof input === 'string') return fail(400, { error: input });
  try {
    const result = await act(input, userId);
    if (!result.ok) return fail(409, { error: result.error });
    return { success: true, changed: 'changed' in result ? result.changed : true };
  } catch (error) {
    console.error(`knights shop: could not ${label}`, { error });
    return fail(500, { error: `Could not ${label}. Nothing was changed; try again.` });
  }
}

export const actions: Actions = {
  add: (event) => run(event, newShopItemSchema, 'add the item', createShopItem),
  save: (event) => run(event, editShopItemSchema, 'save the item', updateShopItem),
  retire: (event) =>
    run(event, itemIdSchema, 'retire the item', ({ id }, userId) =>
      setShopItemActive(id, false, userId)
    ),
  restore: (event) =>
    run(event, itemIdSchema, 'restore the item', ({ id }, userId) =>
      setShopItemActive(id, true, userId)
    ),
};
