import { KEY_VALUE_KEYS } from '~/server/common/constants';
import { dbKV } from '~/server/db/db-helpers';
import { logToAxiom } from '~/server/logging/client';
import type { CreatorCosmeticType, CreatorShopFees } from '~/server/schema/creator-shop.schema';
import { normalizeCreatorShopFees } from '~/server/schema/creator-shop.schema';
import { throwBadRequestError } from '~/server/utils/errorHandling';

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

/**
 * Refuses a submission whose form quoted a different fee than the one about to be
 * charged. Charging either number silently is wrong: the low one under-collects,
 * the high one takes Buzz the creator never agreed to and never gets it back.
 */
export function assertQuotedFee(quotedFee: number, actualFee: number) {
  if (quotedFee === actualFee) return;
  throw throwBadRequestError(
    `The submission fee changed to ${actualFee} Buzz while this form was open. Close and reopen it to continue.`
  );
}

export type CreatorShopFeesInput = {
  submission?: Partial<Record<string, number>>;
  pack?: number;
};

// Read-before-write (dbKV reads the primary) so setting one type's fee can't drop the rest.
export async function setCreatorShopFees(
  input: CreatorShopFeesInput,
  { actorId }: { actorId?: number } = {}
): Promise<CreatorShopFees> {
  const current = await getCreatorShopFees();
  const next = normalizeCreatorShopFees({
    submission: { ...current.submission, ...input.submission },
    pack: input.pack ?? current.pack,
  });
  await dbKV.set(KEY_VALUE_KEYS.CREATOR_SHOP_FEES, next);
  await logToAxiom({
    type: 'info',
    name: 'set-creator-shop-fees',
    actorId,
    previous: current,
    next,
  });
  return next;
}
