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
import { REQUEST_KEY_PATTERN } from '$lib/server/shop/config';
import { getMainAppPort } from '$lib/server/shop/main-app';
import { buyItem } from '$lib/server/shop/purchase';
import { REFUSAL_STATUS, refusalText } from '$lib/shop-view';
import type { Actions, PageServerLoad } from './$types';

const POSTGRES_INT_MAX = 2_147_483_647;
const CLOSED_TEXT = "The shop isn't open yet. Your gold keeps accruing.";

const buzzPacksOpen = () => conversionEnabled() && buzzConfigured();

let warnedNoEndpoint = false;

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
        // Sized for the cosmetic tiles and the try-on preview, both larger than the old row icon.
        image: imageKey ? imageUrl(imageKey, 384) : null,
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
    const rawItemId = String(form.get('itemId') ?? '').trim();
    const itemId = /^\d+$/.test(rawItemId) ? Number(rawItemId) : NaN;
    const requestKey = String(form.get('requestKey') ?? '');
    const rawPrice = String(form.get('price') ?? '').trim();
    const price = rawPrice === '' ? NaN : Number(rawPrice);
    if (
      !(itemId > 0 && itemId <= POSTGRES_INT_MAX) ||
      !REQUEST_KEY_PATTERN.test(requestKey) ||
      !Number.isInteger(price) ||
      price <= 0
    ) {
      return fail(400, { message: refusalText('bad-key'), reason: 'bad-key' as const });
    }

    const open = buzzPacksOpen();
    if (!open && conversionEnabled() && !warnedNoEndpoint) {
      warnedNoEndpoint = true;
      await logToAxiom({
        type: 'warning',
        name: 'knights-conversion-unavailable',
        message: 'BUZZ_ENDPOINT is not configured; Buzz packs are not sold',
      });
    }
    let result;
    let minRank: string | null = null;
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
      if (result.status === 'refused' && result.reason === 'rank')
        minRank = await rankGateOf(itemId);
    } catch (error) {
      console.error('knights: shop purchase failed', { error });
      return fail(500, {
        message: 'Your purchase could not be completed. Try again in a moment.',
        itemId,
      });
    }

    if (result.status === 'refused') {
      return fail(REFUSAL_STATUS[result.reason], {
        message: refusalText(result.reason, { shortfall: result.shortfall, minRank }),
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

async function rankGateOf(itemId: number): Promise<string | null> {
  const row = await db
    .selectFrom('KnightsShopItem')
    .select('minRank')
    .where('id', '=', itemId)
    .executeTakeFirst();
  return row?.minRank ?? null;
}
