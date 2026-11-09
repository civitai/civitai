/**
 * The claim key a box open grants its reward under: the server writes it, the reveal finds the hat by
 * it, and a moderator refund takes the reward back by it.
 */
export const boxOpenClaimKey = (boxItemId: bigint | string) => `box-open-${boxItemId}`;

/** A moderator grant's `Item.sourceKey` starts with this; a purchase's never does. */
export const MOD_GRANT_SOURCE_PREFIX = 'mod-grant-';

/**
 * The `Item.sourceKey` of the `n`th item (from 1) one moderator grant gives one user. `sourceKey` is
 * unique, so the key carries the user: one grant to many users shares its `grantId`.
 */
export function modGrantSourceKey(grantId: string, userId: number, n: number) {
  if (!/^[A-Za-z0-9]+$/.test(grantId)) throw new Error(`Not a grant id: ${grantId}`);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error(`Not a user id: ${userId}`);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Not an item number: ${n}`);
  return `${MOD_GRANT_SOURCE_PREFIX}${grantId}-${userId}-${n}`;
}

/** `BoxOpening.rewardStatus`, which a CHECK holds to these values. */
export const BOX_OPENING_REWARD_STATUS = { granted: 'granted', refunded: 'refunded' } as const;

/** `ItemDefinition.type` values. Text + CHECK in the database; a new type is a migration and a grant handler. */
export const ITEM_TYPE = { cosmetic: 'cosmetic', box: 'box' } as const;
export type ItemType = (typeof ITEM_TYPE)[keyof typeof ITEM_TYPE];

/** `ItemDefinition.status` values, which a CHECK holds to these. */
export const ITEM_DEFINITION_STATUS = {
  draft: 'draft',
  published: 'published',
  archived: 'archived',
} as const;
export type ItemDefinitionStatus =
  (typeof ITEM_DEFINITION_STATUS)[keyof typeof ITEM_DEFINITION_STATUS];

/** The event a cosmetic is sold for (`Cosmetic.data.event`), if any. */
export function cosmeticEventOf(data: unknown): string | undefined {
  const event = (data as { event?: unknown } | null)?.event;
  return typeof event === 'string' ? event : undefined;
}

/** The team a cosmetic was made for (`Cosmetic.data.team`), if any. */
export function cosmeticTeamOf(data: unknown): string | undefined {
  const team = (data as { team?: unknown } | null)?.team;
  return typeof team === 'string' ? team : undefined;
}

/**
 * A cosmetic made for a team goes only to that team's members; a buyer with no team gets none of
 * them.
 */
export const isForTeam = (cosmeticTeam: string | undefined, team: string | undefined) =>
  cosmeticTeam === undefined || cosmeticTeam === team;

/**
 * A box listing that sells several boxes for one charge (`CosmeticShopItem.meta.pack`). The first box
 * of each pack draws only from `guaranteedTierIds` while any of them has something left for its holder.
 */
export type BoxPackTerms = { size: number; guaranteedTierIds: number[] };

export const MAX_BOX_PACK_SIZE = 20;

/** The pack terms in a listing's meta, or undefined for a listing selling one box. */
export function boxPackTermsOf(meta: unknown): BoxPackTerms | undefined {
  const pack = (meta as { pack?: unknown } | null)?.pack;
  if (pack == null) return undefined;
  const { size, guaranteedTierIds } = pack as { size?: unknown; guaranteedTierIds?: unknown };
  // A malformed pack must not sell as a single box at the pack's price.
  if (
    !Number.isInteger(size) ||
    (size as number) < 2 ||
    (size as number) > MAX_BOX_PACK_SIZE ||
    !Array.isArray(guaranteedTierIds) ||
    !guaranteedTierIds.length ||
    !guaranteedTierIds.every((id) => Number.isInteger(id) && id > 0)
  )
    throw new Error('Malformed box pack terms');
  return { size: size as number, guaranteedTierIds: guaranteedTierIds as number[] };
}

const PACK_BOX_SEPARATOR = '#pack-';

/** The `Item.sourceKey` of the `n`th box (from 1) a pack purchase grants; box 1 is the guaranteed one. */
export function packBoxSourceKey(transactionId: string, n: number) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_BOX_PACK_SIZE)
    throw new Error(`Not a pack box number: ${n}`);
  return `${transactionId}${PACK_BOX_SEPARATOR}${String(n).padStart(2, '0')}`;
}

/** Every pack box key of a purchase starts with this. */
export const packBoxSourcePrefix = (transactionId: string) =>
  `${transactionId}${PACK_BOX_SEPARATOR}`;

/** The purchase and box number a pack box's `sourceKey` names, or undefined for any other key. */
export function parsePackBoxSourceKey(sourceKey: string) {
  const at = sourceKey.lastIndexOf(PACK_BOX_SEPARATOR);
  if (at <= 0) return undefined;
  const n = sourceKey.slice(at + PACK_BOX_SEPARATOR.length);
  if (!/^\d{2}$/.test(n)) return undefined;
  return { transactionId: sourceKey.slice(0, at), n: Number(n) };
}
