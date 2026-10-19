import { describe, expect, it } from 'vitest';
import {
  describeInheritedMetric,
  inheritedMetricPrivacy,
} from '~/components/Resource/Forms/metric-privacy-hints';

describe('inheritedMetricPrivacy', () => {
  it("gives a model the owner's account default", () => {
    expect(
      inheritedMetricPrivacy({
        level: 'model',
        userSettings: { hideModelDownloads: true },
        modelMeta: { metricVisibility: { downloads: 'show' } },
        isOwner: true,
      })
    ).toEqual({
      buzz: { hidden: false, source: 'account' },
      downloads: { hidden: true, source: 'account' },
      generations: { hidden: false, source: 'account' },
    });
  });

  it("gives a version the model's explicit setting over the account default", () => {
    const states = inheritedMetricPrivacy({
      level: 'version',
      userSettings: { hideModelDownloads: true },
      modelMeta: { metricVisibility: { downloads: 'show' }, hideBuzz: true },
      isOwner: true,
    });
    expect(states.downloads).toEqual({ hidden: false, source: 'model' });
    expect(states.buzz).toEqual({ hidden: true, source: 'model' });
    expect(states.generations).toEqual({ hidden: false, source: 'account' });
  });

  it("does not stand in the editor's own defaults for a model they do not own", () => {
    const states = inheritedMetricPrivacy({
      level: 'version',
      userSettings: { hideModelDownloads: true },
      modelMeta: { metricVisibility: { generations: 'hide' } },
      isOwner: false,
    });
    expect(states.downloads).toEqual({ hidden: null, source: 'owner' });
    expect(states.generations).toEqual({ hidden: true, source: 'model' });
  });
});

describe('describeInheritedMetric', () => {
  it.each([
    [{ hidden: true, source: 'account' } as const, 'Hidden, from your account default'],
    [{ hidden: false, source: 'model' } as const, 'Shown, from this model'],
    [{ hidden: null, source: 'owner' } as const, "Follows the owner's account default"],
  ])('%o reads %s', (state, text) => {
    expect(describeInheritedMetric(state)).toBe(text);
  });
});
