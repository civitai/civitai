import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as BrowserSettingsProvider from '~/providers/BrowserSettingsProvider';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../../test/component-setup';
import '~/styles/globals.css';

// The real ImageGuard2: the play button must never open a video the guard is still hiding.
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => ({ id: 1 }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ canViewNsfw: false }),
  useOptionalFeatureFlags: () => ({ canViewNsfw: false }),
  useFeatureFlagsReady: () => true,
  FeatureFlagsProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsProvider>()),
  useBrowsingSettings: () => false,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof TrpcModule>()), trpc: makeTrpcProxy() };
});

import { EventContentThumb } from '~/components/Events/ScoredEvent/EventContentThumb';

const media = (id: number, type: 'image' | 'video', nsfwLevel: number) =>
  ({
    id,
    entityId: id,
    entityType: 'Image',
    url: `00000000-0000-0000-0000-00000000000${id}`,
    name: `clip-${id}`,
    type,
    nsfwLevel,
    width: 400,
    height: 500,
    hash: null,
    metadata: { width: 400, height: 500 },
  } as unknown as Parameters<typeof EventContentThumb>[0]['image']);

describe('EventContentThumb play button', () => {
  test('a video the viewer may see plays on tap', async () => {
    const onPlay = vi.fn();
    // Stands in for the hat wrapper, whose click bursts the hat.
    const onCard = vi.fn();
    renderWithProviders(
      <div onClick={onCard}>
        <EventContentThumb entityType="Image" image={media(1, 'video', 1)} onPlay={onPlay} />
      </div>
    );
    await page.getByRole('button', { name: 'Play video' }).click();
    expect(onPlay).toHaveBeenCalledOnce();
    expect(onCard).not.toHaveBeenCalled();
  });

  // Each beside a video that does get one, so the count is read once the guard has settled.
  test('a video still blurred by the guard has no play button', async () => {
    renderWithProviders(
      <>
        <EventContentThumb entityType="Image" image={media(4, 'video', 1)} onPlay={vi.fn()} />
        <EventContentThumb entityType="Image" image={media(2, 'video', 4)} onPlay={vi.fn()} />
      </>
    );
    await expect.element(page.getByRole('button', { name: 'Play video' })).toBeVisible();
    expect(page.getByTestId('event-content-play').elements()).toHaveLength(1);
  });

  test('a still image has none', async () => {
    renderWithProviders(
      <>
        <EventContentThumb entityType="Image" image={media(5, 'video', 1)} onPlay={vi.fn()} />
        <EventContentThumb entityType="Image" image={media(3, 'image', 1)} onPlay={vi.fn()} />
      </>
    );
    await expect.element(page.getByRole('button', { name: 'Play video' })).toBeVisible();
    expect(page.getByTestId('event-content-play').elements()).toHaveLength(1);
  });
});
