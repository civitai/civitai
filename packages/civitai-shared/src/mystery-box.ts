/**
 * The claim key a box open grants its reward under: the server writes it, the reveal finds the hat by
 * it, and a moderator refund takes the reward back by it.
 */
export const boxOpenClaimKey = (boxItemId: bigint | string) => `box-open-${boxItemId}`;

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
