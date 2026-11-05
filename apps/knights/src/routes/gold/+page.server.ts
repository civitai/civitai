import { fail } from '@sveltejs/kit';
import { getGoldBalance } from '$lib/server/conversion/balance';
import {
  buzzConfigured,
  conversionEnabled,
  getBuzzPort,
  shopEnabled,
} from '$lib/server/conversion/runtime';
import { logToAxiom } from '$lib/server/axiom';
import { db } from '$lib/server/db';
import { imageUrl } from '$lib/server/image-url';
import { getPlayerStatusOrNew } from '$lib/server/player-status';
import { loadShop } from '$lib/server/shop/catalog';
import { recentPurchases } from '$lib/server/shop/inventory';
import { getMainAppPort } from '$lib/server/shop/main-app';
import { buyItem } from '$lib/server/shop/purchase';
import { REFUSAL_STATUS, refusalText } from '$lib/shop-view';
import type { Actions, PageServerLoad } from './$types';

const CLOSED_TEXT = "The shop isn't open yet. Your gold keeps accruing.";

const buzzPacksOpen = () => conversionEnabled() && buzzConfigured();

export const load: PageServerLoad = async ({ locals }) => {
  const now = new Date();
  const open = shopEnabled();
  const status = await getPlayerStatusOrNew(db, locals.user.id);
  const [balance, shop, recent] = await Promise.all([
    getGoldBalance(db, locals.user.id),
    open
      ? loadShop(db, {
          playerId: locals.user.id,
          rank: status.rank,
          now,
          buzzPacksOpen: buzzPacksOpen(),
        })
      : null,
    open ? recentPurchases(db, locals.user.id) : [],
  ]);
  return {
    status,
    balance,
    shopOpen: open,
    shop: shop && {
      ...shop,
      cards: shop.cards.map(({ imageKey, ...card }) => ({
        ...card,
        image: imageKey ? imageUrl(imageKey, 192) : null,
      })),
    },
    now: now.toISOString(),
    recent: recent.map(({ createdAt, ...row }) => ({ ...row, at: createdAt.toISOString() })),
  };
};

export const actions: Actions = {
  buy: async ({ locals, request }) => {
    if (!shopEnabled()) return fail(403, { message: CLOSED_TEXT });
    const form = await request.formData();
    const itemId = String(form.get('itemId') ?? '');
    const requestKey = String(form.get('requestKey') ?? '');
    const price = Number(form.get('price'));
    if (!itemId || !Number.isInteger(price)) {
      return fail(400, { message: refusalText('bad-key'), reason: 'bad-key' as const, itemId });
    }

    const open = buzzPacksOpen();
    if (!open && conversionEnabled()) {
      await logToAxiom({
        type: 'warning',
        name: 'knights-conversion-unavailable',
        message: 'BUZZ_ENDPOINT is not configured; Buzz packs are not sold',
      });
    }
    let result;
    try {
      result = await buyItem(
        db,
        {
          buzz: open
            ? getBuzzPort()
            : { grantYellow: async () => Promise.reject(new Error('Buzz is not configured')) },
          mainApp: getMainAppPort(),
          buzzPacksOpen: open,
          log: logToAxiom,
        },
        { playerId: locals.user.id, itemId, requestKey, price, now: new Date() }
      );
    } catch (error) {
      console.error('knights: shop purchase failed', { error });
      return fail(500, {
        message: 'Your purchase could not be completed. Try again in a moment.',
        itemId,
      });
    }

    if (result.status === 'refused') {
      const rank = result.reason === 'rank' ? await rankGateOf(itemId) : null;
      return fail(REFUSAL_STATUS[result.reason], {
        message: refusalText(result.reason, { shortfall: result.shortfall, minRank: rank }),
        reason: result.reason,
        shortfall: result.shortfall ?? 0,
        itemId,
      });
    }
    if (result.status === 'failed') {
      return fail(502, {
        message: result.forfeited
          ? 'This purchase was refused, and as it was made before your career reset its gold is forfeited with the rest.'
          : 'This could not be delivered. Your gold is untouched; try again later.',
        reason: 'failed' as const,
        itemId,
      });
    }
    return {
      ok: true as const,
      pending: result.status === 'pending',
      itemId,
      kind: result.kind,
      gold: result.gold,
    };
  },
};

async function rankGateOf(itemId: string): Promise<string | null> {
  const row = await db
    .selectFrom('KnightsShopItem')
    .select('minRank')
    .where('id', '=', itemId)
    .executeTakeFirst();
  return row?.minRank ?? null;
}
