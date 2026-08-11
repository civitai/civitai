import { KEY_VALUE_KEYS } from '~/server/common/constants';
import { purgeCache } from '~/server/cloudflare/client';
import { dbKV } from '~/server/db/db-helpers';
import { logToAxiom } from '~/server/logging/client';
import type { CreatorCosmeticType, CreatorShopFees } from '~/server/schema/creator-shop.schema';
import { normalizeCreatorShopFees } from '~/server/schema/creator-shop.schema';

// Edge-cache tag shared by the public `creatorShop.getFees` procedure (edgeCacheIt) and the
// write below, so a mod change reaches the submit form immediately instead of waiting out
// the TTL — a stale fee is a number the creator agreed to and did not pay.
export const CREATOR_SHOP_FEES_EDGE_TAG = 'creator-shop-fees';

/**
 * A read failure is deliberately NOT swallowed into the defaults. The fee is charged
 * before review and is non-refundable, so falling back while the row says something
 * lower would charge more than the form quoted; failing the submission instead moves
 * no money. Absent or malformed values still fall back, per value.
 */
export async function getCreatorShopFees(): Promise<CreatorShopFees> {
  return normalizeCreatorShopFees(await dbKV.get(KEY_VALUE_KEYS.CREATOR_SHOP_FEES));
}

export async function getCreatorShopSubmissionFee(type: CreatorCosmeticType): Promise<number> {
  return (await getCreatorShopFees()).submission[type];
}

export type CreatorShopFeesInput = {
  submission?: Partial<Record<string, number>>;
  pack?: number;
};

// Read-before-write (dbKV reads the primary) so setting one type's fee can't drop the rest.
export async function setCreatorShopFees(input: CreatorShopFeesInput): Promise<CreatorShopFees> {
  const current = await getCreatorShopFees();
  const next = normalizeCreatorShopFees({
    submission: { ...current.submission, ...input.submission },
    pack: input.pack ?? current.pack,
  });
  await dbKV.set(KEY_VALUE_KEYS.CREATOR_SHOP_FEES, next);
  // Best-effort: the DB write is the source of truth, so a purge failure must not fail the
  // caller — worst case the CDN serves the old fee until its TTL expires.
  purgeCache({ tags: [CREATOR_SHOP_FEES_EDGE_TAG] }).catch((error) =>
    logToAxiom({
      type: 'error',
      name: 'purge-creator-shop-fees-cache',
      message: (error as Error).message,
      error,
    })
  );
  return next;
}
