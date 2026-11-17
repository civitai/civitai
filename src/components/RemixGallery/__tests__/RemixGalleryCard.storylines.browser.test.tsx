import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type * as TrpcMod from '~/utils/trpc';
import { RemixGalleryCard } from '~/components/RemixGallery/RemixGalleryCard';

const HOST = 74;

const mocks = vi.hoisted(() => ({
  flags: { remixGallery: true, storylines: true },
  summaryCalls: [] as { input: unknown; enabled: boolean }[],
}));

const story = (storylineId: number) => ({
  storylineId,
  title: `Story ${storylineId}`,
  username: `writer${storylineId}`,
  previews: [{ url: `s${storylineId}.jpg`, type: 'image', nsfwLevel: 1 }],
});

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'placement.getRemixGalleryVisibility': {
        useQuery: () => ({
          data: { open: true, hasEntries: false, render: true, ownerId: 41, pendingCount: 0 },
        }),
      },
      'placement.getRemixGalleryCardSummaries': {
        useQuery: (input: unknown, options: { enabled: boolean }) => {
          mocks.summaryCalls.push({ input, enabled: options.enabled });
          return {
            data: options.enabled
              ? {
                  [HOST]: {
                    count: 0,
                    entries: [],
                    storylines: { count: 2, entries: [story(1), story(2)] },
                  },
                }
              : undefined,
          };
        },
      },
    }),
  };
});
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => mocks.flags,
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useViewerBrowsingLevelDebounced: () => 1,
  useBrowsingLevelContext: () => ({ blurLevels: 4 }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactElement }) => children,
}));

beforeEach(() => {
  mocks.flags = { remixGallery: true, storylines: true };
  mocks.summaryCalls = [];
  vi.mocked(useRouter().push).mockClear();
});

const storyTile = (n: number) =>
  page.getByRole('button', { name: `Open writer${n}'s story "Story ${n}"` });

describe("the image page's remix gallery lists the stories started from it", () => {
  test('shows each story with its title, and opens it', async () => {
    renderWithProviders(<RemixGalleryCard imageId={HOST} />);

    await expect.element(page.getByText('2 stories started here')).toBeVisible();
    await expect.element(storyTile(1)).toBeVisible();
    await expect.element(page.getByText('Story 2', { exact: true })).toBeVisible();
    expect(mocks.summaryCalls.at(-1)?.input).toMatchObject({ imageIds: [HOST] });

    await storyTile(2).click();
    expect(useRouter().push).toHaveBeenCalledWith('/storylines/2');
  });

  test('asks nothing and lists nothing with the storylines flag off', async () => {
    mocks.flags = { remixGallery: true, storylines: false };
    renderWithProviders(<RemixGalleryCard imageId={HOST} />);

    await expect.element(page.getByText('Remix gallery')).toBeVisible();
    expect(document.body.textContent).not.toContain('started here');
    expect(mocks.summaryCalls.length).toBeGreaterThan(0);
    expect(mocks.summaryCalls.every((call) => !call.enabled)).toBe(true);
  });
});
