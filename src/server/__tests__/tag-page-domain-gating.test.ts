import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as TagService from '~/server/services/tag.service';

/**
 * Which rule runs is decided in the page resolver, and the two rules are deliberately inert on
 * each other's domain — so swapping them disables the deindex on BOTH domains and every unit test
 * of the rules themselves still passes. This is the only place that mistake is visible.
 */

const { getTagPageSeoData, shouldDeIndexMatureOnlyTag, shouldDeIndexSafeOnlyTag, isGreen } =
  vi.hoisted(() => ({
    getTagPageSeoData: vi.fn(),
    shouldDeIndexMatureOnlyTag: vi.fn().mockReturnValue(false),
    shouldDeIndexSafeOnlyTag: vi.fn().mockReturnValue(false),
    isGreen: { value: true },
  }));

vi.mock('~/server/services/tag.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TagService>()),
  getTagPageSeoData,
  shouldDeIndexMatureOnlyTag,
  shouldDeIndexSafeOnlyTag,
}));

vi.mock('~/server/services/system-cache', async () => ({ getBlockedBrowsingTags: async () => [] }));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps:
    ({ resolver }: { resolver: (args: unknown) => unknown }) =>
    (ctx: unknown) =>
      resolver({
        ctx,
        ssg: { tag: { getTagWithModelCount: { prefetch: vi.fn() } } },
        features: { isGreen: isGreen.value },
      }),
}));

import { getServerSideProps } from '~/pages/tag/[tagname]';

const run = async (green: boolean) => {
  isGreen.value = green;
  return (await getServerSideProps({ query: { tagname: 'anime' } } as never)) as {
    props: { deIndexForDomain: boolean; greenCanonical: string | null };
  };
};

describe('tag page domain gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shouldDeIndexMatureOnlyTag.mockReturnValue(false);
    shouldDeIndexSafeOnlyTag.mockReturnValue(false);
    getTagPageSeoData.mockResolvedValue({ count: 10, models: [] });
  });

  it('reads green-visible data and applies the mature-only rule on green', async () => {
    shouldDeIndexMatureOnlyTag.mockReturnValue(true);

    const { props } = await run(true);

    expect(getTagPageSeoData).toHaveBeenCalledWith({ name: 'anime', safeOnly: true });
    expect(shouldDeIndexMatureOnlyTag).toHaveBeenCalledTimes(1);
    expect(shouldDeIndexSafeOnlyTag).not.toHaveBeenCalled();
    expect(props.deIndexForDomain).toBe(true);
  });

  it('reads everything and applies the safe-only rule on red', async () => {
    shouldDeIndexSafeOnlyTag.mockReturnValue(true);

    const { props } = await run(false);

    expect(getTagPageSeoData).toHaveBeenCalledWith({ name: 'anime', safeOnly: false });
    expect(shouldDeIndexSafeOnlyTag).toHaveBeenCalledTimes(1);
    expect(shouldDeIndexMatureOnlyTag).not.toHaveBeenCalled();
    expect(props.deIndexForDomain).toBe(true);
  });

  it('never hands green a canonical pointing anywhere but itself', async () => {
    const { props } = await run(true);

    expect(props.greenCanonical).toBeNull();
  });
});
