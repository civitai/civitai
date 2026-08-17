import { OVERRIDE_FIELDS } from '~/server/rewards/reward-config';

export type Draft = { enabled: boolean; awardAmount: string; cap: string };
export type StoredOverride = { enabled?: boolean; awardAmount?: number; cap?: number };

/** The shape of one `rewardConfig.get` row that this module depends on. */
export type RewardRow = {
  type: string;
  capOverridable: boolean;
  effective: { enabled: boolean };
};

/**
 * A leaf module on purpose. These decide what gets WRITTEN, and `rewardConfig.set`
 * replaces the stored row wholesale, so they need tests that do not depend on
 * rendering a Mantine table — the panel importing them is the only untested step.
 */

/**
 * Reads the overrides as WRITTEN rather than the effective values, so an input
 * left empty means "use the compiled default" and clearing one removes the
 * override instead of freezing today's default as a literal.
 */
export function storedOverrides(
  value: unknown,
  malformed: boolean
): Record<string, StoredOverride> {
  if (malformed || typeof value !== 'object' || value === null) return {};
  const rewards = (value as { rewards?: unknown }).rewards;
  if (typeof rewards !== 'object' || rewards === null) return {};
  return rewards as Record<string, StoredOverride>;
}

export const numberOrEmpty = (value: number | undefined) =>
  value === undefined ? '' : String(value);

/**
 * 🔴 `enabled` is seeded from what the grant path RESOLVED, not from what is
 * written in the row.
 *
 * They agree whenever the row is readable. When it is not, `storedOverrides`
 * returns `{}` — and seeding from that renders every switch ON, including the
 * rewards the resolver has turned OFF because their entry could not be read.
 * The operator then sees a form claiming everything is paying, and the one
 * button available in that state writes it. `effective.enabled` is already in
 * the payload the panel receives, and it is the truth.
 *
 * The amounts still come from the written row: they have no resolved equivalent
 * that distinguishes "set to 25" from "defaulted to 25", and writing the latter
 * back would freeze today's default as an override.
 */
export function initialDrafts(
  rewards: RewardRow[],
  overrides: Record<string, StoredOverride>
): Record<string, Draft> {
  const drafts: Record<string, Draft> = {};
  for (const reward of rewards) {
    const override = overrides[reward.type] ?? {};
    drafts[reward.type] = {
      enabled: reward.effective.enabled,
      awardAmount: numberOrEmpty(override.awardAmount),
      cap: numberOrEmpty(override.cap),
    };
  }
  return drafts;
}

/**
 * 🔴 Builds the WHOLE map, every time. `set` replaces the row, so a payload
 * containing only the rewards someone edited erases every other reward's
 * override — a one-line mistake with a blast radius across every reward.
 *
 * It throws rather than skipping when a reward has no row, because the delta it
 * would otherwise emit is accepted happily by the server: replace is by design
 * there, so nothing downstream can tell a deliberate clear from a dropped row.
 */
export function buildRewardsPayload({
  rewards,
  overrides,
  rows,
}: {
  rewards: RewardRow[];
  overrides: Record<string, StoredOverride>;
  rows: Record<string, Draft>;
}): Record<string, StoredOverride> {
  const payload: Record<string, StoredOverride> = {};

  // Keys the config names that no reward matches — an override staged ahead of a
  // deploy, which the read path ignores. Dropping them here would delete
  // someone's staged edit on the next unrelated save.
  for (const [type, override] of Object.entries(overrides))
    if (!rewards.some((reward) => reward.type === type)) payload[type] = override;

  for (const reward of rewards) {
    const row = rows[reward.type];
    if (!row)
      throw new Error(
        `No draft for reward "${reward.type}". Saving would drop its override, and the server cannot tell that from a deliberate clear.`
      );

    const entry: StoredOverride = {};
    // Only what DIFFERS from the compiled default is stored, so a later change to
    // that default flows through instead of being frozen behind an override
    // written months earlier. An empty input therefore removes the override.
    if (!row.enabled) entry.enabled = false;
    if (row.awardAmount !== '') entry.awardAmount = Number(row.awardAmount);

    if (reward.capOverridable) {
      if (row.cap !== '') entry.cap = Number(row.cap);
    } else {
      // No input is rendered for a multi-cap reward, so there is no draft to
      // carry — but a stored cap must not be deleted by a save the operator made
      // about something else. The resolver refuses it today; it stops refusing it
      // the day that reward's cap table shrinks to one entry.
      const storedCap = overrides[reward.type]?.cap;
      if (storedCap !== undefined) entry.cap = storedCap;
    }

    if (Object.keys(entry).length) payload[reward.type] = entry;
  }

  return payload;
}

/**
 * The complete mutation input. Extracted from the submit handler so the guard
 * the panel is responsible for sending — `expectedHash` — is covered: it has a
 * single call site, and dropping it there returns production to last-write-wins
 * without failing anything.
 */
export function buildSetInput({
  rewards,
  overrides,
  rows,
  hash,
  force = false,
}: {
  rewards: RewardRow[];
  overrides: Record<string, StoredOverride>;
  rows: Record<string, Draft>;
  hash: string;
  force?: boolean;
}) {
  return {
    rewards: buildRewardsPayload({ rewards, overrides, rows }),
    expectedHash: hash,
    force,
  };
}

/**
 * The panel renders one input per field here. Driving it off the server's list
 * means a field added to `rewardOverrideSchema` and not to the panel fails a
 * test rather than being silently deleted from the row on the next save.
 */
export const PANEL_OVERRIDE_FIELDS = OVERRIDE_FIELDS;
