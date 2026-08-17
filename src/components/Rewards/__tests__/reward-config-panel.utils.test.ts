import { describe, expect, it } from 'vitest';
import {
  buildRewardsPayload,
  buildSetInput,
  initialDrafts,
  numberOrEmpty,
  PANEL_OVERRIDE_FIELDS,
  storedOverrides,
} from '~/components/Rewards/reward-config-panel.utils';
import { rewardOverrideSchema } from '~/server/rewards/reward-config';

/**
 * `rewardConfig.set` REPLACES the stored row, so every property here is about
 * what the panel puts in a payload it did not think it was changing — and about
 * what it seeds the form from, which decides that payload.
 *
 * A leaf module by design: importing the panel itself would pull Mantine, the
 * tRPC client and the signal providers into a node-environment suite, where one
 * import-time throw contributes zero tests and reports nothing.
 */

const REWARDS = [
  { type: 'dailyBoost', capOverridable: true, effective: { enabled: true } },
  { type: 'goodContent', capOverridable: true, effective: { enabled: true } },
  { type: 'imagePostedToModel', capOverridable: false, effective: { enabled: true } },
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

describe('initialDrafts', () => {
  // 🔴 The malformed row is the whole reason this feature exists, and it is the
  // one where `storedOverrides` returns `{}`. Seeding the switch from that
  // renders every reward ON — including ones the resolver has turned OFF because
  // their entry could not be read — and the only button available in that state
  // writes exactly what is on screen.
  it('seeds the switch from what the grant path resolved, not from the unreadable row', () => {
    const rewards = [
      { type: 'firstDailyFollow', capOverridable: true, effective: { enabled: false } },
      { type: 'goodContent', capOverridable: true, effective: { enabled: true } },
    ];

    const drafts = initialDrafts(rewards, {});

    expect(drafts.firstDailyFollow.enabled).toBe(false);
    expect(drafts.goodContent.enabled).toBe(true);
  });

  it('seeds the amounts from the written row, so an unset field stays empty', () => {
    const drafts = initialDrafts(REWARDS, { goodContent: { awardAmount: 1 } });

    expect(drafts.goodContent).toEqual({ enabled: true, awardAmount: '1', cap: '' });
    expect(drafts.dailyBoost).toEqual({ enabled: true, awardAmount: '', cap: '' });
  });

  it('renders a stored zero as a zero rather than as unset', () => {
    expect(
      initialDrafts(REWARDS, { goodContent: { awardAmount: 0 } }).goodContent.awardAmount
    ).toBe('0');
  });
});

describe('storedOverrides', () => {
  it('reads the overrides out of a well-formed row', () => {
    const value = { rewards: { goodContent: { awardAmount: 1 } } };

    expect(storedOverrides(value, false)).toEqual({ goodContent: { awardAmount: 1 } });
  });

  // Returning the row's contents here would put unvalidated values into inputs
  // and back into the next save.
  it('returns nothing for a row the server flagged as unreadable', () => {
    const value = { rewards: { goodContent: { awardAmount: 'lots' } } };

    expect(storedOverrides(value, true)).toEqual({});
  });

  it('survives a row that is not shaped like a config at all', () => {
    for (const value of [null, 'disabled', 42, [], {}, { rewards: null }])
      expect(storedOverrides(value, false)).toEqual({});
  });
});

describe('numberOrEmpty', () => {
  // Inverting this pre-fills every input with today's compiled default, which the
  // next save then writes as a literal override — freezing the default against
  // any later change to it, which is the failure the empty-means-default design
  // exists to avoid.
  it('maps only undefined to empty', () => {
    expect(numberOrEmpty(undefined)).toBe('');
    expect(numberOrEmpty(0)).toBe('0');
    expect(numberOrEmpty(25)).toBe('25');
  });
});

describe('buildRewardsPayload', () => {
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

  // 🔴 The delta shape. The server accepts a partial happily — replace is by
  // design there — so nothing downstream can tell a dropped row from a
  // deliberate clear, and this is the only place the difference is knowable.
  it('refuses to build a payload that is missing a reward it was given', () => {
    const rows = { dailyBoost: row({ enabled: false }) };

    expect(() => buildRewardsPayload({ rewards: REWARDS, overrides: {}, rows })).toThrow(
      /No draft for reward "goodContent"/
    );
  });

  it('preserves an override for a reward that has not shipped yet', () => {
    const overrides = { futureReward: { awardAmount: 5 } };

    expect(buildRewardsPayload({ rewards: REWARDS, overrides, rows: untouched() })).toEqual({
      futureReward: { awardAmount: 5 },
    });
  });

  it('writes nothing for a reward left at its defaults', () => {
    expect(buildRewardsPayload({ rewards: REWARDS, overrides: {}, rows: untouched() })).toEqual({});
  });

  it('removes an override when its input is cleared', () => {
    const overrides = { goodContent: { awardAmount: 1, cap: 50 } };
    const rows = { ...untouched(), goodContent: row({ awardAmount: '', cap: '50' }) };

    expect(buildRewardsPayload({ rewards: REWARDS, overrides, rows })).toEqual({
      goodContent: { cap: 50 },
    });
  });

  it('never writes a cap the operator typed for a reward with multiple caps', () => {
    const rows = { ...untouched(), imagePostedToModel: row({ cap: '9999' }) };

    expect(buildRewardsPayload({ rewards: REWARDS, overrides: {}, rows })).toEqual({});
  });

  // No input is rendered for that reward, so an ordinary save about something
  // else would otherwise delete a stored cap silently. Inert while the resolver
  // refuses it; live the day that reward's cap table shrinks to one entry.
  it('carries forward a stored cap for a reward with multiple caps', () => {
    const overrides = { imagePostedToModel: { cap: 5000 } };

    expect(buildRewardsPayload({ rewards: REWARDS, overrides, rows: untouched() })).toEqual({
      imagePostedToModel: { cap: 5000 },
    });
  });

  it('records only the off state, never an explicit on', () => {
    const rows = { ...untouched(), dailyBoost: row({ enabled: true }) };

    expect(buildRewardsPayload({ rewards: REWARDS, overrides: {}, rows })).toEqual({});
  });

  it('coerces the inputs to numbers, since they are strings in the form', () => {
    const rows = { ...untouched(), goodContent: row({ awardAmount: '2', cap: '100' }) };

    expect(buildRewardsPayload({ rewards: REWARDS, overrides: {}, rows }).goodContent).toEqual({
      awardAmount: 2,
      cap: 100,
    });
  });

  it('writes a zero rather than treating it as empty', () => {
    const rows = { ...untouched(), goodContent: row({ awardAmount: '0' }) };

    expect(buildRewardsPayload({ rewards: REWARDS, overrides: {}, rows }).goodContent).toEqual({
      awardAmount: 0,
    });
  });
});

describe('buildSetInput', () => {
  // 🔴 The panel is the only caller that supplies `expectedHash`, and this is the
  // only place it is assembled. Dropping it there silently returns production to
  // last-write-wins: the service still accepts the write, the router still
  // forwards, and every other test in the repo passes.
  it('sends the hash the panel was given, so the write is checked against it', () => {
    const input = buildSetInput({
      rewards: REWARDS,
      overrides: {},
      rows: untouched(),
      hash: 'abc123',
    });

    expect(input.expectedHash).toBe('abc123');
  });

  it('does not force an overwrite unless asked to', () => {
    const input = buildSetInput({
      rewards: REWARDS,
      overrides: {},
      rows: untouched(),
      hash: 'abc123',
    });

    expect(input.force).toBe(false);
  });

  it('forces only when told', () => {
    const input = buildSetInput({
      rewards: REWARDS,
      overrides: {},
      rows: untouched(),
      hash: 'abc123',
      force: true,
    });

    expect(input.force).toBe(true);
  });

  it('carries the same payload the builder produces', () => {
    const rows = { ...untouched(), goodContent: row({ awardAmount: '2' }) };

    expect(buildSetInput({ rewards: REWARDS, overrides: {}, rows, hash: 'h' }).rewards).toEqual({
      goodContent: { awardAmount: 2 },
    });
  });
});

// A field added to the schema and not to the panel is not a missing input — the
// panel rebuilds each entry from the fields it knows and `set` replaces the row,
// so every override using the new field is deleted by the next unrelated save.
describe('the panel covers every override field', () => {
  it('knows exactly the fields the schema accepts', () => {
    expect([...PANEL_OVERRIDE_FIELDS].sort()).toEqual(
      Object.keys(rewardOverrideSchema.shape).sort()
    );
  });
});
