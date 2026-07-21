import { describe, expect, it } from 'vitest';
import {
  anyMetricHidden,
  getMetaMetricPrivacy,
  getUserMetricPrivacyDefaults,
  resolveModelHiddenMetrics,
  resolveVersionHiddenMetrics,
} from '~/server/utils/model-metric-privacy';

/**
 * Read-time gating contract for Creator Controls metric privacy. The three levels
 * (user default / model / version) and the CP-membership gate + owner/mod bypass are
 * the security-relevant rules — a regression here leaks a hidden metric or hides a
 * lapsed creator's stats. These exercise the REAL resolve functions the surfaces use.
 */

const ALL_HIDDEN = { hideBuzz: true, hideDownloads: true, hideGenerations: true };
const NONE = { buzz: false, downloads: false, generations: false };

describe('getMetaMetricPrivacy / getUserMetricPrivacyDefaults', () => {
  it('reads model/version meta flags', () => {
    expect(getMetaMetricPrivacy({ hideBuzz: true })).toEqual({
      buzz: true,
      downloads: false,
      generations: false,
    });
    expect(getMetaMetricPrivacy(null)).toEqual(NONE);
    expect(getMetaMetricPrivacy(undefined)).toEqual(NONE);
  });

  it('reads user-default flags', () => {
    expect(getUserMetricPrivacyDefaults({ hideModelDownloads: true })).toEqual({
      buzz: false,
      downloads: true,
      generations: false,
    });
    expect(getUserMetricPrivacyDefaults(null)).toEqual(NONE);
  });
});

describe('resolveModelHiddenMetrics — CP gate + bypass', () => {
  it('owner/moderator always sees real stats (bypass)', () => {
    expect(
      resolveModelHiddenMetrics({
        modelMeta: ALL_HIDDEN,
        isOwnerOrModerator: true,
        hasValidMembership: true,
      })
    ).toEqual(NONE);
  });

  it('non-owner sees hidden metric when owner is an active CP member', () => {
    expect(
      resolveModelHiddenMetrics({
        modelMeta: { hideDownloads: true },
        isOwnerOrModerator: false,
        hasValidMembership: true,
      })
    ).toEqual({ buzz: false, downloads: true, generations: false });
  });

  it('non-owner sees REAL stats when owner has lapsed (revert, no write)', () => {
    expect(
      resolveModelHiddenMetrics({
        modelMeta: ALL_HIDDEN,
        userSettings: { hideModelBuzz: true },
        isOwnerOrModerator: false,
        hasValidMembership: false,
      })
    ).toEqual(NONE);
  });

  it('honors the USER default even when model meta has no flag', () => {
    expect(
      resolveModelHiddenMetrics({
        modelMeta: {},
        userSettings: { hideModelGenerations: true },
        isOwnerOrModerator: false,
        hasValidMembership: true,
      })
    ).toEqual({ buzz: false, downloads: false, generations: true });
  });

  it('model flag OR user default (union)', () => {
    expect(
      resolveModelHiddenMetrics({
        modelMeta: { hideBuzz: true },
        userSettings: { hideModelDownloads: true },
        isOwnerOrModerator: false,
        hasValidMembership: true,
      })
    ).toEqual({ buzz: true, downloads: true, generations: false });
  });
});

describe('resolveVersionHiddenMetrics — precedence (version OR model OR user)', () => {
  it('hidden when only the VERSION flag is set', () => {
    expect(
      resolveVersionHiddenMetrics({
        versionMeta: { hideDownloads: true },
        modelMeta: {},
        userSettings: {},
        isOwnerOrModerator: false,
        hasValidMembership: true,
      })
    ).toEqual({ buzz: false, downloads: true, generations: false });
  });

  it('hidden when only the MODEL flag is set (governs version stats too)', () => {
    expect(
      resolveVersionHiddenMetrics({
        versionMeta: {},
        modelMeta: { hideBuzz: true },
        userSettings: {},
        isOwnerOrModerator: false,
        hasValidMembership: true,
      })
    ).toEqual({ buzz: true, downloads: false, generations: false });
  });

  it('hidden when only the USER default is set', () => {
    expect(
      resolveVersionHiddenMetrics({
        versionMeta: {},
        modelMeta: {},
        userSettings: { hideModelGenerations: true },
        isOwnerOrModerator: false,
        hasValidMembership: true,
      })
    ).toEqual({ buzz: false, downloads: false, generations: true });
  });

  it('lapsed membership reverts every level to visible', () => {
    expect(
      resolveVersionHiddenMetrics({
        versionMeta: ALL_HIDDEN,
        modelMeta: ALL_HIDDEN,
        userSettings: { hideModelBuzz: true },
        isOwnerOrModerator: false,
        hasValidMembership: false,
      })
    ).toEqual(NONE);
  });

  it('owner/mod bypass at the version level', () => {
    expect(
      resolveVersionHiddenMetrics({
        versionMeta: ALL_HIDDEN,
        isOwnerOrModerator: true,
        hasValidMembership: true,
      })
    ).toEqual(NONE);
  });
});

describe('anyMetricHidden', () => {
  it('true when any flag set, false otherwise', () => {
    expect(anyMetricHidden(NONE)).toBe(false);
    expect(anyMetricHidden({ buzz: false, downloads: true, generations: false })).toBe(true);
  });
});
