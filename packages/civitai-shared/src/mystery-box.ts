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
