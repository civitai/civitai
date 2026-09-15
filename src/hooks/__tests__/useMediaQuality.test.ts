import { describe, expect, it, vi } from 'vitest';

// `useMediaQuality`'s only hook call is `useCurrentUser`, so with that stubbed it is a pure
// function and the node suite can drive it directly.
const viewer = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => viewer.current }));

import { useMediaQuality, useOptimizedFlag } from '~/hooks/useMediaQuality';

const useQualityAs = (user: null | Record<string, unknown>) => {
  viewer.current = user;
  return useMediaQuality();
};
const lossless = (imageFormat: string) => ({ filePreferences: { imageFormat } });

describe('useMediaQuality entitlement', () => {
  it('serves a signed-out viewer compressed', () => {
    expect(useQualityAs(null).quality).toBe('compressed');
    expect(useQualityAs(null).canUseLossless).toBe(false);
  });

  it('serves an unset preference compressed, member or not', () => {
    expect(useQualityAs({}).quality).toBe('compressed');
    expect(useQualityAs({ isPaidMember: true }).quality).toBe('compressed');
  });

  it('gives lossless to a paid member who chose it', () => {
    expect(useQualityAs({ isPaidMember: true, ...lossless('metadata') }).quality).toBe('lossless');
  });

  it('holds a NON-member at compressed even though they chose lossless', () => {
    // 🔴 The paid-tier deliverable. Deleting the entitlement check leaves every other test in the
    // repo green, so this row is the one that has to fail — the 12,717 accounts on a stored
    // `'metadata'` are exactly this viewer.
    expect(useQualityAs({ isPaidMember: false, ...lossless('metadata') }).quality).toBe(
      'compressed'
    );
  });

  it('holds a FREE-tier subscriber at compressed', () => {
    // `isMember` is `tier != null`, which is TRUE here; only `isPaidMember` excludes tier 'free'.
    // Swapping the predicate would hand lossless to everyone carrying a subscription row.
    expect(
      useQualityAs({ tier: 'free', isPaidMember: false, ...lossless('metadata') }).quality
    ).toBe('compressed');
  });

  it('reads an explicit compressed choice as compressed for a member', () => {
    expect(useQualityAs({ isPaidMember: true, ...lossless('optimized') }).quality).toBe(
      'compressed'
    );
  });

  it.each(['metadata', 'optimized', 'nonsense'])(
    'never reports lossless without the entitlement, whatever is stored (%s)',
    (imageFormat) => {
      const { quality, canUseLossless } = useQualityAs({
        isPaidMember: false,
        ...lossless(imageFormat),
      });
      expect(canUseLossless).toBe(false);
      expect(quality).toBe('compressed');
    }
  );
});

describe('useOptimizedFlag', () => {
  it('is undefined rather than false for lossless', () => {
    // `getEdgeUrl` emits any value that is not undefined, and `optimized=false` is a URL shape no
    // other surface produces — a second CDN cache key for bytes that already exist under the first.
    viewer.current = { isPaidMember: true, ...lossless('metadata') };
    expect(useOptimizedFlag()).toBeUndefined();
  });

  it('is true for a compressed viewer', () => {
    viewer.current = null;
    expect(useOptimizedFlag()).toBe(true);
  });
});
