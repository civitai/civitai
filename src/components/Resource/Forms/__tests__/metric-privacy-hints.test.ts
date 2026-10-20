import { describe, expect, it } from 'vitest';
import {
  metricPrivacyAccessFor,
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

  it('reads the owner’s defaults when the server supplied them to a moderator', () => {
    const states = inheritedMetricPrivacy({
      level: 'model',
      isOwner: false,
      ownerDefaults: { buzz: true, downloads: false, generations: false },
    });
    expect(states.buzz).toEqual({ hidden: true, source: 'owner' });
    expect(states.downloads).toEqual({ hidden: false, source: 'owner' });
  });
});

describe('metricPrivacyAccessFor', () => {
  // access follows the owner's membership, not the editor's
  it('gives a moderator editing someone else’s model live controls', () => {
    expect(metricPrivacyAccessFor({ isOwner: false, ownerHasMembership: false })).toBe('moderator');
  });

  it('gives an owner controls only while their membership is active', () => {
    expect(metricPrivacyAccessFor({ isOwner: true, ownerHasMembership: true })).toBe('owner');
    expect(metricPrivacyAccessFor({ isOwner: true, ownerHasMembership: false })).toBe(
      'owner-inactive'
    );
  });
});
