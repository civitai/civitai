import { describe, expect, it, vi } from 'vitest';
import {
  anyMetricHidden,
  gateHiddenMetrics,
  getMetaMetricPrivacy,
  getUserMetricPrivacyDefaults,
  noHiddenMetrics,
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

describe('v1 API version-stats gating (prepareModelVersionResponse / getStatsForVersion)', () => {
  // v1 exposes only download at the version level; it must honor the version-level
  // hide even when model + user defaults are clear (the precedence bug), and revert
  // on lapse. Public API => isOwnerOrModerator: false.
  it('version-only hide downloads => hidden for a public v1 caller (active member)', () => {
    const hidden = resolveVersionHiddenMetrics({
      versionMeta: { hideDownloads: true },
      modelMeta: {},
      userSettings: {},
      isOwnerOrModerator: false,
      hasValidMembership: true,
    });
    expect(hidden.downloads).toBe(true);
  });

  it('version-only hide reverts to visible when the owner has lapsed', () => {
    const hidden = resolveVersionHiddenMetrics({
      versionMeta: { hideDownloads: true },
      modelMeta: {},
      userSettings: {},
      isOwnerOrModerator: false,
      hasValidMembership: false,
    });
    expect(hidden.downloads).toBe(false);
  });

  it('model-level hide still cascades to version stats in v1', () => {
    const hidden = resolveVersionHiddenMetrics({
      versionMeta: {},
      modelMeta: { hideDownloads: true },
      userSettings: {},
      isOwnerOrModerator: false,
      hasValidMembership: true,
    });
    expect(hidden.downloads).toBe(true);
  });
});

describe('anyMetricHidden', () => {
  it('true when any flag set, false otherwise', () => {
    expect(anyMetricHidden(NONE)).toBe(false);
    expect(anyMetricHidden({ buzz: false, downloads: true, generations: false })).toBe(true);
  });
});

/**
 * Short-circuit invariant (the read-path cost optimization): when NO owner flag is set
 * — no model/version meta flag AND no user default — the resolvers return NONE for BOTH
 * membership values. This is what lets the hot read paths skip the membership lookup
 * entirely (a redis/DB round-trip) whenever `anyMetricHidden(meta) || anyMetricHidden(
 * userDefaults)` is false: the output is provably identical to running the full
 * resolution. A regression here would break the "skip when nothing hidden" guarantee.
 */
describe('short-circuit: membership is irrelevant when nothing is hidden', () => {
  it('resolveModelHiddenMetrics returns NONE for member AND non-member when no flags set', () => {
    const asMember = resolveModelHiddenMetrics({
      modelMeta: {},
      userSettings: {},
      isOwnerOrModerator: false,
      hasValidMembership: true,
    });
    const asNonMember = resolveModelHiddenMetrics({
      modelMeta: {},
      userSettings: {},
      isOwnerOrModerator: false,
      hasValidMembership: false,
    });
    expect(asMember).toEqual(NONE);
    expect(asNonMember).toEqual(NONE);
    expect(asMember).toEqual(asNonMember); // membership value cannot change the output
  });

  it('resolveVersionHiddenMetrics returns NONE for member AND non-member when no flags set', () => {
    const asMember = resolveVersionHiddenMetrics({
      versionMeta: {},
      modelMeta: {},
      userSettings: {},
      isOwnerOrModerator: false,
      hasValidMembership: true,
    });
    const asNonMember = resolveVersionHiddenMetrics({
      versionMeta: {},
      modelMeta: {},
      userSettings: {},
      isOwnerOrModerator: false,
      hasValidMembership: false,
    });
    expect(asMember).toEqual(NONE);
    expect(asNonMember).toEqual(NONE);
    expect(asMember).toEqual(asNonMember);
  });

  it('once ANY flag is set, membership DOES matter (so the short-circuit must not fire)', () => {
    const gate = { modelMeta: { hideBuzz: true }, isOwnerOrModerator: false } as const;
    expect(resolveModelHiddenMetrics({ ...gate, hasValidMembership: true })).toEqual({
      buzz: true,
      downloads: false,
      generations: false,
    });
    expect(resolveModelHiddenMetrics({ ...gate, hasValidMembership: false })).toEqual(NONE);
  });
});

describe('noHiddenMetrics', () => {
  it('returns an all-visible result', () => {
    expect(noHiddenMetrics()).toEqual(NONE);
  });

  it('returns a FRESH object each call (no shared mutable ref)', () => {
    const a = noHiddenMetrics();
    const b = noHiddenMetrics();
    expect(a).not.toBe(b);
    a.downloads = true; // mutating one must not affect the other
    expect(b.downloads).toBe(false);
  });
});

/**
 * Read-time flag gate (`modelMetricPrivacyReadtime`). This is the choke-point every
 * gated surface (getModel / associated-resources / browse feed) uses to select
 * between running #3266's metric-privacy resolution (flag ON) and skipping it
 * entirely (flag OFF). ON must be byte-identical to calling the resolver directly;
 * OFF must NOT invoke the resolver and must emit raw (all-visible) metrics.
 */
describe('gateHiddenMetrics — read-time flag gate', () => {
  it('ON: runs the resolver and returns its result unchanged (current behaviour)', () => {
    const resolve = vi.fn(() =>
      resolveModelHiddenMetrics({
        modelMeta: { hideDownloads: true },
        isOwnerOrModerator: false,
        hasValidMembership: true,
      })
    );
    const result = gateHiddenMetrics(true, resolve);
    expect(resolve).toHaveBeenCalledTimes(1); // resolution IS invoked when ON
    expect(result).toEqual({ buzz: false, downloads: true, generations: false });
  });

  it('OFF: does NOT invoke the resolver and returns raw all-visible metrics', () => {
    const resolve = vi.fn(() =>
      resolveModelHiddenMetrics({
        modelMeta: ALL_HIDDEN, // would hide everything if it ran
        isOwnerOrModerator: false,
        hasValidMembership: true,
      })
    );
    const result = gateHiddenMetrics(false, resolve);
    expect(resolve).not.toHaveBeenCalled(); // the whole resolution is skipped
    expect(result).toEqual(NONE); // raw metrics — nothing hidden (pre-#3266)
  });

  it('OFF path returns a fresh object (parity with the resolver contract)', () => {
    const a = gateHiddenMetrics(false, () => noHiddenMetrics());
    const b = gateHiddenMetrics(false, () => noHiddenMetrics());
    expect(a).not.toBe(b);
  });
});
