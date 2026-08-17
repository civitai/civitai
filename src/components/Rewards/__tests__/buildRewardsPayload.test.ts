import { describe, expect, it } from 'vitest';
import { buildRewardsPayload } from '~/components/Rewards/RewardConfigPanel';

/**
 * `rewardConfig.set` REPLACES the stored row. Every property here is about what
 * the panel must therefore include in a payload it did not think it was changing.
 */

const REWARDS = [
  { type: 'dailyBoost', capOverridable: true },
  { type: 'goodContent', capOverridable: true },
  { type: 'imagePostedToModel', capOverridable: false },
];

const row = (over: Partial<{ enabled: boolean; awardAmount: string; cap: string }> = {}) => ({
  enabled: true,
  awardAmount: '',
  cap: '',
  ...over,
});

const untouched = () => ({
  dailyBoost: row(),
  goodContent: row(),
  imagePostedToModel: row(),
});

describe('buildRewardsPayload', () => {
  // The one that matters: editing one reward must not drop the others' overrides.
  it('keeps every other reward’s override when one reward is edited', () => {
    const overrides = { goodContent: { awardAmount: 1 }, dailyBoost: { enabled: false } };
    const rows = {
      ...untouched(),
      dailyBoost: row({ enabled: false }),
      goodContent: row({ awardAmount: '1' }),
      imagePostedToModel: row({ awardAmount: '60' }),
    };

    expect(buildRewardsPayload({ rewards: REWARDS, overrides, rows })).toEqual({
      dailyBoost: { enabled: false },
      goodContent: { awardAmount: 1 },
      imagePostedToModel: { awardAmount: 60 },
    });
  });

  // An override staged for a reward that does not exist yet. The read path
  // ignores unknown keys, so nothing else would notice this being deleted.
  it('preserves an override for a reward that has not shipped yet', () => {
    const overrides = { futureReward: { awardAmount: 5 } };

    expect(buildRewardsPayload({ rewards: REWARDS, overrides, rows: untouched() })).toEqual({
      futureReward: { awardAmount: 5 },
    });
  });

  it('writes nothing for a reward left at its defaults', () => {
    expect(buildRewardsPayload({ rewards: REWARDS, overrides: {}, rows: untouched() })).toEqual({});
  });

  // Empty means "use the compiled default", so clearing an input has to REMOVE
  // the override rather than write today's default as a literal — otherwise a
  // later change to that default never reaches the reward.
  it('removes an override when its input is cleared', () => {
    const overrides = { goodContent: { awardAmount: 1, cap: 50 } };
    const rows = { ...untouched(), goodContent: row({ awardAmount: '', cap: '50' }) };

    expect(buildRewardsPayload({ rewards: REWARDS, overrides, rows })).toEqual({
      goodContent: { cap: 50 },
    });
  });

  it('never writes a cap for a reward whose cap is not overridable', () => {
    const rows = { ...untouched(), imagePostedToModel: row({ cap: '9999' }) };

    expect(buildRewardsPayload({ rewards: REWARDS, overrides: {}, rows })).toEqual({});
  });

  // `enabled` defaults to on, so an explicit `true` is noise in the row — and
  // writing it would make "on" look like a deliberate override in the editor.
  it('records only the off state, never an explicit on', () => {
    const rows = { ...untouched(), dailyBoost: row({ enabled: true }) };

    expect(buildRewardsPayload({ rewards: REWARDS, overrides: {}, rows })).toEqual({});
  });

  it('coerces the inputs to numbers, since they are strings in the form', () => {
    const rows = { ...untouched(), goodContent: row({ awardAmount: '2', cap: '100' }) };

    const payload = buildRewardsPayload({ rewards: REWARDS, overrides: {}, rows });

    expect(payload.goodContent).toEqual({ awardAmount: 2, cap: 100 });
  });

  it('writes a zero rather than treating it as empty', () => {
    const rows = { ...untouched(), goodContent: row({ awardAmount: '0' }) };

    expect(buildRewardsPayload({ rewards: REWARDS, overrides: {}, rows }).goodContent).toEqual({
      awardAmount: 0,
    });
  });
});
