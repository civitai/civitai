import { useSyncExternalStore } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
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
const flags = vi.hoisted(() => ({} as Record<string, boolean>));
/** How the mocked CDN media fails: through onError, or before it was attached (server-rendered). */
const cdn = vi.hoisted(() => ({
  refuses: false,
  failedBeforeAttach: null as HTMLImageElement | null,
}));

vi.mock('~/components/ImageGuard/ImageGuard2', async (o) => ({
  ...(await o<object>()),
  ImageGuardContent: ({ children }: { children: (safe: boolean) => React.ReactNode }) =>
    children(useSyncExternalStore(guard.subscribe, guard.get)),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', async (o) => {
  const { useEffect } = await import('react');
  function EdgeMedia({
    videoProps,
    onError,
    mediaRef,
  }: {
    videoProps?: { autoPlay?: boolean; standby?: boolean };
    onError?: (e: { target: EventTarget | null }) => void;
    mediaRef?: [HTMLImageElement | null, (img: HTMLImageElement | null) => void];
  }) {
    mediaRenders.push({ autoPlay: videoProps?.autoPlay, standby: videoProps?.standby });
    useEffect(() => {
      if (cdn.refuses) onError?.({ target: null });
      // As EdgeMedia does: the element, once mounted, whatever already happened to it.
      if (cdn.failedBeforeAttach) mediaRef?.[1](cdn.failedBeforeAttach);
    }, [onError, mediaRef]);
    return <div data-testid="media" />;
  }
  return { ...(await o<object>()), EdgeMedia };
});
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
  useFeatureFlags: () => flags,
}));

import { FixedSessionProvider } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
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

// The image detail page: a moderator's slide for a scanned image moves to the retracted-media route
// once the CDN refuses it, whether the refusal reaches onError or happened before hydration.
describe('a scanned image the CDN refuses', () => {
  const scanned = { ...video, id: 7, url: 'img-7', type: 'image' as const, ingestion: 'Scanned' };
  const routeImg = () => document.querySelector('img[src="/api/mod/retracted-media/7"]');
  const renderSlide = (isModerator: boolean) =>
    renderWithProviders(
      <FixedSessionProvider user={{ id: 1, isModerator }}>
        <div style={{ width: 400, height: 300, display: 'flex' }}>
          <ImageDetailCarousel
            images={[scanned]}
            index={0}
            next={noop}
            previous={noop}
            canNavigate={false}
          />
        </div>
      </FixedSessionProvider>
    );
  const setUp = (cdnLeg: boolean) => {
    act(() => guard.set(true));
    flags.modRetractedMedia = true;
    flags.modRetractedMediaCdnLeg = cdnLeg;
  };
  afterEach(() => {
    act(() => guard.set(false));
    for (const key of Object.keys(flags)) delete flags[key];
    cdn.refuses = false;
    cdn.failedBeforeAttach = null;
  });

  test("moves a moderator's slide to the route when the CDN load fails", async () => {
    setUp(true);
    cdn.refuses = true;
    await renderSlide(true);
    await expect.poll(routeImg).not.toBeNull();
  });

  // A server-rendered image can fail before hydration attaches onError, and that event is not replayed.
  test("moves a moderator's slide whose image failed before it was attached", async () => {
    setUp(true);
    cdn.failedBeforeAttach = await new Promise<HTMLImageElement>((resolve) => {
      const img = new Image();
      img.onerror = () => resolve(img);
      img.src = '/__missing__.png';
    });
    await renderSlide(true);
    await expect.poll(routeImg).not.toBeNull();
  });

  // civitai/civitai#10202: the route decides which refused scanned images it serves.
  test("moves a moderator's slide with the CDN-refusal leg off too", async () => {
    setUp(false);
    cdn.refuses = true;
    await renderSlide(true);
    await expect.poll(routeImg).not.toBeNull();
  });

  test('keeps everyone else on the CDN', async () => {
    setUp(true);
    cdn.refuses = true;
    await renderSlide(false);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="media"], img[src^="/api/mod/"]')).not.toBeNull()
    );
    // The mock refuses in its first effect; act flushes it, so a fallback would be committed here.
    await act(async () => undefined);
    expect(routeImg()).toBeNull();
  });
});
