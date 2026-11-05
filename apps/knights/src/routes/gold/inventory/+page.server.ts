import { fail } from '@sveltejs/kit';
import { getGoldBalance } from '$lib/server/conversion/balance';
import { shopEnabled } from '$lib/server/conversion/runtime';
import { db } from '$lib/server/db';
import { listInventory, membershipOf } from '$lib/server/shop/inventory';
import { getMainAppPort, MainAppRejectedError } from '$lib/server/shop/main-app';
import { imageUrl } from '$lib/server/image-url';
import type { Actions, PageServerLoad } from './$types';

const CLOSED_TEXT = "The shop isn't open yet.";

export const load: PageServerLoad = async ({ locals }) => {
  const open = shopEnabled();
  const [items, membership, balance] = await Promise.all([
    open ? listInventory(db, locals.user.id) : [],
    membershipOf(db, locals.user.id, new Date()),
    getGoldBalance(db, locals.user.id),
  ]);
  return {
    shopOpen: open,
    balance,
    items: items.map(({ imageKey, ...item }) => ({
      ...item,
      image: imageKey ? imageUrl(imageKey, 192) : null,
    })),
    membership: membership
      ? {
          tier: membership.tier,
          endsAt: membership.endsAt.toISOString(),
        }
      : null,
    now: new Date().toISOString(),
  };
};

async function change(
  locals: App.Locals,
  request: Request,
  {
    verb,
    run,
  }: { verb: 'equip' | 'unequip'; run: (userId: number, cosmeticId: number) => Promise<void> }
) {
  if (!shopEnabled()) return fail(403, { message: CLOSED_TEXT });
  const cosmeticId = Number((await request.formData()).get('cosmeticId'));
  if (!Number.isInteger(cosmeticId) || cosmeticId <= 0) {
    return fail(400, { message: 'That item could not be found.' });
  }
  // Only what Knights shows in the inventory: the main app refuses a cosmetic the user does not own, this keeps the rest out.
  const owned = (await listInventory(db, locals.user.id)).some(
    (item) => item.cosmeticId === cosmeticId
  );
  if (!owned) return fail(404, { message: 'That item is not in your inventory.' });
  try {
    await run(locals.user.id, cosmeticId);
  } catch (error) {
    if (error instanceof MainAppRejectedError) {
      return fail(409, { message: error.detail || `Civitai would not ${verb} that.`, cosmeticId });
    }
    console.error(`knights: ${verb} failed`, { error });
    return fail(502, { message: 'Civitai did not answer. Try again in a moment.', cosmeticId });
  }
  return { ok: true as const, cosmeticId };
}

export const actions: Actions = {
  equip: ({ locals, request }) =>
    change(locals, request, {
      verb: 'equip',
      run: (userId, cosmeticId) => getMainAppPort().equipCosmetic(userId, cosmeticId),
    }),
  unequip: ({ locals, request }) =>
    change(locals, request, {
      verb: 'unequip',
      run: (userId, cosmeticId) => getMainAppPort().unequipCosmetic(userId, cosmeticId),
    }),
};
