import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { PostsCard } from '~/components/Post/Infinite/PostsCard';
import { renderWithProviders } from '../../../../test/component-setup';
import { IsClientProvider } from '~/providers/IsClientProvider';
import type { PostsInfiniteModel } from '~/server/services/post.service';
import type * as ImageGuard from '~/components/ImageGuard/ImageGuard2';
import type * as EdgeMedia from '~/components/EdgeMedia/EdgeMedia';
import type * as ContextMenu from '~/components/Image/ContextMenu/ImageContextMenu';
import type * as Reactions from '~/components/Reaction/Reactions';

// The ordering test mocks PostsCard away — deliberately, since 200 real cards would install 200
// live intervals — so these three cases are the only thing covering which badge a card shows.
// A post with no publishedAt is a draft, one with a future publishedAt is scheduled, and a
// published one must show neither: PostsCard also renders the public feed.

vi.mock('~/components/ImageGuard/ImageGuard2', async (importOriginal) => {
  const actual = await importOriginal<typeof ImageGuard>();
  const Guard = ({ children }: { children: (safe: boolean) => React.ReactNode }) => (
    <>{children(true)}</>
  );
  Guard.displayName = 'ImageGuard2';
  const BlurToggle = () => null;
  BlurToggle.displayName = 'BlurToggle';
  Guard.BlurToggle = BlurToggle;
  return { ...actual, ImageGuard2: Guard };
});
vi.mock('~/components/EdgeMedia/EdgeMedia', async (importOriginal) => ({
  ...(await importOriginal<typeof EdgeMedia>()),
  EdgeMedia2: () => <div data-testid="media" />,
}));
vi.mock('~/components/Image/ContextMenu/ImageContextMenu', async (importOriginal) => ({
  ...(await importOriginal<typeof ContextMenu>()),
  ImageContextMenu: () => null,
}));
vi.mock('~/components/Reaction/Reactions', async (importOriginal) => ({
  ...(await importOriginal<typeof Reactions>()),
  PostReactions: () => null,
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));

function makePost(publishedAt: Date | null): PostsInfiniteModel {
  return {
    id: 7,
    publishedAt,
    imageCount: 1,
    stats: null,
    cosmetic: null,
    user: { id: 1, username: 'creator' },
    images: [{ id: 7, url: 'x', width: 300, height: 300, type: 'image', metadata: {} }],
  } as unknown as PostsInfiniteModel;
}

const badgeText = () =>
  (document.querySelector('[class*="publishState"]') as HTMLElement | null)?.textContent ?? null;

describe('post card publish state', () => {
  test('a scheduled post shows how long until it publishes', async () => {
    const inThreeDays = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    renderWithProviders(
      <IsClientProvider>
        <PostsCard data={makePost(inThreeDays)} />
      </IsClientProvider>
    );

    await vi.waitFor(() => expect(badgeText()).toBeTruthy());
    // The old card showed a clock icon whose tooltip said "Scheduled" and no time at all.
    expect(badgeText()).toContain('in 3 days');
  });

  test('a draft says so where the countdown would be', async () => {
    renderWithProviders(
      <IsClientProvider>
        <PostsCard data={makePost(null)} />
      </IsClientProvider>
    );

    await vi.waitFor(() => expect(badgeText()).toBeTruthy());
    expect(badgeText()).toBe('Draft');
  });

  test('a published post shows no badge', async () => {
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    renderWithProviders(
      <IsClientProvider>
        <PostsCard data={makePost(lastWeek)} />
      </IsClientProvider>
    );

    // Wait for the card itself, so this is "the badge is absent", not "nothing rendered yet".
    await vi.waitFor(() => expect(document.querySelector('[data-testid="media"]')).toBeTruthy());
    expect(badgeText()).toBeNull();
  });
});
