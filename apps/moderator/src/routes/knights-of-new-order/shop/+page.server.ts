import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { utcDay } from '@civitai/shared/knights-shop';
import { requireAccess } from '$lib/server/access';
import { parseForm } from '$lib/server/query';
import type { Outcome } from '$lib/server/knights/coreset.service';
import {
  createShopItem,
  listShopChanges,
  listShopItems,
  setShopItemActive,
  stockView,
  updateShopItem,
} from '$lib/server/knights/shop-catalog.service';
import {
  editShopItemSchema,
  itemIdSchema,
  newShopItemSchema,
  SHOP_RANKS,
} from '$lib/server/knights/shop-catalog.schema';

const TABS = ['items', 'preview', 'audit'] as const;
type Tab = (typeof TABS)[number];

const isDay = (value: string | null): value is string =>
  value !== null &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const STATUSES = ['live', 'retired', 'all'] as const;
const KINDS = ['buzz_pack', 'membership', 'cosmetic'] as const;

const intParam = (value: string | null) =>
  value && /^\d{1,9}$/.test(value) ? Number(value) : undefined;

export const load: PageServerLoad = async ({ url, locals }) => {
  requireAccess(locals.user, url.pathname);
  const requested = url.searchParams.get('tab');
  const tab: Tab = TABS.find((t) => t === requested) ?? 'items';
  const today = utcDay(new Date());
  const requestedDay = url.searchParams.get('day');
  const day = isDay(requestedDay) && requestedDay > today ? requestedDay : today;
  const itemId = intParam(url.searchParams.get('item'));
  const before = intParam(url.searchParams.get('before'));
  const items = await listShopItems();
  const status = url.searchParams.get('status');
  const kind = url.searchParams.get('kind');
  const audit = tab === 'audit' ? await listShopChanges({ itemId, before }) : null;
  return {
    tab,
    items,
    ranks: SHOP_RANKS,
    today,
    day,
    now: new Date().toISOString(),
    query: {
      q: (url.searchParams.get('q') ?? '').trim().slice(0, 100),
      status: STATUSES.find((s) => s === status) ?? 'live',
      kind: KINDS.find((k) => k === kind) ?? ('' as const),
    },
    todayStock: stockView(items, today).stock.map(({ item, price, deal, hidden }) => ({
      id: item.id,
      price,
      deal,
      hidden: hidden !== null,
    })),
    preview: tab === 'preview' ? stockView(items, day) : null,
    itemId: itemId === undefined ? '' : String(itemId),
    before: before ?? null,
    changes: audit?.changes ?? [],
    nextBefore: audit?.nextBefore ?? null,
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
