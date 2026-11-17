import { useSyncExternalStore } from 'react';
import { act } from 'react';
import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';

// What the image guard reports, switchable mid-test like the viewer revealing the image.
const guard = vi.hoisted(() => {
  let safe = false;
  const listeners = new Set<() => void>();
  return {
    get: () => safe,
    set(next: boolean) {
      safe = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
const mediaRenders = vi.hoisted(() => [] as { autoPlay?: boolean; standby?: boolean }[]);

vi.mock('~/components/ImageGuard/ImageGuard2', async (o) => ({
  ...(await o<object>()),
  ImageGuardContent: ({ children }: { children: (safe: boolean) => React.ReactNode }) =>
    children(useSyncExternalStore(guard.subscribe, guard.get)),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', async (o) => ({
  ...(await o<object>()),
  EdgeMedia: ({ videoProps }: { videoProps?: { autoPlay?: boolean; standby?: boolean } }) => {
    mediaRenders.push({ autoPlay: videoProps?.autoPlay, standby: videoProps?.standby });
    return <div data-testid="media" />;
  },
}));
vi.mock('~/components/ImageHash/ImageHash', async (o) => ({
  ...(await o<object>()),
  MediaHash: () => <div data-testid="hash" />,
}));
vi.mock('~/components/Sticker/ImageStickerOverlay', async (o) => ({
  ...(await o<object>()),
  ImageStickerOverlay: () => null,
}));
vi.mock('~/components/Cosmetics/EventDecoration/DrawnMediaHat', async (o) => ({
  ...(await o<object>()),
  DrawnMediaHat: () => null,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (o) => ({
  ...(await o<object>()),
  useFeatureFlags: () => ({}),
}));

import { ImageDetailCarousel } from '~/components/Image/DetailV2/ImageDetailCarousel';
import { useStickerPlacementDraftStore as stickers } from '~/store/sticker-placement-draft.store';

const video = {
  id: 1,
  nsfwLevel: 8,
  url: 'video-1',
  height: 720,
  width: 1280,
  type: 'video' as const,
  name: null,
};
const noop = () => undefined;

test('a hidden video slide builds no player until it is revealed, then autoplays', async () => {
  mediaRenders.length = 0;
  renderWithProviders(
    <div style={{ width: 400, height: 300, display: 'flex' }}>
      <ImageDetailCarousel
        images={[video]}
        index={0}
        next={noop}
        previous={noop}
        canNavigate={false}
      />
    </div>
  );

  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="hash"], [data-testid="media"]')).not.toBeNull()
  );
  // Includes the first render, before the slide is measured.
  expect(mediaRenders).toEqual([]);
  await expect.element(page.getByTestId('hash')).toBeInTheDocument();

  act(() => guard.set(true));

  await expect.element(page.getByTestId('media')).toBeInTheDocument();
  expect(page.getByTestId('hash').query()).toBeNull();
  expect(mediaRenders.at(-1)).toEqual({ autoPlay: true, standby: false });
});

// Opening the timeline drops the player's controls, which re-ran its autoplay: Movement paused the
// video and it started again at once. Standby is what keeps the player from playing on its own.
test('the player holds still while the sticker timeline is open, and autoplays again after', async () => {
  act(() => guard.set(true));
  mediaRenders.length = 0;
  renderWithProviders(
    <div style={{ width: 400, height: 300, display: 'flex' }}>
      <ImageDetailCarousel
        images={[video]}
        index={0}
        next={noop}
        previous={noop}
        canNavigate={false}
      />
    </div>
  );
  await expect.element(page.getByTestId('media')).toBeInTheDocument();
  expect(mediaRenders.at(-1)).toEqual({ autoPlay: true, standby: false });

  act(() => {
    const store = stickers.getState();
    store.close();
    store.open(video.id);
    store.begin(9, { x: 0.5, y: 0.5 });
    store.closeTray();
    store.setMotion(stickers.getState().selectedDraftId!, true);
  });
  await vi.waitFor(() => expect(mediaRenders.at(-1)?.standby).toBe(true));

  act(() => stickers.getState().setMotion(stickers.getState().selectedDraftId!, false));
  await vi.waitFor(() => expect(mediaRenders.at(-1)?.standby).toBe(false));
  act(() => stickers.getState().close());
});
