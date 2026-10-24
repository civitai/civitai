import { describe, expect, it } from 'vitest';

import {
  compareSemver,
  highestTagVersion,
  parseSemver,
  releaseSkew,
  skewMessage,
} from '../lib/release-version.mjs';

// Guards for scripts/release-app.mjs's "is this branch behind the released
// history?" check.
//
// The concrete state these are written against, measured 2026-08-17: apps/moderator
// is 0.0.1 on `main`, 0.0.26 is live in production, and all 26 releases were cut
// from `moderator-app-pages` — 211 commits that never merged to main. Expected
// values below are written from the released tag list and the deployment, NOT read
// back out of the implementation.

const MODERATOR_TAGS = Array.from({ length: 26 }, (_, i) => `moderator-v0.0.${i + 1}`);

describe('parseSemver', () => {
  it('accepts a plain x.y.z and rejects anything else', () => {
    expect(parseSemver('0.0.26')).toEqual({ major: 0, minor: 0, patch: 26 });
    expect(parseSemver('1.9.12')).toEqual({ major: 1, minor: 9, patch: 12 });
    expect(parseSemver('0.0.26-rc.1')).toBeNull();
    expect(parseSemver('v0.0.26')).toBeNull();
    expect(parseSemver('')).toBeNull();
    expect(parseSemver(undefined)).toBeNull();
  });
});

describe('compareSemver', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareSemver('0.0.2', '0.0.26')).toBeLessThan(0);
    expect(compareSemver('0.1.0', '0.0.26')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareSemver('0.0.26', '0.0.26')).toBe(0);
  });

  // 0.0.2 vs 0.0.26 is the pair a string comparison gets wrong ('0.0.2' > '0.0.26'
  // lexicographically), and it is exactly the pair this app is sitting on.
  it('compares numerically, not lexicographically', () => {
    expect(compareSemver('0.0.9', '0.0.10')).toBeLessThan(0);
    expect(compareSemver('0.0.2', '0.0.26')).toBeLessThan(0);
  });
});

describe('highestTagVersion', () => {
  it('finds the highest released version for the prefix', () => {
    expect(highestTagVersion(MODERATOR_TAGS, 'moderator-v')).toBe('0.0.26');
  });

  it('ignores tags belonging to other apps', () => {
    const mixed = [...MODERATOR_TAGS, 'auth-app-v9.9.9', 'event-engine-v1.9.12'];
    expect(highestTagVersion(mixed, 'moderator-v')).toBe('0.0.26');
  });

  it('ignores unparseable tags instead of throwing', () => {
    // One hand-cut oddity must not disable the guard for every later release.
    const withJunk = [...MODERATOR_TAGS, 'moderator-vNIGHTLY', 'moderator-v0.0.26-hotfix'];
    expect(highestTagVersion(withJunk, 'moderator-v')).toBe('0.0.26');
  });

  it('returns null when the app has never been released', () => {
    expect(highestTagVersion(MODERATOR_TAGS, 'brand-new-app-v')).toBeNull();
  });
});

describe('releaseSkew', () => {
  it('refuses a release from a branch behind the released history', () => {
    const skew = releaseSkew({
      currentVersion: '0.0.1',
      tags: MODERATOR_TAGS,
      tagPrefix: 'moderator-v',
    });
    expect(skew).toEqual({ behind: true, current: '0.0.1', highest: '0.0.26' });
  });

  // The case with no natural brake, and the reason this guard exists: a minor bump
  // off the stale base computes 0.1.0, which collides with NOTHING, becomes the
  // highest tag for the app, and is therefore what the Flux ImagePolicy selects.
  // The guard has to fire on the branch state, before the bump is even computed.
  it('fires on the stale base regardless of which bump would follow', () => {
    expect(
      releaseSkew({ currentVersion: '0.0.1', tags: MODERATOR_TAGS, tagPrefix: 'moderator-v' })
        .behind
    ).toBe(true);
    expect(MODERATOR_TAGS).not.toContain('moderator-v0.1.0');
  });

  it('allows a release when the branch matches the released history', () => {
    // The legitimate path: releasing 0.0.27 from the branch that carries 0.0.26.
    expect(
      releaseSkew({ currentVersion: '0.0.26', tags: MODERATOR_TAGS, tagPrefix: 'moderator-v' })
    ).toEqual({ behind: false, current: '0.0.26', highest: '0.0.26' });
  });

  it('allows a release when the branch is ahead', () => {
    expect(
      releaseSkew({ currentVersion: '0.1.0', tags: MODERATOR_TAGS, tagPrefix: 'moderator-v' })
        .behind
    ).toBe(false);
  });

  it('allows the first ever release of an app', () => {
    expect(
      releaseSkew({ currentVersion: '0.0.1', tags: MODERATOR_TAGS, tagPrefix: 'storage-v' })
    ).toEqual({ behind: false, current: '0.0.1', highest: null });
  });

  it('throws rather than passing when package.json holds a non-semver version', () => {
    expect(() =>
      releaseSkew({ currentVersion: 'nightly', tags: MODERATOR_TAGS, tagPrefix: 'moderator-v' })
    ).toThrow(/not a plain x\.y\.z/);
  });
});

describe('skewMessage', () => {
  it('names the app, both versions, and the branch', () => {
    const msg = skewMessage({
      appDir: 'apps/moderator',
      tagPrefix: 'moderator-v',
      current: '0.0.1',
      highest: '0.0.26',
      branch: 'main',
    });
    expect(msg).toContain('apps/moderator/package.json is 0.0.1');
    expect(msg).toContain('moderator-v0.0.26 is already released');
    expect(msg).toContain("on 'main'");
  });

  // The remedy has to say "fix the branch", because the obvious reading — set the
  // number to the released one — removes the tag collision that is currently the
  // only thing preventing a stale deploy.
  it('steers away from hand-setting the version', () => {
    const msg = skewMessage({
      appDir: 'apps/moderator',
      tagPrefix: 'moderator-v',
      current: '0.0.1',
      highest: '0.0.26',
      branch: 'main',
    });
    expect(msg).toContain('Fix the branch, not the number');
    expect(msg).toContain('Setting the version to 0.0.26 by hand removes the collision');
  });
});
